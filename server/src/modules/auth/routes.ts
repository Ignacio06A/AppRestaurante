import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { prisma } from '../../db';
import { config } from '../../config';
import { ah } from '../../lib/asyncHandler';
import { parse } from '../../lib/validate';
import { authenticate, invalidateUserCache, signToken } from '../../middleware/auth';
import { badRequest, unauthorized } from '../../lib/errors';
import { audit } from '../../lib/audit';

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: process.env.NODE_ENV === 'test' ? 1000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Demasiados intentos. Intente de nuevo en unos minutos.' } },
});

function cookieOptions() {
  return { httpOnly: true, sameSite: 'lax' as const, secure: config.isProd, maxAge: 12 * 3600_000, path: '/' };
}

authRouter.post(
  '/login',
  loginLimiter,
  ah(async (req, res) => {
    const { username, password } = parse(z.object({ username: z.string().trim().min(1, 'Usuario requerido').max(60), password: z.string().min(1, 'Contraseña requerida').max(200) }), req.body);
    const user = await prisma.user.findUnique({ where: { username: username.toLowerCase() }, include: { role: true } });
    // Comparación siempre ejecutada para no filtrar existencia de usuarios por tiempo de respuesta
    const ok = await bcrypt.compare(password, user?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    if (!user || !ok || !user.active) {
      await audit({ userId: user?.id ?? null, action: 'LOGIN_FAILED', entity: 'User', entityId: user?.id, details: { username }, ip: req.ip });
      throw unauthorized(user && !user.active && ok ? 'El usuario está desactivado' : 'Usuario o contraseña incorrectos');
    }
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const token = signToken(user.id, user.tokenVersion);
    res.cookie(config.cookieName, token, cookieOptions());
    await audit({ userId: user.id, action: 'LOGIN', entity: 'User', entityId: user.id, ip: req.ip });
    res.json({ ok: true, token });
  }),
);

authRouter.post(
  '/logout',
  ah(async (_req, res) => {
    res.clearCookie(config.cookieName, { path: '/' });
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  authenticate,
  ah(async (req, res) => {
    res.json(req.user);
  }),
);

authRouter.post(
  '/change-password',
  authenticate,
  ah(async (req, res) => {
    const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8, 'La nueva contraseña debe tener al menos 8 caracteres').max(200) }), req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    if (!(await bcrypt.compare(body.currentPassword, user.passwordHash))) throw badRequest('La contraseña actual es incorrecta');
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(body.newPassword, 12), tokenVersion: { increment: 1 } },
    });
    invalidateUserCache(user.id);
    res.cookie(config.cookieName, signToken(updated.id, updated.tokenVersion), cookieOptions());
    await audit({ userId: user.id, action: 'PASSWORD_CHANGED', entity: 'User', entityId: user.id, ip: req.ip });
    res.json({ ok: true });
  }),
);
