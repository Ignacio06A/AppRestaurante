import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { ah } from '../../lib/asyncHandler';
import { idParam, parse } from '../../lib/validate';
import { requirePermission } from '../../middleware/auth';
import * as svc from './service';
import { dayEnd, dayStart } from '../../lib/dates';

export const ordersRouter = Router();

const itemSchema = z.object({
  productId: z.number().int().positive(),
  quantity: z.number().int().min(1, 'La cantidad mínima es 1').max(99, 'Cantidad máxima 99'),
  notes: z.string().max(300).nullish(),
});
const reasonSchema = z.object({ reason: z.string().trim().min(3, 'Indique un motivo (mín. 3 caracteres)').max(255) });

ordersRouter.get(
  '/',
  requirePermission('orders.view', 'reports.view', 'payments.view'),
  ah(async (req, res) => {
    const q = parse(
      z.object({
        status: z.enum(['OPEN', 'BILL_REQUESTED', 'PAID', 'CANCELLED']).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        tableId: z.coerce.number().int().optional(),
        waiterId: z.coerce.number().int().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      }),
      req.query,
    );
    const where: Prisma.OrderWhereInput = {};
    if (q.status) where.status = q.status;
    if (q.tableId) where.tableId = q.tableId;
    if (q.waiterId) where.waiterId = q.waiterId;
    if (q.from || q.to) {
      where.openedAt = {};
      if (q.from) where.openedAt.gte = dayStart(q.from);
      if (q.to) where.openedAt.lte = dayEnd(q.to);
    }
    const [total, rows] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        orderBy: { openedAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { table: true, waiter: { select: { id: true, name: true } }, _count: { select: { items: true } } },
      }),
    ]);
    res.json({ total, page: q.page, pageSize: q.pageSize, rows });
  }),
);

ordersRouter.post(
  '/',
  requirePermission('orders.create'),
  ah(async (req, res) => {
    const body = parse(
      z.object({
        tableId: z.number().int().positive(),
        guests: z.number().int().min(1).max(50).default(1),
        notes: z.string().max(500).nullish(),
        items: z.array(itemSchema).max(100).optional(),
      }),
      req.body,
    );
    const order = await svc.openOrder(req.user!, body);
    res.status(201).json(await svc.serializeOrder(order));
  }),
);

ordersRouter.get(
  '/:id',
  requirePermission('orders.view', 'payments.view', 'reports.view'),
  ah(async (req, res) => {
    res.json(await svc.serializeOrder(await svc.getOrderDetail(parse(idParam, req.params.id))));
  }),
);

ordersRouter.get(
  '/:id/history',
  requirePermission('orders.view', 'payments.view', 'reports.view'),
  ah(async (req, res) => {
    const id = parse(idParam, req.params.id);
    res.json(
      await prisma.orderHistory.findMany({
        where: { orderId: id },
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { id: true, name: true, role: { select: { name: true } } } } },
      }),
    );
  }),
);

ordersRouter.patch(
  '/:id',
  requirePermission('orders.edit'),
  ah(async (req, res) => {
    const body = parse(z.object({ guests: z.number().int().min(1).max(50).optional(), notes: z.string().max(500).nullish() }), req.body);
    res.json(await svc.serializeOrder(await svc.updateOrderInfo(req.user!, parse(idParam, req.params.id), body)));
  }),
);

ordersRouter.post(
  '/:id/items',
  requirePermission('orders.edit', 'orders.create'),
  ah(async (req, res) => {
    const body = parse(z.object({ items: z.array(itemSchema).min(1).max(100) }), req.body);
    res.status(201).json(await svc.serializeOrder(await svc.sendItems(req.user!, parse(idParam, req.params.id), body.items)));
  }),
);

ordersRouter.patch(
  '/:id/items/:itemId',
  requirePermission('orders.edit'),
  ah(async (req, res) => {
    const body = parse(
      z.object({
        quantity: z.number().int().min(1).max(99).optional(),
        notes: z.string().max(300).nullish(),
        reason: z.string().max(255).nullish(),
      }),
      req.body,
    );
    const o = await svc.updateItem(req.user!, parse(idParam, req.params.id), parse(idParam, req.params.itemId), body);
    res.json(await svc.serializeOrder(o));
  }),
);

ordersRouter.delete(
  '/:id/items/:itemId',
  requirePermission('orders.edit'),
  ah(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body ?? {});
    const o = await svc.cancelItem(req.user!, parse(idParam, req.params.id), parse(idParam, req.params.itemId), reason);
    res.json(await svc.serializeOrder(o));
  }),
);

ordersRouter.post(
  '/:id/deliver',
  requirePermission('orders.edit'),
  ah(async (req, res) => {
    const body = parse(z.object({ itemIds: z.array(z.number().int().positive()).optional() }), req.body ?? {});
    res.json(await svc.serializeOrder(await svc.deliverItems(req.user!, parse(idParam, req.params.id), body.itemIds)));
  }),
);

ordersRouter.post(
  '/:id/request-bill',
  requirePermission('orders.edit', 'payments.create'),
  ah(async (req, res) => {
    res.json(await svc.serializeOrder(await svc.requestBill(req.user!, parse(idParam, req.params.id))));
  }),
);

ordersRouter.post(
  '/:id/reopen',
  requirePermission('orders.edit'),
  ah(async (req, res) => {
    res.json(await svc.serializeOrder(await svc.reopenOrder(req.user!, parse(idParam, req.params.id))));
  }),
);

ordersRouter.post(
  '/:id/discount',
  requirePermission('orders.discount'),
  ah(async (req, res) => {
    const body = parse(
      z.object({ type: z.enum(['AMOUNT', 'PERCENT']).nullable(), value: z.number().min(0).max(999_999_999).default(0), reason: z.string().max(255).nullish() }),
      req.body,
    );
    res.json(await svc.serializeOrder(await svc.applyDiscount(req.user!, parse(idParam, req.params.id), body)));
  }),
);

ordersRouter.post(
  '/:id/cancel',
  requirePermission('orders.cancel'),
  ah(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    res.json(await svc.serializeOrder(await svc.cancelOrder(req.user!, parse(idParam, req.params.id), reason)));
  }),
);

ordersRouter.post(
  '/:id/transfer',
  requirePermission('orders.edit'),
  ah(async (req, res) => {
    const { tableId } = parse(z.object({ tableId: z.number().int().positive() }), req.body);
    res.json(await svc.serializeOrder(await svc.transferOrder(req.user!, parse(idParam, req.params.id), tableId)));
  }),
);
