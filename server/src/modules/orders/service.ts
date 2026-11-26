import { OrderItemStatus, Prisma } from '@prisma/client';
import { prisma, Tx } from '../../db';
import { AuthUser, hasPermission } from '../../middleware/auth';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { computeTableStatus, computeTotals, OPEN_ORDER_STATUSES, paidQuantity } from '../../lib/orderCalc';
import { getSettings } from '../../lib/settings';
import { fromCents } from '../../lib/money';
import { realtime } from '../../realtime';
import { createNotification } from '../notifications/service';

// ------------------------------------------------------------------
//  Utilidades
// ------------------------------------------------------------------

export const orderDetailInclude = {
  table: true,
  waiter: { select: { id: true, name: true } },
  closedBy: { select: { id: true, name: true } },
  batches: { orderBy: { sequence: 'asc' }, include: { createdBy: { select: { id: true, name: true } } } },
  items: {
    orderBy: { id: 'asc' },
    include: {
      area: true,
      product: { select: { id: true, categoryId: true, imageUrl: true } },
      createdBy: { select: { id: true, name: true } },
      cancelledBy: { select: { id: true, name: true } },
      paymentItems: { include: { payment: { select: { status: true } } } },
    },
  },
  payments: {
    orderBy: { createdAt: 'asc' },
    include: { paymentMethod: true, user: { select: { id: true, name: true } } },
  },
} satisfies Prisma.OrderInclude;

export type OrderDetail = Prisma.OrderGetPayload<{ include: typeof orderDetailInclude }>;

/** Bloqueo pesimista de la fila de la orden dentro de una transacción. */
export async function lockOrder(tx: Tx, orderId: number) {
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
}

async function history(
  tx: Tx,
  data: { orderId: number; userId: number; action: string; description: string; orderItemId?: number; details?: unknown },
) {
  await tx.orderHistory.create({
    data: {
      orderId: data.orderId,
      userId: data.userId,
      action: data.action,
      description: data.description,
      orderItemId: data.orderItemId,
      details: (data.details ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

function assertCanEdit(user: AuthUser, order: { waiterId: number }) {
  if (!hasPermission(user, 'orders.edit')) throw forbidden('No tiene permiso para modificar pedidos');
  if (order.waiterId !== user.id && !hasPermission(user, 'orders.edit_any')) {
    throw forbidden('Solo el mesero asignado puede modificar esta orden');
  }
}

function assertOpen(order: { status: string }) {
  if (!OPEN_ORDER_STATUSES.includes(order.status as never)) throw conflict('La orden ya está cerrada o anulada');
}

export async function serializeOrder(order: OrderDetail) {
  const settings = await getSettings();
  const totals = computeTotals(order, settings);
  return {
    ...order,
    tableStatus: OPEN_ORDER_STATUSES.includes(order.status) ? computeTableStatus(order) : null,
    items: order.items.map((i) => ({
      ...i,
      paymentItems: undefined,
      paidQuantity: paidQuantity(i),
      lineTotal: fromCents(Math.round(Number(i.unitPrice) * 100) * i.quantity),
    })),
    totals: {
      subtotal: fromCents(totals.subtotal),
      discount: fromCents(totals.discount),
      service: fromCents(totals.service),
      tax: fromCents(totals.tax),
      total: fromCents(totals.total),
      paid: fromCents(totals.paid),
      balance: fromCents(totals.balance),
      factor: totals.factor,
      taxRate: Number(settings.taxRate),
      serviceRate: Number(settings.serviceRate),
      pricesIncludeTax: settings.pricesIncludeTax,
    },
  };
}

export async function getOrderDetail(orderId: number, tx: Tx | typeof prisma = prisma) {
  const order = await tx.order.findUnique({ where: { id: orderId }, include: orderDetailInclude });
  if (!order) throw notFound('Orden no encontrada');
  return order;
}

/** Emite eventos de tiempo real tras una mutación de orden. */
function broadcast(orderId: number, areas: Iterable<string> = [], extra: Record<string, unknown> = {}) {
  realtime.orderUpdated(orderId, extra);
  realtime.tablesUpdated({ orderId });
  const a = [...areas];
  if (a.length) realtime.kdsUpdated(a, { orderId });
}

// ------------------------------------------------------------------
//  Abrir orden / enviar productos
// ------------------------------------------------------------------

export interface NewItemInput {
  productId: number;
  quantity: number;
  notes?: string | null;
}

/**
 * Crea una nueva comanda (batch) con los productos indicados. Cada producto
 * hereda automáticamente su área de preparación (COCINA / BAR).
 * Solo se insertan productos NUEVOS: lo enviado antes nunca se reenvía.
 */
async function addBatch(tx: Tx, orderId: number, user: AuthUser, items: NewItemInput[], reason = 'ITEMS_SENT') {
  if (!items.length) throw badRequest('Debe incluir al menos un producto');
  const productIds = [...new Set(items.map((i) => i.productId))];
  const products = await tx.product.findMany({ where: { id: { in: productIds } }, include: { area: true } });
  const byId = new Map(products.map((p) => [p.id, p]));
  for (const it of items) {
    const p = byId.get(it.productId);
    if (!p || !p.active) throw badRequest(`El producto #${it.productId} no existe o fue desactivado`);
    if (!p.available) throw conflict(`"${p.name}" está agotado y no puede solicitarse`);
  }
  const last = await tx.orderBatch.findFirst({ where: { orderId }, orderBy: { sequence: 'desc' } });
  const batch = await tx.orderBatch.create({
    data: { orderId, sequence: (last?.sequence ?? 0) + 1, createdById: user.id },
  });
  const created = [];
  for (const it of items) {
    const p = byId.get(it.productId)!;
    const row = await tx.orderItem.create({
      data: {
        orderId,
        batchId: batch.id,
        productId: p.id,
        areaId: p.areaId,
        productName: p.name,
        unitPrice: p.price,
        quantity: it.quantity,
        notes: it.notes?.trim() || null,
        createdById: user.id,
      },
      include: { area: true },
    });
    created.push(row);
  }
  await history(tx, {
    orderId,
    userId: user.id,
    action: reason,
    description:
      `Comanda #${batch.sequence}: ` + created.map((c) => `${c.quantity}x ${c.productName} (${c.area.name})`).join(', '),
    details: { batchId: batch.id, items: created.map((c) => ({ id: c.id, productName: c.productName, quantity: c.quantity, area: c.area.code, notes: c.notes })) },
  });
  return { batch, created };
}

function notifyNewTickets(orderId: number, batchId: number, created: { area: { code: string } }[], meta: Record<string, unknown>) {
  const areas = new Set(created.map((c) => c.area.code));
  for (const a of areas) realtime.kdsNewTicket(a, { orderId, batchId, ...meta });
  return areas;
}

export async function openOrder(user: AuthUser, input: { tableId: number; guests: number; notes?: string | null; items?: NewItemInput[] }) {
  const result = await prisma.$transaction(async (tx) => {
    const table = await tx.diningTable.findUnique({ where: { id: input.tableId } });
    if (!table || !table.active) throw notFound('Mesa no encontrada');
    const existing = await tx.order.findFirst({ where: { tableId: table.id, status: { in: OPEN_ORDER_STATUSES } } });
    if (existing) throw conflict(`La mesa ${table.name} ya tiene una orden abierta (#${existing.number})`, { orderId: existing.id });
    let order;
    try {
      order = await tx.order.create({
        data: { tableId: table.id, waiterId: user.id, guests: input.guests, notes: input.notes?.trim() || null },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw conflict(`La mesa ${table.name} ya tiene una orden abierta`);
      }
      throw e;
    }
    await history(tx, { orderId: order.id, userId: user.id, action: 'ORDER_OPENED', description: `${table.name} abierta para ${input.guests} persona(s)` });
    let batchInfo: Awaited<ReturnType<typeof addBatch>> | null = null;
    if (input.items?.length) batchInfo = await addBatch(tx, order.id, user, input.items);
    return { order, table, batchInfo };
  });
  let areas: Set<string> = new Set();
  if (result.batchInfo) {
    areas = notifyNewTickets(result.order.id, result.batchInfo.batch.id, result.batchInfo.created, {
      table: result.table.name,
      orderNumber: result.order.number,
    });
  }
  broadcast(result.order.id, areas);
  return getOrderDetail(result.order.id);
}

export async function sendItems(user: AuthUser, orderId: number, items: NewItemInput[]) {
  const r = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { table: true } });
    if (!order) throw notFound('Orden no encontrada');
    assertOpen(order);
    assertCanEdit(user, order);
    // Si la cuenta estaba solicitada y se agregan productos, vuelve a quedar abierta
    if (order.status === 'BILL_REQUESTED') {
      await tx.order.update({ where: { id: orderId }, data: { status: 'OPEN', billRequestedAt: null } });
    }
    const b = await addBatch(tx, orderId, user, items);
    await tx.order.update({ where: { id: orderId }, data: { version: { increment: 1 } } });
    return { order, ...b };
  });
  const areas = notifyNewTickets(orderId, r.batch.id, r.created, { table: r.order.table.name, orderNumber: r.order.number });
  broadcast(orderId, areas);
  return getOrderDetail(orderId);
}

// ------------------------------------------------------------------
//  Edición de productos ya enviados
// ------------------------------------------------------------------

const EDITABLE_NOTES: OrderItemStatus[] = ['PENDING', 'IN_PREPARATION'];

/**
 * Reglas de modificación:
 *  - Notas: solo si el producto está Pendiente o En preparación (se marca "MODIFICADO" en KDS).
 *  - Aumentar cantidad:
 *      · Pendiente → se actualiza la misma línea (aún no se empezó a preparar).
 *      · En preparación / Listo / Entregado → se crea una NUEVA solicitud solo por la diferencia.
 *  - Disminuir cantidad: la línea se reduce y se crea un registro CANCELADO por la diferencia
 *    (se conserva la trazabilidad de la cancelación).
 *  - Nunca se duplica lo ya enviado.
 */
export async function updateItem(
  user: AuthUser,
  orderId: number,
  itemId: number,
  input: { quantity?: number; notes?: string | null; reason?: string | null },
) {
  const r = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { table: true } });
    if (!order) throw notFound('Orden no encontrada');
    assertOpen(order);
    assertCanEdit(user, order);
    const item = await tx.orderItem.findUnique({
      where: { id: itemId },
      include: { area: true, paymentItems: { include: { payment: { select: { status: true } } } } },
    });
    if (!item || item.orderId !== orderId) throw notFound('Producto no encontrado en la orden');
    if (item.status === 'CANCELLED') throw conflict('El producto ya fue cancelado');

    const now = new Date();
    const areas = new Set<string>([item.area.code]);
    const changes: string[] = [];
    let newBatch: Awaited<ReturnType<typeof addBatch>> | null = null;

    // --- Notas
    const notesProvided = input.notes !== undefined;
    const newNotes = notesProvided ? input.notes?.trim() || null : item.notes;
    if (notesProvided && newNotes !== item.notes) {
      if (!EDITABLE_NOTES.includes(item.status)) throw conflict('No se pueden cambiar las observaciones de un producto que ya está listo o entregado');
      await tx.orderItem.update({ where: { id: item.id }, data: { notes: newNotes, modifiedAt: now } });
      await history(tx, {
        orderId,
        userId: user.id,
        orderItemId: item.id,
        action: 'ITEM_NOTES_CHANGED',
        description: `${item.productName}: observación "${item.notes ?? '—'}" → "${newNotes ?? '—'}"`,
        details: { before: item.notes, after: newNotes },
      });
      changes.push('notes');
    }

    // --- Cantidad
    if (input.quantity !== undefined && input.quantity !== item.quantity) {
      const q = input.quantity;
      const paid = paidQuantity(item);
      if (q < paid) throw conflict(`No se puede reducir por debajo de ${paid} unidad(es) ya pagada(s)`);
      if (q > item.quantity) {
        const delta = q - item.quantity;
        if (item.status === 'PENDING') {
          await tx.orderItem.update({ where: { id: item.id }, data: { quantity: q, modifiedAt: now } });
          await history(tx, {
            orderId,
            userId: user.id,
            orderItemId: item.id,
            action: 'ITEM_QTY_CHANGED',
            description: `${item.productName}: cantidad ${item.quantity} → ${q}`,
            details: { before: item.quantity, after: q },
          });
        } else {
          // Ya se está preparando: la diferencia se envía como solicitud nueva
          newBatch = await addBatch(tx, orderId, user, [{ productId: item.productId, quantity: delta, notes: newNotes }], 'ITEMS_ADDED');
        }
        changes.push('qty+');
      } else {
        const delta = item.quantity - q;
        if (q === 0) throw badRequest('Para eliminar el producto utilice la opción Eliminar');
        await tx.orderItem.update({
          where: { id: item.id },
          data: { quantity: q, modifiedAt: EDITABLE_NOTES.includes(item.status) ? now : item.modifiedAt },
        });
        const cancelled = await tx.orderItem.create({
          data: {
            orderId,
            batchId: item.batchId,
            productId: item.productId,
            areaId: item.areaId,
            productName: item.productName,
            unitPrice: item.unitPrice,
            quantity: delta,
            notes: item.notes,
            status: 'CANCELLED',
            parentItemId: item.id,
            createdById: user.id,
            cancelledAt: now,
            cancelledById: user.id,
            cancelReason: input.reason?.trim() || 'Reducción de cantidad',
          },
        });
        await history(tx, {
          orderId,
          userId: user.id,
          orderItemId: item.id,
          action: 'ITEM_QTY_CHANGED',
          description: `${item.productName}: cantidad ${item.quantity} → ${q} (${delta} cancelada(s))`,
          details: { before: item.quantity, after: q, cancelledItemId: cancelled.id, reason: input.reason },
        });
        changes.push('qty-');
      }
    }
    if (!changes.length) throw badRequest('No hay cambios para guardar');
    await tx.order.update({ where: { id: orderId }, data: { version: { increment: 1 } } });
    return { order, areas, newBatch };
  });
  if (r.newBatch) notifyNewTickets(orderId, r.newBatch.batch.id, r.newBatch.created, { table: r.order.table.name, orderNumber: r.order.number });
  broadcast(orderId, r.areas);
  return getOrderDetail(orderId);
}

export async function cancelItem(user: AuthUser, orderId: number, itemId: number, reason: string, opts: { fromKds?: boolean } = {}) {
  const r = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { table: true } });
    if (!order) throw notFound('Orden no encontrada');
    assertOpen(order);
    if (!opts.fromKds) assertCanEdit(user, order);
    const item = await tx.orderItem.findUnique({
      where: { id: itemId },
      include: { area: true, paymentItems: { include: { payment: { select: { status: true } } } } },
    });
    if (!item || item.orderId !== orderId) throw notFound('Producto no encontrado en la orden');
    if (item.status === 'CANCELLED') throw conflict('El producto ya estaba cancelado');
    if (paidQuantity(item) > 0) throw conflict('No se puede cancelar un producto que ya fue pagado');
    await tx.orderItem.update({
      where: { id: item.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: user.id, cancelReason: reason },
    });
    await history(tx, {
      orderId,
      userId: user.id,
      orderItemId: item.id,
      action: 'ITEM_CANCELLED',
      description: `${item.quantity}x ${item.productName} cancelado${opts.fromKds ? ` por ${item.area.name}` : ''}: ${reason}`,
      details: { previousStatus: item.status, reason, fromKds: !!opts.fromKds },
    });
    await tx.order.update({ where: { id: orderId }, data: { version: { increment: 1 } } });
    return { order, item };
  });
  if (opts.fromKds && r.order.waiterId !== user.id) {
    await createNotification(r.order.waiterId, {
      type: 'ITEM_CANCELLED',
      title: `${r.order.table.name}: producto cancelado`,
      message: `${r.item.area.name} canceló ${r.item.quantity}x ${r.item.productName}. Motivo: ${reason}`,
      data: { orderId, itemId, tableId: r.order.tableId },
    });
  }
  broadcast(orderId, [r.item.area.code]);
  return getOrderDetail(orderId);
}

/** El mesero confirma que entregó en la mesa los productos listos. */
export async function deliverItems(user: AuthUser, orderId: number, itemIds?: number[]) {
  await prisma.$transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) throw notFound('Orden no encontrada');
    assertOpen(order);
    assertCanEdit(user, order);
    const where: Prisma.OrderItemWhereInput = { orderId, status: 'READY' };
    if (itemIds?.length) where.id = { in: itemIds };
    const items = await tx.orderItem.findMany({ where });
    if (!items.length) throw conflict('No hay productos listos para entregar');
    await tx.orderItem.updateMany({ where: { id: { in: items.map((i) => i.id) } }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
    await history(tx, {
      orderId,
      userId: user.id,
      action: 'ITEMS_DELIVERED',
      description: 'Entregado: ' + items.map((i) => `${i.quantity}x ${i.productName}`).join(', '),
    });
  });
  broadcast(orderId);
  return getOrderDetail(orderId);
}

export async function updateOrderInfo(user: AuthUser, orderId: number, input: { guests?: number; notes?: string | null }) {
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) throw notFound('Orden no encontrada');
    assertOpen(order);
    assertCanEdit(user, order);
    await tx.order.update({ where: { id: orderId }, data: { guests: input.guests ?? order.guests, notes: input.notes === undefined ? order.notes : input.notes?.trim() || null } });
    await history(tx, { orderId, userId: user.id, action: 'ORDER_UPDATED', description: `Datos de la orden actualizados`, details: input });
  });
  broadcast(orderId);
  return getOrderDetail(orderId);
}

export async function requestBill(user: AuthUser, orderId: number) {
  await prisma.$transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) throw notFound('Orden no encontrada');
    if (order.status !== 'OPEN') throw conflict('La cuenta ya fue solicitada o la orden está cerrada');
    if (!hasPermission(user, 'orders.edit', 'payments.create')) throw forbidden();
    if (!order.items.some((i) => i.status !== 'CANCELLED')) throw conflict('La orden no tiene productos para cobrar');
    await tx.order.update({ where: { id: orderId }, data: { status: 'BILL_REQUESTED', billRequestedAt: new Date() } });
    await history(tx, { orderId, userId: user.id, action: 'BILL_REQUESTED', description: 'Cuenta solicitada (pendiente de pago)' });
  });
  broadcast(orderId);
  realtime.cashUpdated({ orderId });
  return getOrderDetail(orderId);
}

export async function reopenOrder(user: AuthUser, orderId: number) {
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) throw notFound('Orden no encontrada');
    if (order.status !== 'BILL_REQUESTED') throw conflict('Solo se puede reabrir una cuenta solicitada');
    assertCanEdit(user, order);
    await tx.order.update({ where: { id: orderId }, data: { status: 'OPEN', billRequestedAt: null } });
    await history(tx, { orderId, userId: user.id, action: 'ORDER_REOPENED', description: 'Cuenta reabierta para agregar productos' });
  });
  broadcast(orderId);
  return getOrderDetail(orderId);
}

export async function applyDiscount(user: AuthUser, orderId: number, input: { type: 'AMOUNT' | 'PERCENT' | null; value: number; reason?: string | null }) {
  await prisma.$transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { payments: true } });
    if (!order) throw notFound('Orden no encontrada');
    assertOpen(order);
    if (order.payments.some((p) => p.status === 'COMPLETED')) throw conflict('No se puede modificar el descuento después de registrar pagos');
    if (input.type === 'PERCENT' && input.value > 100) throw badRequest('El porcentaje no puede ser mayor a 100');
    await tx.order.update({
      where: { id: orderId },
      data: {
        discountType: input.type,
        discountValue: input.type ? input.value : 0,
        discountReason: input.type ? input.reason?.trim() || null : null,
      },
    });
    await history(tx, {
      orderId,
      userId: user.id,
      action: 'DISCOUNT_APPLIED',
      description: input.type ? `Descuento ${input.type === 'PERCENT' ? input.value + '%' : '₡' + input.value} — ${input.reason ?? ''}` : 'Descuento eliminado',
      details: input,
    });
  });
  broadcast(orderId);
  return getOrderDetail(orderId);
}

export async function cancelOrder(user: AuthUser, orderId: number, reason: string) {
  const r = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { payments: true, items: { include: { area: true } } } });
    if (!order) throw notFound('Orden no encontrada');
    assertOpen(order);
    if (order.payments.some((p) => p.status === 'COMPLETED')) throw conflict('No se puede anular una orden con pagos registrados');
    const now = new Date();
    const active = order.items.filter((i) => i.status !== 'CANCELLED');
    await tx.orderItem.updateMany({
      where: { id: { in: active.map((i) => i.id) } },
      data: { status: 'CANCELLED', cancelledAt: now, cancelledById: user.id, cancelReason: `Orden anulada: ${reason}` },
    });
    await tx.order.update({ where: { id: orderId }, data: { status: 'CANCELLED', closedAt: now, closedById: user.id, cancelReason: reason } });
    await history(tx, { orderId, userId: user.id, action: 'ORDER_CANCELLED', description: `Orden anulada: ${reason}` });
    return active.map((i) => i.area.code);
  });
  broadcast(orderId, r);
  return getOrderDetail(orderId);
}

export async function transferOrder(user: AuthUser, orderId: number, tableId: number) {
  await prisma.$transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { table: true } });
    if (!order) throw notFound('Orden no encontrada');
    assertOpen(order);
    assertCanEdit(user, order);
    const target = await tx.diningTable.findUnique({ where: { id: tableId } });
    if (!target || !target.active) throw notFound('Mesa destino no encontrada');
    const busy = await tx.order.findFirst({ where: { tableId, status: { in: OPEN_ORDER_STATUSES } } });
    if (busy) throw conflict(`La mesa ${target.name} está ocupada`);
    await tx.order.update({ where: { id: orderId }, data: { tableId } });
    await history(tx, { orderId, userId: user.id, action: 'TABLE_TRANSFERRED', description: `Orden trasladada de ${order.table.name} a ${target.name}` });
  });
  const o = await getOrderDetail(orderId);
  const areas = [...new Set(o.items.filter((i) => ['PENDING', 'IN_PREPARATION', 'READY'].includes(i.status)).map((i) => i.area.code))];
  broadcast(orderId, areas);
  return o;
}
