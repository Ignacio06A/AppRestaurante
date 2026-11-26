// Genera supabase/setup.sql (migraciones + seed) para pegar en el SQL Editor de Supabase.
import { readFileSync, readdirSync, writeFileSync } from 'fs';
const dir = new URL('.', import.meta.url).pathname;
const parts = [
  '-- =============================================================',
  '--  Comanda — instalación completa en Supabase (archivo generado)',
  '--  Pegue TODO este archivo en Supabase → SQL Editor y ejecútelo una vez',
  '--  en un proyecto nuevo. Regenerar con: npm run setup-sql',
  '-- =============================================================',
];
for (const f of [...readdirSync(`${dir}migrations`).sort().map((f) => `migrations/${f}`), 'seed.sql']) {
  parts.push('', `-- >>> ${f}`, readFileSync(`${dir}${f}`, 'utf8'));
}
writeFileSync(`${dir}setup.sql`, parts.join('\n'));
console.log('supabase/setup.sql generado');
