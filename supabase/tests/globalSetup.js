import { readFileSync, readdirSync } from 'fs';
import pg from 'pg';

/**
 * Crea desde cero una base local de PRUEBAS que simula Supabase y aplica
 * las migraciones y los datos iniciales. Solo actúa sobre bases "*_test".
 */
export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/comanda_supabase_test';

export default async function setup() {
  const url = new URL(TEST_DB);
  const dbName = url.pathname.slice(1);
  if (!dbName.endsWith('_test')) throw new Error(`Las pruebas solo se ejecutan contra una base *_test (actual: ${dbName})`);
  const admin = new pg.Client({ connectionString: TEST_DB.replace(`/${dbName}`, '/postgres') });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const c = new pg.Client({ connectionString: TEST_DB });
  await c.connect();
  const dir = new URL('..', import.meta.url).pathname;
  await c.query(readFileSync(`${dir}tests/stub_supabase.sql`, 'utf8'));
  for (const f of readdirSync(`${dir}migrations`).sort()) await c.query(readFileSync(`${dir}migrations/${f}`, 'utf8'));
  await c.query(readFileSync(`${dir}seed.sql`, 'utf8'));
  await c.end();
}
