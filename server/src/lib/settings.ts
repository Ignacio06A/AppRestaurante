import { prisma, Tx } from '../db';

export async function getSettings(tx: Tx | typeof prisma = prisma) {
  const s = await tx.restaurantSettings.findUnique({ where: { id: 1 } });
  if (s) return s;
  return tx.restaurantSettings.create({ data: { id: 1, name: 'Mi Restaurante' } });
}
