import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db';
import { ah } from '../../lib/asyncHandler';
import { idParam, parse } from '../../lib/validate';
import { requirePermission } from '../../middleware/auth';
import { computeTotals, OPEN_ORDER_STATUSES } from '../../lib/orderCalc';
import { getSettings } from '../../lib/settings';
import { fromCents, toCents } from '../../lib/money';
import { equalSplit, getAccount, getReceipt, registerPayment } from './service';
import { badRequest } from '../../lib/errors';

export const paymentsRouter = Router();

/** Cuentas pendientes (mesas con orden abierta o cuenta solicitada). */
paymentsRouter.get(
  '/accounts',
  requirePermission('payments.view'),
  ah(async (_req, res) => {
    const settings = await getSettings();
    const orders = await prisma.order.findMany({
      where: { status: { in: OPEN_ORDER_STATUSES } },
      orderBy: [{ status: 'desc' }, { openedAt: 'asc' }],
      include: {
        table: true,
        waiter: { select: { id: true, name: true } },
        items: { select: { id: true, status: true, unitPrice: true, quantity: true } },
        payments: { select: { amount: true, status: true } },
      },
    });
    res.json(
      orders.map((o) => {
        const t = computeTotals(o, settings);
        return {
          id: o.id,
          number: o.number,
          status: o.status,
          table: o.table,
          waiter: o.waiter,
          guests: o.guests,
          openedAt: o.openedAt,
          billRequestedAt: o.billRequestedAt,
          itemCount: o.items.filter((i) => i.status !== 'CANCELLED').reduce((a, i) => a + i.quantity, 0),
          pendingPrep: o.items.filter((i) => i.status === 'PENDING' || i.status === 'IN_PREPARATION').length,
          total: fromCents(t.total),
          paid: fromCents(t.paid),
          balance: fromCents(t.balance),
        };
      }),
    );
  }),
);

paymentsRouter.get(
  '/orders/:id/account',
  requirePermission('payments.view'),
  ah(async (req, res) => {
    res.json(await getAccount(parse(idParam, req.params.id)));
  }),
);

paymentsRouter.get(
  '/orders/:id/split',
  requirePermission('payments.view'),
  ah(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const { parts } = parse(z.object({ parts: z.coerce.number().int().min(2).max(50) }), req.query);
    const acc = await getAccount(id);
    res.json({ parts, balance: acc.totals.balance, amounts: equalSplit(toCents(acc.totals.balance), parts) });
  }),
);

paymentsRouter.post(
  '/orders/:id/payments',
  requirePermission('payments.create'),
  ah(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const body = parse(
      z.object({
        paymentMethodId: z.number().int().positive(),
        amount: z.number().positive().max(999_999_999).optional(),
        receivedAmount: z.number().min(0).max(999_999_999).nullish(),
        reference: z.string().max(120).nullish(),
        payerLabel: z.string().max(60).nullish(),
        splitMode: z.enum(['FULL', 'EQUAL', 'ITEMS', 'CUSTOM']).default('FULL'),
        items: z.array(z.object({ orderItemId: z.number().int().positive(), quantity: z.number().int().min(1) })).optional(),
        idempotencyKey: z.string().min(8).max(80),
        registerId: z.number().int().positive().optional(),
      }),
      req.body,
    );
    if (body.splitMode === 'ITEMS' && !body.items?.length) throw badRequest('Seleccione al menos un producto');
    const r = await registerPayment(req.user!, id, body);
    res.status(r.duplicated ? 200 : 201).json({ payment: r.payment, closed: r.closed, duplicated: r.duplicated, account: await getAccount(id) });
  }),
);

paymentsRouter.get(
  '/orders/:id/receipt',
  requirePermission('payments.view', 'orders.view'),
  ah(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const paymentId = req.query.paymentId ? parse(idParam, req.query.paymentId) : undefined;
    res.json(await getReceipt(id, paymentId));
  }),
);

/** Pagos registrados (para consulta). */
paymentsRouter.get(
  '/payments',
  requirePermission('payments.view', 'reports.view'),
  ah(async (req, res) => {
    const q = parse(z.object({ sessionId: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    res.json(
      await prisma.payment.findMany({
        where: q.sessionId ? { cashSessionId: q.sessionId } : {},
        orderBy: { createdAt: 'desc' },
        take: q.limit,
        include: { paymentMethod: true, user: { select: { id: true, name: true } }, order: { select: { id: true, number: true, table: { select: { name: true } } } } },
      }),
    );
  }),
);

