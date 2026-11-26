import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowRight, ChefHat, Coins, LayoutGrid, Receipt, TrendingUp, Users, Wine } from 'lucide-react';
import { api } from '../../lib/api';
import { compactMoney, money, shortDay, time } from '../../lib/format';
import { Card, CardHeader, ErrorState, Loading, PageHeader, StatCard } from '../../components/ui';

interface Dash {
  today: { orders: number; total: number; guests: number; avgTicket: number };
  yesterday: { orders: number; total: number };
  week: { day: string; total: number; orders: number }[];
  tables: { total: number; occupied: number; billRequested: number };
  kds: Record<'KITCHEN' | 'BAR', { PENDING: number; IN_PREPARATION: number; READY: number }>;
  cash: { id: number; register: string; openedBy: string; openedAt: string } | null;
  recentSales: { id: number; number: number; table: string; waiter: string; total: number; closedAt: string }[];
}

export const CHART = { primary: '#d96a27', secondary: '#3a3530', grid: '#ece8e3', muted: '#a39b92' };

export function ChartTooltip({ active, payload, label, formatter }: { active?: boolean; payload?: { value: number; name: string; color: string }[]; label?: string; formatter?: (l: string) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-ink-200 bg-white px-3 py-2 text-xs shadow-lift">
      <div className="mb-1 font-bold text-ink-900">{formatter ? formatter(String(label)) : label}</div>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2 text-ink-600">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          {p.name}: <span className="font-bold text-ink-900">{p.name.toLowerCase().includes('órdenes') ? p.value : money(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<Dash>('/reports/dashboard'), refetchInterval: 60_000 });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const vsYesterday = d.yesterday.total ? ((d.today.total - d.yesterday.total) / d.yesterday.total) * 100 : null;
  const weekTotal = d.week.reduce((a, w) => a + w.total, 0);

  return (
    <div>
      <PageHeader
        eyebrow="Panel administrativo"
        title="Resumen de hoy"
        subtitle={new Date().toLocaleDateString('es-CR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Costa_Rica' })}
        actions={
          <Link to="/admin/reportes" className="inline-flex h-10 items-center gap-2 rounded-xl bg-ink-900 px-4 text-sm font-semibold text-white hover:bg-ink-800">
            Ver reportes <ArrowRight className="h-4 w-4" />
          </Link>
        }
      />
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard label="Ventas de hoy" value={money(d.today.total)} trend={vsYesterday} hint="vs. ayer" icon={<TrendingUp className="h-5 w-5" />} accent="bg-brand-100 text-brand-700" />
        <StatCard label="Órdenes pagadas" value={d.today.orders} hint={`Ticket promedio ${money(d.today.avgTicket)}`} icon={<Receipt className="h-5 w-5" />} accent="bg-emerald-100 text-emerald-700" />
        <StatCard label="Clientes atendidos" value={d.today.guests} icon={<Users className="h-5 w-5" />} accent="bg-sky-100 text-sky-700" />
        <StatCard
          label="Mesas ocupadas"
          value={`${d.tables.occupied}/${d.tables.total}`}
          hint={d.tables.billRequested ? `${d.tables.billRequested} esperando cobro` : 'Sin cuentas solicitadas'}
          icon={<LayoutGrid className="h-5 w-5" />}
          accent="bg-violet-100 text-violet-700"
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Ventas últimos 7 días" subtitle={`Total ${money(weekTotal)}`} />
          <div className="h-72 p-4">
            <ResponsiveContainer>
              <BarChart data={d.week} margin={{ left: 0, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} stroke={CHART.grid} />
                <XAxis dataKey="day" tickFormatter={shortDay} tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: CHART.muted }} />
                <YAxis tickFormatter={compactMoney} tickLine={false} axisLine={false} width={56} tick={{ fontSize: 12, fill: CHART.muted }} />
                <Tooltip content={<ChartTooltip formatter={shortDay} />} cursor={{ fill: '#f3f0ec' }} />
                <Bar dataKey="total" name="Ventas" fill={CHART.primary} radius={[8, 8, 0, 0]} maxBarSize={48} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Producción en vivo" subtitle="Productos en cola por área" />
            <div className="grid grid-cols-2 gap-3 p-5">
              {(['KITCHEN', 'BAR'] as const).map((a) => (
                <Link key={a} to={a === 'KITCHEN' ? '/cocina' : '/bar'} className="rounded-2xl border border-ink-200 p-4 transition hover:border-ink-300 hover:shadow-card">
                  <div className="flex items-center gap-2 text-sm font-bold">
                    {a === 'KITCHEN' ? <ChefHat className="h-4 w-4 text-amber-600" /> : <Wine className="h-4 w-4 text-sky-600" />}
                    {a === 'KITCHEN' ? 'Cocina' : 'Bar'}
                  </div>
                  <div className="mt-3 space-y-1 text-xs text-ink-600">
                    <div className="flex justify-between"><span>Pendientes</span><b className="text-ink-900">{d.kds[a].PENDING}</b></div>
                    <div className="flex justify-between"><span>Preparando</span><b className="text-amber-700">{d.kds[a].IN_PREPARATION}</b></div>
                    <div className="flex justify-between"><span>Listos sin entregar</span><b className="text-lime-700">{d.kds[a].READY}</b></div>
                  </div>
                </Link>
              ))}
            </div>
          </Card>
          <Card>
            <CardHeader title="Caja" icon={<Coins className="h-4 w-4" />} />
            <div className="p-5 text-sm">
              {d.cash ? (
                <>
                  <div className="font-bold text-emerald-700">● {d.cash.register} abierta</div>
                  <div className="mt-1 text-ink-500">Por {d.cash.openedBy} desde {time(d.cash.openedAt)}</div>
                </>
              ) : (
                <div className="font-semibold text-ink-500">Caja cerrada</div>
              )}
            </div>
          </Card>
        </div>
      </div>

      <Card className="mt-6">
        <CardHeader title="Últimas ventas registradas" />
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>Orden</th>
                <th>Mesa</th>
                <th>Mesero</th>
                <th>Cierre</th>
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {d.recentSales.map((s) => (
                <tr key={s.id}>
                  <td className="font-semibold">#{s.number}</td>
                  <td>{s.table}</td>
                  <td>{s.waiter}</td>
                  <td className="text-ink-500">{new Date(s.closedAt).toLocaleString('es-CR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Costa_Rica' })}</td>
                  <td className="text-right font-bold tabular-nums">{money(s.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
