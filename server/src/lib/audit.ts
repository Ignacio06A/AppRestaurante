import { Prisma } from '@prisma/client';
import { prisma, Tx } from '../db';

export async function audit(
  params: { userId?: number | null; action: string; entity: string; entityId?: string | number | null; details?: unknown; ip?: string | null },
  tx: Tx | typeof prisma = prisma,
) {
  await tx.auditLog.create({
    data: {
      userId: params.userId ?? null,
      action: params.action,
      entity: params.entity,
      entityId: params.entityId != null ? String(params.entityId) : null,
      details: (params.details ?? undefined) as Prisma.InputJsonValue | undefined,
      ip: params.ip ?? null,
    },
  });
}
