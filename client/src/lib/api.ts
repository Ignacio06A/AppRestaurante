/**
 * Capa de acceso a datos sobre Supabase.
 *
 * Las pantallas siguen usando rutas tipo REST (api.get('/orders/5'), ...). Este
 * módulo las traduce a llamadas de Supabase: funciones RPC de PostgreSQL para
 * toda la lógica de negocio (pedidos, cocina, pagos, caja, reportes) y acceso
 * directo a tablas (protegido por RLS) solo para catálogos administrativos.
 */
import { PostgrestError } from '@supabase/supabase-js';
import { supabase, usernameToEmail } from './supabase';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: unknown) {
    super(message);
  }
}

const UNIQUE_MESSAGES: Record<string, string> = {
  dining_tables_number_key: 'Ya existe una mesa con ese número',
  categories_name_key: 'Ya existe una categoría con ese nombre',
  payment_methods_code_key: 'Ya existe un método de pago con ese código',
  cash_registers_name_key: 'Ya existe una caja con ese nombre',
};

function toApiError(e: PostgrestError | { message: string; code?: string; status?: number }): ApiError {
  const code = (e as PostgrestError).code ?? '';
  if (code.startsWith('PT')) {
    const status = Number(code.slice(2));
    if (status === 401) window.dispatchEvent(new CustomEvent('auth:expired'));
    return new ApiError(status, e.message, code);
  }
  if (code === '23505') {
    const key = Object.keys(UNIQUE_MESSAGES).find((k) => e.message.includes(k));
    return new ApiError(409, key ? UNIQUE_MESSAGES[key] : 'Ya existe un registro con esos datos', code);
  }
  if (code === '23514' || code === '22P02' || code === '23502') return new ApiError(400, 'Datos inválidos: revise los valores ingresados', code);
  if (code === '42501') return new ApiError(403, 'No tiene permisos para realizar esta acción', code);
  if (code === 'PGRST116') return new ApiError(404, 'Registro no encontrado', code);
  if (e.message?.includes('Failed to fetch')) return new ApiError(0, 'No se pudo conectar con el servidor. Verifique su conexión.');
  return new ApiError((e as { status?: number }).status ?? 500, e.message || 'Error inesperado', code);
}

/** Llama a una función RPC y devuelve su resultado o lanza ApiError. */
export async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw toApiError(error);
  return data as T;
}

async function q<T>(p: PromiseLike<{ data: unknown; error: PostgrestError | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw toApiError(error);
  return data as T;
}

// ---------------------------------------------------------------- conversión de nombres
const toCamel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const toSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export function camel<T = Record<string, unknown>>(o: unknown): T {
  if (Array.isArray(o)) return o.map((x) => camel(x)) as T;
  if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o as object).map(([k, v]) => [toCamel(k), v])) as T;
  return o as T;
}

function snake(o: Record<string, unknown>, allowed: string[]) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (allowed.includes(k) && v !== undefined) out[toSnake(k)] = v === '' ? null : v;
  return out;
}

// ---------------------------------------------------------------- rutas
type Params = Record<string, string>;
type Handler = (p: Params, body: Record<string, unknown>, query: URLSearchParams) => Promise<unknown>;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const num = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? null : Number(v));
const str = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? null : v);
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

const TABLE_FIELDS = ['number', 'name', 'zone', 'capacity', 'active'];
const CATEGORY_FIELDS = ['name', 'description', 'sortOrder', 'active', 'defaultAreaId'];
const PRODUCT_FIELDS = ['name', 'description', 'price', 'categoryId', 'areaId', 'imageUrl', 'active', 'available', 'sortOrder'];
const PM_FIELDS = ['code', 'name', 'kind', 'active', 'sortOrder'];
const SETTINGS_FIELDS = [
  'name', 'legalName', 'legalId', 'address', 'phone', 'email', 'logoUrl', 'currencyCode', 'currencySymbol', 'taxRate',
  'serviceRate', 'pricesIncludeTax', 'receiptFooter', 'kdsWarningMinutes', 'kdsCriticalMinutes',
];

const routes: [Method, string, Handler][] = [
  // --- Sesión
  ['GET', '/auth/me', () => rpc('me')],
  ['POST', '/auth/login', async (_p, b) => {
    const { error } = await supabase.auth.signInWithPassword({ email: usernameToEmail(String(b.username)), password: String(b.password) });
    if (error) {
      const banned = /banned/i.test(error.message);
      throw new ApiError(401, banned ? 'El usuario está desactivado' : /rate limit|too many/i.test(error.message) ? 'Demasiados intentos. Intente de nuevo en unos minutos.' : 'Usuario o contraseña incorrectos');
    }
    try {
      await rpc('log_login');
    } catch (e) {
      await supabase.auth.signOut();
      throw e;
    }
    return { ok: true };
  }],
  ['POST', '/auth/logout', async () => (await supabase.auth.signOut(), { ok: true })],
  ['POST', '/auth/change-password', async (_p, b) => {
    const { data } = await supabase.auth.getUser();
    if (!data.user?.email) throw new ApiError(401, 'Sesión inválida');
    const check = await supabase.auth.signInWithPassword({ email: data.user.email, password: String(b.currentPassword) });
    if (check.error) throw new ApiError(400, 'La contraseña actual es incorrecta');
    const { error } = await supabase.auth.updateUser({ password: String(b.newPassword) });
    if (error) throw new ApiError(400, error.message);
    return { ok: true };
  }],

  // --- Configuración
  ['GET', '/settings', async () => camel(await q(supabase.from('restaurant_settings').select('*').eq('id', 1).single()))],
  ['PUT', '/settings', async (_p, b) => camel(await q(supabase.from('restaurant_settings').update(snake(b, SETTINGS_FIELDS)).eq('id', 1).select('*').single()))],
  ['GET', '/payment-methods', async (_p, _b, qs) => {
    let qb = supabase.from('payment_methods').select('*').order('sort_order').order('id');
    if (qs.get('all') !== '1') qb = qb.eq('active', true);
    return camel(await q(qb));
  }],
  ['POST', '/payment-methods', async (_p, b) => camel(await q(supabase.from('payment_methods').insert(snake(b, PM_FIELDS)).select('*').single()))],
  ['PUT', '/payment-methods/:id', async (p, b) => camel(await q(supabase.from('payment_methods').update(snake(b, PM_FIELDS.filter((f) => f !== 'code'))).eq('id', Number(p.id)).select('*').single()))],

  // --- Mesas
  ['GET', '/tables', (_p, _b, qs) => rpc('get_tables', { p_all: qs.get('all') === '1' })],
  ['POST', '/tables', async (_p, b) => camel(await q(supabase.from('dining_tables').insert(snake(b, TABLE_FIELDS)).select('*').single()))],
  ['PUT', '/tables/:id', async (p, b) => camel(await q(supabase.from('dining_tables').update(snake(b, TABLE_FIELDS)).eq('id', Number(p.id)).select('*').single()))],
  ['DELETE', '/tables/:id', async (p) => ({ result: await rpc('delete_table', { p_id: Number(p.id) }) })],

  // --- Menú
  ['GET', '/menu', () => rpc('get_menu')],
  ['GET', '/areas', async () => q(supabase.from('preparation_areas').select('id, code, name').order('id'))],
  ['GET', '/categories', () => rpc('list_categories')],
  ['POST', '/categories', async (_p, b) => camel(await q(supabase.from('categories').insert(snake(b, CATEGORY_FIELDS)).select('*').single()))],
  ['PUT', '/categories/:id', async (p, b) => camel(await q(supabase.from('categories').update(snake(b, CATEGORY_FIELDS)).eq('id', Number(p.id)).select('*').single()))],
  ['DELETE', '/categories/:id', async (p) => ({ result: await rpc('delete_category', { p_id: Number(p.id) }) })],
  ['GET', '/products', (_p, _b, qs) => rpc('list_products', { p_search: str(qs.get('search')), p_category_id: num(qs.get('categoryId')), p_include_inactive: qs.get('includeInactive') === '1' })],
  ['POST', '/products', async (_p, b) => camel(await q(supabase.from('products').insert(snake(b, PRODUCT_FIELDS)).select('*').single()))],
  ['PUT', '/products/:id', async (p, b) => camel(await q(supabase.from('products').update(snake(b, PRODUCT_FIELDS)).eq('id', Number(p.id)).select('*').single()))],
  ['PATCH', '/products/:id/availability', async (p, b) => rpc('set_product_availability', { p_product_id: Number(p.id), p_available: !!b.available })],
  ['DELETE', '/products/:id', async (p) => ({ result: await rpc('delete_product', { p_id: Number(p.id) }) })],

  // --- Órdenes
  ['GET', '/orders', (_p, _b, qs) => rpc('list_orders', { p_status: str(qs.get('status')), p_from: str(qs.get('from')), p_to: str(qs.get('to')), p_page: num(qs.get('page')) ?? 1, p_page_size: num(qs.get('pageSize')) ?? 25 })],
  ['POST', '/orders', (_p, b) => rpc('open_order', { p_table_id: b.tableId, p_guests: b.guests ?? 1, p_notes: b.notes ?? null, p_items: b.items ?? null })],
  ['GET', '/orders/:id', (p) => rpc('get_order', { p_order_id: Number(p.id) })],
  ['GET', '/orders/:id/history', (p) => rpc('get_order_history', { p_order_id: Number(p.id) })],
  ['PATCH', '/orders/:id', (p, b) => rpc('update_order_info', { p_order_id: Number(p.id), p_guests: b.guests ?? null, p_notes: b.notes ?? null, p_set_notes: has(b, 'notes') })],
  ['POST', '/orders/:id/items', (p, b) => rpc('send_items', { p_order_id: Number(p.id), p_items: b.items })],
  ['PATCH', '/orders/:id/items/:itemId', (p, b) => rpc('update_order_item', {
    p_order_id: Number(p.id), p_item_id: Number(p.itemId), p_quantity: b.quantity ?? null, p_notes: b.notes ?? null, p_set_notes: has(b, 'notes'), p_reason: b.reason ?? null,
  })],
  ['DELETE', '/orders/:id/items/:itemId', (p, b) => rpc('cancel_order_item', { p_order_id: Number(p.id), p_item_id: Number(p.itemId), p_reason: b.reason ?? '' })],
  ['POST', '/orders/:id/deliver', (p, b) => rpc('deliver_items', { p_order_id: Number(p.id), p_item_ids: b.itemIds ?? null })],
  ['POST', '/orders/:id/request-bill', (p) => rpc('request_bill', { p_order_id: Number(p.id) })],
  ['POST', '/orders/:id/reopen', (p) => rpc('reopen_order', { p_order_id: Number(p.id) })],
  ['POST', '/orders/:id/discount', (p, b) => rpc('apply_discount', { p_order_id: Number(p.id), p_type: b.type ?? null, p_value: b.value ?? 0, p_reason: b.reason ?? null })],
  ['POST', '/orders/:id/cancel', (p, b) => rpc('cancel_order', { p_order_id: Number(p.id), p_reason: b.reason ?? '' })],
  ['POST', '/orders/:id/transfer', (p, b) => rpc('transfer_order', { p_order_id: Number(p.id), p_table_id: b.tableId })],

  // --- Cocina / Bar
  ['GET', '/kds/:area/tickets', (p) => rpc('kds_tickets', { p_area: p.area })],
  ['PATCH', '/kds/:area/items/:id', (p, b) => rpc('kds_set_items_status', { p_area: p.area, p_item_ids: [Number(p.id)], p_status: b.status })],
  ['POST', '/kds/:area/batches/:batchId/status', (p, b) => rpc('kds_set_batch_status', { p_area: p.area, p_batch_id: Number(p.batchId), p_status: b.status })],
  ['POST', '/kds/:area/items/:id/cancel', (p, b) => rpc('kds_cancel_item', { p_area: p.area, p_item_id: Number(p.id), p_reason: b.reason ?? '' })],

  // --- Notificaciones
  ['GET', '/notifications', async () => {
    const { data: u } = await supabase.auth.getUser();
    const uid = u.user?.id ?? '';
    const [items, unread] = await Promise.all([
      q(supabase.from('notifications').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(50)),
      supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', uid).is('read_at', null),
    ]);
    return { items: camel(items), unread: unread.count ?? 0 };
  }],
  ['POST', '/notifications/read-all', async () => {
    const { data: u } = await supabase.auth.getUser();
    await q(supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('user_id', u.user?.id ?? '').is('read_at', null));
    return { ok: true };
  }],
  ['POST', '/notifications/:id/read', async (p) => (await q(supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', Number(p.id)).is('read_at', null)), { ok: true })],

  // --- Caja
  ['GET', '/cashier/accounts', () => rpc('cashier_accounts')],
  ['GET', '/cashier/orders/:id/account', (p) => rpc('get_account', { p_order_id: Number(p.id) })],
  ['GET', '/cashier/orders/:id/split', (p, _b, qs) => rpc('split_equal', { p_order_id: Number(p.id), p_parts: num(qs.get('parts')) })],
  ['POST', '/cashier/orders/:id/payments', (p, b) => rpc('register_payment', {
    p_order_id: Number(p.id), p_payment_method_id: b.paymentMethodId, p_split_mode: b.splitMode, p_idempotency_key: b.idempotencyKey,
    p_amount: b.amount ?? null, p_received_amount: b.receivedAmount ?? null, p_reference: b.reference ?? null,
    p_payer_label: b.payerLabel ?? null, p_items: b.items ?? null,
  })],
  ['GET', '/cashier/orders/:id/receipt', async (p, _b, qs) => {
    const r = await rpc<{ settings: unknown }>('get_receipt', { p_order_id: Number(p.id), p_payment_id: num(qs.get('paymentId')) });
    return { ...r, settings: camel(r.settings) };
  }],
  ['GET', '/cash/current', () => rpc('cash_current')],
  ['POST', '/cash/open', (_p, b) => rpc('cash_open', { p_opening_amount: b.openingAmount, p_notes: b.notes ?? null })],
  ['GET', '/cash/sessions', (_p, _b, qs) => rpc('cash_sessions_list', { p_page: num(qs.get('page')) ?? 1, p_page_size: num(qs.get('pageSize')) ?? 20 })],
  ['GET', '/cash/sessions/:id', (p) => rpc('cash_session_detail', { p_session_id: Number(p.id) })],
  ['POST', '/cash/sessions/:id/movements', (p, b) => rpc('cash_add_movement', { p_session_id: Number(p.id), p_type: b.type, p_amount: b.amount, p_description: b.description })],
  ['POST', '/cash/sessions/:id/close', (p, b) => rpc('cash_close', { p_session_id: Number(p.id), p_counted_cash: b.countedCash, p_notes: b.notes ?? null })],

  // --- Reportes
  ['GET', '/reports/dashboard', () => rpc('report_dashboard')],
  ['GET', '/reports/sales', (_p, _b, qs) => rpc('report_sales', { p_from: qs.get('from'), p_to: qs.get('to') })],

  // --- Administración
  ['GET', '/admin/users', (_p, _b, qs) => rpc('admin_list_users', { p_search: str(qs.get('search')), p_role_id: num(qs.get('roleId')) })],
  ['POST', '/admin/users', (_p, b) => rpc('admin_create_user', { p_name: b.name, p_username: b.username, p_password: b.password, p_role_id: b.roleId, p_active: b.active ?? true })],
  ['PUT', '/admin/users/:id', (p, b) => rpc('admin_update_user', {
    p_id: p.id, p_name: b.name ?? null, p_username: b.username ?? null, p_password: b.password || null, p_role_id: b.roleId ?? null, p_active: b.active ?? null,
  })],
  ['DELETE', '/admin/users/:id', async (p) => (await rpc('admin_deactivate_user', { p_id: p.id }), { result: 'deactivated' })],
  ['GET', '/admin/roles', () => rpc('admin_roles')],
  ['GET', '/admin/permissions', async () => q(supabase.from('permissions').select('id, code, description, module').order('module').order('code'))],
  ['PUT', '/admin/roles/:id/permissions', async (p, b) => (await rpc('admin_set_role_permissions', { p_role_id: Number(p.id), p_permissions: b.permissions }), { ok: true })],
  ['GET', '/audit', (_p, _b, qs) => rpc('audit_list', {
    p_user_id: str(qs.get('userId')), p_action: str(qs.get('action')), p_from: str(qs.get('from')), p_to: str(qs.get('to')),
    p_page: num(qs.get('page')) ?? 1, p_page_size: num(qs.get('pageSize')) ?? 50,
  })],
];

const compiled = routes.map(([method, pattern, handler]) => {
  const keys: string[] = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k: string) => (keys.push(k), '([^/]+)')) + '$');
  return { method, re, keys, handler };
});

async function request<T>(method: Method, url: string, body?: unknown): Promise<T> {
  const [path, search = ''] = url.split('?');
  for (const r of compiled) {
    if (r.method !== method) continue;
    const m = path.match(r.re);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    try {
      return (await r.handler(params, (body ?? {}) as Record<string, unknown>, new URLSearchParams(search))) as T;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw toApiError(e as PostgrestError);
    }
  }
  throw new ApiError(404, `Operación no disponible: ${method} ${path}`);
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {}),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body ?? {}),
  del: <T>(url: string, body?: unknown) => request<T>('DELETE', url, body ?? {}),
  /** Sube una imagen al bucket público "images" de Supabase Storage. */
  upload: async (file: File) => {
    const ext = (file.name.split('.').pop() ?? 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
    const path = `${Date.now()}-${uuid().slice(0, 8)}.${ext}`;
    const { error } = await supabase.storage.from('images').upload(path, file, { contentType: file.type, upsert: false });
    if (error) throw new ApiError(400, /mime|type/i.test(error.message) ? 'Formato no permitido (PNG, JPG, WEBP o GIF)' : /size|large/i.test(error.message) ? 'La imagen no debe superar 3 MB' : error.message);
    return { url: supabase.storage.from('images').getPublicUrl(path).data.publicUrl };
  },
};

export function errorMessage(e: unknown) {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Ocurrió un error inesperado';
}

export function uuid() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function qs(params: Record<string, string | number | undefined | null | boolean>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
}
