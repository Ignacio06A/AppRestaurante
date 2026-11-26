import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db';
import { ah } from '../../lib/asyncHandler';
import { idParam, money, parse } from '../../lib/validate';
import { requirePermission } from '../../middleware/auth';
import { conflict, notFound } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { realtime } from '../../realtime';

export const menuRouter = Router();

/** Menú para tomar pedidos: solo categorías activas y productos activos (incluye agotados marcados). */
menuRouter.get(
  '/menu',
  ah(async (_req, res) => {
    const categories = await prisma.category.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        products: {
          where: { active: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          include: { area: true },
        },
      },
    });
    res.json(categories.filter((c) => c.products.length > 0));
  }),
);

menuRouter.get(
  '/areas',
  ah(async (_req, res) => {
    res.json(await prisma.preparationArea.findMany({ orderBy: { id: 'asc' } }));
  }),
);

// ---------------- Categorías ----------------
const categorySchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(255).nullish(),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  active: z.boolean().default(true),
  defaultAreaId: z.number().int().positive().nullish(),
});

menuRouter.get(
  '/categories',
  ah(async (_req, res) => {
    res.json(
      await prisma.category.findMany({
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        include: { defaultArea: true, _count: { select: { products: true } } },
      }),
    );
  }),
);

menuRouter.post(
  '/categories',
  requirePermission('menu.manage'),
  ah(async (req, res) => {
    const body = parse(categorySchema, req.body);
    if (await prisma.category.findUnique({ where: { name: body.name } })) throw conflict('Ya existe una categoría con ese nombre');
    const c = await prisma.category.create({ data: body });
    await audit({ userId: req.user!.id, action: 'CATEGORY_CREATED', entity: 'Category', entityId: c.id, details: body, ip: req.ip });
    realtime.menuUpdated();
    res.status(201).json(c);
  }),
);

menuRouter.put(
  '/categories/:id',
  requirePermission('menu.manage'),
  ah(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const body = parse(categorySchema.partial(), req.body);
    if (!(await prisma.category.findUnique({ where: { id } }))) throw notFound('Categoría no encontrada');
    if (body.name) {
      const dup = await prisma.category.findUnique({ where: { name: body.name } });
      if (dup && dup.id !== id) throw conflict('Ya existe una categoría con ese nombre');
    }
    const c = await prisma.category.update({ where: { id }, data: body });
    await audit({ userId: req.user!.id, action: 'CATEGORY_UPDATED', entity: 'Category', entityId: id, details: body, ip: req.ip });
    realtime.menuUpdated();
    res.json(c);
  }),
);

menuRouter.delete(
  '/categories/:id',
  requirePermission('menu.manage'),
  ah(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const c = await prisma.category.findUnique({ where: { id }, include: { _count: { select: { products: true } } } });
    if (!c) throw notFound('Categoría no encontrada');
    let result: 'deleted' | 'deactivated';
    if (c._count.products > 0) {
      await prisma.category.update({ where: { id }, data: { active: false } });
      result = 'deactivated';
    } else {
      await prisma.category.delete({ where: { id } });
      result = 'deleted';
    }
    await audit({ userId: req.user!.id, action: `CATEGORY_${result.toUpperCase()}`, entity: 'Category', entityId: id, ip: req.ip });
    realtime.menuUpdated();
    res.json({ result });
  }),
);

// ---------------- Productos ----------------
const productSchema = z.object({
  name: z.string().trim().min(2, 'Nombre muy corto').max(120),
  description: z.string().trim().max(500).nullish(),
  price: money,
  categoryId: z.number().int().positive(),
  areaId: z.number().int().positive(),
  imageUrl: z.string().trim().max(500).nullish(),
  active: z.boolean().default(true),
  available: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});

menuRouter.get(
  '/products',
  ah(async (req, res) => {
    const q = parse(z.object({ categoryId: z.coerce.number().int().optional(), search: z.string().optional(), includeInactive: z.string().optional() }), req.query);
    res.json(
      await prisma.product.findMany({
        where: {
          ...(q.categoryId ? { categoryId: q.categoryId } : {}),
          ...(q.search ? { name: { contains: q.search, mode: 'insensitive' } } : {}),
          ...(q.includeInactive === '1' ? {} : { active: true }),
        },
        orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
        include: { category: true, area: true },
      }),
    );
  }),
);

menuRouter.post(
  '/products',
  requirePermission('menu.manage'),
  ah(async (req, res) => {
    const body = parse(productSchema, req.body);
    await assertRefs(body.categoryId, body.areaId);
    const p = await prisma.product.create({ data: { ...body, imageUrl: body.imageUrl || null }, include: { category: true, area: true } });
    await audit({ userId: req.user!.id, action: 'PRODUCT_CREATED', entity: 'Product', entityId: p.id, details: body, ip: req.ip });
    realtime.menuUpdated();
    res.status(201).json(p);
  }),
);

menuRouter.put(
  '/products/:id',
  requirePermission('menu.manage'),
  ah(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const body = parse(productSchema.partial(), req.body);
    const prev = await prisma.product.findUnique({ where: { id } });
    if (!prev) throw notFound('Producto no encontrado');
    if (body.categoryId || body.areaId) await assertRefs(body.categoryId ?? prev.categoryId, body.areaId ?? prev.areaId);
    const p = await prisma.product.update({
      where: { id },
      data: { ...body, imageUrl: body.imageUrl === undefined ? undefined : body.imageUrl || null },
      include: { category: true, area: true },
    });
    const details: Record<string, unknown> = { ...body };
    if (body.price !== undefined && Number(prev.price) !== body.price) details.priceChange = { from: Number(prev.price), to: body.price };
    await audit({ userId: req.user!.id, action: details.priceChange ? 'PRODUCT_PRICE_CHANGED' : 'PRODUCT_UPDATED', entity: 'Product', entityId: id, details, ip: req.ip });
    realtime.menuUpdated();
    res.json(p);
  }),
);

/** Agotado / disponible. Lo pueden usar cocina y bar (permiso menu.availability). */
menuRouter.patch(
  '/products/:id/availability',
  requirePermission('menu.manage', 'menu.availability'),
  ah(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const { available } = parse(z.object({ available: z.boolean() }), req.body);
    if (!(await prisma.product.findUnique({ where: { id } }))) throw notFound('Producto no encontrado');
    const p = await prisma.product.update({ where: { id }, data: { available }, include: { category: true, area: true } });
    await audit({ userId: req.user!.id, action: available ? 'PRODUCT_AVAILABLE' : 'PRODUCT_SOLD_OUT', entity: 'Product', entityId: id, ip: req.ip });
    realtime.menuUpdated();
    res.json(p);
  }),
);

/** Si el producto tiene ventas se desactiva (se conserva el histórico); si no, se elimina. */
menuRouter.delete(
  '/products/:id',
  requirePermission('menu.manage'),
  ah(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const p = await prisma.product.findUnique({ where: { id }, include: { _count: { select: { orderItems: true } } } });
    if (!p) throw notFound('Producto no encontrado');
    let result: 'deleted' | 'deactivated';
    if (p._count.orderItems > 0) {
      await prisma.product.update({ where: { id }, data: { active: false } });
      result = 'deactivated';
    } else {
      await prisma.product.delete({ where: { id } });
      result = 'deleted';
    }
    await audit({ userId: req.user!.id, action: `PRODUCT_${result.toUpperCase()}`, entity: 'Product', entityId: id, details: { name: p.name }, ip: req.ip });
    realtime.menuUpdated();
    res.json({ result });
  }),
);

async function assertRefs(categoryId: number, areaId: number) {
  const [c, a] = await Promise.all([
    prisma.category.findUnique({ where: { id: categoryId } }),
    prisma.preparationArea.findUnique({ where: { id: areaId } }),
  ]);
  if (!c) throw notFound('Categoría no encontrada');
  if (!a) throw notFound('Área de preparación no encontrada');
}
