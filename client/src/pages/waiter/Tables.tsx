import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { toast } from 'sonner';
import { Armchair, Clock, Users } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { TableInfo, TableStatus, Order } from '../../lib/types';
import { TABLE_STATUS } from '../../lib/labels';
import { elapsed, money } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import { useNow } from '../../lib/hooks';
import { Button, EmptyState, ErrorState, Loading, Modal, PageHeader, Stepper, Tabs } from '../../components/ui';

type Filter = 'ALL' | 'MINE' | 'FREE' | 'ACTIVE';

export default function TablesPage() {
  const { user, can } = useAuth();
  const navigate = useNavigate();
  const now = useNow(15_000);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [opening, setOpening] = useState<TableInfo | null>(null);
  const [guests, setGuests] = useState(2);
  const q = useQuery({ queryKey: ['tables'], queryFn: () => api.get<TableInfo[]>('/tables'), refetchInterval: 30_000 });

  const open = useMutation({
    mutationFn: (t: TableInfo) => api.post<Order>('/orders', { tableId: t.id, guests }),
    onSuccess: (o) => {
      toast.success(`${o.table.name} abierta`);
      navigate(`/mesas/orden/${o.id}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const tables = q.data ?? [];
  const counts = useMemo(() => {
    const c: Partial<Record<TableStatus, number>> = {};
    tables.forEach((t) => (c[t.status] = (c[t.status] ?? 0) + 1));
    return c;
  }, [tables]);

  const filtered = tables.filter((t) => {
    if (filter === 'MINE') return t.order?.waiter.id === user?.id;
    if (filter === 'FREE') return t.status === 'AVAILABLE';
    if (filter === 'ACTIVE') return t.status !== 'AVAILABLE';
    return true;
  });
  const zones = [...new Set(filtered.map((t) => t.zone ?? 'General'))];
  const readyMine = tables.filter((t) => t.order?.waiter.id === user?.id && (t.status === 'READY' || t.status === 'PARTIALLY_READY')).length;

  const onClick = (t: TableInfo) => {
    if (t.order) return navigate(`/mesas/orden/${t.order.id}`);
    if (!can('orders.create')) return toast.info('Mesa disponible');
    setGuests(Math.min(t.capacity, 2));
    setOpening(t);
  };

  return (
    <div>
      <PageHeader
        eyebrow="Salón"
        title="Mesas"
        subtitle={`${counts.AVAILABLE ?? 0} disponibles · ${tables.length - (counts.AVAILABLE ?? 0)} con cuenta abierta${readyMine ? ` · ${readyMine} con productos listos para entregar` : ''}`}
        actions={
          <Tabs<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'ALL', label: 'Todas' },
              { value: 'MINE', label: 'Mis mesas' },
              { value: 'ACTIVE', label: 'Activas' },
              { value: 'FREE', label: 'Libres' },
            ]}
          />
        }
      />

      <div className="mb-6 flex flex-wrap gap-2">
        {(Object.keys(TABLE_STATUS) as TableStatus[]).map((s) => (
          <span key={s} className={clsx('inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset', TABLE_STATUS[s].chip)}>
            <span className={clsx('h-2 w-2 rounded-full', TABLE_STATUS[s].dot)} />
            {TABLE_STATUS[s].label}
            <span className="tabular-nums opacity-70">{counts[s] ?? 0}</span>
          </span>
        ))}
      </div>

      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !filtered.length ? (
        <div className="card">
          <EmptyState icon={<Armchair className="h-7 w-7" />} title="No hay mesas en este filtro" />
        </div>
      ) : (
        <div className="space-y-8">
          {zones.map((zone) => (
            <section key={zone}>
              <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.16em] text-ink-500">{zone}</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
                {filtered
                  .filter((t) => (t.zone ?? 'General') === zone)
                  .map((t) => {
                    const st = TABLE_STATUS[t.status];
                    const mine = t.order?.waiter.id === user?.id;
                    const pending = (t.order?.itemCounts.PENDING ?? 0) + (t.order?.itemCounts.IN_PREPARATION ?? 0);
                    const ready = t.order?.itemCounts.READY ?? 0;
                    return (
                      <button
                        key={t.id}
                        onClick={() => onClick(t)}
                        className={clsx(
                          'group relative flex min-h-[148px] flex-col rounded-2xl border-2 p-4 text-left shadow-card transition hover:-translate-y-0.5 hover:shadow-lift',
                          st.card,
                          t.status === 'READY' && 'animate-pulse-ring',
                        )}
                      >
                        <div className="flex items-start justify-between">
                          <div>
                            <div className="text-[11px] font-bold uppercase tracking-wider text-ink-500">#{t.number}</div>
                            <div className="text-lg font-extrabold leading-tight text-ink-900">{t.name}</div>
                          </div>
                          <span className={clsx('mt-1 h-3 w-3 rounded-full ring-4 ring-white', st.dot)} />
                        </div>
                        <div className="mt-1 text-xs font-semibold text-ink-600">{st.label}</div>
                        <div className="flex-1" />
                        {t.order ? (
                          <div className="mt-3 space-y-1.5 text-xs text-ink-600">
                            <div className="flex items-center justify-between">
                              <span className="flex items-center gap-1">
                                <Users className="h-3.5 w-3.5" /> {t.order.guests}
                              </span>
                              <span className="flex items-center gap-1 tabular-nums">
                                <Clock className="h-3.5 w-3.5" /> {elapsed(t.order.openedAt, now)}
                              </span>
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              <span className={clsx('truncate font-semibold', mine ? 'text-brand-700' : 'text-ink-500')}>{mine ? 'Mi mesa' : t.order.waiter.name.split(' ')[0]}</span>
                              <span className="font-extrabold tabular-nums text-ink-900">{money(t.order.total)}</span>
                            </div>
                            {(pending > 0 || ready > 0) && (
                              <div className="flex gap-1.5 pt-0.5">
                                {pending > 0 && <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">{pending} en cola</span>}
                                {ready > 0 && <span className="rounded-md bg-lime-200 px-1.5 py-0.5 text-[10px] font-bold text-lime-900">{ready} listos</span>}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="mt-3 flex items-center gap-1 text-xs text-ink-500">
                            <Users className="h-3.5 w-3.5" /> {t.capacity} personas
                          </div>
                        )}
                      </button>
                    );
                  })}
              </div>
            </section>
          ))}
        </div>
      )}

      <Modal
        open={!!opening}
        onClose={() => setOpening(null)}
        title={`Abrir ${opening?.name ?? ''}`}
        subtitle={opening?.zone ?? undefined}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpening(null)}>
              Cancelar
            </Button>
            <Button loading={open.isPending} onClick={() => opening && open.mutate(opening)}>
              Abrir mesa y tomar pedido
            </Button>
          </>
        }
      >
        <div className="flex items-center justify-between">
          <div>
            <div className="font-semibold">Número de personas</div>
            <div className="text-sm text-ink-500">Capacidad: {opening?.capacity}</div>
          </div>
          <Stepper value={guests} onChange={setGuests} min={1} max={50} />
        </div>
      </Modal>
    </div>
  );
}
