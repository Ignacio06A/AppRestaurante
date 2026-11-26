import { createContext, ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from './auth';
import { supabase } from './supabase';
import { Notification } from './types';
import { chime } from './sound';
import { camel } from './api';

interface RealtimeCtx {
  connected: boolean;
}
const Ctx = createContext<RealtimeCtx>({ connected: false });

type Row = Record<string, unknown>;

/**
 * Sincronización en tiempo real con Supabase Realtime.
 * La app escucha los cambios de las tablas (respetando RLS) y, ante cada uno,
 * invalida las consultas afectadas de React Query para que todas las pantallas
 * (mesas, KDS, caja, dashboard) se actualicen solas.
 */
export function SocketProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const wasConnected = useRef(false);
  const announced = useRef(new Set<number>());

  useEffect(() => {
    if (!user) return;
    let areaCodes: Record<number, string> = {};
    void supabase
      .from('preparation_areas')
      .select('id, code')
      .then(({ data }) => {
        areaCodes = Object.fromEntries((data ?? []).map((a) => [a.id as number, a.code as string]));
      });
    const myAreas = new Set<string>([...(user.permissions.includes('kds.kitchen') ? ['KITCHEN'] : []), ...(user.permissions.includes('kds.bar') ? ['BAR'] : [])]);

    const inv = (...keys: string[]) => keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    const onOrderChange = (orderId?: number) => {
      inv('tables', 'accounts', 'dashboard', 'kds');
      if (orderId) {
        qc.invalidateQueries({ queryKey: ['order', orderId] });
        qc.invalidateQueries({ queryKey: ['account', orderId] });
        qc.invalidateQueries({ queryKey: ['history', orderId] });
      }
    };

    const channel = supabase
      .channel(`comanda-${user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, (p) => {
        const row = (p.new && Object.keys(p.new).length ? p.new : p.old) as Row;
        onOrderChange(row.order_id as number);
        // Aviso de comanda nueva en las pantallas de cocina / bar
        if (p.eventType === 'INSERT' && row.status === 'PENDING' && !row.parent_item_id) {
          const area = areaCodes[row.area_id as number];
          const batch = row.batch_id as number;
          if (area && myAreas.has(area) && !announced.current.has(batch)) {
            announced.current.add(batch);
            chime('ticket');
            toast.info(`Nueva comanda — ${area === 'KITCHEN' ? 'Cocina' : 'Bar'}`, { description: `${row.quantity}x ${row.product_name}…` });
          }
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (p) => onOrderChange(((p.new as Row)?.id ?? (p.old as Row)?.id) as number))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payments' }, (p) => {
        onOrderChange((p.new as Row)?.order_id as number);
        inv('cash');
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cash_sessions' }, () => inv('cash', 'accounts', 'dashboard'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cash_movements' }, () => inv('cash', 'dashboard'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dining_tables' }, () => inv('tables'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => inv('menu', 'products'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'categories' }, () => inv('menu', 'categories'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'restaurant_settings' }, () => inv('settings'))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}` }, (p) => {
        const n = camel<Notification>(p.new);
        inv('notifications');
        chime(n.type === 'ITEM_CANCELLED' ? 'alert' : 'ready');
        const fn = n.type === 'ITEM_CANCELLED' ? toast.error : toast.success;
        fn(n.title, { description: n.message, duration: 8000 });
      })
      .subscribe((status) => {
        const ok = status === 'SUBSCRIBED';
        setConnected(ok);
        if (ok && wasConnected.current) qc.invalidateQueries(); // resincroniza tras reconexión
        if (ok) wasConnected.current = true;
      });

    return () => {
      void supabase.removeChannel(channel);
      setConnected(false);
      wasConnected.current = false;
    };
  }, [user, qc]);

  return <Ctx.Provider value={{ connected }}>{children}</Ctx.Provider>;
}

export const useSocket = () => useContext(Ctx);
