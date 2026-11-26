import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../../db';
import { ah } from '../../lib/asyncHandler';
import { idParam, parse } from '../../lib/validate';
import { invalidateUserCache, requirePermission } from '../../middleware/auth';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { FORBIDDEN_FOR_ROLE, PERMISSIONS, RoleCode } from '../../lib/permissions';

export const usersRouter = Router();
usersRouter.use(requirePermission('users.manage'));

const publicUser = {
  id: true,
  name: true,
  username: true,
  active: true,
  lastLoginAt: true,
  createdAt: true,
  role: { select: { id: true, code: true, name: true } },
} as const;

usersRouter.get(
  '/users',
  ah(async (req, res) => {
    const q = parse(z.object({ search: z.string().optional(), roleId: z.coerce.number().int().optional() }), req.query);
    res.json(
      await prisma.user.findMany({
        where: {
          ...(q.roleId ? { roleId: q.roleId } : {}),
          ...(q.search ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { username: { contains: q.search, mode: 'insensitive' } }] } : {}),
        },
        orderBy: [{ active: 'desc' }, { name: 'asc' }],
        select: publicUser,
      }),
    );
  }),
);

const userSchema = z.object({
  name: z.string().trim().min(2, 'Nombre muy corto').max(120),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, 'El usuario debe tener al menos 3 caracteres')
    .max(60)
    .regex(/^[a-z0-9._-]+$/, 'Solo letras minúsculas, números, punto, guion y guion bajo'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres').max(200),
  roleId: z.number().int().positive(),
  active: z.boolean().default(true),
});

usersRouter.post(
  '/users',
  ah(async (req, res) => {
    const body = parse(userSchema, req.body);
    if (await prisma.user.findUnique({ where: { username: body.username } })) throw conflict('El nombre de usuario ya existe');
    if (!(await prisma.role.findUnique({ where: { id: body.roleId } }))) throw notFound('Rol no encontrado');
    const u = await prisma.user.create({
      data: { name: body.name, username: body.username, roleId: body.roleId, active: body.active, passwordHash: await bcrypt.hash(body.password, 12) },
      select: publicUser,
    });
    await audit({ userId: req.user!.id, action: 'USER_CREATED', entity: 'User', entityId: u.id, details: { username: u.username, role: u.role.code }, ip: req.ip });
    res.status(201).json(u);
  }),
);

usersRouter.put(
  '/users/:id',
  ah(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const body = parse(userSchema.partial().extend({ password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres').max(200).optional().or(z.literal('')) }), req.body);
    const prev = await prisma.user.findUnique({ where: { id } });
    if (!prev) throw notFound('Usuario no encontrado');
    if (id === req.user!.id && (body.active === false || (body.roleId && body.roleId !== prev.roleId))) {
      throw badRequest('No puede desactivarse ni cambiar su propio rol');
    }
    if (body.username && body.username !== prev.username) {
      if (await prisma.user.findUnique({ where: { username: body.username } })) throw conflict('El nombre de usuario ya existe');
    }
    const invalidate = body.active === false || !!body.password || (body.roleId && body.roleId !== prev.roleId);
    const u = await prisma.user.update({
      where: { id },
      data: {
        name: body.name,
        username: body.username,
        roleId: body.roleId,
        active: body.active,
        ...(body.password ? { passwordHash: await bcrypt.hash(body.password, 12) } : {}),
        ...(invalidate ? { tokenVersion: { increment: 1 } } : {}),
      },
      select: publicUser,
    });
    invalidateUserCache(id);
    const { password: _pw, ...logged } = body;
    await audit({ userId: req.user!.id, action: 'USER_UPDATED', entity: 'User', entityId: id, details: { ...logged, passwordReset: !!body.password }, ip: req.ip });
    res.json(u);
  }),
);

/** Los usuarios nunca se eliminan (conservan historial financiero): solo se desactivan. */
usersRouter.delete(
  '/users/:id',
  ah(async (req, res) => {
    const id = parse(idParam, req.params.id);
    if (id === req.user!.id) throw badRequest('No puede desactivar su propio usuario');
    const u = await prisma.user.findUnique({ where: { id } });
    if (!u) throw notFound('Usuario no encontrado');
    await prisma.user.update({ where: { id }, data: { active: false, tokenVersion: { increment: 1 } } });
    invalidateUserCache(id);
    await audit({ userId: req.user!.id, action: 'USER_DEACTIVATED', entity: 'User', entityId: id, ip: req.ip });
    res.json({ result: 'deactivated' });
  }),
);

// ---------------- Roles y permisos ----------------
usersRouter.get(
  '/roles',
  ah(async (_req, res) => {
    const roles = await prisma.role.findMany({
      orderBy: { id: 'asc' },
      include: { permissions: { include: { permission: true } }, _count: { select: { users: true } } },
    });
    res.json(
      roles.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        description: r.description,
        userCount: r._count.users,
        permissions: r.permissions.map((p) => p.permission.code),
        forbidden: FORBIDDEN_FOR_ROLE[r.code as RoleCode] ?? [],
      })),
    );
  }),
);

usersRouter.get(
  '/permissions',
  ah(async (_req, res) => {
    res.json(await prisma.permission.findMany({ orderBy: [{ module: 'asc' }, { code: 'asc' }] }));
  }),
);

usersRouter.put(
  '/roles/:id/permissions',
  ah(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const { permissions } = parse(z.object({ permissions: z.array(z.string()).max(100) }), req.body);
    const role = await prisma.role.findUnique({ where: { id } });
    if (!role) throw notFound('Rol no encontrado');
    const unknown = permissions.filter((p) => !(p in PERMISSIONS));
    if (unknown.length) throw badRequest(`Permisos desconocidos: ${unknown.join(', ')}`);
    const blocked = (FORBIDDEN_FOR_ROLE[role.code as RoleCode] ?? []).filter((p) => permissions.includes(p));
    if (blocked.length) throw badRequest(`El rol ${role.name} no puede tener estos permisos: ${blocked.join(', ')}`);
    if (role.code === 'ADMIN' && !permissions.includes('users.manage')) throw badRequest('El rol Administrador debe conservar el permiso users.manage');
    const perms = await prisma.permission.findMany({ where: { code: { in: permissions } } });
    await prisma.$transaction([
      prisma.rolePermission.deleteMany({ where: { roleId: id } }),
      prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: id, permissionId: p.id })) }),
    ]);
    invalidateUserCache();
    await audit({ userId: req.user!.id, action: 'ROLE_PERMISSIONS_UPDATED', entity: 'Role', entityId: id, details: { permissions }, ip: req.ip });
    res.json({ ok: true });
  }),
);
