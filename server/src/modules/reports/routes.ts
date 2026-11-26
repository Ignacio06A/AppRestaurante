import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../../lib/asyncHandler';
import { parse } from '../../lib/validate';
import { requirePermission } from '../../middleware/auth';
import { badRequest } from '../../lib/errors';
import { diffDays, localDate } from '../../lib/dates';
import { getSettings } from '../../lib/settings';
import { dashboard, salesReport } from './service';
import { toExcel, toPdf } from './export';

export const reportsRouter = Router();
reportsRouter.use(requirePermission('reports.view'));

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)');
const rangeSchema = z.object({ from: date.optional(), to: date.optional() });

function resolveRange(q: unknown) {
  const r = parse(rangeSchema, q);
  const to = r.to ?? localDate();
  const from = r.from ?? to;
  if (from > to) throw badRequest('La fecha inicial no puede ser mayor a la final');
  if (diffDays(from, to) > 366) throw badRequest('El rango máximo es de 366 días');
  return { from, to };
}

reportsRouter.get('/dashboard', ah(async (_req, res) => res.json(await dashboard())));

reportsRouter.get(
  '/sales',
  ah(async (req, res) => {
    res.json(await salesReport(resolveRange(req.query)));
  }),
);

reportsRouter.get(
  '/sales/export',
  ah(async (req, res) => {
    const range = resolveRange(req.query);
    const format = parse(z.enum(['pdf', 'xlsx']), req.query.format);
    const [rep, settings] = await Promise.all([salesReport(range), getSettings()]);
    const filename = `reporte-ventas-${range.from}_${range.to}.${format}`;
    if (format === 'xlsx') {
      const buf = await toExcel(rep, settings.name);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(buf);
    }
    const buf = await toPdf(rep, settings.name);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  }),
);
