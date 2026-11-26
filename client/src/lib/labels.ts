import { ItemStatus, OrderStatus, TableStatus } from './types';

export const TABLE_STATUS: Record<TableStatus, { label: string; dot: string; chip: string; card: string; ring: string }> = {
  AVAILABLE: { label: 'Disponible', dot: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-700 ring-emerald-200', card: 'border-emerald-200 bg-white', ring: 'ring-emerald-500' },
  WAITING_ORDER: { label: 'Esperando pedido', dot: 'bg-sky-500', chip: 'bg-sky-50 text-sky-700 ring-sky-200', card: 'border-sky-300 bg-sky-50/60', ring: 'ring-sky-500' },
  IN_PREPARATION: { label: 'En preparación', dot: 'bg-amber-500', chip: 'bg-amber-50 text-amber-800 ring-amber-200', card: 'border-amber-300 bg-amber-50/60', ring: 'ring-amber-500' },
  PARTIALLY_READY: { label: 'Parcialmente listo', dot: 'bg-violet-500', chip: 'bg-violet-50 text-violet-700 ring-violet-200', card: 'border-violet-300 bg-violet-50/60', ring: 'ring-violet-500' },
  READY: { label: 'Pedido listo', dot: 'bg-lime-500', chip: 'bg-lime-50 text-lime-800 ring-lime-300', card: 'border-lime-400 bg-lime-50', ring: 'ring-lime-500' },
  OCCUPIED: { label: 'Ocupada', dot: 'bg-indigo-500', chip: 'bg-indigo-50 text-indigo-700 ring-indigo-200', card: 'border-indigo-300 bg-indigo-50/50', ring: 'ring-indigo-500' },
  PENDING_PAYMENT: { label: 'Pendiente de pago', dot: 'bg-rose-500', chip: 'bg-rose-50 text-rose-700 ring-rose-200', card: 'border-rose-300 bg-rose-50/60', ring: 'ring-rose-500' },
};

export const ITEM_STATUS: Record<ItemStatus, { label: string; chip: string }> = {
  PENDING: { label: 'Pendiente', chip: 'bg-ink-100 text-ink-700 ring-ink-200' },
  IN_PREPARATION: { label: 'En preparación', chip: 'bg-amber-50 text-amber-800 ring-amber-200' },
  READY: { label: 'Listo', chip: 'bg-lime-50 text-lime-800 ring-lime-300' },
  DELIVERED: { label: 'Entregado', chip: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  CANCELLED: { label: 'Cancelado', chip: 'bg-rose-50 text-rose-700 ring-rose-200' },
};

export const ORDER_STATUS: Record<OrderStatus, { label: string; chip: string }> = {
  OPEN: { label: 'Abierta', chip: 'bg-sky-50 text-sky-700 ring-sky-200' },
  BILL_REQUESTED: { label: 'Cuenta solicitada', chip: 'bg-rose-50 text-rose-700 ring-rose-200' },
  PAID: { label: 'Pagada', chip: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  CANCELLED: { label: 'Anulada', chip: 'bg-ink-100 text-ink-600 ring-ink-200' },
};

export const MOVEMENT_TYPE: Record<string, { label: string; chip: string }> = {
  SALE: { label: 'Venta', chip: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  INCOME: { label: 'Entrada', chip: 'bg-sky-50 text-sky-700 ring-sky-200' },
  WITHDRAWAL: { label: 'Retiro', chip: 'bg-amber-50 text-amber-800 ring-amber-200' },
  EXPENSE: { label: 'Gasto', chip: 'bg-rose-50 text-rose-700 ring-rose-200' },
  ADJUSTMENT: { label: 'Ajuste', chip: 'bg-violet-50 text-violet-700 ring-violet-200' },
};

export const PM_KIND: Record<string, string> = { CASH: 'Efectivo', CARD: 'Tarjeta', TRANSFER: 'Transferencia', OTHER: 'Otro' };
