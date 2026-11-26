import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, ChefHat, Clock, Coins, Receipt, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { CashSession, CashSummary, OrderStatus } from '../../lib/types';
import { ORDER_STATUS } from '../../lib/labels';
import { elapsed, money, time } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { Badge, Button, Card, EmptyState, ErrorState, Loading, PageHeader, StatCard } from '../../components/ui';

export interface AccountRow {
  id: number;
  number: number;
  status: OrderStatus;
  table: { id: number; name: string; zone: string | null };
  waiter: { id: number; name: string };
  guests: number;
  openedAt: string;
  billRequestedAt: string | null;
  itemCount: number;
  pendingPrep: number;
  total: number;
  paid: number;
  balance: number;
}

export function useCashCurrent() {
  return useQuery({ queryKey: ['cash', 'current'], queryFn: () => api.get<{ session: CashSession | null; summary?: CashSummary }>('/cash/current') });
}

export default function Accounts() {
  const navigate = useNavigate();
  const now = useNow(30_000);
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['accounts'], queryFn: () => api.get<AccountRow[]>('/cashier/accounts'), refetchInterval: 30_000 });
  const cash = useCashCurrent();
  const rows = q.data ?? [];
  const requested = rows.filter((r) => r.status === 'BILL_REQUESTED');
  const open = rows.filter((r) => r.status === 'OPEN');
  const pendingTotal = rows.reduce((a, r) => a + r.balance, 0);

  return (
    <div>
      <PageHeader eyebrow="Caja" title="Cuentas por cobrar" subtitle="Mesas con cuenta abierta, ordenadas por prioridad. Se actualiza en tiempo real." />

      {!cash.isLoading && !cash.data?.session && (
        <div className="mb-6 flex flex-wrap items-center gap-4 rounded-2xl border border-amber-300 bg-amber-50 p-4">
          <AlertTriangle className="h-6 w-6 shrink-0 text-amber-600" />
          <div className="flex-1">
            <div className="font-bold text-amber-900">La caja está cerrada</div>
            <div className="text-sm text-amber-800">Debe abrir la caja antes de registrar pagos.</div>
          </div>
          {can('cash.operate') && (
            <Link to="/caja/control">
              <Button variant="dark" icon={<Coins className="h-4 w-4" />}>
                Abrir caja
              </Button>
            </Link>
          )}
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Cuenta solicitada" value={requested.length} icon={<Receipt className="h-5 w-5" />} accent="bg-rose-100 text-rose-700" />
        <StatCard label="Mesas abiertas" value={open.length} icon={<Users className="h-5 w-5" />} accent="bg-sky-100 text-sky-700" />
        <StatCard label="Saldo por cobrar" value={money(pendingTotal)} icon={<Coins className="h-5 w-5" />} accent="bg-brand-100 text-brand-700" />
        <StatCard label="Vendido en caja" value={money(cash.data?.summary?.totalSales ?? 0)} hint={cash.data?.session ? `${cash.data.summary?.paymentsCount ?? 0} pagos en esta sesión` : 'Caja cerrada'} icon={<Coins className="h-5 w-5" />} accent="bg-emerald-100 text-emerald-700" />
      </div>

      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !rows.length ? (
        <Card>
          <EmptyState icon={<Receipt className="h-7 w-7" />} title="No hay cuentas pendientes" description="Cuando un mesero abra una mesa, aparecerá aquí." />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((r) => (
            <button
              key={r.id}
              onClick={() => navigate(`/caja/cuenta/${r.id}`)}
              className={clsx('card group flex flex-col p-5 text-left transition hover:-translate-y-0.5 hover:shadow-lift', r.status === 'BILL_REQUESTED' && 'border-rose-300 ring-1 ring-rose-200')}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-xl font-extrabold tracking-tight">{r.table.name}</div>
                  <div className="text-xs text-ink-500">
                    Orden #{r.number} · {r.waiter.name}
                  </div>
                </div>
                <Badge className={ORDER_STATUS[r.status].chip}>{ORDER_STATUS[r.status].label}</Badge>
              </div>
              <div className="mt-4 flex items-center gap-4 text-xs text-ink-500">
                <span className="flex items-center gap-1">
                  <Users className="h-3.5 w-3.5" /> {r.guests}
                </span>
                <span className="flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5" /> {elapsed(r.openedAt, now)}
                </span>
                <span>{r.itemCount} productos</span>
                {r.pendingPrep > 0 && (
                  <span className="flex items-center gap-1 font-semibold text-amber-700">
                    <ChefHat className="h-3.5 w-3.5" /> {r.pendingPrep} en preparación
                  </span>
                )}
              </div>
              <div className="mt-4 flex items-end justify-between border-t border-ink-100 pt-4">
                <div className="text-xs text-ink-500">
                  {r.billRequestedAt ? `Solicitada ${time(r.billRequestedAt)}` : 'Consumiendo'}
                  {r.paid > 0 && <div className="font-semibold text-emerald-700">Pagado {money(r.paid)}</div>}
                </div>
                <div className="text-right">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-ink-400">Saldo</div>
                  <div className="text-2xl font-extrabold tracking-tight">{money(r.balance)}</div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
