import { Prisma } from '@prisma/client';

/** Todos los cálculos se hacen en céntimos enteros para evitar errores de punto flotante. */
export type Cents = number;

export function toCents(v: Prisma.Decimal | number | string | null | undefined): Cents {
  if (v === null || v === undefined) return 0;
  return Math.round(Number(v.toString()) * 100);
}

export function fromCents(c: Cents): number {
  return Math.round(c) / 100;
}

export function toDecimal(c: Cents): Prisma.Decimal {
  return new Prisma.Decimal(fromCents(c).toFixed(2));
}

export function pct(base: Cents, rate: number): Cents {
  return Math.round((base * rate) / 100);
}
