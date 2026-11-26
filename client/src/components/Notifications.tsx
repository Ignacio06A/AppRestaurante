import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { Bell, BellOff, CheckCheck, CircleAlert, CircleCheckBig, X } from 'lucide-react';
import { api } from '../lib/api';
import { Notification } from '../lib/types';
import { time } from '../lib/format';
import { useAuth } from '../lib/auth';

export function useNotifications() {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ items: Notification[]; unread: number }>('/notifications'),
    refetchInterval: 60_000,
  });
}

export function NotificationsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data } = useNotifications();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { can } = useAuth();
  const readAll = useMutation({ mutationFn: () => api.post('/notifications/read-all'), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const readOne = useMutation({ mutationFn: (id: number) => api.post(`/notifications/${id}/read`), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-ink-950/30" onClick={onClose} />
      <div className="absolute inset-y-0 right-0 flex w-full max-w-sm animate-slide-in flex-col bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-ink-100 px-5 py-4">
          <div className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-brand-500" />
            <h2 className="font-bold">Notificaciones</h2>
            {!!data?.unread && <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-bold text-brand-700">{data.unread} nuevas</span>}
          </div>
          <div className="flex items-center gap-1">
            <button className="rounded-lg p-2 text-ink-500 hover:bg-ink-100" title="Marcar todas como leídas" onClick={() => readAll.mutate()}>
              <CheckCheck className="h-4 w-4" />
            </button>
            <button className="rounded-lg p-2 text-ink-500 hover:bg-ink-100" onClick={onClose}>
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {!data?.items.length ? (
            <div className="flex flex-col items-center gap-2 py-20 text-sm text-ink-500">
              <BellOff className="h-8 w-8 text-ink-300" />
              Sin notificaciones
            </div>
          ) : (
            data.items.map((n) => {
              const bad = n.type === 'ITEM_CANCELLED';
              return (
                <button
                  key={n.id}
                  onClick={() => {
                    readOne.mutate(n.id);
                    if (n.data?.orderId && can('orders.create')) {
                      navigate(`/mesas/orden/${n.data.orderId}`);
                      onClose();
                    }
                  }}
                  className={clsx('flex w-full gap-3 border-b border-ink-100 px-5 py-4 text-left transition hover:bg-ink-50', !n.readAt && 'bg-brand-50/50')}
                >
                  <div className={clsx('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full', bad ? 'bg-rose-100 text-rose-600' : 'bg-lime-100 text-lime-700')}>
                    {bad ? <CircleAlert className="h-4 w-4" /> : <CircleCheckBig className="h-4 w-4" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-sm font-bold text-ink-900">{n.title}</div>
                      <div className="shrink-0 text-[11px] text-ink-400">{time(n.createdAt)}</div>
                    </div>
                    <div className="mt-0.5 text-sm text-ink-600">{n.message}</div>
                  </div>
                  {!n.readAt && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-brand-500" />}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
