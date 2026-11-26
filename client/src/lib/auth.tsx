import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { RoleCode, User } from './types';

interface AuthCtx {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
  can: (...perms: string[]) => boolean;
}

const Ctx = createContext<AuthCtx | null>(null);

export const HOME_BY_ROLE: Record<RoleCode, string> = {
  ADMIN: '/admin',
  WAITER: '/mesas',
  KITCHEN: '/cocina',
  BAR: '/bar',
  CASHIER: '/caja',
};

export function homeFor(user: User) {
  const base = HOME_BY_ROLE[user.role];
  if (base) return base;
  if (user.permissions.includes('tables.view')) return '/mesas';
  return '/';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  useEffect(() => {
    api
      .get<User>('/auth/me')
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
    const onExpired = () => {
      setUser(null);
      qc.clear();
    };
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, [qc]);

  const login = useCallback(async (username: string, password: string) => {
    await api.post('/auth/login', { username, password });
    const me = await api.get<User>('/auth/me');
    setUser(me);
    return me;
  }, []);

  const logout = useCallback(async () => {
    await api.post('/auth/logout').catch(() => undefined);
    setUser(null);
    qc.clear();
  }, [qc]);

  const can = useCallback((...perms: string[]) => !!user && perms.some((p) => user.permissions.includes(p)), [user]);

  return <Ctx.Provider value={{ user, loading, login, logout, can }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth fuera de AuthProvider');
  return c;
}
