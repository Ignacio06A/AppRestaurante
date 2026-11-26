import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { salesReport } from './service';

type Report = Awaited<ReturnType<typeof salesReport>>;

// Las fuentes estándar de PDF no incluyen el símbolo ₡, por eso se usa el código ISO.
const crc = (v: number) => 'CRC ' + Math.round(v).toLocaleString('es-CR');
const pctStr = (v: number | null) => (v === null ? 'n/d' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);

export async function toExcel(rep: Report, restaurant: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = restaurant;
  wb.created = new Date();
  const money = '"₡"#,##0.00';
  const header = (ws: ExcelJS.Worksheet) => {
    const row = ws.getRow(1);
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
  };

  const s = wb.addWorksheet('Resumen');
  s.columns = [
    { header: 'Indicador', key: 'k', width: 34 },
    { header: 'Valor', key: 'v', width: 22 },
  ];
  header(s);
  const k = rep.kpis;
  const rows: [string, number | string, boolean?][] = [
    ['Periodo', `${rep.range.from} a ${rep.range.to}`],
    ['Ventas totales', k.totalSales, true],
    ['Ventas netas (sin servicio/IVA)', k.netSales, true],
    ['Órdenes pagadas', k.orders],
    ['Clientes atendidos', k.guests],
    ['Productos vendidos', k.itemsSold],
    ['Ticket promedio por mesa', k.avgTicket, true],
    ['Promedio por cliente', k.avgPerGuest, true],
    ['Promedio de ventas diarias', k.avgDailySales, true],
    ['Descuentos', k.discounts, true],
    ['Servicio', k.service, true],
    ['Impuestos', k.tax, true],
    ['Órdenes anuladas', k.cancelledOrders],
    [`Ventas periodo anterior (${rep.previousRange.from} a ${rep.previousRange.to})`, k.previousTotalSales, true],
    ['Variación vs periodo anterior', pctStr(k.salesChangePct)],
  ];
  for (const [label, value, isMoney] of rows) {
    const r = s.addRow({ k: label, v: value });
    if (isMoney) r.getCell(2).numFmt = money;
  }

  const addTable = (name: string, cols: { header: string; key: string; width: number; money?: boolean }[], data: Record<string, unknown>[]) => {
    const ws = wb.addWorksheet(name);
    ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width, style: c.money ? { numFmt: money } : undefined }));
    header(ws);
    data.forEach((d) => ws.addRow(d));
  };

  addTable('Ventas por día', [{ header: 'Fecha', key: 'day', width: 14 }, { header: 'Órdenes', key: 'orders', width: 10 }, { header: 'Total', key: 'total', width: 18, money: true }], rep.byDay);
  addTable('Por hora', [{ header: 'Hora', key: 'hour', width: 10 }, { header: 'Órdenes', key: 'orders', width: 10 }, { header: 'Total', key: 'total', width: 18, money: true }], rep.byHour.map((h) => ({ ...h, hour: `${String(h.hour).padStart(2, '0')}:00` })));
  addTable('Productos', [{ header: 'Producto', key: 'name', width: 32 }, { header: 'Categoría', key: 'category', width: 20 }, { header: 'Cantidad', key: 'quantity', width: 10 }, { header: 'Ingresos', key: 'revenue', width: 18, money: true }], rep.topProducts);
  addTable('Categorías', [{ header: 'Categoría', key: 'name', width: 26 }, { header: 'Cantidad', key: 'quantity', width: 10 }, { header: 'Ingresos', key: 'revenue', width: 18, money: true }], rep.byCategory);
  addTable('Métodos de pago', [{ header: 'Método', key: 'name', width: 22 }, { header: 'Pagos', key: 'count', width: 10 }, { header: 'Total', key: 'total', width: 18, money: true }], rep.byPaymentMethod);
  addTable('Meseros', [{ header: 'Mesero', key: 'name', width: 26 }, { header: 'Órdenes', key: 'orders', width: 10 }, { header: 'Clientes', key: 'guests', width: 10 }, { header: 'Ventas', key: 'total', width: 18, money: true }, { header: 'Ticket prom.', key: 'avgTicket', width: 16, money: true }], rep.byWaiter);
  addTable('Tendencia mensual', [{ header: 'Mes', key: 'month', width: 12 }, { header: 'Órdenes', key: 'orders', width: 10 }, { header: 'Total', key: 'total', width: 18, money: true }], rep.monthly);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toPdf(rep: Report, restaurant: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - 80;
    doc.fillColor('#111827').fontSize(18).font('Helvetica-Bold').text(restaurant);
    doc.fontSize(12).font('Helvetica').fillColor('#6B7280').text(`Reporte de ventas: ${rep.range.from} a ${rep.range.to}`);
    doc.text(`Generado: ${new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' })}`);
    doc.moveDown();

    const k = rep.kpis;
    const kpis: [string, string][] = [
      ['Ventas totales', crc(k.totalSales)],
      ['Órdenes pagadas', String(k.orders)],
      ['Clientes', String(k.guests)],
      ['Ticket promedio', crc(k.avgTicket)],
      ['Promedio diario', crc(k.avgDailySales)],
      ['Vs. periodo anterior', pctStr(k.salesChangePct)],
    ];
    const boxW = W / 3;
    let y = doc.y;
    kpis.forEach(([label, value], i) => {
      const x = 40 + (i % 3) * boxW;
      const yy = y + Math.floor(i / 3) * 52;
      doc.roundedRect(x + 2, yy, boxW - 4, 46, 6).fillAndStroke('#F9FAFB', '#E5E7EB');
      doc.fillColor('#6B7280').fontSize(9).font('Helvetica').text(label, x + 10, yy + 8, { width: boxW - 20 });
      doc.fillColor('#111827').fontSize(14).font('Helvetica-Bold').text(value, x + 10, yy + 22, { width: boxW - 20 });
    });
    doc.y = y + 112;
    doc.x = 40;

    const table = (title: string, cols: { h: string; w: number; align?: 'left' | 'right' }[], rows: string[][]) => {
      if (doc.y > doc.page.height - 140) doc.addPage();
      doc.moveDown(0.5).fillColor('#111827').fontSize(12).font('Helvetica-Bold').text(title, 40);
      doc.moveDown(0.3);
      const total = cols.reduce((a, c) => a + c.w, 0);
      const scale = W / total;
      const drawRow = (cells: string[], bold = false, bg?: string) => {
        if (doc.y > doc.page.height - 60) doc.addPage();
        const ry = doc.y;
        if (bg) doc.rect(40, ry - 2, W, 16).fill(bg);
        let x = 40;
        cells.forEach((c, i) => {
          const w = cols[i].w * scale;
          doc.fillColor('#111827').fontSize(9).font(bold ? 'Helvetica-Bold' : 'Helvetica').text(c, x + 4, ry, { width: w - 8, align: cols[i].align ?? 'left', lineBreak: false });
          x += w;
        });
        doc.y = ry + 16;
      };
      drawRow(cols.map((c) => c.h), true, '#E5E7EB');
      rows.forEach((r, i) => drawRow(r, false, i % 2 ? '#F9FAFB' : undefined));
      if (!rows.length) drawRow(['Sin datos', ...cols.slice(1).map(() => '')]);
    };

    table('Productos más vendidos', [{ h: 'Producto', w: 4 }, { h: 'Categoría', w: 3 }, { h: 'Cant.', w: 1, align: 'right' }, { h: 'Ingresos', w: 2, align: 'right' }], rep.topProducts.map((p) => [p.name, p.category, String(p.quantity), crc(p.revenue)]));
    table('Ventas por método de pago', [{ h: 'Método', w: 4 }, { h: 'Pagos', w: 2, align: 'right' }, { h: 'Total', w: 3, align: 'right' }], rep.byPaymentMethod.map((m) => [m.name, String(m.count), crc(m.total)]));
    table('Ventas por mesero', [{ h: 'Mesero', w: 4 }, { h: 'Órdenes', w: 2, align: 'right' }, { h: 'Clientes', w: 2, align: 'right' }, { h: 'Ventas', w: 3, align: 'right' }, { h: 'Ticket prom.', w: 3, align: 'right' }], rep.byWaiter.map((w) => [w.name, String(w.orders), String(w.guests), crc(w.total), crc(w.avgTicket)]));
    table('Ingresos por categoría', [{ h: 'Categoría', w: 5 }, { h: 'Cant.', w: 2, align: 'right' }, { h: 'Ingresos', w: 3, align: 'right' }], rep.byCategory.map((c) => [c.name, String(c.quantity), crc(c.revenue)]));
    table('Ventas por día', [{ h: 'Fecha', w: 4 }, { h: 'Órdenes', w: 2, align: 'right' }, { h: 'Total', w: 3, align: 'right' }], rep.byDay.filter((d) => d.orders > 0 || rep.byDay.length <= 31).map((d) => [d.day, String(d.orders), crc(d.total)]));
    table('Horarios con mayor movimiento', [{ h: 'Hora', w: 3 }, { h: 'Órdenes', w: 2, align: 'right' }, { h: 'Total', w: 3, align: 'right' }], rep.byHour.filter((h) => h.orders > 0).map((h) => [`${String(h.hour).padStart(2, '0')}:00 - ${String(h.hour).padStart(2, '0')}:59`, String(h.orders), crc(h.total)]));
    table('Tendencia mensual (12 meses)', [{ h: 'Mes', w: 3 }, { h: 'Órdenes', w: 2, align: 'right' }, { h: 'Total', w: 3, align: 'right' }], rep.monthly.map((m) => [m.month, String(m.orders), crc(m.total)]));

    doc.end();
  });
}
