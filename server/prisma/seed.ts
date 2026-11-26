/* eslint-disable no-console */
import { PrismaClient, PaymentMethodKind, Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLE_LABELS, RoleCode } from '../src/lib/permissions';
import { computeTotals } from '../src/lib/orderCalc';

const prisma = new PrismaClient();

const USERS: { name: string; username: string; password: string; role: RoleCode }[] = [
  { name: 'Administrador General', username: 'admin', password: 'Admin123', role: 'ADMIN' },
  { name: 'Carlos Mora', username: 'mesero', password: 'Mesero123', role: 'WAITER' },
  { name: 'Ana Jiménez', username: 'mesera2', password: 'Mesero123', role: 'WAITER' },
  { name: 'Luis Vargas', username: 'cocina', password: 'Cocina123', role: 'KITCHEN' },
  { name: 'Sofía Rojas', username: 'bar', password: 'Bar12345', role: 'BAR' },
  { name: 'María Solís', username: 'cajero', password: 'Cajero123', role: 'CASHIER' },
];

const CATEGORIES: { name: string; area: 'KITCHEN' | 'BAR'; products: [string, string, number][] }[] = [
  {
    name: 'Entradas',
    area: 'KITCHEN',
    products: [
      ['Patacones con frijolitos', 'Plátano verde frito, frijol molido y pico de gallo', 3800],
      ['Ceviche de pescado', 'Corvina marinada en limón, culantro y chile dulce', 5200],
      ['Chifrijo', 'Arroz, frijoles, chicharrón, pico de gallo y aguacate', 4900],
      ['Nachos de la casa', 'Totopos con queso, frijol, carne y guacamole', 5600],
    ],
  },
  {
    name: 'Platos fuertes',
    area: 'KITCHEN',
    products: [
      ['Casado con pollo', 'Arroz, frijoles, ensalada, plátano maduro y pollo a la plancha', 5900],
      ['Casado con bistec', 'Arroz, frijoles, ensalada, plátano maduro y bistec encebollado', 6500],
      ['Arroz con pollo', 'Arroz con pollo tradicional, papas tostadas y ensalada', 5400],
      ['Hamburguesa clásica', 'Carne 180 g, queso cheddar, lechuga, tomate y salsa de la casa', 6200],
      ['Filete de pescado al ajillo', 'Filete de corvina en mantequilla de ajo, arroz y vegetales', 8900],
      ['Lomito a la parrilla', 'Lomito 250 g, chimichurri, papas y ensalada', 12500],
    ],
  },
  {
    name: 'Acompañamientos',
    area: 'KITCHEN',
    products: [
      ['Orden de papas fritas', 'Papas fritas crujientes', 2200],
      ['Yuca frita', 'Yuca frita con chimichurri', 2400],
      ['Ensalada verde', 'Lechuga, tomate, pepino y vinagreta', 2500],
      ['Gallo pinto', 'Arroz y frijoles salteados con natilla', 2300],
    ],
  },
  {
    name: 'Postres',
    area: 'KITCHEN',
    products: [
      ['Tres leches', 'Queque bañado en tres leches con canela', 3200],
      ['Flan de coco', 'Flan casero con coco rallado', 2900],
      ['Brownie con helado', 'Brownie tibio con helado de vainilla', 3600],
    ],
  },
  {
    name: 'Bebidas frías',
    area: 'BAR',
    products: [
      ['Refresco natural', 'Cas, mora, fresa, piña o maracuyá', 1800],
      ['Limonada con hierbabuena', 'Limonada frapé con hierbabuena', 2200],
      ['Coca-Cola', 'Lata 355 ml', 1500],
      ['Agua mineral', 'Botella 500 ml', 1300],
      ['Cerveza nacional', 'Botella 350 ml', 2000],
    ],
  },
  {
    name: 'Bebidas calientes',
    area: 'BAR',
    products: [
      ['Café chorreado', 'Café costarricense de altura', 1500],
      ['Cappuccino', 'Espresso con leche espumada', 2300],
      ['Chocolate caliente', 'Chocolate con leche', 2100],
    ],
  },
  {
    name: 'Cócteles',
    area: 'BAR',
    products: [
      ['Guaro sour', 'Guaro, limón y azúcar', 3500],
      ['Mojito', 'Ron, hierbabuena, limón y soda', 4200],
      ['Piña colada', 'Ron, crema de coco y piña', 4500],
      ['Margarita', 'Tequila, triple sec y limón', 4500],
    ],
  },
  {
    name: 'Otros',
    area: 'KITCHEN',
    products: [['Porción de pan', 'Pan artesanal con mantequilla', 1200]],
  },
];

const PAYMENT_METHODS: { code: string; name: string; kind: PaymentMethodKind; sortOrder: number }[] = [
  { code: 'CASH', name: 'Efectivo', kind: 'CASH', sortOrder: 1 },
  { code: 'CARD', name: 'Tarjeta', kind: 'CARD', sortOrder: 2 },
  { code: 'SINPE', name: 'SINPE Móvil', kind: 'TRANSFER', sortOrder: 3 },
  { code: 'TRANSFER', name: 'Transferencia bancaria', kind: 'TRANSFER', sortOrder: 4 },
  { code: 'VOUCHER', name: 'Vale / Cupón', kind: 'OTHER', sortOrder: 5 },
];

async function seedBase() {
  // Permisos
  for (const [code, p] of Object.entries(PERMISSIONS)) {
    await prisma.permission.upsert({ where: { code }, update: { description: p.description, module: p.module }, create: { code, description: p.description, module: p.module } });
  }
  const perms = await prisma.permission.findMany();
  const permId = new Map(perms.map((p) => [p.code, p.id]));

  // Roles (permisos por defecto solo al crear el rol; luego los administra el admin)
  for (const code of Object.keys(ROLE_LABELS) as RoleCode[]) {
    const existing = await prisma.role.findUnique({ where: { code } });
    if (existing) continue;
    await prisma.role.create({
      data: {
        code,
        name: ROLE_LABELS[code],
        permissions: { create: DEFAULT_ROLE_PERMISSIONS[code].map((c) => ({ permissionId: permId.get(c)! })) },
      },
    });
  }
  const roles = new Map((await prisma.role.findMany()).map((r) => [r.code, r.id]));

  for (const u of USERS) {
    await prisma.user.upsert({
      where: { username: u.username },
      update: {},
      create: { name: u.name, username: u.username, passwordHash: await bcrypt.hash(u.password, 10), roleId: roles.get(u.role)! },
    });
  }

  await prisma.preparationArea.upsert({ where: { code: 'KITCHEN' }, update: {}, create: { code: 'KITCHEN', name: 'Cocina' } });
  await prisma.preparationArea.upsert({ where: { code: 'BAR' }, update: {}, create: { code: 'BAR', name: 'Bar' } });
  const areas = new Map((await prisma.preparationArea.findMany()).map((a) => [a.code, a.id]));

  let catOrder = 1;
  for (const c of CATEGORIES) {
    const cat = await prisma.category.upsert({
      where: { name: c.name },
      update: {},
      create: { name: c.name, sortOrder: catOrder++, defaultAreaId: areas.get(c.area) },
    });
    let pOrder = 1;
    for (const [name, description, price] of c.products) {
      const exists = await prisma.product.findFirst({ where: { name, categoryId: cat.id } });
      if (!exists) {
        await prisma.product.create({ data: { name, description, price, categoryId: cat.id, areaId: areas.get(c.area)!, sortOrder: pOrder } });
      }
      pOrder++;
    }
  }

  const zones = ['Salón', 'Salón', 'Salón', 'Salón', 'Salón', 'Salón', 'Terraza', 'Terraza', 'Terraza', 'Terraza', 'Barra', 'Barra'];
  for (let i = 1; i <= 12; i++) {
    await prisma.diningTable.upsert({
      where: { number: i },
      update: {},
      create: { number: i, name: i > 10 ? `Barra ${i - 10}` : `Mesa ${i}`, zone: zones[i - 1], capacity: i > 10 ? 2 : i % 3 === 0 ? 6 : 4 },
    });
  }

  for (const pm of PAYMENT_METHODS) {
    await prisma.paymentMethod.upsert({ where: { code: pm.code }, update: {}, create: pm });
  }
  await prisma.cashRegister.upsert({ where: { name: 'Caja Principal' }, update: {}, create: { name: 'Caja Principal' } });
  await prisma.restaurantSettings.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      name: 'Restaurante La Esquina Tica',
      legalName: 'La Esquina Tica S.A.',
      legalId: '3-101-000000',
      address: 'San José, Costa Rica',
      phone: '+506 2222-0000',
      taxRate: 13,
      serviceRate: 10,
      pricesIncludeTax: false,
      receiptFooter: '¡Gracias por su visita! Pura vida.',
    },
  });
}

/** Historial de ventas de demostración (60 días) para que los reportes muestren datos. */
async function seedDemoSales() {
  if ((await prisma.order.count()) > 0) {
    console.log('  · Ya existen órdenes: se omite el historial de demostración');
    return;
  }
  const settings = await prisma.restaurantSettings.findUniqueOrThrow({ where: { id: 1 } });
  const waiters = await prisma.user.findMany({ where: { role: { code: 'WAITER' } } });
  const cashier = await prisma.user.findUniqueOrThrow({ where: { username: 'cajero' } });
  const products = await prisma.product.findMany({ include: { area: true } });
  const food = products.filter((p) => p.area.code === 'KITCHEN');
  const drinks = products.filter((p) => p.area.code === 'BAR');
  const tables = await prisma.diningTable.findMany();
  const methods = await prisma.paymentMethod.findMany();
  const register = await prisma.cashRegister.findFirstOrThrow();

  let seed = 42;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const DAY = 86_400_000;
  const today = new Date();
  today.setUTCHours(6, 0, 0, 0); // medianoche Costa Rica (UTC-6)

  for (let d = 60; d >= 1; d--) {
    const base = new Date(today.getTime() - d * DAY);
    const weekday = new Date(base.getTime() + 12 * 3600_000).getUTCDay();
    const ordersToday = Math.round((weekday === 5 || weekday === 6 ? 26 : weekday === 0 ? 20 : 14) * (0.8 + rnd() * 0.4));
    const opening = 50_000;
    const session = await prisma.cashSession.create({
      data: { registerId: register.id, openedById: cashier.id, openedAt: new Date(base.getTime() + 10.5 * 3600_000), openingAmount: opening, status: 'CLOSED' },
    });
    const byKind = { CASH: 0, CARD: 0, TRANSFER: 0, OTHER: 0 };
    for (let o = 0; o < ordersToday; o++) {
      const hourWeights = [11, 12, 12, 13, 13, 13, 14, 14, 15, 17, 18, 19, 19, 19, 20, 20, 21];
      const openedAt = new Date(base.getTime() + (pick(hourWeights) + rnd()) * 3600_000);
      const closedAt = new Date(openedAt.getTime() + (40 + rnd() * 50) * 60_000);
      const guests = 1 + Math.floor(rnd() * 5);
      const waiter = pick(waiters);
      const order = await prisma.order.create({
        data: { tableId: pick(tables).id, waiterId: waiter.id, guests, status: 'PAID', openedAt, closedAt, closedById: cashier.id },
      });
      const batch = await prisma.orderBatch.create({ data: { orderId: order.id, sequence: 1, createdById: waiter.id, createdAt: openedAt } });
      const lines: Prisma.OrderItemCreateManyInput[] = [];
      const nFood = Math.max(1, Math.round(guests * (0.8 + rnd() * 0.5)));
      for (let i = 0; i < nFood; i++) {
        const p = pick(food);
        lines.push({ orderId: order.id, batchId: batch.id, productId: p.id, areaId: p.areaId, productName: p.name, unitPrice: p.price, quantity: 1, status: 'DELIVERED', createdById: waiter.id, createdAt: openedAt, readyAt: openedAt, deliveredAt: openedAt });
      }
      for (let i = 0; i < guests; i++) {
        const p = pick(drinks);
        lines.push({ orderId: order.id, batchId: batch.id, productId: p.id, areaId: p.areaId, productName: p.name, unitPrice: p.price, quantity: 1 + (rnd() > 0.8 ? 1 : 0), status: 'DELIVERED', createdById: waiter.id, createdAt: openedAt, readyAt: openedAt, deliveredAt: openedAt });
      }
      await prisma.orderItem.createMany({ data: lines });
      const t = computeTotals({ discountType: null, discountValue: 0, items: lines.map((l, i) => ({ id: i, quantity: l.quantity, unitPrice: Number(l.unitPrice), status: 'DELIVERED' as const })) }, settings);
      await prisma.order.update({
        where: { id: order.id },
        data: { subtotal: t.subtotal / 100, serviceAmount: t.service / 100, taxAmount: t.tax / 100, discountAmount: 0, total: t.total / 100 },
      });
      const r = rnd();
      const method = r < 0.4 ? methods.find((m) => m.code === 'CASH')! : r < 0.8 ? methods.find((m) => m.code === 'CARD')! : r < 0.97 ? methods.find((m) => m.code === 'SINPE')! : methods.find((m) => m.code === 'VOUCHER')!;
      byKind[method.kind] += t.total;
      const pay = await prisma.payment.create({
        data: { orderId: order.id, paymentMethodId: method.id, cashSessionId: session.id, amount: t.total / 100, userId: cashier.id, idempotencyKey: `seed-${order.id}`, createdAt: closedAt, receivedAmount: method.kind === 'CASH' ? t.total / 100 : null },
      });
      await prisma.cashMovement.create({
        data: { sessionId: session.id, type: 'SALE', amount: t.total / 100, paymentMethodId: method.id, paymentId: pay.id, description: `Venta orden #${order.number}`, userId: cashier.id, createdAt: closedAt },
      });
    }
    const expense = Math.round(5000 + rnd() * 15000) * 100;
    await prisma.cashMovement.create({ data: { sessionId: session.id, type: 'EXPENSE', amount: -expense / 100, description: 'Compra de insumos (verdulería)', userId: cashier.id, createdAt: new Date(base.getTime() + 15 * 3600_000) } });
    const expectedCash = opening * 100 + byKind.CASH - expense;
    const counted = expectedCash + (rnd() > 0.85 ? -100000 : 0);
    const total = byKind.CASH + byKind.CARD + byKind.TRANSFER + byKind.OTHER;
    await prisma.cashClosing.create({
      data: {
        sessionId: session.id,
        closedById: cashier.id,
        closedAt: new Date(base.getTime() + 22.5 * 3600_000),
        openingAmount: opening,
        totalSales: total / 100,
        cashSales: byKind.CASH / 100,
        cardSales: byKind.CARD / 100,
        transferSales: byKind.TRANSFER / 100,
        otherSales: byKind.OTHER / 100,
        totalIncome: 0,
        totalWithdrawals: 0,
        totalExpenses: expense / 100,
        totalAdjustments: 0,
        expectedCash: expectedCash / 100,
        countedCash: counted / 100,
        difference: (counted - expectedCash) / 100,
      },
    });
  }
  console.log(`  · Historial de demostración creado: ${await prisma.order.count()} órdenes pagadas`);
}

async function main() {
  console.log('🌱 Sembrando datos base...');
  await seedBase();
  if (process.env.SEED_DEMO !== '0' && process.env.NODE_ENV !== 'test') await seedDemoSales();
  console.log('✅ Listo. Usuarios de prueba:');
  for (const u of USERS) console.log(`   ${ROLE_LABELS[u.role].padEnd(14)} usuario: ${u.username.padEnd(8)} contraseña: ${u.password}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
