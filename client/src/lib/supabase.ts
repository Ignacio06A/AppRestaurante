import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anonKey) {
  // Se muestra en consola y la app indica el problema en la pantalla de inicio de sesión
  console.error('Faltan VITE_SUPABASE_URL y/o VITE_SUPABASE_ANON_KEY en las variables de entorno');
}

export const supabaseConfigured = !!url && !!anonKey;

export const supabase = createClient(url ?? 'http://localhost', anonKey ?? 'missing-key', {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'comanda-auth' },
  realtime: { params: { eventsPerSecond: 20 } },
});

/** El inicio de sesión es por "usuario"; Supabase Auth usa un correo sintético interno. */
export const usernameToEmail = (username: string) => `${username.trim().toLowerCase()}@comanda.local`;
