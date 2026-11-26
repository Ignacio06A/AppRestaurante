/**
 * Pruebas de integración de la lógica de negocio en la base de datos.
 * Cada llamada se ejecuta como lo hace Supabase: rol "authenticated" y
 * el id del usuario en request.jwt.claims, de modo que se prueban también
 * los permisos, las políticas RLS y las funciones SECURITY DEFINER.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DB } from './globalSetup.js';

const pool = new pg.Pool({ connectionString: TEST_DB, max: 4 });
const users = {};
let products = {};
let tables = [];
let methods = {};

/** Ejecuta SQL como un usuario autenticado de Supabase. */
async function as(username, sql, params = []) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role authenticated');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: users[username], role: 'authenticated' })]);
    const r = await c.query(sql, params);
    await c.query('commit');
    return r.rows;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

/** Llama a una función RPC con argumentos con nombre (como supabase.rpc). */
async function rpc(username, fn, args = {}) {
  const keys = Object.keys(args);
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
  const vals = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' && !Array.isArray(args[k]) ? JSON.stringify(args[k]) : args[k]));
  const rows = await as(username, sql, vals);
  return rows[0].r;
}

async function rpcError(username, fn, args = {}) {
  try {
    await rpc(username, fn, args);
  } catch (e) {
    return { code: e.code, message: e.message };
  }
  throw new Error(`Se esperaba un error en ${fn}`);
}

const items = (list) => JSON.stringify(list);
const tableOf = async (user, id) => (await rpc(user, 'get_tables')).find((t) => t.id === id);

beforeAll(async () => {
  const r = await pool.query('select id, username from public.profiles');
  r.rows.forEach((u) => (users[u.username] = u.id));
  products = Object.fromEntries((await pool.query('select id, name from public.products')).rows.map((p) => [p.name, p.id]));
  tables = (await pool.query('select id, name from public.dining_tables order by number')).rows;
  methods = Object.fromEntries((await pool.query('select id, code from public.payment_methods')).rows.map((m) => [m.code, m.id]));
});

afterAll(() => pool.end());

describe('Autenticación, permisos y RLS', () => {
  it('rechaza llamadas sin usuario y usuarios sin perfil', async () => {
    users.anon = null;
    const e = await rpcError('anon', 'get_tables');
    expect(e.code).toBe('PT401');
  });

  it('me() devuelve el rol y los permisos', async () => {
    const me = await rpc('mesero', 'me');
    expect(me.role).toBe('WAITER');
    expect(me.permissions).toContain('orders.create');
    expect(me.permissions).not.toContain('payments.create');
  });

  it('cocina no puede cobrar, cambiar precios ni ver el bar', async () => {
    expect((await rpcError('cocina', 'register_payment', { p_order_id: 1, p_payment_method_id: 1, p_split_mode: 'FULL', p_idempotency_key: 'xxxxxxxxxx' })).code).toBe('PT403');
    const updated = await as('cocina', 'update public.products set price = 1 where id = $1 returning id', [products['Coca-Cola']]);
    expect(updated.length).toBe(0); // RLS bloquea la actualización
    expect((await rpcError('cocina', 'kds_tickets', { p_area: 'BAR' })).code).toBe('PT403');
    expect((await rpcError('bar', 'kds_tickets', { p_area: 'KITCHEN' })).code).toBe('PT403');
  });

  it('cocina no puede leer pagos ni la bitácora (RLS)', async () => {
    expect((await as('cocina', 'select * from public.payments')).length).toBe(0);
    expect((await as('cocina', 'select * from public.audit_logs')).length).toBe(0);
  });

  it('el administrador no puede otorgar permisos de pago al rol Cocina', async () => {
    const roles = await rpc('admin', 'admin_roles');
    const kitchen = roles.find((r) => r.code === 'KITCHEN');
    const e = await rpcError('admin', 'admin_set_role_permissions', { p_role_id: kitchen.id, p_permissions: [...kitchen.permissions, 'payments.create'] });
    expect(e.code).toBe('PT400');
  });

  it('un usuario no puede crear usuarios sin permiso y el admin sí', async () => {
    expect((await rpcError('mesero', 'admin_create_user', { p_name: 'X', p_username: 'xxx', p_password: '12345678', p_role_id: 2 })).code).toBe('PT403');
    const u = await rpc('admin', 'admin_create_user', { p_name: 'Pedro Prueba', p_username: 'pedro', p_password: 'Pedro1234', p_role_id: 2 });
    expect(u.username).toBe('pedro');
    const auth = await pool.query(`select email, encrypted_password = extensions.crypt('Pedro1234', encrypted_password) ok from auth.users where id = $1`, [u.id]);
    expect(auth.rows[0]).toEqual({ email: 'pedro@comanda.local', ok: true });
    await rpc('admin', 'admin_deactivate_user', { p_id: u.id });
    users.pedro = u.id;
    expect((await rpcError('pedro', 'get_tables')).code).toBe('PT401');
  });
});

describe('Flujo completo: mesero → cocina/bar → caja', () => {
  let orderId = 0;

  it('crea la orden y distribuye automáticamente comida a cocina y bebidas a bar', async () => {
    const o = await rpc('mesero', 'open_order', {
      p_table_id: tables[0].id,
      p_guests: 3,
      p_items: items([
        { productId: products['Hamburguesa clásica'], quantity: 2, notes: 'Una sin cebolla' },
        { productId: products['Orden de papas fritas'], quantity: 1 },
        { productId: products['Coca-Cola'], quantity: 2 },
        { productId: products['Limonada con hierbabuena'], quantity: 1 },
      ]),
    });
    orderId = o.id;
    const kt = (await rpc('cocina', 'kds_tickets', { p_area: 'KITCHEN' })).find((t) => t.order.id === orderId);
    expect(kt.items.map((i) => i.productName).sort()).toEqual(['Hamburguesa clásica', 'Orden de papas fritas']);
    const bt = (await rpc('bar', 'kds_tickets', { p_area: 'BAR' })).find((t) => t.order.id === orderId);
    expect(bt.items.map((i) => i.productName).sort()).toEqual(['Coca-Cola', 'Limonada con hierbabuena']);
    expect((await tableOf('mesero', tables[0].id)).status).toBe('IN_PREPARATION');
  });

  it('impide abrir una segunda orden en la misma mesa', async () => {
    expect((await rpcError('mesera2', 'open_order', { p_table_id: tables[0].id, p_guests: 1 })).code).toBe('PT409');
  });

  it('otro mesero y el cajero no pueden modificar la orden', async () => {
    const add = { p_order_id: orderId, p_items: items([{ productId: products['Coca-Cola'], quantity: 1 }]) };
    expect((await rpcError('mesera2', 'send_items', add)).code).toBe('PT403');
    expect((await rpcError('cajero', 'send_items', add)).code).toBe('PT403');
  });

  it('cocina marca productos individualmente; la mesa queda parcialmente lista y el mesero es notificado', async () => {
    const o = await rpc('mesero', 'get_order', { p_order_id: orderId });
    const burger = o.items.find((i) => i.productName === 'Hamburguesa clásica');
    const fries = o.items.find((i) => i.productName === 'Orden de papas fritas');
    await rpc('cocina', 'kds_set_items_status', { p_area: 'KITCHEN', p_item_ids: [burger.id], p_status: 'IN_PREPARATION' });
    await rpc('cocina', 'kds_set_items_status', { p_area: 'KITCHEN', p_item_ids: [fries.id], p_status: 'READY' });
    const notifs = await as('mesero', 'select * from public.notifications order by id desc');
    expect(notifs[0].type).toBe('ITEMS_READY');
    expect(notifs[0].title).toContain(tables[0].name);
    expect((await as('cocina', 'select * from public.notifications')).length).toBe(0); // cada uno ve solo las suyas
    expect((await tableOf('mesero', tables[0].id)).status).toBe('PARTIALLY_READY');
  });

  it('cocina no puede cambiar productos del bar', async () => {
    const o = await rpc('mesero', 'get_order', { p_order_id: orderId });
    const coke = o.items.find((i) => i.productName === 'Coca-Cola');
    expect((await rpcError('cocina', 'kds_set_items_status', { p_area: 'KITCHEN', p_item_ids: [coke.id], p_status: 'READY' })).code).toBe('PT403');
  });

  it('agregar productos crea una comanda nueva sin duplicar los enviados', async () => {
    const before = (await rpc('mesero', 'get_order', { p_order_id: orderId })).items.length;
    const o = await rpc('mesero', 'send_items', { p_order_id: orderId, p_items: items([{ productId: products['Tres leches'], quantity: 1 }]) });
    expect(o.items.length).toBe(before + 1);
    const lastBatch = o.batches[o.batches.length - 1];
    expect(o.items.filter((i) => i.batchId === lastBatch.id).map((i) => i.productName)).toEqual(['Tres leches']);
  });

  it('aumentar un producto en preparación envía solo la diferencia como solicitud nueva', async () => {
    let o = await rpc('mesero', 'get_order', { p_order_id: orderId });
    const burger = o.items.find((i) => i.productName === 'Hamburguesa clásica' && i.status === 'IN_PREPARATION');
    o = await rpc('mesero', 'update_order_item', { p_order_id: orderId, p_item_id: burger.id, p_quantity: 3 });
    expect(o.items.filter((i) => i.productName === 'Hamburguesa clásica').map((b) => [b.quantity, b.status])).toEqual([
      [2, 'IN_PREPARATION'],
      [1, 'PENDING'],
    ]);
  });

  it('disminuir deja registro de cancelación; cambiar notas marca el producto como modificado', async () => {
    let o = await rpc('mesero', 'get_order', { p_order_id: orderId });
    const coke = o.items.find((i) => i.productName === 'Coca-Cola');
    o = await rpc('mesero', 'update_order_item', { p_order_id: orderId, p_item_id: coke.id, p_quantity: 1, p_notes: 'Con hielo', p_set_notes: true, p_reason: 'Cliente cambió de opinión' });
    const cokes = o.items.filter((i) => i.productName === 'Coca-Cola');
    const live = cokes.find((c) => c.status === 'PENDING');
    expect(live.quantity).toBe(1);
    expect(live.modifiedAt).toBeTruthy();
    const cancelled = cokes.find((c) => c.status === 'CANCELLED');
    expect(cancelled.quantity).toBe(1);
    expect(cancelled.cancelReason).toBe('Cliente cambió de opinión');
  });

  it('eliminar exige motivo, cancela el producto y queda en el historial con usuario y fecha', async () => {
    const o = await rpc('mesero', 'get_order', { p_order_id: orderId });
    const lemonade = o.items.find((i) => i.productName === 'Limonada con hierbabuena');
    expect((await rpcError('mesero', 'cancel_order_item', { p_order_id: orderId, p_item_id: lemonade.id, p_reason: '' })).code).toBe('PT400');
    await rpc('mesero', 'cancel_order_item', { p_order_id: orderId, p_item_id: lemonade.id, p_reason: 'Error al tomar el pedido' });
    const hist = await rpc('mesero', 'get_order_history', { p_order_id: orderId });
    expect(hist.map((h) => h.action)).toEqual(
      expect.arrayContaining(['ORDER_OPENED', 'ITEMS_SENT', 'ITEMS_ADDED', 'ITEM_QTY_CHANGED', 'ITEM_NOTES_CHANGED', 'ITEM_CANCELLED', 'ITEM_STATUS_CHANGED']),
    );
    expect(hist[0].user.name).toBe('Carlos Mora');
    expect(hist[0].createdAt).toBeTruthy();
  });

  it('no permite pedir productos agotados', async () => {
    await rpc('bar', 'set_product_availability', { p_product_id: products['Mojito'], p_available: false });
    expect((await rpcError('mesero', 'send_items', { p_order_id: orderId, p_items: items([{ productId: products['Mojito'], quantity: 1 }]) })).code).toBe('PT409');
    await rpc('bar', 'set_product_availability', { p_product_id: products['Mojito'], p_available: true });
  });

  it('la mesa no queda lista con productos pendientes; "todo listo" por comanda notifica pedido completo', async () => {
    expect((await tableOf('mesero', tables[0].id)).status).not.toBe('READY');
    for (const area of ['KITCHEN', 'BAR']) {
      const user = area === 'KITCHEN' ? 'cocina' : 'bar';
      const tks = (await rpc(user, 'kds_tickets', { p_area: area })).filter((t) => t.order.id === orderId && t.state !== 'DONE');
      for (const t of tks) await rpc(user, 'kds_set_batch_status', { p_area: area, p_batch_id: t.batchId, p_status: 'READY' });
    }
    const notifs = await as('mesero', 'select * from public.notifications order by id desc');
    expect(notifs[0].type).toBe('ORDER_READY');
    expect((await tableOf('mesero', tables[0].id)).status).toBe('READY');
    await rpc('mesero', 'deliver_items', { p_order_id: orderId });
    expect((await tableOf('mesero', tables[0].id)).status).toBe('OCCUPIED');
  });

  it('calcula la cuenta con servicio 10% e IVA 13% y excluye cancelados', async () => {
    await rpc('mesero', 'request_bill', { p_order_id: orderId });
    const acc = await rpc('cajero', 'get_account', { p_order_id: orderId });
    const subtotal = 3 * 6200 + 2200 + 1500 + 3200;
    expect(Number(acc.totals.subtotal)).toBe(subtotal);
    expect(Number(acc.totals.service)).toBe(subtotal * 0.1);
    expect(Number(acc.totals.tax)).toBe(subtotal * 0.13);
    expect(Number(acc.totals.total)).toBe(subtotal * 1.23);
    expect(acc.cancelledItems.length).toBeGreaterThanOrEqual(2);
    expect((await tableOf('mesero', tables[0].id)).status).toBe('PENDING_PAYMENT');
  });

  it('exige caja abierta para cobrar', async () => {
    const e = await rpcError('cajero', 'register_payment', { p_order_id: orderId, p_payment_method_id: methods.CASH, p_split_mode: 'FULL', p_idempotency_key: 'no-cash-session-1' });
    expect(e.code).toBe('PT409');
    expect(e.message).toMatch(/abrir la caja/i);
  });

  let sessionId = 0;
  it('abre la caja (solo una vez)', async () => {
    const s = await rpc('cajero', 'cash_open', { p_opening_amount: 50000, p_notes: 'Fondo inicial' });
    sessionId = s.id;
    expect((await rpcError('cajero', 'cash_open', { p_opening_amount: 1000 })).code).toBe('PT409');
  });

  it('divide la cuenta: por consumo + partes iguales + pagos parciales, sin duplicados', async () => {
    let acc = await rpc('cajero', 'get_account', { p_order_id: orderId });
    const total = Number(acc.totals.total);
    const burger = acc.items.find((i) => i.productName === 'Hamburguesa clásica');
    const coke = acc.items.find((i) => i.productName === 'Coca-Cola');
    const byItems = {
      p_order_id: orderId, p_payment_method_id: methods.CARD, p_split_mode: 'ITEMS', p_payer_label: 'Persona 1',
      p_items: items([{ orderItemId: burger.id, quantity: 1 }, { orderItemId: coke.id, quantity: 1 }]), p_idempotency_key: 'pay-items-001',
    };
    const p1 = await rpc('cajero', 'register_payment', byItems);
    const expected1 = Math.round((6200 + 1500) * 1.23 * 100) / 100;
    expect(Number(p1.payment.amount)).toBeCloseTo(expected1, 2);

    const dup = await rpc('cajero', 'register_payment', byItems);
    expect(dup.duplicated).toBe(true);
    expect((await pool.query('select count(*)::int c from public.payments where order_id = $1', [orderId])).rows[0].c).toBe(1);

    expect((await rpcError('cajero', 'register_payment', { ...byItems, p_items: items([{ orderItemId: coke.id, quantity: 1 }]), p_idempotency_key: 'pay-items-002' })).code).toBe('PT409');

    const split = await rpc('cajero', 'split_equal', { p_order_id: orderId, p_parts: 2 });
    const amounts = split.amounts.map(Number);
    expect(amounts[0] + amounts[1]).toBeCloseTo(total - expected1, 2);

    expect((await rpcError('cajero', 'register_payment', { p_order_id: orderId, p_payment_method_id: methods.SINPE, p_split_mode: 'CUSTOM', p_amount: total, p_idempotency_key: 'pay-over-001' })).code).toBe('PT409');

    const p2 = await rpc('cajero', 'register_payment', { p_order_id: orderId, p_payment_method_id: methods.SINPE, p_split_mode: 'EQUAL', p_amount: amounts[0], p_payer_label: 'Persona 2', p_reference: 'SINPE-123', p_idempotency_key: 'pay-eq-001' });
    expect(p2.closed).toBe(false);
    expect(Number(p2.account.totals.balance)).toBeCloseTo(amounts[1], 2);
    expect((await tableOf('mesero', tables[0].id)).status).toBe('PENDING_PAYMENT');

    const p3 = await rpc('cajero', 'register_payment', {
      p_order_id: orderId, p_payment_method_id: methods.CASH, p_split_mode: 'EQUAL', p_amount: amounts[1],
      p_received_amount: Math.ceil(amounts[1] / 1000) * 1000 + 1000, p_payer_label: 'Persona 3', p_idempotency_key: 'pay-eq-002',
    });
    expect(p3.closed).toBe(true);
    expect(Number(p3.payment.changeAmount)).toBeGreaterThan(0);
    expect((await tableOf('mesero', tables[0].id)).status).toBe('AVAILABLE');

    const o = (await pool.query('select status, total from public.orders where id = $1', [orderId])).rows[0];
    expect(o.status).toBe('PAID');
    expect(Number(o.total)).toBeCloseTo(total, 2);
    expect((await pool.query(`select count(*)::int c from public.cash_movements m join public.payments p on p.id = m.payment_id where p.order_id = $1 and m.type = 'SALE'`, [orderId])).rows[0].c).toBe(3);
    expect((await rpcError('cajero', 'register_payment', { p_order_id: orderId, p_payment_method_id: methods.CASH, p_split_mode: 'FULL', p_idempotency_key: 'pay-after-close' })).code).toBe('PT409');

    const rec = await rpc('cajero', 'get_receipt', { p_order_id: orderId });
    expect(rec.order.payments.length).toBe(3);
  });

  it('registra movimientos de caja y cierra con arqueo correcto', async () => {
    await rpc('cajero', 'cash_add_movement', { p_session_id: sessionId, p_type: 'EXPENSE', p_amount: 5000, p_description: 'Compra de hielo' });
    await rpc('cajero', 'cash_add_movement', { p_session_id: sessionId, p_type: 'INCOME', p_amount: 10000, p_description: 'Fondo adicional' });
    expect((await rpcError('cajero', 'cash_add_movement', { p_session_id: sessionId, p_type: 'WITHDRAWAL', p_amount: 99999999, p_description: 'Retiro imposible' })).code).toBe('PT409');
    expect((await rpcError('cajero', 'cash_add_movement', { p_session_id: sessionId, p_type: 'ADJUSTMENT', p_amount: 100, p_description: 'Sin permiso' })).code).toBe('PT403');
    await rpc('admin', 'cash_add_movement', { p_session_id: sessionId, p_type: 'ADJUSTMENT', p_amount: -100, p_description: 'Ajuste autorizado por faltante' });

    const cur = await rpc('cajero', 'cash_current');
    const cashSales = Number((await pool.query(`select coalesce(sum(p.amount),0) s from public.payments p join public.payment_methods m on m.id = p.payment_method_id where p.cash_session_id = $1 and m.kind = 'CASH'`, [sessionId])).rows[0].s);
    const expected = 50000 + cashSales + 10000 - 5000 - 100;
    expect(Number(cur.summary.expectedCash)).toBeCloseTo(expected, 2);

    const close = await rpc('cajero', 'cash_close', { p_session_id: sessionId, p_counted_cash: expected - 500, p_notes: 'Faltante menor' });
    expect(Number(close.difference)).toBe(-500);
    expect(Number(close.cardSales)).toBeGreaterThan(0);
    expect(Number(close.transferSales)).toBeGreaterThan(0);
    expect((await rpcError('cajero', 'cash_close', { p_session_id: sessionId, p_counted_cash: 1 })).code).toBe('PT409');
    const hist = await rpc('cajero', 'cash_sessions_list');
    expect(hist.rows[0].closing).toBeTruthy();
  });

  it('los reportes solo cuentan ventas registradas (no anuladas ni pendientes)', async () => {
    await rpc('mesero', 'open_order', { p_table_id: tables[1].id, p_guests: 2, p_items: items([{ productId: products['Lomito a la parrilla'], quantity: 2 }]) });
    const toCancel = await rpc('mesero', 'open_order', { p_table_id: tables[2].id, p_guests: 1, p_items: items([{ productId: products['Ceviche de pescado'], quantity: 1 }]) });
    await rpc('admin', 'cancel_order', { p_order_id: toCancel.id, p_reason: 'Cliente se retiró' });

    const today = (await pool.query(`select (now() at time zone 'America/Costa_Rica')::date::text d`)).rows[0].d;
    const r = await rpc('admin', 'report_sales', { p_from: today, p_to: today });
    const paid = (await pool.query('select total from public.orders where id = $1', [orderId])).rows[0];
    expect(r.kpis.orders).toBe(1);
    expect(Number(r.kpis.totalSales)).toBeCloseTo(Number(paid.total), 2);
    expect(r.kpis.cancelledOrders).toBe(1);
    expect(r.topProducts[0].name).toBe('Hamburguesa clásica');
    expect(r.byPaymentMethod.length).toBe(3);
    expect(r.byWaiter[0].name).toBe('Carlos Mora');
    expect(r.byDay.length).toBe(1);
    expect(r.monthly.length).toBe(12);
    expect((await rpcError('mesero', 'report_sales', { p_from: today, p_to: today })).code).toBe('PT403');
    const dash = await rpc('admin', 'report_dashboard');
    expect(dash.today.orders).toBe(1);
  });

  it('registra la bitácora de acciones importantes', async () => {
    const r = await rpc('admin', 'audit_list', { p_page_size: 200 });
    expect(r.rows.map((x) => x.action)).toEqual(expect.arrayContaining(['PAYMENT_REGISTERED', 'CASH_OPENED', 'CASH_CLOSED', 'CASH_EXPENSE', 'PRODUCT_SOLD_OUT', 'USER_CREATED']));
  });
});
