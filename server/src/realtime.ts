import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { config } from './config';
import { AuthUser, resolveUserFromToken } from './middleware/auth';

/**
 * Salas (rooms) de Socket.IO:
 *  - user:<id>        notificaciones personales (p.ej. mesero: "producto listo")
 *  - area:KITCHEN     KDS de cocina (solo productos con destino COCINA)
 *  - area:BAR         KDS de bar (solo productos con destino BAR)
 *  - floor            todos los que ven el estado de mesas (meseros, caja, admin)
 *  - cash             caja / administración
 */
let io: Server | null = null;

export const Events = {
  KDS_TICKET_NEW: 'kds:ticket-new',
  KDS_UPDATED: 'kds:updated',
  TABLES_UPDATED: 'tables:updated',
  ORDER_UPDATED: 'order:updated',
  NOTIFICATION: 'notification:new',
  CASH_UPDATED: 'cash:updated',
  MENU_UPDATED: 'menu:updated',
} as const;

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function initRealtime(server: HttpServer) {
  io = new Server(server, {
    cors: { origin: config.clientOrigin, credentials: true },
    path: '/socket.io',
  });

  io.use(async (socket, next) => {
    try {
      const cookies = parseCookies(socket.handshake.headers.cookie);
      const token = cookies[config.cookieName] ?? (socket.handshake.auth?.token as string | undefined);
      const user = await resolveUserFromToken(token);
      if (!user) return next(new Error('UNAUTHORIZED'));
      (socket.data as { user: AuthUser }).user = user;
      next();
    } catch (e) {
      next(e as Error);
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = (socket.data as { user: AuthUser }).user;
    socket.join(`user:${user.id}`);
    const p = user.permissions;
    if (p.includes('kds.kitchen')) socket.join('area:KITCHEN');
    if (p.includes('kds.bar')) socket.join('area:BAR');
    if (p.includes('tables.view') || p.includes('orders.view')) socket.join('floor');
    if (p.includes('payments.view') || p.includes('cash.operate') || p.includes('reports.view')) socket.join('cash');
    socket.join('all');
    socket.emit('hello', { userId: user.id, rooms: [...socket.rooms] });
  });

  return io;
}

export function getIO() {
  return io;
}

function emit(room: string, event: string, payload: unknown) {
  io?.to(room).emit(event, payload);
}

export const realtime = {
  kdsNewTicket(areaCode: string, payload: unknown) {
    emit(`area:${areaCode}`, Events.KDS_TICKET_NEW, payload);
  },
  kdsUpdated(areaCodes: Iterable<string>, payload: unknown) {
    for (const a of new Set(areaCodes)) emit(`area:${a}`, Events.KDS_UPDATED, payload);
  },
  tablesUpdated(payload: unknown = {}) {
    emit('floor', Events.TABLES_UPDATED, payload);
    emit('cash', Events.TABLES_UPDATED, payload);
  },
  orderUpdated(orderId: number, extra: Record<string, unknown> = {}) {
    emit('floor', Events.ORDER_UPDATED, { orderId, ...extra });
    emit('cash', Events.ORDER_UPDATED, { orderId, ...extra });
  },
  notifyUser(userId: number, notification: unknown) {
    emit(`user:${userId}`, Events.NOTIFICATION, notification);
  },
  cashUpdated(payload: unknown = {}) {
    emit('cash', Events.CASH_UPDATED, payload);
  },
  menuUpdated() {
    emit('all', Events.MENU_UPDATED, {});
  },
};
