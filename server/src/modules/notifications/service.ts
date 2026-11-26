import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { realtime } from '../../realtime';

export async function createNotification(userId: number, n: { type: string; title: string; message: string; data?: unknown }) {
  const row = await prisma.notification.create({
    data: { userId, type: n.type, title: n.title, message: n.message, data: (n.data ?? undefined) as Prisma.InputJsonValue | undefined },
  });
  realtime.notifyUser(userId, row);
  return row;
}
