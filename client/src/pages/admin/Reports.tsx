import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CalendarDays, FileDown, FileSpreadsheet, Receipt, TrendingUp, Users, UtensilsCrossed } from 'lucide-react';
import { toast } from 'sonner';
import { api, qs } from '../../lib/api';
import { compactMoney, money, monthLabel, shortDay, todayLocal } from '../../lib/format';
import { Button, Card, CardHeader, ErrorState, Input, Loading, PageHeader, StatCard, Tabs } from '../../components/ui';
import { CHART, ChartTooltip } from './Dashboard';

interface Report {
  range: { from: string; to: string; days: number };
  previousRange: { from: string; to: string };
  kpis: {
    totalSales: number; netSales: number; orders: number; guests: number; itemsSold: number; avgTicket: number; avgPerGuest: number; avgDailySales: number;
    discounts: number; service: number; tax: number; cancelledOrders: number; previousTotalSales: number; previousOrders: number; salesChangePct: number | null; ordersChangePct: number | null;
  };
  byDay: { day: string; orders: number; total: number }[];
  byHour: { hour: number; orders: number; total: number }[];
  byPaymentMethod: { name: string; kind: string; count: number; total: number }[];
  byWaiter: { id: number; name: string; orders: number; total: number; guests: number; avgTicket: number }[];
  topProducts: { id: number; name: string; category: string; quantity: number; revenue: number }[];
  byCategory: { id: number; name: string; quantity: number; revenue: number }[];
  monthly: { month: string; orders: number; total: number }[];
}

type Preset = 'DAY' | 'WEEK' | 'MONTH' | 'CUSTOM';
const PIE = ['#d96a27', '#3a3530', '#0ea5e9', '#84cc16', '#a855f7', '#f59e0b'];

function presetRange(p: Preset): { from: string; to: string } {
  const today = todayLocal();
  if (p === 'DAY') return { from: today, to: today };
  if (p === 'WEEK') return { from: todayLocal(-6), to: today };
  if (p === 'MONTH') return { from: `${today.slice(0, 7)}-01`, to: today };
  return { from: todayLocal(-29), to: today };
}

export default function Reports() {
  const [preset, setPreset] = useState<Preset>('WEEK');
  const [range, setRange] = useState(presetRange('WEEK'));
  const q = useQuery({ queryKey: ['report', range], queryFn: () => api.get<Report>(`/reports/sales${qs(range)}`) });
  const [exporting, setExporting] = useState<string | null>(null);

  const choose = (p: Preset) => {
    setPreset(p);
    if (p !== 'CUSTOM') setRange(presetRange(p));
  };

  const exportFile = async (format: 'pdf' | 'xlsx') => {
    setExporting(format);
    try {
      const res = await fetch(`/api/reports/sales/export${qs({ ...range, format })}`, { credentials: 'include' });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? 'No se pudo exportar');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `reporte-ventas-${range.from}_${range.to}.${format}`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setExporting(null);
    }
  };

  const r = q.data;
  const k = r?.kpis;
  const peakHour = r?.byHour.reduce((a, h) => (h.orders > a.orders ? h : a), r.byHour[0]);

  return (
    <div>
      <PageHeader
        eyebrow="Reportes"
        title="Ventas y estadísticas"
        subtitle="Calculado únicamente con cuentas pagadas y cerradas (no incluye órdenes anuladas ni pendientes)."
        actions={
          <>
            <Button variant="secondary" icon={<FileDown className="h-4 w-4" />} loading={exporting === 'pdf'} onClick={() => exportFile('pdf')}>
              PDF
            </Button>
            <Button variant="secondary" icon={<FileSpreadsheet className="h-4 w-4" />} loading={exporting === 'xlsx'} onClick={() => exportFile('xlsx')}>
              Excel
            </Button>
          </>
        }
      />

      <Card className="mb-6 flex flex-wrap items-end gap-4 p-4">
        <Tabs<Preset>
          value={preset}
          onChange={choose}
          options={[
            { value: 'DAY', label: 'Diario' },
            { value: 'WEEK', label: 'Semanal' },
            { value: 'MONTH', label: 'Mensual' },
            { value: 'CUSTOM', label: 'Personalizado' },
          ]}
        />
        <div className="flex flex-wrap items-end gap-3">
          <label>
            <span className="label">Desde</span>
            <Input type="date" value={range.from} max={range.to} onChange={(e) => (setPreset('CUSTOM'), setRange((x) => ({ ...x, from: e.target.value })))} />
          </label>
          <label>
            <span className="label">Hasta</span>
            <Input type="date" value={range.to} min={range.from} onChange={(e) => (setPreset('CUSTOM'), setRange((x) => ({ ...x, to: e.target.value })))} />
          </label>
        </div>
        {r && (
          <div className="ml-auto flex items-center gap-2 text-xs text-ink-500">
            <CalendarDays className="h-4 w-4" /> {r.range.days} día(s) · comparado con {r.previousRange.from} a {r.previousRange.to}
          </div>
        )}
      </Card>

      {q.isLoading ? (
        <Loading />
      ) : q.error || !r || !k ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <StatCard label="Ventas totales" value={money(k.totalSales)} trend={k.salesChangePct} hint={`antes ${money(k.previousTotalSales)}`} icon={<TrendingUp className="h-5 w-5" />} accent="bg-brand-100 text-brand-700" />
            <StatCard label="Órdenes pagadas" value={k.orders} trend={k.ordersChangePct} hint={`${k.cancelledOrders} anuladas`} icon={<Receipt className="h-5 w-5" />} accent="bg-emerald-100 text-emerald-700" />
            <StatCard label="Promedio por mesa" value={money(k.avgTicket)} hint={`${money(k.avgPerGuest)} por cliente`} icon={<UtensilsCrossed className="h-5 w-5" />} accent="bg-sky-100 text-sky-700" />
            <StatCard label="Clientes atendidos" value={k.guests} hint={`${k.itemsSold} productos vendidos`} icon={<Users className="h-5 w-5" />} accent="bg-violet-100 text-violet-700" />
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Mini label="Promedio diario" value={money(k.avgDailySales)} />
            <Mini label="Ventas netas" value={money(k.netSales)} />
            <Mini label="Servicio cobrado" value={money(k.service)} />
            <Mini label="IVA" value={money(k.tax)} />
          </div>

          <Card>
            <CardHeader title={r.range.days > 1 ? 'Ventas por día' : 'Ventas por hora'} subtitle={r.range.days > 1 ? 'Comparación entre días del periodo' : 'Distribución del día'} />
            <div className="h-80 p-4">
              <ResponsiveContainer>
                {r.range.days > 1 ? (
                  <AreaChart data={r.byDay} margin={{ left: 0, right: 8, top: 8 }}>
                    <defs>
                      <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={CHART.primary} stopOpacity={0.3} />
                        <stop offset="100%" stopColor={CHART.primary} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} stroke={CHART.grid} />
                    <XAxis dataKey="day" tickFormatter={shortDay} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: CHART.muted }} minTickGap={16} />
                    <YAxis tickFormatter={compactMoney} tickLine={false} axisLine={false} width={56} tick={{ fontSize: 11, fill: CHART.muted }} />
                    <Tooltip content={<ChartTooltip formatter={shortDay} />} />
                    <Area type="monotone" dataKey="total" name="Ventas" stroke={CHART.primary} strokeWidth={2.5} fill="url(#g1)" />
                  </AreaChart>
                ) : (
                  <BarChart data={r.byHour.filter((h) => h.hour >= 6)} margin={{ left: 0, right: 8, top: 8 }}>
                    <CartesianGrid vertical={false} stroke={CHART.grid} />
                    <XAxis dataKey="hour" tickFormatter={(h) => `${h}h`} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: CHART.muted }} />
                    <YAxis tickFormatter={compactMoney} tickLine={false} axisLine={false} width={56} tick={{ fontSize: 11, fill: CHART.muted }} />
                    <Tooltip content={<ChartTooltip formatter={(h) => `${h}:00`} />} cursor={{ fill: '#f3f0ec' }} />
                    <Bar dataKey="total" name="Ventas" fill={CHART.primary} radius={[6, 6, 0, 0]} />
                  </BarChart>
                )}
              </ResponsiveContainer>
            </div>
          </Card>

          <div className="grid gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader title="Horarios con mayor movimiento" subtitle={peakHour && peakHour.orders ? `Hora pico: ${peakHour.hour}:00 – ${peakHour.hour}:59 (${peakHour.orders} órdenes)` : 'Órdenes según hora de apertura'} />
              <div className="h-64 p-4">
                <ResponsiveContainer>
                  <BarChart data={r.byHour.filter((h) => h.hour >= 6)} margin={{ left: -16, right: 8, top: 8 }}>
                    <CartesianGrid vertical={false} stroke={CHART.grid} />
                    <XAxis dataKey="hour" tickFormatter={(h) => `${h}h`} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: CHART.muted }} />
                    <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: CHART.muted }} />
                    <Tooltip content={<ChartTooltip formatter={(h) => `${h}:00`} />} cursor={{ fill: '#f3f0ec' }} />
                    <Bar dataKey="orders" name="Órdenes" fill={CHART.secondary} radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card>
              <CardHeader title="Ventas por método de pago" />
              <div className="grid items-center gap-4 p-4 sm:grid-cols-[200px_1fr]">
                <div className="h-48">
                  <ResponsiveContainer>
                    <PieChart>
                      <Pie data={r.byPaymentMethod} dataKey="total" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2} stroke="none">
                        {r.byPaymentMethod.map((_, i) => (
                          <Cell key={i} fill={PIE[i % PIE.length]} />
                        ))}
                      </Pie>
                      <Tooltip content={<ChartTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <ul className="space-y-2 text-sm">
                  {r.byPaymentMethod.map((m, i) => (
                    <li key={m.name} className="flex items-center gap-3">
                      <span className="h-3 w-3 rounded-sm" style={{ background: PIE[i % PIE.length] }} />
                      <span className="flex-1 font-semibold">{m.name}</span>
                      <span className="text-xs text-ink-500">{m.count} pagos</span>
                      <span className="w-28 text-right font-bold tabular-nums">{money(m.total)}</span>
                      <span className="w-12 text-right text-xs text-ink-500">{k.totalSales ? ((m.total / k.totalSales) * 100).toFixed(0) : 0}%</span>
                    </li>
                  ))}
                  {!r.byPaymentMethod.length && <li className="text-ink-500">Sin pagos en el periodo</li>}
                </ul>
              </div>
            </Card>
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader title="Productos más vendidos" />
              <RankTable rows={r.topProducts.map((p) => ({ key: p.id, name: p.name, sub: p.category, qty: p.quantity, value: p.revenue }))} />
            </Card>
            <Card>
              <CardHeader title="Categorías con mayores ingresos" />
              <RankTable rows={r.byCategory.map((c) => ({ key: c.id, name: c.name, qty: c.quantity, value: c.revenue }))} />
            </Card>
          </div>

          <Card>
            <CardHeader title="Rendimiento de meseros" subtitle="Ventas por mesero en el periodo" />
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Mesero</th>
                    <th className="text-right">Órdenes</th>
                    <th className="text-right">Clientes</th>
                    <th className="text-right">Ticket promedio</th>
                    <th className="text-right">Ventas</th>
                    <th className="w-1/4">Participación</th>
                  </tr>
                </thead>
                <tbody>
                  {r.byWaiter.map((w) => (
                    <tr key={w.id}>
                      <td className="font-semibold">{w.name}</td>
                      <td className="text-right tabular-nums">{w.orders}</td>
                      <td className="text-right tabular-nums">{w.guests}</td>
                      <td className="text-right tabular-nums">{money(w.avgTicket)}</td>
                      <td className="text-right font-bold tabular-nums">{money(w.total)}</td>
                      <td>
                        <div className="h-2 rounded-full bg-ink-100">
                          <div className="h-2 rounded-full bg-brand-500" style={{ width: `${k.totalSales ? (w.total / k.totalSales) * 100 : 0}%` }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!r.byWaiter.length && (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-ink-500">
                        Sin ventas en el periodo
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <CardHeader title="Tendencia mensual" subtitle="Comparación con los 11 meses anteriores" />
            <div className="h-72 p-4">
              <ResponsiveContainer>
                <BarChart data={r.monthly} margin={{ left: 0, right: 8, top: 8 }}>
                  <CartesianGrid vertical={false} stroke={CHART.grid} />
                  <XAxis dataKey="month" tickFormatter={monthLabel} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: CHART.muted }} />
                  <YAxis tickFormatter={compactMoney} tickLine={false} axisLine={false} width={56} tick={{ fontSize: 11, fill: CHART.muted }} />
                  <Tooltip content={<ChartTooltip formatter={monthLabel} />} cursor={{ fill: '#f3f0ec' }} />
                  <Bar dataKey="total" name="Ventas" radius={[6, 6, 0, 0]}>
                    {r.monthly.map((m, i) => (
                      <Cell key={m.month} fill={i === r.monthly.length - 1 ? CHART.primary : '#d6cfc7'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-ink-200/70 bg-white px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">{label}</div>
      <div className="mt-0.5 font-extrabold tabular-nums">{value}</div>
    </div>
  );
}

function RankTable({ rows }: { rows: { key: number; name: string; sub?: string; qty: number; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="px-5 py-6 text-sm text-ink-500">Sin datos en el periodo.</p>;
  return (
    <ul className="divide-y divide-ink-100">
      {rows.slice(0, 10).map((r, i) => (
        <li key={r.key} className="flex items-center gap-4 px-5 py-3">
          <span className="w-5 text-right text-sm font-extrabold text-ink-400">{i + 1}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-semibold">{r.name}</span>
              <span className="shrink-0 text-sm font-bold tabular-nums">{money(r.value)}</span>
            </div>
            <div className="mt-1.5 flex items-center gap-3">
              <div className="h-1.5 flex-1 rounded-full bg-ink-100">
                <div className="h-1.5 rounded-full bg-brand-500" style={{ width: `${(r.value / max) * 100}%` }} />
              </div>
              <span className="w-24 shrink-0 text-right text-xs text-ink-500">
                {r.qty} uds{r.sub ? ` · ${r.sub}` : ''}
              </span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
