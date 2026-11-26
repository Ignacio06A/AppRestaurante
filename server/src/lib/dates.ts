/**
 * Costa Rica usa UTC-6 todo el año (sin horario de verano).
 * Los rangos de fechas de reportes se interpretan en hora local del restaurante.
 */
export const TZ = 'America/Costa_Rica';
export const TZ_OFFSET = '-06:00';

export function dayStart(date: string) {
  return new Date(`${date}T00:00:00.000${TZ_OFFSET}`);
}
export function dayEnd(date: string) {
  return new Date(`${date}T23:59:59.999${TZ_OFFSET}`);
}
/** Fecha local (YYYY-MM-DD) de un instante. */
export function localDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function addDays(date: string, n: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function diffDays(from: string, to: string) {
  return Math.round((new Date(`${to}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86_400_000);
}
