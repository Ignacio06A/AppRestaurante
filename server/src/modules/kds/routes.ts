import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db';
import { ah } from '../../lib/asyncHandler';
import { idParam, parse } from '../../lib/validate';
import { forbidden, notFound } from '../../lib/errors';
import { AreaCode, assertArea, getTickets, setBatchStatus, setItemsStatus } from './service';
import { cancelItem } from '../orders/service';

export const kdsRouter = Router();
const areaSchema = z.enum(['KITCHEN', 'BAR']);

kdsRouter.get(
  '/:area/tickets',
  ah(async (req, res) => {
    const area = parse(areaSchema, req.params.area) as AreaCode;
    assertArea(req.user!, area);
    res.json(await getTickets(area));
  }),
);

kdsRouter.patch(
  '/:area/items/:itemId',
  ah(async (req, res) => {
    const area = parse(areaSchema, req.params.area) as AreaCode;
    const itemId = parse(idParam, req.params.itemId);
    const { status } = parse(z.object({ status: z.enum(['PENDING', 'IN_PREPARATION', 'READY']) }), req.body);
    res.json(await setItemsStatus(req.user!, area, [itemId], status));
  }),
);

kdsRouter.post(
  '/:area/batches/:batchId/status',
  ah(async (req, res) => {
    const area = parse(areaSchema, req.params.area) as AreaCode;
    const batchId = parse(idParam, req.params.batchId);
    const { status } = parse(z.object({ status: z.enum(['IN_PREPARATION', 'READY']) }), req.body);
    res.json(await setBatchStatus(req.user!, area, batchId, status));
  }),
);

/** Cocina/bar puede cancelar un producto (p.ej. sin ingredientes). Se notifica al mesero. */
kdsRouter.post(
  '/:area/items/:itemId/cancel',
  ah(async (req, res) => {
    const area = parse(areaSchema, req.params.area) as AreaCode;
    assertArea(req.user!, area);
    const itemId = parse(idParam, req.params.itemId);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'Indique un motivo').max(255) }), req.body);
    const item = await prisma.orderItem.findUnique({ where: { id: itemId }, include: { area: true } });
    if (!item) throw notFound('Producto no encontrado');
    if (item.area.code !== area) throw forbidden('El producto no pertenece a esta área');
    await cancelItem(req.user!, item.orderId, itemId, reason, { fromKds: true });
    res.json({ ok: true });
  }),
);
