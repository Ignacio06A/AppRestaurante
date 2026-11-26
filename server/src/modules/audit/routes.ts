import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { ah } from '../../lib/asyncHandler';
import { parse } from '../../lib/validate';
import { requirePermission } from '../../middleware/auth';
import { dayEnd, dayStart } from '../../lib/dates';

export const auditRouter = Router();

auditRouter.get(
  '/',
  requirePermission('audit.view'),
  ah(async (req, res) => {
    const q = parse(
      z.object({
        userId: z.coerce.number().int().optional(),
        action: z.string().optional(),
        entity: z.string().optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    const where: Prisma.AuditLogWhereInput = {};
    if (q.userId) where.userId = q.userId;
    if (q.action) where.action = { contains: q.action, mode: 'insensitive' };
    if (q.entity) where.entity = q.entity;
    if (q.from || q.to) where.createdAt = { ...(q.from ? { gte: dayStart(q.from) } : {}), ...(q.to ? { lte: dayEnd(q.to) } : {}) };
    const [total, rows] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { user: { select: { id: true, name: true, username: true } } },
      }),
    ]);
    res.json({ total, page: q.page, pageSize: q.pageSize, rows });
  }),
);
