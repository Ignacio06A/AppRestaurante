import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { addDays, dayEnd, dayStart, diffDays, localDate, TZ } from '../../lib/dates';

/**
 * Todos los reportes se calculan EXCLUSIVAMENTE sobre ventas efectivamente
 * registradas: órdenes en estado PAID (cuenta pagada y cerrada), usando los
 * totales congelados al momento del cierre. Órdenes anuladas o pendientes de
 * pago no se consideran (regla de negocio 19).
 *
 * Las columnas DateTime de Prisma se guardan en UTC (timestamp sin zona), por
 * eso se convierten: col AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'.
 */
const local = (col: string) => Prisma.raw(`("${col}" AT TIME ZONE 'UTC' AT TIME ZONE '${TZ}')`);

function monthsBack(date: string, k: number) {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 - k, 1)).toISOString().slice(0, 10);
}

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export interface Range {
  from: string;
  to: string;
}

async function totalsFor(r: Range) {
  const [row] = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT COUNT(*)::int AS orders,
           COALESCE(SUM(total),0) AS total,
           COALESCE(SUM(subtotal),0) AS subtotal,
           COALESCE(SUM("discountAmount"),0) AS discount,
           COALESCE(SUM("serviceAmount"),0) AS service,
           COALESCE(SUM("taxAmount"),0) AS tax,
           COALESCE(SUM(guests),0)::int AS guests
    FROM "Order"
    WHERE status = 'PAID' AND "closedAt" BETWEEN ${dayStart(r.from)} AND ${dayEnd(r.to)}`;
  return {
    orders: n(row.orders),
    total: n(row.total),
    subtotal: n(row.subtotal),
    discount: n(row.discount),
    service: n(row.service),
    tax: n(row.tax),
    guests: n(row.guests),
  };
}

export async function salesReport(r: Range) {
  const start = dayStart(r.from);
  const end = dayEnd(r.to);
  const days = diffDays(r.from, r.to) + 1;

  const prevTo = addDays(r.from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));

  const [totals, previous, byDayRows, byHourRows, byMethodRows, byWaiterRows, topProductRows, byCategoryRows, itemsRow, monthlyRows, cancelledRow] =
    await Promise.all([
      totalsFor(r),
      totalsFor({ from: prevFrom, to: prevTo }),
      prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT to_char(${local('closedAt')}::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS orders, COALESCE(SUM(total),0) AS total
        FROM "Order" WHERE status = 'PAID' AND "closedAt" BETWEEN ${start} AND ${end}
        GROUP BY 1 ORDER BY 1`,
      prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT EXTRACT(HOUR FROM ${local('openedAt')})::int AS hour, COUNT(*)::int AS orders, COALESCE(SUM(total),0) AS total
        FROM "Order" WHERE status = 'PAID' AND "closedAt" BETWEEN ${start} AND ${end}
        GROUP BY 1 ORDER BY 1`,
      prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT pm.name, pm.kind, COUNT(p.id)::int AS count, COALESCE(SUM(p.amount),0) AS total
        FROM "Payment" p
        JOIN "Order" o ON o.id = p."orderId"
        JOIN "PaymentMethod" pm ON pm.id = p."paymentMethodId"
        WHERE p.status = 'COMPLETED' AND o.status = 'PAID' AND o."closedAt" BETWEEN ${start} AND ${end}
        GROUP BY pm.id, pm.name, pm.kind ORDER BY total DESC`,
      prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT u.id, u.name, COUNT(o.id)::int AS orders, COALESCE(SUM(o.total),0) AS total,
               COALESCE(SUM(o.guests),0)::int AS guests, COALESCE(AVG(o.total),0) AS avg_ticket
        FROM "Order" o JOIN "User" u ON u.id = o."waiterId"
        WHERE o.status = 'PAID' AND o."closedAt" BETWEEN ${start} AND ${end}
        GROUP BY u.id, u.name ORDER BY total DESC`,
      prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT oi."productId" AS id, oi."productName" AS name, c.name AS category,
               SUM(oi.quantity)::int AS quantity, COALESCE(SUM(oi.quantity * oi."unitPrice"),0) AS revenue
        FROM "OrderItem" oi
        JOIN "Order" o ON o.id = oi."orderId"
        JOIN "Product" p ON p.id = oi."productId"
        JOIN "Category" c ON c.id = p."categoryId"
        WHERE o.status = 'PAID' AND oi.status <> 'CANCELLED' AND o."closedAt" BETWEEN ${start} AND ${end}
        GROUP BY oi."productId", oi."productName", c.name ORDER BY quantity DESC, revenue DESC LIMIT 15`,
      prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT c.id, c.name, SUM(oi.quantity)::int AS quantity, COALESCE(SUM(oi.quantity * oi."unitPrice"),0) AS revenue
        FROM "OrderItem" oi
        JOIN "Order" o ON o.id = oi."orderId"
        JOIN "Product" p ON p.id = oi."productId"
        JOIN "Category" c ON c.id = p."categoryId"
        WHERE o.status = 'PAID' AND oi.status <> 'CANCELLED' AND o."closedAt" BETWEEN ${start} AND ${end}
        GROUP BY c.id, c.name ORDER BY revenue DESC`,
      prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT COALESCE(SUM(oi.quantity),0)::int AS items
        FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId"
        WHERE o.status = 'PAID' AND oi.status <> 'CANCELLED' AND o."closedAt" BETWEEN ${start} AND ${end}`,
      prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT to_char(date_trunc('month', ${local('closedAt')}), 'YYYY-MM') AS month, COUNT(*)::int AS orders, COALESCE(SUM(total),0) AS total
        FROM "Order"
        WHERE status = 'PAID' AND "closedAt" BETWEEN ${dayStart(monthsBack(r.to, 11))} AND ${end}
        GROUP BY 1 ORDER BY 1`,
      prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT COUNT(*)::int AS orders FROM "Order" WHERE status = 'CANCELLED' AND "closedAt" BETWEEN ${start} AND ${end}`,
    ]);

  // Serie diaria completa (días sin ventas = 0)
  const dayMap = new Map(byDayRows.map((d) => [String(d.day), d]));
  const byDay = Array.from({ length: Math.min(days, 400) }, (_, i) => {
    const day = addDays(r.from, i);
    const row = dayMap.get(day);
    return { day, orders: n(row?.orders), total: n(row?.total) };
  });
  const hourMap = new Map(byHourRows.map((h) => [n(h.hour), h]));
  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: n(hourMap.get(h)?.orders), total: n(hourMap.get(h)?.total) }));

  // Tendencia de 12 meses
  const monthMap = new Map(monthlyRows.map((m) => [String(m.month), m]));
  const monthly: { month: string; orders: number; total: number }[] = [];
  {
    const [y, m] = r.to.split('-').map(Number);
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(y, m - 1 - i, 1));
      const key = d.toISOString().slice(0, 7);
      monthly.push({ month: key, orders: n(monthMap.get(key)?.orders), total: n(monthMap.get(key)?.total) });
    }
  }

  const pctChange = (cur: number, prev: number) => (prev === 0 ? (cur === 0 ? 0 : null) : ((cur - prev) / prev) * 100);
  const items = n(itemsRow[0]?.items);

  return {
    range: { ...r, days },
    previousRange: { from: prevFrom, to: prevTo },
    kpis: {
      totalSales: totals.total,
      netSales: totals.subtotal - totals.discount,
      orders: totals.orders,
      guests: totals.guests,
      itemsSold: items,
      avgTicket: totals.orders ? totals.total / totals.orders : 0,
      avgPerGuest: totals.guests ? totals.total / totals.guests : 0,
      avgDailySales: totals.total / days,
      discounts: totals.discount,
      service: totals.service,
      tax: totals.tax,
      cancelledOrders: n(cancelledRow[0]?.orders),
      previousTotalSales: previous.total,
      previousOrders: previous.orders,
      salesChangePct: pctChange(totals.total, previous.total),
      ordersChangePct: pctChange(totals.orders, previous.orders),
    },
    byDay,
    byHour,
    byPaymentMethod: byMethodRows.map((m) => ({ name: String(m.name), kind: String(m.kind), count: n(m.count), total: n(m.total) })),
    byWaiter: byWaiterRows.map((w) => ({ id: n(w.id), name: String(w.name), orders: n(w.orders), total: n(w.total), guests: n(w.guests), avgTicket: n(w.avg_ticket) })),
    topProducts: topProductRows.map((p) => ({ id: n(p.id), name: String(p.name), category: String(p.category), quantity: n(p.quantity), revenue: n(p.revenue) })),
    byCategory: byCategoryRows.map((c) => ({ id: n(c.id), name: String(c.name), quantity: n(c.quantity), revenue: n(c.revenue) })),
    monthly,
  };
}

/** Indicadores en vivo para el dashboard del administrador. */
export async function dashboard() {
  const today = localDate();
  const weekFrom = addDays(today, -6);
  const [todayTotals, yesterdayTotals, week, openOrders, kds, openCash] = await Promise.all([
    totalsFor({ from: today, to: today }),
    totalsFor({ from: addDays(today, -1), to: addDays(today, -1) }),
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT to_char(${local('closedAt')}::date, 'YYYY-MM-DD') AS day, COALESCE(SUM(total),0) AS total, COUNT(*)::int AS orders
      FROM "Order" WHERE status = 'PAID' AND "closedAt" BETWEEN ${dayStart(weekFrom)} AND ${dayEnd(today)}
      GROUP BY 1 ORDER BY 1`,
    prisma.order.groupBy({ by: ['status'], where: { status: { in: ['OPEN', 'BILL_REQUESTED'] } }, _count: true }),
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT a.code, oi.status, COUNT(*)::int AS count
      FROM "OrderItem" oi JOIN "PreparationArea" a ON a.id = oi."areaId"
      WHERE oi.status IN ('PENDING','IN_PREPARATION','READY')
      GROUP BY a.code, oi.status`,
    prisma.cashSession.findFirst({ where: { status: 'OPEN' }, include: { openedBy: { select: { name: true } }, register: true } }),
  ]);
  const weekMap = new Map(week.map((w) => [String(w.day), w]));
  const tables = await prisma.diningTable.count({ where: { active: true } });
  const occupied = openOrders.reduce((a, o) => a + o._count, 0);
  const kdsStats = { KITCHEN: { PENDING: 0, IN_PREPARATION: 0, READY: 0 }, BAR: { PENDING: 0, IN_PREPARATION: 0, READY: 0 } } as Record<string, Record<string, number>>;
  for (const k of kds) kdsStats[String(k.code)][String(k.status)] = n(k.count);

  const recent = await prisma.order.findMany({
    where: { status: 'PAID' },
    orderBy: { closedAt: 'desc' },
    take: 8,
    include: { table: { select: { name: true } }, waiter: { select: { name: true } } },
  });

  return {
    today: { ...todayTotals, avgTicket: todayTotals.orders ? todayTotals.total / todayTotals.orders : 0 },
    yesterday: yesterdayTotals,
    week: Array.from({ length: 7 }, (_, i) => {
      const day = addDays(weekFrom, i);
      return { day, total: n(weekMap.get(day)?.total), orders: n(weekMap.get(day)?.orders) };
    }),
    tables: { total: tables, occupied, billRequested: openOrders.find((o) => o.status === 'BILL_REQUESTED')?._count ?? 0 },
    kds: kdsStats,
    cash: openCash ? { id: openCash.id, register: openCash.register.name, openedBy: openCash.openedBy.name, openedAt: openCash.openedAt } : null,
    recentSales: recent.map((o) => ({ id: o.id, number: o.number, table: o.table.name, waiter: o.waiter.name, total: Number(o.total), closedAt: o.closedAt })),
  };
}

