import { ReactNode, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import {
  BarChart3, Bell, BookOpen, ChefHat, ClipboardList, Coins, History, KeyRound, LayoutDashboard, LayoutGrid, LogOut, Menu, Receipt,
  Settings as SettingsIcon, ShieldCheck, Tags, UtensilsCrossed, Users, Volume2, VolumeX, Wifi, WifiOff, Wine, X, Armchair,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useSocket } from '../lib/socket';
import { useSettings } from '../lib/hooks';
import { NotificationsPanel, useNotifications } from './Notifications';
import { ChangePasswordModal } from './ChangePassword';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  perms: string[];
  end?: boolean;
}

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Operación',
    items: [
      { to: '/mesas', label: 'Mesas y pedidos', icon: <LayoutGrid />, perms: ['orders.create'] },
      { to: '/cocina', label: 'Cocina (KDS)', icon: <ChefHat />, perms: ['kds.kitchen'] },
      { to: '/bar', label: 'Bar', icon: <Wine />, perms: ['kds.bar'] },
    ],
  },
  {
    section: 'Caja',
    items: [
      { to: '/caja', label: 'Cuentas por cobrar', icon: <Receipt />, perms: ['payments.view'], end: true },
      { to: '/caja/control', label: 'Control de caja', icon: <Coins />, perms: ['cash.operate'] },
      { to: '/caja/historial', label: 'Aperturas y cierres', icon: <History />, perms: ['cash.history'] },
    ],
  },
  {
    section: 'Administración',
    items: [
      { to: '/admin', label: 'Dashboard', icon: <LayoutDashboard />, perms: ['reports.view'], end: true },
      { to: '/admin/reportes', label: 'Reportes', icon: <BarChart3 />, perms: ['reports.view'] },
      { to: '/admin/ordenes', label: 'Órdenes', icon: <ClipboardList />, perms: ['reports.view'] },
      { to: '/admin/productos', label: 'Productos y menú', icon: <UtensilsCrossed />, perms: ['menu.manage', 'menu.availability'] },
      { to: '/admin/categorias', label: 'Categorías', icon: <Tags />, perms: ['menu.manage'] },
      { to: '/admin/mesas', label: 'Mesas', icon: <Armchair />, perms: ['tables.manage'] },
      { to: '/admin/usuarios', label: 'Usuarios', icon: <Users />, perms: ['users.manage'] },
      { to: '/admin/roles', label: 'Roles y permisos', icon: <ShieldCheck />, perms: ['users.manage'] },
      { to: '/admin/configuracion', label: 'Configuración', icon: <SettingsIcon />, perms: ['settings.manage'] },
      { to: '/admin/bitacora', label: 'Bitácora', icon: <BookOpen />, perms: ['audit.view'] },
    ],
  },
];

export function useMuted() {
  const [muted, setMuted] = useState(() => {
    try {
      return localStorage.getItem('rms:mute') === '1';
    } catch {
      return false;
    }
  });
  const toggle = () => {
    const v = !muted;
    setMuted(v);
    try {
      localStorage.setItem('rms:mute', v ? '1' : '0');
    } catch {
      /* noop */
    }
  };
  return [muted, toggle] as const;
}

export function Brand({ dark = true, name }: { dark?: boolean; name?: string }) {
  const { data: settings } = useSettings();
  return (
    <div className="flex min-w-0 items-center gap-3">
      {settings?.logoUrl ? (
        <img src={settings.logoUrl} alt="" className="h-9 w-9 shrink-0 rounded-xl object-cover" />
      ) : (
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-500 text-white shadow-lg shadow-brand-500/30">
          <svg viewBox="0 0 64 64" className="h-6 w-6">
            <path d="M14 38a18 18 0 0 1 36 0z" fill="currentColor" />
            <rect x="10" y="41" width="44" height="5" rx="2.5" fill="currentColor" />
            <circle cx="32" cy="17" r="3.5" fill="currentColor" />
          </svg>
        </div>
      )}
      <div className="min-w-0">
        <div className={clsx('truncate text-[15px] font-extrabold leading-tight tracking-tight', dark ? 'text-white' : 'text-ink-900')}>{name ?? settings?.name ?? 'Comanda'}</div>
        <div className={clsx('text-[10px] font-bold uppercase tracking-[0.18em]', dark ? 'text-ink-400' : 'text-ink-500')}>Comanda · Gestión</div>
      </div>
    </div>
  );
}

export function ConnectionPill({ dark }: { dark?: boolean }) {
  const { connected } = useSocket();
  return (
    <span
      title={connected ? 'Conectado en tiempo real' : 'Sin conexión en tiempo real — reconectando...'}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold',
        connected ? (dark ? 'bg-emerald-500/15 text-emerald-300' : 'bg-emerald-50 text-emerald-700') : dark ? 'bg-rose-500/20 text-rose-300' : 'bg-rose-50 text-rose-700',
      )}
    >
      {connected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5 animate-pulse" />}
      <span className="hidden sm:inline">{connected ? 'En línea' : 'Reconectando'}</span>
    </span>
  );
}

export function AppShell() {
  const { user, logout, can } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [pwdOpen, setPwdOpen] = useState(false);
  const [muted, toggleMuted] = useMuted();
  const { data: notifs } = useNotifications();
  const loc = useLocation();
  const navigate = useNavigate();

  useEffect(() => setMobileOpen(false), [loc.pathname]);

  const sections = NAV.map((s) => ({ ...s, items: s.items.filter((i) => can(...i.perms)) })).filter((s) => s.items.length);

  const sidebar = (
    <div className="flex h-full flex-col bg-ink-900 text-ink-300">
      <div className="flex h-16 items-center justify-between px-5">
        <Brand />
        <button className="text-ink-400 lg:hidden" onClick={() => setMobileOpen(false)} aria-label="Cerrar menú">
          <X className="h-5 w-5" />
        </button>
      </div>
      <nav className="scrollbar-thin flex-1 space-y-6 overflow-y-auto px-3 py-4">
        {sections.map((s) => (
          <div key={s.section}>
            <div className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-ink-500">{s.section}</div>
            <div className="space-y-0.5">
              {s.items.map((i) => (
                <NavLink
                  key={i.to}
                  to={i.to}
                  end={i.end}
                  className={({ isActive }) =>
                    clsx(
                      'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition [&>svg]:h-[18px] [&>svg]:w-[18px]',
                      isActive ? 'bg-white/10 text-white shadow-inner' : 'text-ink-400 hover:bg-white/5 hover:text-ink-100',
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span className={clsx('flex [&>svg]:h-[18px] [&>svg]:w-[18px]', isActive ? 'text-brand-400' : '')}>{i.icon}</span>
                      {i.label}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="border-t border-white/5 p-3">
        <div className="flex items-center gap-3 rounded-xl bg-white/5 p-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-sm font-extrabold text-white">
            {user?.name.split(' ').map((p) => p[0]).slice(0, 2).join('')}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-bold text-white">{user?.name}</div>
            <div className="truncate text-xs text-ink-400">{user?.roleName}</div>
          </div>
          <button title="Cambiar contraseña" onClick={() => setPwdOpen(true)} className="rounded-lg p-1.5 text-ink-400 hover:bg-white/10 hover:text-white">
            <KeyRound className="h-4 w-4" />
          </button>
          <button
            title="Cerrar sesión"
            onClick={async () => {
              await logout();
              navigate('/login');
            }}
            className="rounded-lg p-1.5 text-ink-400 hover:bg-white/10 hover:text-white"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen lg:pl-64">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 lg:block">{sidebar}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink-950/60" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 animate-slide-in">{sidebar}</aside>
        </div>
      )}
      <header className="no-print sticky top-0 z-20 flex h-16 items-center gap-1.5 border-b sm:gap-3 border-ink-200/70 bg-ink-50/85 px-4 backdrop-blur-md sm:px-6">
        <button className="rounded-xl p-2 text-ink-600 hover:bg-ink-100 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Abrir menú">
          <Menu className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1 lg:hidden">
          <Brand dark={false} />
        </div>
        <div className="hidden flex-1 lg:block" />
        <ConnectionPill />
        <button onClick={toggleMuted} title={muted ? 'Activar sonido' : 'Silenciar alertas'} className="rounded-xl p-2 text-ink-500 hover:bg-ink-100">
          {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
        </button>
        <button onClick={() => setNotifOpen(true)} className="relative rounded-xl p-2 text-ink-600 hover:bg-ink-100" aria-label="Notificaciones">
          <Bell className="h-5 w-5" />
          {!!notifs?.unread && (
            <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-brand-500 px-1 text-[10px] font-extrabold text-white ring-2 ring-ink-50">
              {notifs.unread > 99 ? '99+' : notifs.unread}
            </span>
          )}
        </button>
      </header>
      <main className="px-4 py-6 sm:px-6 lg:px-8">
        <Outlet />
      </main>
      <NotificationsPanel open={notifOpen} onClose={() => setNotifOpen(false)} />
      <ChangePasswordModal open={pwdOpen} onClose={() => setPwdOpen(false)} />
    </div>
  );
}
