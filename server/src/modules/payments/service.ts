import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { AuthUser } from '../../middleware/auth';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { computeTotals, OPEN_ORDER_STATUSES, paidQuantity } from '../../lib/orderCalc';
import { fromCents, toCents, toDecimal } from '../../lib/money';
import { getSettings } from '../../lib/settings';
import { audit } from '../../lib/audit';
import { realtime } from '../../realtime';
import { getOpenSession } from '../cash/service';
import { getOrderDetail, lockOrder, orderDetailInclude, serializeOrder } from '../orders/service';

export interface PaymentInput {
  paymentMethodId: number;
  amount?: number;
  receivedAmount?: number | null;
  reference?: string | null;
  payerLabel?: string | null;
  splitMode: 'FULL' | 'EQUAL' | 'ITEMS' | 'CUSTOM';
  items?: { orderItemId: number; quantity: number }[];
  idempotencyKey: string;
  registerId?: number;
}

/** Monto proporcional de una línea (incluye servicio, impuesto y descuento prorrateados). */
function shareFor(unitPriceCents: number, quantity: number, factor: number) {
  return Math.round(unitPriceCents * quantity * factor);
}

/** Cuenta detallada de la orden para caja. */
export async function getAccount(orderId: number) {
  const order = await getOrderDetail(orderId);
  const s = await serializeOrder(order);
  const settings = await getSettings();
  const totals = computeTotals(order, settings);
  return {
    ...s,
    items: s.items
      .filter((i) => i.status !== 'CANCELLED')
      .map((i) => {
        const unitShare = fromCents(shareFor(toCents(i.unitPrice), 1, totals.factor));
        return { ...i, unpaidQuantity: i.quantity - i.paidQuantity, unitShare };
      }),
    cancelledItems: s.items.filter((i) => i.status === 'CANCELLED'),
  };
}

/** Divide el saldo pendiente en N partes iguales (la última absorbe el redondeo). */
export function equalSplit(balanceCents: number, parts: number) {
  const base = Math.floor(balanceCents / parts / 100) * 100; // partes redondeadas a colones enteros
  const arr = Array.from({ length: parts }, () => base);
  arr[parts - 1] = balanceCents - base * (parts - 1);
  return arr.map(fromCents);
}

/**
 * Registra un pago (total, parcial, dividido o por productos).
 *  - Transaccional con bloqueo de fila de la orden (evita pagos concurrentes).
 *  - Idempotente mediante idempotencyKey (evita ventas duplicadas por doble clic / reintentos).
 *  - Requiere caja abierta. Genera el movimiento de caja tipo VENTA.
 *  - Cuando el saldo llega a cero: congela totales, cierra la orden y libera la mesa.
 */
export async function registerPayment(user: AuthUser, orderId: number, input: PaymentInput) {
  const existing = await prisma.payment.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) {
    if (existing.orderId !== orderId) throw conflict('Clave de idempotencia ya utilizada en otra orden');
    return { payment: existing, duplicated: true, closed: false };
  }

  const settings = await getSettings();
  let result;
  try {
    result = await prisma.$transaction(
      async (tx) => {
        await lockOrder(tx, orderId);
        const order = await tx.order.findUnique({ where: { id: orderId }, include: orderDetailInclude });
        if (!order) throw notFound('Orden no encontrada');
        if (!OPEN_ORDER_STATUSES.includes(order.status)) throw conflict('La cuenta ya fue pagada o está anulada');

        const session = await getOpenSession(input.registerId, tx);
        if (!session) throw conflict('Debe abrir la caja antes de registrar pagos');

        const method = await tx.paymentMethod.findUnique({ where: { id: input.paymentMethodId } });
        if (!method || !method.active) throw badRequest('Método de pago inválido');

        const totals = computeTotals(order, settings);
        if (totals.total <= 0) throw conflict('La cuenta no tiene monto por cobrar');
        if (totals.balance <= 0) throw conflict('La cuenta no tiene saldo pendiente');

        // --- Determinar monto
        let amount: number;
        const allocations: { orderItemId: number; quantity: number; amount: number }[] = [];
        if (input.splitMode === 'ITEMS') {
          if (!input.items?.length) throw badRequest('Seleccione los productos a pagar');
          const byId = new Map(order.items.map((i) => [i.id, i]));
          amount = 0;
          for (const sel of input.items) {
            const it = byId.get(sel.orderItemId);
            if (!it || it.status === 'CANCELLED') throw badRequest(`Producto #${sel.orderItemId} inválido`);
            const unpaid = it.quantity - paidQuantity(it);
            if (sel.quantity > unpaid) throw conflict(`"${it.productName}": solo quedan ${unpaid} unidad(es) por pagar`);
            const a = shareFor(toCents(it.unitPrice), sel.quantity, totals.factor);
            allocations.push({ orderItemId: it.id, quantity: sel.quantity, amount: a });
            amount += a;
          }
          // Si con esto se pagan todos los productos, se liquida el saldo exacto (evita residuos de redondeo)
          const remainingUnits = order.items
            .filter((i) => i.status !== 'CANCELLED')
            .reduce((acc, i) => acc + (i.quantity - paidQuantity(i)), 0);
          const selectedUnits = input.items.reduce((a, i) => a + i.quantity, 0);
          if (selectedUnits === remainingUnits) amount = totals.balance;
          amount = Math.min(amount, totals.balance);
        } else if (input.splitMode === 'FULL') {
          amount = totals.balance;
        } else {
          if (input.amount === undefined) throw badRequest('Indique el monto a pagar');
          amount = toCents(input.amount);
        }
        if (amount <= 0) throw badRequest('El monto debe ser mayor a cero');
        if (amount > totals.balance) {
          throw conflict(`El monto excede el saldo pendiente (₡${fromCents(totals.balance).toLocaleString('es-CR')})`);
        }

        // --- Efectivo recibido / vuelto
        let received: number | null = null;
        let change = 0;
        if (method.kind === 'CASH') {
          received = input.receivedAmount != null ? toCents(input.receivedAmount) : amount;
          if (received < amount) throw badRequest('El efectivo recibido es menor al monto a pagar');
          change = received - amount;
        }

        const payment = await tx.payment.create({
          data: {
            orderId,
            paymentMethodId: method.id,
            cashSessionId: session.id,
            amount: toDecimal(amount),
            receivedAmount: received !== null ? toDecimal(received) : null,
            changeAmount: toDecimal(change),
            reference: input.reference?.trim() || null,
            payerLabel: input.payerLabel?.trim() || null,
            splitMode: input.splitMode,
            idempotencyKey: input.idempotencyKey,
            userId: user.id,
            items: allocations.length ? { create: allocations.map((a) => ({ orderItemId: a.orderItemId, quantity: a.quantity, amount: toDecimal(a.amount) })) } : undefined,
          },
          include: { paymentMethod: true },
        });

        await tx.cashMovement.create({
          data: {
            sessionId: session.id,
            type: 'SALE',
            amount: toDecimal(amount),
            paymentMethodId: method.id,
            paymentId: payment.id,
            description: `Venta orden #${order.number} — ${order.table.name}${input.payerLabel ? ` (${input.payerLabel})` : ''}`,
            userId: user.id,
          },
        });

        await tx.orderHistory.create({
          data: {
            orderId,
            userId: user.id,
            action: 'PAYMENT_REGISTERED',
            description: `Pago ${method.name} ₡${fromCents(amount).toLocaleString('es-CR')}${input.payerLabel ? ` — ${input.payerLabel}` : ''}`,
            details: { paymentId: payment.id, amount: fromCents(amount), method: method.code, splitMode: input.splitMode },
          },
        });

        const newBalance = totals.balance - amount;
        let closed = false;
        if (newBalance <= 0) {
          await tx.order.update({
            where: { id: orderId },
            data: {
              status: 'PAID',
              closedAt: new Date(),
              closedById: user.id,
              subtotal: toDecimal(totals.subtotal),
              discountAmount: toDecimal(totals.discount),
              serviceAmount: toDecimal(totals.service),
              taxAmount: toDecimal(totals.tax),
              total: toDecimal(totals.total),
            },
          });
          await tx.orderHistory.create({
            data: { orderId, userId: user.id, action: 'ORDER_CLOSED', description: `Cuenta pagada y cerrada. Total ₡${fromCents(totals.total).toLocaleString('es-CR')}. Mesa liberada.` },
          });
          closed = true;
        } else if (order.status === 'OPEN') {
          await tx.order.update({ where: { id: orderId }, data: { status: 'BILL_REQUESTED', billRequestedAt: order.billRequestedAt ?? new Date() } });
        }
        await audit(
          { userId: user.id, action: 'PAYMENT_REGISTERED', entity: 'Payment', entityId: payment.id, details: { orderId, amount: fromCents(amount), method: method.code, closed } },
          tx,
        );
        return { payment, closed, sessionId: session.id };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 },
    );
  } catch (e) {
    // Carrera con la misma clave de idempotencia: devolver el pago ya registrado
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const dup = await prisma.payment.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (dup) return { payment: dup, duplicated: true, closed: false };
    }
    throw e;
  }

  realtime.orderUpdated(orderId, { paid: true, closed: result.closed });
  realtime.tablesUpdated({ orderId });
  realtime.cashUpdated({ sessionId: result.sessionId });
  return { ...result, duplicated: false };
}

/** Datos para el comprobante imprimible. */
export async function getReceipt(orderId: number, paymentId?: number) {
  const account = await getAccount(orderId);
  const settings = await getSettings();
  const payment = paymentId ? account.payments.find((p) => p.id === paymentId) : undefined;
  if (paymentId && !payment) throw notFound('Pago no encontrado en esta orden');
  return { settings, order: account, payment: payment ?? null, generatedAt: new Date() };
}
