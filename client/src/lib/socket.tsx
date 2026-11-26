import { createContext, ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from './auth';
import { Notification } from './types';
import { chime } from './sound';

interface SocketCtx {
  socket: Socket | null;
  connected: boolean;
}
const Ctx = createContext<SocketCtx>({ socket: null, connected: false });

/**
 * Conexión WebSocket única por sesión. Cada evento del servidor invalida las
 * consultas afectadas de React Query, de modo que todas las pantallas
 * (mesas, KDS, caja, dashboard) se sincronizan en tiempo real.
 */
export function SocketProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const firstConnect = useRef(true);

  useEffect(() => {
    if (!user) return;
    const s = io({ path: '/socket.io', withCredentials: true, transports: ['websocket', 'polling'] });
    setSocket(s);
    s.on('connect', () => {
      setConnected(true);
      if (!firstConnect.current) qc.invalidateQueries(); // resincroniza tras reconexión
      firstConnect.current = false;
    });
    s.on('disconnect', () => setConnected(false));

    s.on('tables:updated', () => {
      qc.invalidateQueries({ queryKey: ['tables'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    });
    s.on('order:updated', (p: { orderId: number }) => {
      qc.invalidateQueries({ queryKey: ['order', p.orderId] });
      qc.invalidateQueries({ queryKey: ['account', p.orderId] });
      qc.invalidateQueries({ queryKey: ['history', p.orderId] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
    });
    s.on('kds:updated', () => qc.invalidateQueries({ queryKey: ['kds'] }));
    s.on('kds:ticket-new', (p: { table?: string; orderNumber?: number }) => {
      qc.invalidateQueries({ queryKey: ['kds'] });
      chime('ticket');
      toast.info(`Nueva comanda — ${p.table ?? ''}`, { description: p.orderNumber ? `Orden #${p.orderNumber}` : undefined });
    });
    s.on('notification:new', (n: Notification) => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      chime(n.type === 'ITEM_CANCELLED' ? 'alert' : 'ready');
      const fn = n.type === 'ITEM_CANCELLED' ? toast.error : toast.success;
      fn(n.title, { description: n.message, duration: 8000 });
    });
    s.on('cash:updated', () => {
      qc.invalidateQueries({ queryKey: ['cash'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    });
    s.on('menu:updated', () => {
      qc.invalidateQueries({ queryKey: ['menu'] });
      qc.invalidateQueries({ queryKey: ['products'] });
      qc.invalidateQueries({ queryKey: ['settings'] });
    });
    return () => {
      s.close();
      setSocket(null);
      setConnected(false);
      firstConnect.current = true;
    };
  }, [user, qc]);

  return <Ctx.Provider value={{ socket, connected }}>{children}</Ctx.Provider>;
}

export const useSocket = () => useContext(Ctx);
