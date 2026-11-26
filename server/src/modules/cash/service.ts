import { CashMovementType, Prisma } from '@prisma/client';
import { prisma, Tx } from '../../db';
import { AuthUser, hasPermission } from '../../middleware/auth';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { fromCents, toCents, toDecimal } from '../../lib/money';
import { audit } from '../../lib/audit';
import { realtime } from '../../realtime';

export async function lockSession(tx: Tx, sessionId: number) {
  await tx.$queryRaw`SELECT id FROM "CashSession" WHERE id = ${sessionId} FOR UPDATE`;
}

export async function defaultRegisterId(tx: Tx | typeof prisma = prisma) {
  const r = await tx.cashRegister.findFirst({ where: { active: true }, orderBy: { id: 'asc' } });
  if (!r) throw notFound('No hay cajas registradoras configuradas');
  return r.id;
}

export async function getOpenSession(registerId?: number, tx: Tx | typeof prisma = prisma) {
  const rid = registerId ?? (await defaultRegisterId(tx));
  return tx.cashSession.findFirst({
    where: { registerId: rid, status: 'OPEN' },
    include: { register: true, openedBy: { select: { id: true, name: true } } },
  });
}

/** Resumen de arqueo calculado a partir de pagos y movimientos registrados. */
export async function computeSessionSummary(sessionId: number, tx: Tx | typeof prisma = prisma) {
  const session = await tx.cashSession.findUnique({ where: { id: sessionId } });
  if (!session) throw notFound('Sesión de caja no encontrada');
  const payments = await tx.payment.findMany({
    where: { cashSessionId: sessionId, status: 'COMPLETED' },
    include: { paymentMethod: true },
  });
  const movements = await tx.cashMovement.findMany({ where: { sessionId, type: { not: 'SALE' } } });

  const byKind = { CASH: 0, CARD: 0, TRANSFER: 0, OTHER: 0 };
  const byMethod = new Map<string, { name: string; kind: string; total: number; count: number }>();
  for (const p of payments) {
    const c = toCents(p.amount);
    byKind[p.paymentMethod.kind] += c;
    const m = byMethod.get(p.paymentMethod.code) ?? { name: p.paymentMethod.name, kind: p.paymentMethod.kind, total: 0, count: 0 };
    m.total += c;
    m.count += 1;
    byMethod.set(p.paymentMethod.code, m);
  }
  const sum = (t: CashMovementType) => movements.filter((m) => m.type === t).reduce((a, m) => a + toCents(m.amount), 0);
  const income = sum('INCOME');
  const withdrawals = -sum('WITHDRAWAL'); // guardados en negativo
  const expenses = -sum('EXPENSE');
  const adjustments = sum('ADJUSTMENT');
  const opening = toCents(session.openingAmount);
  const totalSales = byKind.CASH + byKind.CARD + byKind.TRANSFER + byKind.OTHER;
  const expectedCash = opening + byKind.CASH + income - withdrawals - expenses + adjustments;

  return {
    cents: { opening, totalSales, cash: byKind.CASH, card: byKind.CARD, transfer: byKind.TRANSFER, other: byKind.OTHER, income, withdrawals, expenses, adjustments, expectedCash },
    summary: {
      openingAmount: fromCents(opening),
      totalSales: fromCents(totalSales),
      cashSales: fromCents(byKind.CASH),
      cardSales: fromCents(byKind.CARD),
      transferSales: fromCents(byKind.TRANSFER),
      otherSales: fromCents(byKind.OTHER),
      totalIncome: fromCents(income),
      totalWithdrawals: fromCents(withdrawals),
      totalExpenses: fromCents(expenses),
      totalAdjustments: fromCents(adjustments),
      expectedCash: fromCents(expectedCash),
      paymentsCount: payments.length,
      byMethod: [...byMethod.entries()].map(([code, m]) => ({ code, ...m, total: fromCents(m.total) })),
    },
  };
}

export async function openSession(user: AuthUser, input: { registerId?: number; openingAmount: number; notes?: string | null }) {
  const session = await prisma.$transaction(async (tx) => {
    const registerId = input.registerId ?? (await defaultRegisterId(tx));
    const reg = await tx.cashRegister.findUnique({ where: { id: registerId } });
    if (!reg || !reg.active) throw notFound('Caja registradora no encontrada');
    const open = await tx.cashSession.findFirst({ where: { registerId, status: 'OPEN' } });
    if (open) throw conflict(`La ${reg.name} ya está abierta`);
    try {
      const s = await tx.cashSession.create({
        data: { registerId, openedById: user.id, openingAmount: toDecimal(toCents(input.openingAmount)), openingNotes: input.notes?.trim() || null },
      });
      await audit({ userId: user.id, action: 'CASH_OPENED', entity: 'CashSession', entityId: s.id, details: { registerId, openingAmount: input.openingAmount } }, tx);
      return s;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict(`La ${reg.name} ya está abierta`);
      throw e;
    }
  });
  realtime.cashUpdated({ sessionId: session.id });
  return session;
}

export async function addMovement(
  user: AuthUser,
  sessionId: number,
  input: { type: 'INCOME' | 'WITHDRAWAL' | 'EXPENSE' | 'ADJUSTMENT'; amount: number; description: string },
) {
  if (input.type === 'ADJUSTMENT' && !hasPermission(user, 'cash.adjust')) throw forbidden('Los ajustes de caja requieren autorización (permiso cash.adjust)');
  if (input.type !== 'ADJUSTMENT' && input.amount <= 0) throw badRequest('El monto debe ser mayor a cero');
  if (input.type === 'ADJUSTMENT' && input.amount === 0) throw badRequest('El ajuste no puede ser cero');
  const mv = await prisma.$transaction(async (tx) => {
    await lockSession(tx, sessionId);
    const s = await tx.cashSession.findUnique({ where: { id: sessionId } });
    if (!s) throw notFound('Sesión de caja no encontrada');
    if (s.status !== 'OPEN') throw conflict('La caja está cerrada');
    let cents = toCents(input.amount);
    if (input.type === 'WITHDRAWAL' || input.type === 'EXPENSE') {
      const { cents: sum } = await computeSessionSummary(sessionId, tx);
      if (cents > sum.expectedCash) throw conflict(`Fondos insuficientes en caja. Efectivo disponible: ₡${fromCents(sum.expectedCash).toLocaleString('es-CR')}`);
      cents = -cents;
    }
    const m = await tx.cashMovement.create({
      data: {
        sessionId,
        type: input.type,
        amount: toDecimal(cents),
        description: input.description.trim(),
        userId: user.id,
        authorizedById: input.type === 'ADJUSTMENT' ? user.id : null,
      },
      include: { user: { select: { id: true, name: true } } },
    });
    await audit({ userId: user.id, action: `CASH_${input.type}`, entity: 'CashMovement', entityId: m.id, details: { sessionId, amount: fromCents(cents), description: input.description } }, tx);
    return m;
  });
  realtime.cashUpdated({ sessionId });
  return mv;
}

/** Cierre de caja: transaccional, congela el arqueo y calcula diferencia. */
export async function closeSession(user: AuthUser, sessionId: number, input: { countedCash: number; notes?: string | null }) {
  const closing = await prisma.$transaction(async (tx) => {
    await lockSession(tx, sessionId);
    const s = await tx.cashSession.findUnique({ where: { id: sessionId } });
    if (!s) throw notFound('Sesión de caja no encontrada');
    if (s.status !== 'OPEN') throw conflict('La caja ya fue cerrada');
    const { cents } = await computeSessionSummary(sessionId, tx);
    const counted = toCents(input.countedCash);
    const c = await tx.cashClosing.create({
      data: {
        sessionId,
        closedById: user.id,
        openingAmount: toDecimal(cents.opening),
        totalSales: toDecimal(cents.totalSales),
        cashSales: toDecimal(cents.cash),
        cardSales: toDecimal(cents.card),
        transferSales: toDecimal(cents.transfer),
        otherSales: toDecimal(cents.other),
        totalIncome: toDecimal(cents.income),
        totalWithdrawals: toDecimal(cents.withdrawals),
        totalExpenses: toDecimal(cents.expenses),
        totalAdjustments: toDecimal(cents.adjustments),
        expectedCash: toDecimal(cents.expectedCash),
        countedCash: toDecimal(counted),
        difference: toDecimal(counted - cents.expectedCash),
        notes: input.notes?.trim() || null,
      },
    });
    await tx.cashSession.update({ where: { id: sessionId }, data: { status: 'CLOSED' } });
    await audit({ userId: user.id, action: 'CASH_CLOSED', entity: 'CashSession', entityId: sessionId, details: { expected: fromCents(cents.expectedCash), counted: fromCents(counted), difference: fromCents(counted - cents.expectedCash) } }, tx);
    return c;
  });
  realtime.cashUpdated({ sessionId });
  return closing;
}
