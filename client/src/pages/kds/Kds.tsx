import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { toast } from 'sonner';
import { Check, ChefHat, Clock, Flame, LogOut, PackageX, Play, RotateCcw, Undo2, Volume2, VolumeX, Wine, X, Search } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { Category, KdsItem, KdsTicket } from '../../lib/types';
import { elapsed, minutesSince, time } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import { useNow, useSettings } from '../../lib/hooks';
import { ConnectionPill, useMuted } from '../../components/AppShell';
import { Button, Loading, Modal, Toggle, useConfirm } from '../../components/ui';

type View = 'ACTIVE' | 'DONE';

/**
 * Kitchen Display System. La misma pantalla sirve para COCINA y BAR, pero cada una
 * solo recibe los productos de su área (el backend filtra por área de preparación).
 */
export default function KdsPage({ area }: { area: 'KITCHEN' | 'BAR' }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user, logout, can } = useAuth();
  const confirm = useConfirm();
  const now = useNow(1000);
  const { data: settings } = useSettings();
  const [muted, toggleMuted] = useMuted();
  const [view, setView] = useState<View>('ACTIVE');
  const [stockOpen, setStockOpen] = useState(false);
  const label = area === 'KITCHEN' ? 'Cocina' : 'Bar';
  const warn = settings?.kdsWarningMinutes ?? 10;
  const crit = settings?.kdsCriticalMinutes ?? 20;

  const q = useQuery({ queryKey: ['kds', area], queryFn: () => api.get<KdsTicket[]>(`/kds/${area}/tickets`), refetchInterval: 30_000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['kds', area] });
  const onErr = (e: unknown) => toast.error(errorMessage(e));

  const itemStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) => api.patch(`/kds/${area}/items/${id}`, { status }),
    onSuccess: refresh,
    onError: onErr,
  });
  const batchStatus = useMutation({
    mutationFn: ({ batchId, status }: { batchId: number; status: string }) => api.post(`/kds/${area}/batches/${batchId}/status`, { status }),
    onSuccess: (_d, v) => {
      if (v.status === 'READY') toast.success('Comanda lista — mesero notificado');
      refresh();
    },
    onError: onErr,
  });
  const cancelItem = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => api.post(`/kds/${area}/items/${id}/cancel`, { reason }),
    onSuccess: () => (toast.success('Producto cancelado — mesero notificado'), refresh()),
    onError: onErr,
  });

  const tickets = q.data ?? [];
  const active = tickets.filter((t) => t.state !== 'DONE');
  const done = tickets.filter((t) => t.state === 'DONE').reverse();
  const shown = view === 'ACTIVE' ? active : done;
  const totals = useMemo(() => {
    let pending = 0;
    let prep = 0;
    active.forEach((t) => t.items.forEach((i) => (i.status === 'PENDING' ? (pending += i.quantity) : i.status === 'IN_PREPARATION' ? (prep += i.quantity) : null)));
    return { pending, prep };
  }, [active]);

  // Resumen agregado de productos pendientes (útil para preparar en lote)
  const summary = useMemo(() => {
    const m = new Map<string, number>();
    active.forEach((t) => t.items.filter((i) => i.status === 'PENDING' || i.status === 'IN_PREPARATION').forEach((i) => m.set(i.productName, (m.get(i.productName) ?? 0) + i.quantity)));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [active]);

  return (
    <div className="min-h-screen bg-ink-950 text-ink-100">
      <header className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-white/5 bg-ink-950/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className={clsx('flex h-11 w-11 items-center justify-center rounded-2xl', area === 'KITCHEN' ? 'bg-amber-500/15 text-amber-400' : 'bg-sky-500/15 text-sky-400')}>
          {area === 'KITCHEN' ? <ChefHat className="h-6 w-6" /> : <Wine className="h-6 w-6" />}
        </div>
        <div>
          <h1 className="text-xl font-extrabold tracking-tight text-white">{label}</h1>
          <div className="text-xs text-ink-400">
            {user?.name} · {new Date(now).toLocaleTimeString('es-CR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Costa_Rica' })}
          </div>
        </div>
        <div className="ml-2 hidden gap-2 md:flex">
          <Counter label="Pendientes" value={totals.pending} className="bg-white/5 text-white" />
          <Counter label="En preparación" value={totals.prep} className="bg-amber-500/15 text-amber-300" />
          <Counter label="Comandas" value={active.length} className="bg-white/5 text-white" />
        </div>
        <div className="flex-1" />
        <div className="flex rounded-xl bg-white/5 p-1">
          {(['ACTIVE', 'DONE'] as View[]).map((v) => (
            <button key={v} onClick={() => setView(v)} className={clsx('rounded-lg px-4 py-2 text-sm font-bold transition', view === v ? 'bg-white text-ink-900' : 'text-ink-400 hover:text-white')}>
              {v === 'ACTIVE' ? `En curso (${active.length})` : `Listos (${done.length})`}
            </button>
          ))}
        </div>
        <ConnectionPill dark />
        {can('menu.availability', 'menu.manage') && (
          <button onClick={() => setStockOpen(true)} className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold text-ink-300 hover:bg-white/10 hover:text-white" title="Productos agotados">
            <PackageX className="h-5 w-5" /> <span className="hidden lg:inline">Agotados</span>
          </button>
        )}
        <button onClick={toggleMuted} className="rounded-xl p-2.5 text-ink-400 hover:bg-white/10 hover:text-white" title={muted ? 'Activar sonido' : 'Silenciar'}>
          {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
        </button>
        {user?.role === 'ADMIN' && (
          <button onClick={() => navigate('/admin')} className="rounded-xl px-3 py-2 text-sm font-semibold text-ink-300 hover:bg-white/10">
            Panel
          </button>
        )}
        <button
          onClick={async () => {
            await logout();
            navigate('/login');
          }}
          className="rounded-xl p-2.5 text-ink-400 hover:bg-white/10 hover:text-white"
          title="Cerrar sesión"
        >
          <LogOut className="h-5 w-5" />
        </button>
      </header>

      <div className="flex">
        <main className="min-w-0 flex-1 p-4 sm:p-6">
          {q.isLoading ? (
            <Loading />
          ) : shown.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-32 text-center">
              <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-3xl bg-white/5 text-ink-500">{area === 'KITCHEN' ? <ChefHat className="h-10 w-10" /> : <Wine className="h-10 w-10" />}</div>
              <div className="text-xl font-bold text-white">{view === 'ACTIVE' ? 'Sin comandas pendientes' : 'Sin comandas recientes'}</div>
              <div className="mt-1 text-sm text-ink-400">{view === 'ACTIVE' ? 'Las nuevas comandas aparecerán aquí automáticamente.' : 'Aquí se muestran las comandas completadas en los últimos 20 minutos.'}</div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {shown.map((t, idx) => (
                <TicketCard
                  key={t.batchId}
                  ticket={t}
                  position={view === 'ACTIVE' ? idx + 1 : undefined}
                  now={now}
                  warn={warn}
                  crit={crit}
                  busy={itemStatus.isPending || batchStatus.isPending}
                  onItem={(item, status) => itemStatus.mutate({ id: item.id, status })}
                  onBatch={(status) => batchStatus.mutate({ batchId: t.batchId, status })}
                  onCancel={async (item) => {
                    const reason = await confirm({
                      title: `Cancelar ${item.quantity}x ${item.productName}`,
                      message: `Se notificará al mesero ${t.order.waiter.name} (${t.order.table.name}).`,
                      danger: true,
                      confirmText: 'Cancelar producto',
                      prompt: { label: 'Motivo', placeholder: 'Ej. se terminó el ingrediente' },
                    });
                    if (typeof reason === 'string') cancelItem.mutate({ id: item.id, reason });
                  }}
                />
              ))}
            </div>
          )}
        </main>
        {view === 'ACTIVE' && summary.length > 0 && (
          <aside className="sticky top-[69px] hidden h-[calc(100vh-69px)] w-64 shrink-0 overflow-y-auto border-l border-white/5 p-5 xl:block">
            <h2 className="mb-3 text-[11px] font-bold uppercase tracking-[0.16em] text-ink-500">Total por preparar</h2>
            <ul className="space-y-2">
              {summary.map(([name, qty]) => (
                <li key={name} className="flex items-center justify-between gap-2 rounded-xl bg-white/5 px-3 py-2">
                  <span className="truncate text-sm font-semibold text-ink-200">{name}</span>
                  <span className="text-lg font-extrabold tabular-nums text-white">{qty}</span>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>
      <StockModal open={stockOpen} onClose={() => setStockOpen(false)} area={area} />
    </div>
  );
}

function Counter({ label, value, className }: { label: string; value: number; className: string }) {
  return (
    <div className={clsx('rounded-xl px-3 py-1.5 text-center', className)}>
      <div className="text-lg font-extrabold leading-none tabular-nums">{value}</div>
      <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wider opacity-70">{label}</div>
    </div>
  );
}

function TicketCard({
  ticket: t, position, now, warn, crit, busy, onItem, onBatch, onCancel,
}: {
  ticket: KdsTicket;
  position?: number;
  now: number;
  warn: number;
  crit: number;
  busy: boolean;
  onItem: (i: KdsItem, status: string) => void;
  onBatch: (status: string) => void;
  onCancel: (i: KdsItem) => void;
}) {
  const mins = minutesSince(t.receivedAt, now);
  const done = t.state === 'DONE';
  const level = done ? 'done' : mins >= crit ? 'crit' : mins >= warn ? 'warn' : 'ok';
  const header = {
    ok: 'bg-ink-800 text-white',
    warn: 'bg-amber-500 text-amber-950',
    crit: 'bg-rose-600 text-white',
    done: 'bg-emerald-700 text-white',
  }[level];
  const anyPending = t.items.some((i) => i.status === 'PENDING');
  const live = t.items.filter((i) => i.status !== 'CANCELLED');

  return (
    <div className={clsx('flex animate-slide-in flex-col overflow-hidden rounded-2xl bg-ink-900 ring-1 ring-white/10', level === 'crit' && 'ring-2 ring-rose-500', t.modified && !done && 'ring-2 ring-amber-400')}>
      <div className={clsx('flex items-center justify-between gap-3 px-4 py-3', header)}>
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black tracking-tight">{t.order.table.name}</span>
            {position && <span className="rounded-md bg-black/20 px-1.5 text-xs font-bold">#{position}</span>}
          </div>
          <div className="text-xs font-semibold opacity-80">
            Orden #{t.order.number} · Comanda {t.sequence} · {t.order.waiter.name}
          </div>
        </div>
        <div className="text-right">
          <div className="flex items-center justify-end gap-1 text-xl font-black tabular-nums">
            {level === 'crit' ? <Flame className="h-5 w-5" /> : <Clock className="h-4 w-4 opacity-70" />}
            {elapsed(t.receivedAt, now)}
          </div>
          <div className="text-[11px] font-semibold opacity-75">Recibido {time(t.receivedAt)}</div>
        </div>
      </div>
      {t.modified && !done && <div className="bg-amber-400 px-4 py-1 text-center text-xs font-black uppercase tracking-widest text-amber-950">⚠ Orden modificada</div>}

      <ul className="flex-1 divide-y divide-white/5">
        {t.items.map((i) => {
          const cancelled = i.status === 'CANCELLED';
          const ready = i.status === 'READY' || i.status === 'DELIVERED';
          const prep = i.status === 'IN_PREPARATION';
          return (
            <li key={i.id} className={clsx('flex items-start gap-3 px-4 py-3', ready && 'bg-emerald-500/10', prep && 'bg-amber-500/10')}>
              <div className={clsx('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xl font-black', cancelled ? 'bg-white/5 text-ink-500' : ready ? 'bg-emerald-500 text-white' : prep ? 'bg-amber-400 text-amber-950' : 'bg-white text-ink-900')}>
                {i.quantity}
              </div>
              <div className="min-w-0 flex-1 pt-0.5">
                <div className={clsx('text-[17px] font-bold leading-tight', cancelled ? 'text-ink-500 line-through' : ready ? 'text-emerald-300' : 'text-white')}>{i.productName}</div>
                {i.notes && <div className="mt-1 rounded-lg bg-brand-500/20 px-2 py-1 text-sm font-bold text-brand-200">📝 {i.notes}</div>}
                {i.modifiedAt && !cancelled && !ready && <div className="mt-1 text-[11px] font-black uppercase tracking-wider text-amber-400">Modificado {time(i.modifiedAt)}</div>}
                {i.cancelledQuantity > 0 && !cancelled && <div className="mt-1 text-xs font-bold text-rose-400">−{i.cancelledQuantity} cancelado(s)</div>}
                {cancelled && <div className="mt-1 text-xs font-bold uppercase text-rose-400">Cancelado · {i.cancelReason}</div>}
                <div className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                  {ready ? `Listo ${time(i.readyAt)}` : prep ? `En preparación desde ${time(i.startedAt)}` : cancelled ? '' : 'Pendiente'}
                </div>
              </div>
              {!cancelled && !done && (
                <div className="flex shrink-0 flex-col gap-1.5">
                  {i.status === 'PENDING' && (
                    <KdsBtn className="bg-amber-400 text-amber-950 hover:bg-amber-300" disabled={busy} onClick={() => onItem(i, 'IN_PREPARATION')} title="Empezar">
                      <Play className="h-5 w-5" />
                    </KdsBtn>
                  )}
                  {(i.status === 'PENDING' || i.status === 'IN_PREPARATION') && (
                    <KdsBtn className="bg-emerald-500 text-white hover:bg-emerald-400" disabled={busy} onClick={() => onItem(i, 'READY')} title="Marcar listo">
                      <Check className="h-5 w-5" />
                    </KdsBtn>
                  )}
                  {i.status === 'IN_PREPARATION' && (
                    <KdsBtn className="bg-white/10 text-ink-300 hover:bg-white/20" disabled={busy} onClick={() => onItem(i, 'PENDING')} title="Volver a pendiente">
                      <Undo2 className="h-4 w-4" />
                    </KdsBtn>
                  )}
                  {i.status === 'READY' && (
                    <KdsBtn className="bg-white/10 text-ink-300 hover:bg-white/20" disabled={busy} onClick={() => onItem(i, 'IN_PREPARATION')} title="Deshacer listo">
                      <RotateCcw className="h-4 w-4" />
                    </KdsBtn>
                  )}
                  {i.status !== 'READY' && (
                    <KdsBtn className="bg-white/5 text-ink-500 hover:bg-rose-500/20 hover:text-rose-300" disabled={busy} onClick={() => onCancel(i)} title="Cancelar">
                      <X className="h-4 w-4" />
                    </KdsBtn>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="border-t border-white/5 p-3">
        <div className="mb-2 flex items-center justify-between text-xs font-semibold text-ink-400">
          <span>
            Progreso: {t.progress.ready}/{t.progress.total} listos
          </span>
          {live.length > t.progress.ready && <span className="text-amber-300">Faltan {live.length - t.progress.ready}</span>}
        </div>
        <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${t.progress.total ? (t.progress.ready / t.progress.total) * 100 : 0}%` }} />
        </div>
        {!done && (
          <div className="grid grid-cols-2 gap-2">
            <Button size="lg" variant="secondary" className="!border-white/10 !bg-white/5 !text-white hover:!bg-white/10" disabled={!anyPending || busy} onClick={() => onBatch('IN_PREPARATION')}>
              <Play className="h-4 w-4" /> Empezar todo
            </Button>
            <Button size="lg" variant="success" disabled={busy} onClick={() => onBatch('READY')}>
              <Check className="h-5 w-5" /> Todo listo
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function KdsBtn({ className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={clsx('flex h-11 w-11 items-center justify-center rounded-xl font-bold transition active:scale-95 disabled:opacity-40', className)} {...rest} />;
}

function StockModal({ open, onClose, area }: { open: boolean; onClose: () => void; area: 'KITCHEN' | 'BAR' }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const q = useQuery({ queryKey: ['menu'], queryFn: () => api.get<Category[]>('/menu'), enabled: open });
  const m = useMutation({
    mutationFn: ({ id, available }: { id: number; available: boolean }) => api.patch(`/products/${id}/availability`, { available }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['menu'] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const products = (q.data ?? []).flatMap((c) => c.products ?? []).filter((p) => p.area.code === area && p.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <Modal open={open} onClose={onClose} title="Disponibilidad de productos" subtitle="Los productos agotados no podrán ser solicitados por los meseros" size="lg">
      <div className="relative mb-4">
        <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
        <input className="input pl-10" placeholder="Buscar..." value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="divide-y divide-ink-100 rounded-xl border border-ink-200">
        {products.map((p) => (
          <div key={p.id} className="flex items-center justify-between px-4 py-3">
            <span className={clsx('font-semibold', !p.available && 'text-ink-400 line-through')}>{p.name}</span>
            <Toggle checked={p.available} onChange={(v) => m.mutate({ id: p.id, available: v })} label={p.available ? 'Disponible' : 'Agotado'} />
          </div>
        ))}
      </div>
    </Modal>
  );
}
