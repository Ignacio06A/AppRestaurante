import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db';
import { ah } from '../../lib/asyncHandler';
import { idParam, parse } from '../../lib/validate';
import { requirePermission } from '../../middleware/auth';
import { computeTableStatus, computeTotals, OPEN_ORDER_STATUSES } from '../../lib/orderCalc';
import { getSettings } from '../../lib/settings';
import { fromCents } from '../../lib/money';
import { conflict, notFound } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { realtime } from '../../realtime';

export const tablesRouter = Router();

/** Plano de mesas con su estado en tiempo real. */
tablesRouter.get(
  '/',
  requirePermission('tables.view', 'tables.manage', 'payments.view'),
  ah(async (req, res) => {
    const includeInactive = req.query.all === '1';
    const settings = await getSettings();
    const tables = await prisma.diningTable.findMany({
      where: includeInactive ? {} : { active: true },
      orderBy: { number: 'asc' },
      include: {
        orders: {
          where: { status: { in: OPEN_ORDER_STATUSES } },
          include: {
            waiter: { select: { id: true, name: true } },
            items: { select: { id: true, status: true, unitPrice: true, quantity: true, areaId: true } },
            payments: { select: { amount: true, status: true } },
          },
        },
      },
    });
    res.json(
      tables.map((t) => {
        const o = t.orders[0] ?? null;
        const totals = o ? computeTotals(o, settings) : null;
        const counts = o
          ? o.items.reduce<Record<string, number>>((acc, i) => ((acc[i.status] = (acc[i.status] ?? 0) + i.quantity), acc), {})
          : {};
        return {
          id: t.id,
          number: t.number,
          name: t.name,
          zone: t.zone,
          capacity: t.capacity,
          active: t.active,
          status: computeTableStatus(o),
          order: o
            ? {
                id: o.id,
                number: o.number,
                status: o.status,
                guests: o.guests,
                openedAt: o.openedAt,
                waiter: o.waiter,
                itemCounts: counts,
                total: fromCents(totals!.total),
                paid: fromCents(totals!.paid),
                balance: fromCents(totals!.balance),
              }
            : null,
        };
      }),
    );
  }),
);

const tableSchema = z.object({
  number: z.number().int().min(1).max(9999),
  name: z.string().trim().min(1).max(60),
  zone: z.string().trim().max(60).nullish(),
  capacity: z.number().int().min(1).max(100).default(4),
  active: z.boolean().optional(),
});

tablesRouter.post(
  '/',
  requirePermission('tables.manage'),
  ah(async (req, res) => {
    const body = parse(tableSchema, req.body);
    const exists = await prisma.diningTable.findUnique({ where: { number: body.number } });
    if (exists) throw conflict(`Ya existe una mesa con el número ${body.number}`);
    const t = await prisma.diningTable.create({ data: { ...body, zone: body.zone || null } });
    await audit({ userId: req.user!.id, action: 'TABLE_CREATED', entity: 'DiningTable', entityId: t.id, details: body, ip: req.ip });
    realtime.tablesUpdated();
    res.status(201).json(t);
  }),
);

tablesRouter.put(
  '/:id',
  requirePermission('tables.manage'),
  ah(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const body = parse(tableSchema.partial(), req.body);
    const t = await prisma.diningTable.findUnique({ where: { id } });
    if (!t) throw notFound('Mesa no encontrada');
    if (body.number && body.number !== t.number) {
      const dup = await prisma.diningTable.findUnique({ where: { number: body.number } });
      if (dup) throw conflict(`Ya existe una mesa con el número ${body.number}`);
    }
    if (body.active === false) {
      const open = await prisma.order.findFirst({ where: { tableId: id, status: { in: OPEN_ORDER_STATUSES } } });
      if (open) throw conflict('No se puede desactivar una mesa con una orden abierta');
    }
    const updated = await prisma.diningTable.update({ where: { id }, data: { ...body, zone: body.zone === undefined ? undefined : body.zone || null } });
    await audit({ userId: req.user!.id, action: 'TABLE_UPDATED', entity: 'DiningTable', entityId: id, details: body, ip: req.ip });
    realtime.tablesUpdated();
    res.json(updated);
  }),
);

/** Elimina la mesa si nunca tuvo órdenes; si tiene historial, solo se desactiva. */
tablesRouter.delete(
  '/:id',
  requirePermission('tables.manage'),
  ah(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const t = await prisma.diningTable.findUnique({ where: { id }, include: { _count: { select: { orders: true } } } });
    if (!t) throw notFound('Mesa no encontrada');
    const open = await prisma.order.findFirst({ where: { tableId: id, status: { in: OPEN_ORDER_STATUSES } } });
    if (open) throw conflict('No se puede eliminar una mesa con una orden abierta');
    let result: 'deleted' | 'deactivated';
    if (t._count.orders > 0) {
      await prisma.diningTable.update({ where: { id }, data: { active: false } });
      result = 'deactivated';
    } else {
      await prisma.diningTable.delete({ where: { id } });
      result = 'deleted';
    }
    await audit({ userId: req.user!.id, action: result === 'deleted' ? 'TABLE_DELETED' : 'TABLE_DEACTIVATED', entity: 'DiningTable', entityId: id, ip: req.ip });
    realtime.tablesUpdated();
    res.json({ result });
  }),
);
