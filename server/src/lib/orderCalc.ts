import { OrderItemStatus, OrderStatus, Prisma, RestaurantSettings } from '@prisma/client';
import { Cents, pct, toCents } from './money';

type ItemLike = {
  id: number;
  quantity: number;
  unitPrice: Prisma.Decimal | number;
  status: OrderItemStatus;
  paymentItems?: { quantity: number; payment?: { status: string } | null }[];
};
type PaymentLike = { amount: Prisma.Decimal | number; status: string };
type OrderLike = {
  discountType: string | null;
  discountValue: Prisma.Decimal | number;
  items: ItemLike[];
  payments?: PaymentLike[];
};

export const BILLABLE = (s: OrderItemStatus) => s !== 'CANCELLED';
export const ACTIVE_KDS_STATUSES: OrderItemStatus[] = ['PENDING', 'IN_PREPARATION'];

export interface Totals {
  subtotal: Cents;
  discount: Cents;
  service: Cents;
  tax: Cents;
  total: Cents;
  paid: Cents;
  balance: Cents;
  /** factor para prorratear impuestos/servicio/descuento a una línea */
  factor: number;
}

export function computeTotals(order: OrderLike, settings: Pick<RestaurantSettings, 'taxRate' | 'serviceRate' | 'pricesIncludeTax'>): Totals {
  const subtotal = order.items
    .filter((i) => BILLABLE(i.status))
    .reduce((acc, i) => acc + toCents(i.unitPrice) * i.quantity, 0);

  let discount = 0;
  const dv = Number(order.discountValue?.toString() ?? 0);
  if (order.discountType === 'PERCENT') discount = pct(subtotal, Math.min(100, dv));
  else if (order.discountType === 'AMOUNT') discount = Math.min(toCents(dv), subtotal);

  const base = subtotal - discount;
  const serviceRate = Number(settings.serviceRate.toString());
  const taxRate = Number(settings.taxRate.toString());
  const service = pct(base, serviceRate);
  let tax: Cents;
  let total: Cents;
  if (settings.pricesIncludeTax) {
    tax = base - Math.round(base / (1 + taxRate / 100));
    total = base + service;
  } else {
    tax = pct(base, taxRate);
    total = base + service + tax;
  }
  const paid = (order.payments ?? []).filter((p) => p.status === 'COMPLETED').reduce((a, p) => a + toCents(p.amount), 0);
  return {
    subtotal,
    discount,
    service,
    tax,
    total,
    paid,
    balance: Math.max(0, total - paid),
    factor: subtotal > 0 ? total / subtotal : 1,
  };
}

export function paidQuantity(item: ItemLike): number {
  return (item.paymentItems ?? [])
    .filter((pi) => !pi.payment || pi.payment.status === 'COMPLETED')
    .reduce((a, pi) => a + pi.quantity, 0);
}

export type TableStatus =
  | 'AVAILABLE'
  | 'OCCUPIED'
  | 'WAITING_ORDER'
  | 'IN_PREPARATION'
  | 'PARTIALLY_READY'
  | 'READY'
  | 'PENDING_PAYMENT';

/**
 * Estado visual de la mesa, derivado del estado real de su orden abierta:
 *  - AVAILABLE        sin orden abierta
 *  - WAITING_ORDER    mesa abierta pero aún no se ha enviado ningún producto
 *  - IN_PREPARATION   hay productos pendientes / en preparación y ninguno listo
 *  - PARTIALLY_READY  algunos productos listos y otros todavía pendientes
 *  - READY            todos los productos por entregar están listos
 *  - OCCUPIED         todo fue entregado (clientes consumiendo)
 *  - PENDING_PAYMENT  se solicitó la cuenta o tiene pagos parciales
 */
export function computeTableStatus(
  order: { status: OrderStatus; items: { status: OrderItemStatus }[]; payments?: PaymentLike[] } | null | undefined,
): TableStatus {
  if (!order) return 'AVAILABLE';
  const hasPayments = (order.payments ?? []).some((p) => p.status === 'COMPLETED');
  if (order.status === 'BILL_REQUESTED' || hasPayments) return 'PENDING_PAYMENT';
  const live = order.items.filter((i) => i.status !== 'CANCELLED');
  if (live.length === 0) return 'WAITING_ORDER';
  const notDelivered = live.filter((i) => i.status !== 'DELIVERED');
  if (notDelivered.length === 0) return 'OCCUPIED';
  const ready = notDelivered.filter((i) => i.status === 'READY').length;
  if (ready === 0) return 'IN_PREPARATION';
  if (ready === notDelivered.length) return 'READY';
  return 'PARTIALLY_READY';
}

export const OPEN_ORDER_STATUSES: OrderStatus[] = ['OPEN', 'BILL_REQUESTED'];
