import { FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ChefHat, Eye, EyeOff, LayoutGrid, Receipt, Wine } from 'lucide-react';
import { useAuth, homeFor } from '../lib/auth';
import { errorMessage } from '../lib/api';
import { Button, Field, Input } from '../components/ui';
import { Brand } from '../components/AppShell';

export default function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (user) return <Navigate to={homeFor(user)} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!username.trim() || !password) return setError('Ingrese usuario y contraseña');
    setLoading(true);
    try {
      const me = await login(username.trim().toLowerCase(), password);
      navigate(loc.state?.from && loc.state.from !== '/login' ? loc.state.from : homeFor(me), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden overflow-hidden bg-ink-900 lg:block">
        <div className="absolute -left-32 -top-32 h-[520px] w-[520px] rounded-full bg-brand-500/25 blur-3xl" />
        <div className="absolute -bottom-40 right-0 h-[420px] w-[420px] rounded-full bg-amber-400/10 blur-3xl" />
        <div className="relative flex h-full flex-col justify-between p-12">
          <Brand />
          <div className="max-w-lg">
            <h1 className="text-5xl font-extrabold leading-[1.05] tracking-tight text-white">
              Del pedido a la caja,
              <br />
              <span className="text-brand-400">en tiempo real.</span>
            </h1>
            <p className="mt-5 text-lg text-ink-300">Meseros, cocina, bar y caja sincronizados en una sola plataforma para operar su restaurante sin papeles.</p>
            <div className="mt-10 grid grid-cols-2 gap-3">
              {[
                { icon: <LayoutGrid />, t: 'Mesas y pedidos', d: 'Toma de órdenes ágil' },
                { icon: <ChefHat />, t: 'Cocina KDS', d: 'Comandas al instante' },
                { icon: <Wine />, t: 'Bar', d: 'Bebidas separadas' },
                { icon: <Receipt />, t: 'Caja', d: 'Pagos y arqueos' },
              ].map((f) => (
                <div key={f.t} className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur">
                  <div className="mb-2 text-brand-400 [&>svg]:h-5 [&>svg]:w-5">{f.icon}</div>
                  <div className="text-sm font-bold text-white">{f.t}</div>
                  <div className="text-xs text-ink-400">{f.d}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="text-xs text-ink-500">© {new Date().getFullYear()} Comanda · Moneda: colones costarricenses (CRC)</div>
        </div>
      </div>

      <div className="flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-sm">
          <div className="mb-10 lg:hidden">
            <Brand dark={false} />
          </div>
          <h2 className="text-3xl font-extrabold tracking-tight">Iniciar sesión</h2>
          <p className="mt-2 text-sm text-ink-500">Ingrese con su usuario asignado. Verá únicamente los módulos de su rol.</p>
          <form onSubmit={submit} className="mt-8 space-y-5">
            <Field label="Usuario">
              <Input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="ej. mesero" className="h-12" />
            </Field>
            <Field label="Contraseña">
              <div className="relative">
                <Input type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" className="h-12 pr-12" />
                <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-ink-400 hover:text-ink-700" aria-label="Mostrar contraseña">
                  {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </Field>
            {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">{error}</div>}
            <Button type="submit" size="lg" className="w-full" loading={loading}>
              Entrar
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
