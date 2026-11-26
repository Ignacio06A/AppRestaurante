import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db';
import { ah } from '../../lib/asyncHandler';
import { idParam, parse } from '../../lib/validate';
import { requirePermission } from '../../middleware/auth';
import { getSettings } from '../../lib/settings';
import { audit } from '../../lib/audit';
import { conflict, notFound } from '../../lib/errors';
import { realtime } from '../../realtime';

export const settingsRouter = Router();

settingsRouter.get(
  '/settings',
  ah(async (_req, res) => {
    res.json(await getSettings());
  }),
);

settingsRouter.put(
  '/settings',
  requirePermission('settings.manage'),
  ah(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(120),
        legalName: z.string().trim().max(160).nullish(),
        legalId: z.string().trim().max(40).nullish(),
        address: z.string().trim().max(255).nullish(),
        phone: z.string().trim().max(40).nullish(),
        email: z.string().trim().email('Correo inválido').max(120).nullish().or(z.literal('')),
        logoUrl: z.string().trim().max(500).nullish(),
        currencyCode: z.string().trim().length(3).default('CRC'),
        currencySymbol: z.string().trim().min(1).max(4).default('₡'),
        taxRate: z.number().min(0).max(100),
        serviceRate: z.number().min(0).max(100),
        pricesIncludeTax: z.boolean(),
        receiptFooter: z.string().trim().max(300).nullish(),
        kdsWarningMinutes: z.number().int().min(1).max(240),
        kdsCriticalMinutes: z.number().int().min(1).max(480),
      }),
      req.body,
    );
    await getSettings();
    const s = await prisma.restaurantSettings.update({ where: { id: 1 }, data: { ...body, email: body.email || null } });
    await audit({ userId: req.user!.id, action: 'SETTINGS_UPDATED', entity: 'RestaurantSettings', entityId: 1, details: body, ip: req.ip });
    realtime.menuUpdated();
    res.json(s);
  }),
);

// ---------------- Métodos de pago ----------------
settingsRouter.get(
  '/payment-methods',
  ah(async (req, res) => {
    res.json(await prisma.paymentMethod.findMany({ where: req.query.all === '1' ? {} : { active: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }));
  }),
);

const pmSchema = z.object({
  code: z.string().trim().toUpperCase().min(2).max(30).regex(/^[A-Z0-9_]+$/, 'Código: solo mayúsculas, números y _'),
  name: z.string().trim().min(2).max(60),
  kind: z.enum(['CASH', 'CARD', 'TRANSFER', 'OTHER']),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(999).default(0),
});

settingsRouter.post(
  '/payment-methods',
  requirePermission('settings.manage'),
  ah(async (req, res) => {
    const body = parse(pmSchema, req.body);
    if (await prisma.paymentMethod.findUnique({ where: { code: body.code } })) throw conflict('Ya existe un método con ese código');
    const pm = await prisma.paymentMethod.create({ data: body });
    await audit({ userId: req.user!.id, action: 'PAYMENT_METHOD_CREATED', entity: 'PaymentMethod', entityId: pm.id, details: body, ip: req.ip });
    res.status(201).json(pm);
  }),
);

settingsRouter.put(
  '/payment-methods/:id',
  requirePermission('settings.manage'),
  ah(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const body = parse(pmSchema.omit({ code: true }).partial(), req.body);
    if (!(await prisma.paymentMethod.findUnique({ where: { id } }))) throw notFound('Método no encontrado');
    const pm = await prisma.paymentMethod.update({ where: { id }, data: body });
    await audit({ userId: req.user!.id, action: 'PAYMENT_METHOD_UPDATED', entity: 'PaymentMethod', entityId: id, details: body, ip: req.ip });
    res.json(pm);
  }),
);

// ---------------- Cajas registradoras ----------------
settingsRouter.get(
  '/cash-registers',
  ah(async (_req, res) => {
    res.json(await prisma.cashRegister.findMany({ orderBy: { id: 'asc' } }));
  }),
);

settingsRouter.post(
  '/cash-registers',
  requirePermission('settings.manage'),
  ah(async (req, res) => {
    const { name } = parse(z.object({ name: z.string().trim().min(2).max(60) }), req.body);
    if (await prisma.cashRegister.findUnique({ where: { name } })) throw conflict('Ya existe una caja con ese nombre');
    const r = await prisma.cashRegister.create({ data: { name } });
    await audit({ userId: req.user!.id, action: 'CASH_REGISTER_CREATED', entity: 'CashRegister', entityId: r.id, ip: req.ip });
    res.status(201).json(r);
  }),
);
