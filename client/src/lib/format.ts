const crcFmt = new Intl.NumberFormat('es-CR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export function money(v: number | string | null | undefined, symbol = '₡') {
  const n = Number(v ?? 0);
  return `${n < 0 ? '-' : ''}${symbol}${crcFmt.format(Math.abs(n))}`;
}

export function compactMoney(v: number) {
  if (Math.abs(v) >= 1_000_000) return `₡${(v / 1_000_000).toFixed(1).replace('.0', '')}M`;
  if (Math.abs(v) >= 1_000) return `₡${Math.round(v / 1000)}k`;
  return `₡${Math.round(v)}`;
}

const TZ = 'America/Costa_Rica';

export function time(d: string | Date | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleTimeString('es-CR', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
}

export function dateTime(d: string | Date | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleString('es-CR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: TZ });
}

export function date(d: string | Date | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('es-CR', { day: '2-digit', month: 'short', year: 'numeric', timeZone: TZ });
}

export function minutesSince(d: string | Date, now = Date.now()) {
  return Math.max(0, Math.floor((now - new Date(d).getTime()) / 60000));
}

export function elapsed(d: string | Date, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - new Date(d).getTime()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** Fecha local Costa Rica YYYY-MM-DD */
export function todayLocal(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function shortDay(iso: string) {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('es-CR', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function monthLabel(ym: string) {
  const d = new Date(`${ym}-15T12:00:00Z`);
  return d.toLocaleDateString('es-CR', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}
