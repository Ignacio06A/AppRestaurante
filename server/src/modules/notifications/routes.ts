import { Router } from 'express';
import { prisma } from '../../db';
import { ah } from '../../lib/asyncHandler';
import { idParam, parse } from '../../lib/validate';
import { notFound } from '../../lib/errors';

export const notificationsRouter = Router();

notificationsRouter.get(
  '/',
  ah(async (req, res) => {
    const [items, unread] = await Promise.all([
      prisma.notification.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.notification.count({ where: { userId: req.user!.id, readAt: null } }),
    ]);
    res.json({ items, unread });
  }),
);

notificationsRouter.post(
  '/read-all',
  ah(async (req, res) => {
    await prisma.notification.updateMany({ where: { userId: req.user!.id, readAt: null }, data: { readAt: new Date() } });
    res.json({ ok: true });
  }),
);

notificationsRouter.post(
  '/:id/read',
  ah(async (req, res) => {
    const id = parse(idParam, req.params.id);
    const n = await prisma.notification.findUnique({ where: { id } });
    if (!n || n.userId !== req.user!.id) throw notFound();
    await prisma.notification.update({ where: { id }, data: { readAt: n.readAt ?? new Date() } });
    res.json({ ok: true });
  }),
);
