import { OrderItemStatus, Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { AuthUser } from '../../middleware/auth';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { realtime } from '../../realtime';
import { createNotification } from '../notifications/service';
import { lockOrder } from '../orders/service';

export type AreaCode = 'KITCHEN' | 'BAR';
export const AREA_PERMISSION: Record<AreaCode, string> = { KITCHEN: 'kds.kitchen', BAR: 'kds.bar' };

export function assertArea(user: AuthUser, area: AreaCode) {
  if (!user.permissions.includes(AREA_PERMISSION[area])) throw forbidden(`No tiene acceso al área ${area === 'KITCHEN' ? 'Cocina' : 'Bar'}`);
}

/**
 * Tickets del KDS: cada comanda (batch) de una orden, filtrada SOLO por los
 * productos del área. Cocina nunca ve bebidas del bar y viceversa.
 */
export async function getTickets(area: AreaCode, recentMinutes = 20) {
  const areaRow = await prisma.preparationArea.findUnique({ where: { code: area } });
  if (!areaRow) throw notFound('Área no encontrada');
  const since = new Date(Date.now() - recentMinutes * 60_000);
  const batches = await prisma.orderBatch.findMany({
    where: {
      items: {
        some: {
          areaId: areaRow.id,
          OR: [{ status: { in: ['PENDING', 'IN_PREPARATION'] } }, { readyAt: { gte: since } }, { cancelledAt: { gte: since } }],
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    include: {
      createdBy: { select: { id: true, name: true } },
      order: { select: { id: true, number: true, status: true, guests: true, table: { select: { id: true, name: true, number: true } }, waiter: { select: { id: true, name: true } } } },
      items: { where: { areaId: areaRow.id }, orderBy: { id: 'asc' } },
    },
  });

  const tickets = batches
    .map((b) => {
      // Las cancelaciones parciales (splits) se muestran como alerta en la línea original
      const items = b.items
        .filter((i) => !i.parentItemId)
        .map((i) => ({
          id: i.id,
          productName: i.productName,
          quantity: i.quantity,
          notes: i.notes,
          status: i.status,
          modifiedAt: i.modifiedAt,
          createdAt: i.createdAt,
          startedAt: i.startedAt,
          readyAt: i.readyAt,
          cancelledAt: i.cancelledAt,
          cancelReason: i.cancelReason,
          cancelledQuantity: b.items.filter((s) => s.parentItemId === i.id).reduce((a, s) => a + s.quantity, 0),
        }));
      const live = items.filter((i) => i.status !== 'CANCELLED');
      const pending = live.filter((i) => i.status === 'PENDING' || i.status === 'IN_PREPARATION');
      const done = pending.length === 0;
      return {
        batchId: b.id,
        sequence: b.sequence,
        receivedAt: b.createdAt,
        sentBy: b.createdBy,
        order: b.order,
        items,
        state: done ? 'DONE' : live.some((i) => i.status !== 'PENDING') ? 'IN_PROGRESS' : 'NEW',
        modified: items.some((i) => i.modifiedAt && i.status !== 'READY') || b.items.some((s) => s.parentItemId && s.cancelledAt && s.cancelledAt >= since),
        progress: { ready: live.filter((i) => i.status === 'READY' || i.status === 'DELIVERED').length, total: live.length },
      };
    })
    .filter((t) => t.items.length > 0);
  return tickets;
}

const TRANSITIONS: Record<OrderItemStatus, OrderItemStatus[]> = {
  PENDING: ['IN_PREPARATION', 'READY'],
  IN_PREPARATION: ['READY', 'PENDING'],
  READY: ['IN_PREPARATION'], // deshacer
  DELIVERED: [],
  CANCELLED: [],
};

const STATUS_LABEL: Record<OrderItemStatus, string> = {
  PENDING: 'Pendiente',
  IN_PREPARATION: 'En preparación',
  READY: 'Listo',
  DELIVERED: 'Entregado',
  CANCELLED: 'Cancelado',
};

/** Cambia el estado de uno o varios productos de un área. Notifica al mesero cuando quedan listos. */
export async function setItemsStatus(user: AuthUser, area: AreaCode, itemIds: number[], status: OrderItemStatus) {
  if (!['PENDING', 'IN_PREPARATION', 'READY'].includes(status)) throw badRequest('Estado no permitido desde KDS');
  assertArea(user, area);
  const first = await prisma.orderItem.findFirst({ where: { id: { in: itemIds } }, select: { orderId: true } });
  if (!first) throw notFound('Producto no encontrado');

  const r = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, first.orderId);
    const items = await tx.orderItem.findMany({
      where: { id: { in: itemIds } },
      include: { area: true, order: { include: { table: true } } },
    });
    if (items.length !== itemIds.length) throw notFound('Algún producto no existe');
    const orderIds = new Set(items.map((i) => i.orderId));
    if (orderIds.size > 1) throw badRequest('Los productos deben pertenecer a la misma orden');
    for (const it of items) {
      if (it.area.code !== area) throw forbidden(`"${it.productName}" no pertenece a esta área`);
      if (it.status === status) continue;
      if (!TRANSITIONS[it.status].includes(status)) {
        throw conflict(`"${it.productName}" está ${STATUS_LABEL[it.status].toLowerCase()} y no puede pasar a ${STATUS_LABEL[status].toLowerCase()}`);
      }
    }
    const toChange = items.filter((i) => i.status !== status);
    if (!toChange.length) return { changed: [], order: items[0].order };
    const now = new Date();
    const data: Prisma.OrderItemUpdateManyMutationInput = { status };
    if (status === 'IN_PREPARATION') Object.assign(data, { startedAt: now, readyAt: null });
    if (status === 'READY') Object.assign(data, { readyAt: now });
    if (status === 'PENDING') Object.assign(data, { startedAt: null, readyAt: null });
    await tx.orderItem.updateMany({ where: { id: { in: toChange.map((i) => i.id) } }, data });
    // Si pasó a listo sin pasar por "en preparación", registrar inicio
    if (status === 'READY') {
      await tx.orderItem.updateMany({ where: { id: { in: toChange.map((i) => i.id) }, startedAt: null }, data: { startedAt: now } });
    }
    await tx.orderHistory.create({
      data: {
        orderId: first.orderId,
        userId: user.id,
        action: 'ITEM_STATUS_CHANGED',
        description: `${area === 'KITCHEN' ? 'Cocina' : 'Bar'}: ${toChange.map((i) => `${i.quantity}x ${i.productName}`).join(', ')} → ${STATUS_LABEL[status]}`,
        details: { itemIds: toChange.map((i) => i.id), status },
      },
    });
    const remaining = await tx.orderItem.count({
      where: { orderId: first.orderId, status: { in: ['PENDING', 'IN_PREPARATION'] } },
    });
    return { changed: toChange, order: items[0].order, remaining };
  });

  if (r.changed.length) {
    if (status === 'READY') {
      const areaName = area === 'KITCHEN' ? 'Cocina' : 'Bar';
      const allReady = r.remaining === 0;
      await createNotification(r.order.waiterId, {
        type: allReady ? 'ORDER_READY' : 'ITEMS_READY',
        title: allReady ? `Mesa ${r.order.table.name}: ¡pedido completo listo!` : `Mesa ${r.order.table.name}: listo en ${areaName}`,
        message: r.changed.map((i) => `${i.quantity}x ${i.productName}`).join(', '),
        data: { orderId: r.order.id, tableId: r.order.tableId, area, itemIds: r.changed.map((i) => i.id), allReady },
      });
    }
    realtime.kdsUpdated([area], { orderId: r.order.id });
    realtime.orderUpdated(r.order.id);
    realtime.tablesUpdated({ orderId: r.order.id });
  }
  return { changed: r.changed.length };
}

export async function setBatchStatus(user: AuthUser, area: AreaCode, batchId: number, status: 'IN_PREPARATION' | 'READY') {
  assertArea(user, area);
  const from: OrderItemStatus[] = status === 'READY' ? ['PENDING', 'IN_PREPARATION'] : ['PENDING'];
  const items = await prisma.orderItem.findMany({
    where: { batchId, area: { code: area }, status: { in: from }, parentItemId: null },
    select: { id: true },
  });
  if (!items.length) throw conflict('No hay productos para actualizar en esta comanda');
  return setItemsStatus(user, area, items.map((i) => i.id), status);
}
