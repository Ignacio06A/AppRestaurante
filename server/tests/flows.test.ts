import http from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import { io as ioClient, Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { initRealtime } from '../src/realtime';
import { prisma } from '../src/db';

const app = createApp();
const server = http.createServer(app);
initRealtime(server);
let baseUrl = '';

type Agent = ReturnType<typeof request.agent>;
const agents: Record<string, { agent: Agent; token: string }> = {};

async function login(username: string, password: string) {
  const agent = request.agent(server);
  const r = await agent.post('/api/auth/login').send({ username, password });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { agent, token: r.body.token as string };
}

function socketFor(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = ioClient(baseUrl, { auth: { token }, transports: ['websocket'], forceNew: true });
    s.on('hello', () => resolve(s));
    s.on('connect_error', reject);
  });
}

function waitFor<T = unknown>(s: Socket, event: string, predicate: (p: T) => boolean = () => true, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout esperando ${event}`)), ms);
    const h = (p: T) => {
      if (predicate(p)) {
        clearTimeout(t);
        s.off(event, h);
        resolve(p);
      }
    };
    s.on(event, h);
  });
}

const W = () => agents.mesero.agent;
const K = () => agents.cocina.agent;
const B = () => agents.bar.agent;
const C = () => agents.cajero.agent;
const A = () => agents.admin.agent;

let productIds: Record<string, number> = {};
let tables: { id: number; name: string }[] = [];
const sockets: Socket[] = [];

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  agents.admin = await login('admin', 'Admin123');
  agents.mesero = await login('mesero', 'Mesero123');
  agents.mesera2 = await login('mesera2', 'Mesero123');
  agents.cocina = await login('cocina', 'Cocina123');
  agents.bar = await login('bar', 'Bar12345');
  agents.cajero = await login('cajero', 'Cajero123');
  const products = await prisma.product.findMany();
  productIds = Object.fromEntries(products.map((p) => [p.name, p.id]));
  tables = await prisma.diningTable.findMany({ orderBy: { number: 'asc' } });
});

afterAll(async () => {
  sockets.forEach((s) => s.close());
  await new Promise((r) => server.close(r));
  await prisma.$disconnect();
});

describe('Autenticación y control de acceso', () => {
  it('rechaza credenciales incorrectas y solicitudes sin sesión', async () => {
    expect((await request(server).post('/api/auth/login').send({ username: 'admin', password: 'x' })).status).toBe(401);
    expect((await request(server).get('/api/tables')).status).toBe(401);
  });

  it('devuelve el usuario con su rol y permisos', async () => {
    const r = await W().get('/api/auth/me');
    expect(r.body.role).toBe('WAITER');
    expect(r.body.permissions).toContain('orders.create');
    expect(r.body.permissions).not.toContain('payments.create');
  });

  it('cocina no puede registrar pagos, modificar precios ni ver el bar', async () => {
    expect((await K().post('/api/cashier/orders/1/payments').send({ paymentMethodId: 1, idempotencyKey: 'xxxxxxxxxx' })).status).toBe(403);
    expect((await K().put(`/api/products/${productIds['Coca-Cola']}`).send({ price: 1 })).status).toBe(403);
    expect((await K().get('/api/kds/BAR/tickets')).status).toBe(403);
    expect((await B().get('/api/kds/KITCHEN/tickets')).status).toBe(403);
  });

  it('el administrador no puede otorgar permisos de pago al rol Cocina', async () => {
    const roles = (await A().get('/api/admin/roles')).body as { id: number; code: string; permissions: string[] }[];
    const kitchen = roles.find((r) => r.code === 'KITCHEN')!;
    const r = await A().put(`/api/admin/roles/${kitchen.id}/permissions`).send({ permissions: [...kitchen.permissions, 'payments.create'] });
    expect(r.status).toBe(400);
  });
});

describe('Flujo completo: mesero → cocina/bar → caja', () => {
  let orderId = 0;
  let waiterSocket: Socket;
  let kitchenSocket: Socket;
  let barSocket: Socket;

  beforeAll(async () => {
    waiterSocket = await socketFor(agents.mesero.token);
    kitchenSocket = await socketFor(agents.cocina.token);
    barSocket = await socketFor(agents.bar.token);
    sockets.push(waiterSocket, kitchenSocket, barSocket);
  });

  it('crea la orden y distribuye automáticamente: comida a cocina y bebidas a bar (en tiempo real)', async () => {
    const kNew = waitFor<{ orderId: number }>(kitchenSocket, 'kds:ticket-new');
    const bNew = waitFor<{ orderId: number }>(barSocket, 'kds:ticket-new');
    const r = await W()
      .post('/api/orders')
      .send({
        tableId: tables[0].id,
        guests: 3,
        items: [
          { productId: productIds['Hamburguesa clásica'], quantity: 2, notes: 'Una sin cebolla' },
          { productId: productIds['Orden de papas fritas'], quantity: 1 },
          { productId: productIds['Coca-Cola'], quantity: 2 },
          { productId: productIds['Limonada con hierbabuena'], quantity: 1 },
        ],
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    orderId = r.body.id;
    expect((await kNew).orderId).toBe(orderId);
    expect((await bNew).orderId).toBe(orderId);

    const kt = (await K().get('/api/kds/KITCHEN/tickets')).body as { order: { id: number }; items: { productName: string; quantity: number }[] }[];
    const kitchenTicket = kt.find((t) => t.order.id === orderId)!;
    expect(kitchenTicket.items.map((i) => i.productName).sort()).toEqual(['Hamburguesa clásica', 'Orden de papas fritas']);

    const bt = (await B().get('/api/kds/BAR/tickets')).body as typeof kt;
    const barTicket = bt.find((t) => t.order.id === orderId)!;
    expect(barTicket.items.map((i) => i.productName).sort()).toEqual(['Coca-Cola', 'Limonada con hierbabuena']);

    const t = (await W().get('/api/tables')).body.find((x: { id: number }) => x.id === tables[0].id);
    expect(t.status).toBe('IN_PREPARATION');
  });

  it('impide abrir una segunda orden en la misma mesa', async () => {
    const r = await agents.mesera2.agent.post('/api/orders').send({ tableId: tables[0].id, guests: 1 });
    expect(r.status).toBe(409);
  });

  it('otro mesero no puede modificar la orden ajena', async () => {
    const r = await agents.mesera2.agent.post(`/api/orders/${orderId}/items`).send({ items: [{ productId: productIds['Coca-Cola'], quantity: 1 }] });
    expect(r.status).toBe(403);
  });

  it('el cajero no puede modificar pedidos', async () => {
    const r = await C().post(`/api/orders/${orderId}/items`).send({ items: [{ productId: productIds['Coca-Cola'], quantity: 1 }] });
    expect(r.status).toBe(403);
  });

  it('cocina marca productos individualmente; la orden queda parcialmente lista y el mesero es notificado', async () => {
    const order = (await W().get(`/api/orders/${orderId}`)).body;
    const burger = order.items.find((i: { productName: string }) => i.productName === 'Hamburguesa clásica');
    const fries = order.items.find((i: { productName: string }) => i.productName === 'Orden de papas fritas');

    expect((await K().patch(`/api/kds/KITCHEN/items/${burger.id}`).send({ status: 'IN_PREPARATION' })).status).toBe(200);
    const notif = waitFor<{ title: string; type: string }>(waiterSocket, 'notification:new');
    expect((await K().patch(`/api/kds/KITCHEN/items/${fries.id}`).send({ status: 'READY' })).status).toBe(200);
    const n = await notif;
    expect(n.type).toBe('ITEMS_READY');
    expect(n.title).toContain(tables[0].name);

    const t = (await W().get('/api/tables')).body.find((x: { id: number }) => x.id === tables[0].id);
    expect(t.status).toBe('PARTIALLY_READY');
  });

  it('no se puede cambiar un producto cancelado o de otra área', async () => {
    const order = (await W().get(`/api/orders/${orderId}`)).body;
    const coke = order.items.find((i: { productName: string }) => i.productName === 'Coca-Cola');
    expect((await K().patch(`/api/kds/KITCHEN/items/${coke.id}`).send({ status: 'READY' })).status).toBe(403);
  });

  it('modifica la orden: agrega productos nuevos sin duplicar los enviados', async () => {
    const before = await prisma.orderItem.count({ where: { orderId } });
    const kNew = waitFor<{ orderId: number; batchId: number }>(kitchenSocket, 'kds:ticket-new');
    const r = await W().post(`/api/orders/${orderId}/items`).send({ items: [{ productId: productIds['Tres leches'], quantity: 1 }] });
    expect(r.status).toBe(201);
    const ev = await kNew;
    const after = await prisma.orderItem.count({ where: { orderId } });
    expect(after).toBe(before + 1);
    const batchItems = await prisma.orderItem.findMany({ where: { batchId: ev.batchId } });
    expect(batchItems.map((i) => i.productName)).toEqual(['Tres leches']);
  });

  it('aumentar cantidad de un producto en preparación crea solo la diferencia como solicitud nueva', async () => {
    const order = (await W().get(`/api/orders/${orderId}`)).body;
    const burger = order.items.find((i: { productName: string; status: string }) => i.productName === 'Hamburguesa clásica' && i.status === 'IN_PREPARATION');
    const r = await W().patch(`/api/orders/${orderId}/items/${burger.id}`).send({ quantity: 3 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const burgers = r.body.items.filter((i: { productName: string }) => i.productName === 'Hamburguesa clásica');
    expect(burgers.map((b: { quantity: number; status: string }) => [b.quantity, b.status])).toEqual([
      [2, 'IN_PREPARATION'],
      [1, 'PENDING'],
    ]);
  });

  it('disminuir cantidad deja registro de la cancelación; cambiar notas marca el producto como modificado', async () => {
    const order = (await W().get(`/api/orders/${orderId}`)).body;
    const coke = order.items.find((i: { productName: string }) => i.productName === 'Coca-Cola');
    const r = await W().patch(`/api/orders/${orderId}/items/${coke.id}`).send({ quantity: 1, notes: 'Con hielo', reason: 'Cliente cambió de opinión' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const cokes = r.body.items.filter((i: { productName: string }) => i.productName === 'Coca-Cola');
    expect(cokes.find((c: { status: string }) => c.status === 'PENDING').quantity).toBe(1);
    expect(cokes.find((c: { status: string }) => c.status === 'PENDING').modifiedAt).toBeTruthy();
    const cancelled = cokes.find((c: { status: string }) => c.status === 'CANCELLED');
    expect(cancelled.quantity).toBe(1);
    expect(cancelled.cancelReason).toBe('Cliente cambió de opinión');
  });

  it('eliminar un producto lo cancela (con motivo) y queda en el historial con usuario y fecha', async () => {
    const order = (await W().get(`/api/orders/${orderId}`)).body;
    const lemonade = order.items.find((i: { productName: string }) => i.productName === 'Limonada con hierbabuena');
    expect((await W().delete(`/api/orders/${orderId}/items/${lemonade.id}`).send({})).status).toBe(400);
    const r = await W().delete(`/api/orders/${orderId}/items/${lemonade.id}`).send({ reason: 'Error al tomar el pedido' });
    expect(r.status).toBe(200);
    const hist = (await W().get(`/api/orders/${orderId}/history`)).body as { action: string; user: { name: string }; createdAt: string }[];
    const actions = hist.map((h) => h.action);
    expect(actions).toEqual(expect.arrayContaining(['ORDER_OPENED', 'ITEMS_SENT', 'ITEMS_ADDED', 'ITEM_QTY_CHANGED', 'ITEM_NOTES_CHANGED', 'ITEM_CANCELLED', 'ITEM_STATUS_CHANGED']));
    expect(hist[0].user.name).toBe('Carlos Mora');
    expect(hist[0].createdAt).toBeTruthy();
  });

  it('no permite pedir productos agotados', async () => {
    const pid = productIds['Mojito'];
    expect((await B().patch(`/api/products/${pid}/availability`).send({ available: false })).status).toBe(200);
    const r = await W().post(`/api/orders/${orderId}/items`).send({ items: [{ productId: pid, quantity: 1 }] });
    expect(r.status).toBe(409);
    await B().patch(`/api/products/${pid}/availability`).send({ available: true });
  });

  it('la orden no queda lista mientras existan productos pendientes; "todo listo" por comanda', async () => {
    const tickets = (await K().get('/api/kds/KITCHEN/tickets')).body as { batchId: number; order: { id: number }; state: string }[];
    const mine = tickets.filter((t) => t.order.id === orderId && t.state !== 'DONE');
    expect(mine.length).toBeGreaterThan(0);
    let t = (await W().get('/api/tables')).body.find((x: { id: number }) => x.id === tables[0].id);
    expect(t.status).not.toBe('READY');
    const notif = waitFor<{ type: string }>(waiterSocket, 'notification:new', (n) => n.type === 'ORDER_READY');
    for (const tk of mine) expect((await K().post(`/api/kds/KITCHEN/batches/${tk.batchId}/status`).send({ status: 'READY' })).status).toBe(200);
    const barTk = ((await B().get('/api/kds/BAR/tickets')).body as typeof tickets).filter((x) => x.order.id === orderId && x.state !== 'DONE');
    for (const tk of barTk) expect((await B().post(`/api/kds/BAR/batches/${tk.batchId}/status`).send({ status: 'READY' })).status).toBe(200);
    await notif;
    t = (await W().get('/api/tables')).body.find((x: { id: number }) => x.id === tables[0].id);
    expect(t.status).toBe('READY');
    expect((await W().post(`/api/orders/${orderId}/deliver`).send({})).status).toBe(200);
    t = (await W().get('/api/tables')).body.find((x: { id: number }) => x.id === tables[0].id);
    expect(t.status).toBe('OCCUPIED');
  });

  it('calcula la cuenta: subtotal, servicio 10%, IVA 13% y excluye cancelados', async () => {
    expect((await W().post(`/api/orders/${orderId}/request-bill`)).status).toBe(200);
    const acc = (await C().get(`/api/cashier/orders/${orderId}/account`)).body;
    // 3 hamburguesas (6200) + papas (2200) + 1 coca (1500) + tres leches (3200)
    const subtotal = 3 * 6200 + 2200 + 1500 + 3200;
    expect(acc.totals.subtotal).toBe(subtotal);
    expect(acc.totals.service).toBe(subtotal * 0.1);
    expect(acc.totals.tax).toBe(subtotal * 0.13);
    expect(acc.totals.total).toBe(subtotal * 1.23);
    expect(acc.cancelledItems.length).toBeGreaterThanOrEqual(2);
    const t = (await W().get('/api/tables')).body.find((x: { id: number }) => x.id === tables[0].id);
    expect(t.status).toBe('PENDING_PAYMENT');
  });

  it('exige caja abierta para cobrar', async () => {
    const r = await C().post(`/api/cashier/orders/${orderId}/payments`).send({ paymentMethodId: 1, splitMode: 'FULL', idempotencyKey: 'no-cash-session-1' });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/abrir la caja/i);
  });

  let sessionId = 0;
  it('abre la caja', async () => {
    const r = await C().post('/api/cash/open').send({ openingAmount: 50000, notes: 'Fondo inicial' });
    expect(r.status).toBe(201);
    sessionId = r.body.id;
    expect((await C().post('/api/cash/open').send({ openingAmount: 1000 })).status).toBe(409);
  });

  it('divide la cuenta: pago por productos consumidos + partes iguales + pagos parciales, sin duplicados', async () => {
    const methods = (await C().get('/api/payment-methods')).body as { id: number; code: string }[];
    const cash = methods.find((m) => m.code === 'CASH')!;
    const card = methods.find((m) => m.code === 'CARD')!;
    const sinpe = methods.find((m) => m.code === 'SINPE')!;
    let acc = (await C().get(`/api/cashier/orders/${orderId}/account`)).body;
    const total = acc.totals.total;

    // Persona 1 paga lo que consumió: 1 hamburguesa + la coca
    const burger = acc.items.find((i: { productName: string }) => i.productName === 'Hamburguesa clásica');
    const coke = acc.items.find((i: { productName: string }) => i.productName === 'Coca-Cola');
    const p1 = await C()
      .post(`/api/cashier/orders/${orderId}/payments`)
      .send({ paymentMethodId: card.id, splitMode: 'ITEMS', payerLabel: 'Persona 1', items: [{ orderItemId: burger.id, quantity: 1 }, { orderItemId: coke.id, quantity: 1 }], idempotencyKey: 'pay-items-001' });
    expect(p1.status, JSON.stringify(p1.body)).toBe(201);
    const expected1 = Math.round((6200 + 1500) * 1.23 * 100) / 100;
    expect(Number(p1.body.payment.amount)).toBeCloseTo(expected1, 2);

    // Reintento con la misma clave: no se duplica la venta
    const dup = await C()
      .post(`/api/cashier/orders/${orderId}/payments`)
      .send({ paymentMethodId: card.id, splitMode: 'ITEMS', payerLabel: 'Persona 1', items: [{ orderItemId: burger.id, quantity: 1 }], idempotencyKey: 'pay-items-001' });
    expect(dup.status).toBe(200);
    expect(dup.body.duplicated).toBe(true);
    expect(await prisma.payment.count({ where: { orderId } })).toBe(1);

    // No se puede volver a pagar la coca
    const again = await C()
      .post(`/api/cashier/orders/${orderId}/payments`)
      .send({ paymentMethodId: card.id, splitMode: 'ITEMS', items: [{ orderItemId: coke.id, quantity: 1 }], idempotencyKey: 'pay-items-002' });
    expect(again.status).toBe(409);

    // El resto se divide en 2 partes iguales
    const split = (await C().get(`/api/cashier/orders/${orderId}/split?parts=2`)).body;
    expect(split.amounts.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(total - expected1, 2);

    // No se permite pagar más que el saldo
    const over = await C().post(`/api/cashier/orders/${orderId}/payments`).send({ paymentMethodId: sinpe.id, splitMode: 'CUSTOM', amount: total, idempotencyKey: 'pay-over-001' });
    expect(over.status).toBe(409);

    const p2 = await C().post(`/api/cashier/orders/${orderId}/payments`).send({ paymentMethodId: sinpe.id, splitMode: 'EQUAL', amount: split.amounts[0], payerLabel: 'Persona 2', reference: 'SINPE-123', idempotencyKey: 'pay-eq-001' });
    expect(p2.status).toBe(201);
    expect(p2.body.closed).toBe(false);
    acc = p2.body.account;
    expect(acc.totals.balance).toBeCloseTo(split.amounts[1], 2);
    let t = (await W().get('/api/tables')).body.find((x: { id: number }) => x.id === tables[0].id);
    expect(t.status).toBe('PENDING_PAYMENT');

    // Último pago en efectivo con vuelto → cierra la cuenta y libera la mesa
    const tablesEvent = waitFor(waiterSocket, 'tables:updated');
    const p3 = await C()
      .post(`/api/cashier/orders/${orderId}/payments`)
      .send({ paymentMethodId: cash.id, splitMode: 'EQUAL', amount: split.amounts[1], receivedAmount: Math.ceil(split.amounts[1] / 1000) * 1000 + 1000, payerLabel: 'Persona 3', idempotencyKey: 'pay-eq-002' });
    expect(p3.status, JSON.stringify(p3.body)).toBe(201);
    expect(p3.body.closed).toBe(true);
    expect(Number(p3.body.payment.changeAmount)).toBeGreaterThan(0);
    await tablesEvent;
    t = (await W().get('/api/tables')).body.find((x: { id: number }) => x.id === tables[0].id);
    expect(t.status).toBe('AVAILABLE');

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PAID');
    expect(Number(order.total)).toBeCloseTo(total, 2);
    expect(await prisma.cashMovement.count({ where: { payment: { orderId }, type: 'SALE' } })).toBe(3);

    // Una cuenta pagada no acepta más pagos
    expect((await C().post(`/api/cashier/orders/${orderId}/payments`).send({ paymentMethodId: cash.id, splitMode: 'FULL', idempotencyKey: 'pay-after-close' })).status).toBe(409);

    // Comprobante
    const rec = await C().get(`/api/cashier/orders/${orderId}/receipt`);
    expect(rec.status).toBe(200);
    expect(rec.body.order.payments.length).toBe(3);
  });

  it('registra movimientos de caja y cierra con arqueo correcto', async () => {
    expect((await C().post(`/api/cash/sessions/${sessionId}/movements`).send({ type: 'EXPENSE', amount: 5000, description: 'Compra de hielo' })).status).toBe(201);
    expect((await C().post(`/api/cash/sessions/${sessionId}/movements`).send({ type: 'INCOME', amount: 10000, description: 'Fondo adicional' })).status).toBe(201);
    expect((await C().post(`/api/cash/sessions/${sessionId}/movements`).send({ type: 'WITHDRAWAL', amount: 99999999, description: 'Retiro imposible' })).status).toBe(409);
    expect((await C().post(`/api/cash/sessions/${sessionId}/movements`).send({ type: 'ADJUSTMENT', amount: 100, description: 'Sin permiso' })).status).toBe(403);
    expect((await A().post(`/api/cash/sessions/${sessionId}/movements`).send({ type: 'ADJUSTMENT', amount: -100, description: 'Ajuste autorizado por faltante' })).status).toBe(201);

    const cur = (await C().get('/api/cash/current')).body;
    const payments = await prisma.payment.findMany({ where: { cashSessionId: sessionId }, include: { paymentMethod: true } });
    const cashSales = payments.filter((p) => p.paymentMethod.kind === 'CASH').reduce((a, p) => a + Number(p.amount), 0);
    const expected = 50000 + cashSales + 10000 - 5000 - 100;
    expect(cur.summary.expectedCash).toBeCloseTo(expected, 2);

    const close = await C().post(`/api/cash/sessions/${sessionId}/close`).send({ countedCash: expected - 500, notes: 'Faltante menor' });
    expect(close.status).toBe(200);
    expect(Number(close.body.difference)).toBe(-500);
    expect(Number(close.body.cardSales)).toBeGreaterThan(0);
    expect(Number(close.body.transferSales)).toBeGreaterThan(0);
    expect((await C().post(`/api/cash/sessions/${sessionId}/close`).send({ countedCash: 1 })).status).toBe(409);
    const hist = (await C().get('/api/cash/sessions')).body;
    expect(hist.rows[0].closing).toBeTruthy();
  });

  it('los reportes solo cuentan ventas registradas (no órdenes anuladas ni pendientes)', async () => {
    // Orden pendiente en otra mesa y una anulada: no deben sumar
    const pending = await W().post('/api/orders').send({ tableId: tables[1].id, guests: 2, items: [{ productId: productIds['Lomito a la parrilla'], quantity: 2 }] });
    expect(pending.status).toBe(201);
    const toCancel = await W().post('/api/orders').send({ tableId: tables[2].id, guests: 1, items: [{ productId: productIds['Ceviche de pescado'], quantity: 1 }] });
    expect((await A().post(`/api/orders/${toCancel.body.id}/cancel`).send({ reason: 'Cliente se retiró' })).status).toBe(200);

    const r = (await A().get('/api/reports/sales')).body;
    const paid = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(r.kpis.orders).toBe(1);
    expect(r.kpis.totalSales).toBeCloseTo(Number(paid.total), 2);
    expect(r.kpis.cancelledOrders).toBe(1);
    expect(r.topProducts[0].name).toBe('Hamburguesa clásica');
    expect(r.byPaymentMethod.length).toBe(3);
    expect(r.byWaiter[0].name).toBe('Carlos Mora');

    expect((await W().get('/api/reports/sales')).status).toBe(403);

    const pdf = await A().get('/api/reports/sales/export?format=pdf').buffer(true);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    const xlsx = await A().get('/api/reports/sales/export?format=xlsx').buffer(true);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
  });

  it('registra la bitácora de auditoría de acciones importantes', async () => {
    const r = (await A().get('/api/audit?pageSize=200')).body;
    const actions = r.rows.map((x: { action: string }) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['LOGIN', 'PAYMENT_REGISTERED', 'CASH_OPENED', 'CASH_CLOSED', 'CASH_EXPENSE']));
  });
});
