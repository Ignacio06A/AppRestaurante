import { execSync } from 'child_process';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';

/**
 * Prepara la base de datos de PRUEBAS: aplica migraciones y vacía las tablas.
 * Por seguridad solo se ejecuta si el nombre de la base termina en "_test".
 */
export default async function setup() {
  const parsed = loadEnv({ path: '.env.test', override: true }).parsed ?? {};
  const env = { ...process.env, ...parsed };
  const url = new URL(env.DATABASE_URL!);
  const dbName = url.pathname.replace('/', '');
  if (!dbName.endsWith('_test')) throw new Error(`Las pruebas solo se ejecutan contra una base *_test (actual: ${dbName})`);

  execSync('npx prisma migrate deploy', { env, stdio: 'inherit' });
  const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length) {
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  }
  await prisma.$disconnect();
  execSync('npx tsx prisma/seed.ts', { env, stdio: 'inherit' });
}
