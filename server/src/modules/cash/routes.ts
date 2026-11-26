import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db';
import { ah } from '../../lib/asyncHandler';
import { idParam, money, parse } from '../../lib/validate';
import { requirePermission } from '../../middleware/auth';
import { notFound } from '../../lib/errors';
import { addMovement, closeSession, computeSessionSummary, getOpenSession, openSession } from './service';

export const cashRouter = Router();

const sessionInclude = {
  register: true,
  openedBy: { select: { id: true, name: true } },
  closing: { include: { closedBy: { select: { id: true, name: true } } } },
} as const;

cashRouter.get(
  '/current',
  requirePermission('cash.operate', 'payments.view', 'payments.create'),
  ah(async (req, res) => {
    const registerId = req.query.registerId ? parse(idParam, req.query.registerId) : undefined;
    const s = await getOpenSession(registerId);
    if (!s) return res.json({ session: null });
    const { summary } = await computeSessionSummary(s.id);
    res.json({ session: s, summary });
  }),
);

cashRouter.post(
  '/open',
  requirePermission('cash.operate'),
  ah(async (req, res) => {
    const body = parse(z.object({ registerId: z.number().int().positive().optional(), openingAmount: money, notes: z.string().max(500).nullish() }), req.body);
    res.status(201).json(await openSession(req.user!, body));
  }),
);

cashRouter.get(
  '/sessions',
  requirePermission('cash.history'),
  ah(async (req, res) => {
    const q = parse(z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }), req.query);
    const [total, rows] = await Promise.all([
      prisma.cashSession.count(),
      prisma.cashSession.findMany({ orderBy: { openedAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: sessionInclude }),
    ]);
    res.json({ total, page: q.page, pageSize: q.pageSize, rows });
  }),
);

cashRouter.get(
  '/sessions/:id',
  requirePermission('cash.history', 'cash.operate'),
  ah(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const s = await prisma.cashSession.findUnique({ where: { id }, include: sessionInclude });
    if (!s) throw notFound('Sesión de caja no encontrada');
    const [movements, { summary }] = await Promise.all([
      prisma.cashMovement.findMany({
        where: { sessionId: id },
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { id: true, name: true } }, paymentMethod: true, authorizedBy: { select: { id: true, name: true } } },
      }),
      computeSessionSummary(id),
    ]);
    res.json({ session: s, summary, movements });
  }),
);

cashRouter.post(
  '/sessions/:id/movements',
  requirePermission('cash.operate'),
  ah(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const body = parse(
      z.object({
        type: z.enum(['INCOME', 'WITHDRAWAL', 'EXPENSE', 'ADJUSTMENT']),
        amount: z.number().finite().min(-999_999_999).max(999_999_999),
        description: z.string().trim().min(3, 'Describa el movimiento (mín. 3 caracteres)').max(255),
      }),
      req.body,
    );
    res.status(201).json(await addMovement(req.user!, id, body));
  }),
);

cashRouter.post(
  '/sessions/:id/close',
  requirePermission('cash.close'),
  ah(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const body = parse(z.object({ countedCash: money, notes: z.string().max(500).nullish() }), req.body);
    res.json(await closeSession(req.user!, id, body));
  }),
);
