import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from '../db';
import { forbidden, unauthorized } from '../lib/errors';
import { PermissionCode, RoleCode } from '../lib/permissions';

export interface AuthUser {
  id: number;
  name: string;
  username: string;
  role: RoleCode;
  roleName: string;
  permissions: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

interface TokenPayload {
  sub: number;
  v: number;
}

export function signToken(userId: number, tokenVersion: number) {
  return jwt.sign({ sub: userId, v: tokenVersion }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  });
}

/** Cache corto de usuarios para no consultar la BD en cada request/evento. */
const cache = new Map<number, { user: AuthUser; version: number; at: number }>();
const CACHE_MS = 15_000;

export function invalidateUserCache(userId?: number) {
  if (userId === undefined) cache.clear();
  else cache.delete(userId);
}

export async function resolveUserFromToken(token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  let payload: TokenPayload;
  try {
    payload = jwt.verify(token, config.jwtSecret) as unknown as TokenPayload;
  } catch {
    return null;
  }
  const userId = Number(payload.sub);
  const cached = cache.get(userId);
  if (cached && cached.version === payload.v && Date.now() - cached.at < CACHE_MS) return cached.user;

  const u = await prisma.user.findUnique({
    where: { id: userId },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });
  if (!u || !u.active || u.tokenVersion !== payload.v) return null;
  const user: AuthUser = {
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role.code as RoleCode,
    roleName: u.role.name,
    permissions: u.role.permissions.map((rp) => rp.permission.code),
  };
  cache.set(userId, { user, version: u.tokenVersion, at: Date.now() });
  return user;
}

export function extractToken(req: Request): string | undefined {
  const fromCookie = req.cookies?.[config.cookieName];
  if (fromCookie) return fromCookie;
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  return undefined;
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const user = await resolveUserFromToken(extractToken(req));
    if (!user) return next(unauthorized('Sesión inválida o expirada'));
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

export function hasPermission(user: AuthUser | undefined, ...perms: PermissionCode[]) {
  return !!user && perms.some((p) => user.permissions.includes(p));
}

/** Autoriza si el usuario tiene AL MENOS UNO de los permisos indicados. */
export function requirePermission(...perms: PermissionCode[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!hasPermission(req.user, ...perms)) return next(forbidden());
    next();
  };
}
