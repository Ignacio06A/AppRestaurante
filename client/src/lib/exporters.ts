/**
 * Exportación de reportes a PDF y Excel generada en el navegador
 * (ya no hay servidor propio). Las librerías se cargan solo al exportar.
 */
export interface SalesReport {
  range: { from: string; to: string; days: number };
  previousRange: { from: string; to: string };
  kpis: Record<string, number | null>;
  byDay: { day: string; orders: number; total: number }[];
  byHour: { hour: number; orders: number; total: number }[];
  byPaymentMethod: { name: string; kind: string; count: number; total: number }[];
  byWaiter: { name: string; orders: number; total: number; guests: number; avgTicket: number }[];
  topProducts: { name: string; category: string; quantity: number; revenue: number }[];
  byCategory: { name: string; quantity: number; revenue: number }[];
  monthly: { month: string; orders: number; total: number }[];
}

const n = (v: unknown) => Number(v ?? 0);
const crc = (v: unknown) => '₡' + Math.round(n(v)).toLocaleString('es-CR');
const pctStr = (v: number | null | undefined) => (v === null || v === undefined ? 'n/d' : `${v >= 0 ? '+' : ''}${n(v).toFixed(1)}%`);
const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;

function download(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function kpiRows(r: SalesReport): [string, string][] {
  const k = r.kpis;
  return [
    ['Periodo', `${r.range.from} a ${r.range.to}`],
    ['Ventas totales', crc(k.totalSales)],
    ['Ventas netas (sin servicio/IVA)', crc(k.netSales)],
    ['Órdenes pagadas', String(n(k.orders))],
    ['Clientes atendidos', String(n(k.guests))],
    ['Productos vendidos', String(n(k.itemsSold))],
    ['Ticket promedio por mesa', crc(k.avgTicket)],
    ['Promedio por cliente', crc(k.avgPerGuest)],
    ['Promedio de ventas diarias', crc(k.avgDailySales)],
    ['Descuentos', crc(k.discounts)],
    ['Servicio', crc(k.service)],
    ['Impuestos (IVA)', crc(k.tax)],
    ['Órdenes anuladas', String(n(k.cancelledOrders))],
    [`Ventas periodo anterior (${r.previousRange.from} a ${r.previousRange.to})`, crc(k.previousTotalSales)],
    ['Variación vs periodo anterior', pctStr(k.salesChangePct)],
  ];
}

export async function exportExcel(r: SalesReport, restaurant: string) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = restaurant;
  wb.created = new Date();
  const money = '"₡"#,##0.00';
  const style = (ws: import('exceljs').Worksheet) => {
    const row = ws.getRow(1);
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
  };
  const s = wb.addWorksheet('Resumen');
  s.columns = [{ header: 'Indicador', key: 'k', width: 44 }, { header: 'Valor', key: 'v', width: 24 }];
  style(s);
  kpiRows(r).forEach(([k, v]) => s.addRow({ k, v }));

  const sheet = (name: string, cols: { header: string; key: string; width: number; money?: boolean }[], data: Record<string, unknown>[]) => {
    const ws = wb.addWorksheet(name);
    ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width, style: c.money ? { numFmt: money } : undefined }));
    style(ws);
    data.forEach((d) => ws.addRow(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v]))));
  };
  sheet('Ventas por día', [{ header: 'Fecha', key: 'day', width: 14 }, { header: 'Órdenes', key: 'orders', width: 10 }, { header: 'Total', key: 'total', width: 18, money: true }], r.byDay);
  sheet('Por hora', [{ header: 'Hora', key: 'hour', width: 10 }, { header: 'Órdenes', key: 'orders', width: 10 }, { header: 'Total', key: 'total', width: 18, money: true }], r.byHour.map((h) => ({ ...h, hour: hourLabel(h.hour) })));
  sheet('Productos', [{ header: 'Producto', key: 'name', width: 32 }, { header: 'Categoría', key: 'category', width: 20 }, { header: 'Cantidad', key: 'quantity', width: 10 }, { header: 'Ingresos', key: 'revenue', width: 18, money: true }], r.topProducts);
  sheet('Categorías', [{ header: 'Categoría', key: 'name', width: 26 }, { header: 'Cantidad', key: 'quantity', width: 10 }, { header: 'Ingresos', key: 'revenue', width: 18, money: true }], r.byCategory);
  sheet('Métodos de pago', [{ header: 'Método', key: 'name', width: 24 }, { header: 'Pagos', key: 'count', width: 10 }, { header: 'Total', key: 'total', width: 18, money: true }], r.byPaymentMethod);
  sheet('Meseros', [{ header: 'Mesero', key: 'name', width: 26 }, { header: 'Órdenes', key: 'orders', width: 10 }, { header: 'Clientes', key: 'guests', width: 10 }, { header: 'Ventas', key: 'total', width: 18, money: true }, { header: 'Ticket prom.', key: 'avgTicket', width: 16, money: true }], r.byWaiter);
  sheet('Tendencia mensual', [{ header: 'Mes', key: 'month', width: 12 }, { header: 'Órdenes', key: 'orders', width: 10 }, { header: 'Total', key: 'total', width: 18, money: true }], r.monthly);

  const buf = await wb.xlsx.writeBuffer();
  download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `reporte-ventas-${r.range.from}_${r.range.to}.xlsx`);
}

export async function exportPdf(r: SalesReport, restaurant: string) {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  // Las fuentes estándar de PDF no incluyen el símbolo ₡: se usa el código ISO
  const c = (v: unknown) => 'CRC ' + Math.round(n(v)).toLocaleString('es-CR');
  doc.setFont('helvetica', 'bold').setFontSize(18).text(restaurant, 40, 50);
  doc.setFont('helvetica', 'normal').setFontSize(11).setTextColor(100).text(`Reporte de ventas: ${r.range.from} a ${r.range.to}`, 40, 70);
  doc.text(`Generado: ${new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' })}`, 40, 86);
  doc.setTextColor(0);

  const head = { fillColor: [31, 41, 55] as [number, number, number], textColor: 255, fontStyle: 'bold' as const };
  let y = 104;
  const table = (title: string, columns: string[], body: (string | number)[][], right: number[] = []) => {
    if (y > 680) {
      doc.addPage();
      y = 50;
    }
    doc.setFont('helvetica', 'bold').setFontSize(12).text(title, 40, y + 14);
    autoTable(doc, {
      startY: y + 22,
      head: [columns],
      body: body.length ? body : [['Sin datos', ...columns.slice(1).map(() => '')]],
      headStyles: head,
      styles: { fontSize: 9, cellPadding: 4 },
      alternateRowStyles: { fillColor: [249, 250, 251] },
      columnStyles: Object.fromEntries(right.map((i) => [i, { halign: 'right' as const }])),
      margin: { left: 40, right: 40 },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 16;
  };
  table('Resumen', ['Indicador', 'Valor'], kpiRows(r).map(([k, v]) => [k, v.replace('₡', 'CRC ')]), [1]);
  table('Productos más vendidos', ['Producto', 'Categoría', 'Cant.', 'Ingresos'], r.topProducts.map((p) => [p.name, p.category, n(p.quantity), c(p.revenue)]), [2, 3]);
  table('Ventas por método de pago', ['Método', 'Pagos', 'Total'], r.byPaymentMethod.map((m) => [m.name, n(m.count), c(m.total)]), [1, 2]);
  table('Ventas por mesero', ['Mesero', 'Órdenes', 'Clientes', 'Ventas', 'Ticket prom.'], r.byWaiter.map((w) => [w.name, n(w.orders), n(w.guests), c(w.total), c(w.avgTicket)]), [1, 2, 3, 4]);
  table('Ingresos por categoría', ['Categoría', 'Cant.', 'Ingresos'], r.byCategory.map((x) => [x.name, n(x.quantity), c(x.revenue)]), [1, 2]);
  table('Ventas por día', ['Fecha', 'Órdenes', 'Total'], r.byDay.filter((d) => n(d.orders) > 0 || r.byDay.length <= 31).map((d) => [d.day, n(d.orders), c(d.total)]), [1, 2]);
  table('Horarios con mayor movimiento', ['Hora', 'Órdenes', 'Total'], r.byHour.filter((h) => n(h.orders) > 0).map((h) => [`${hourLabel(h.hour)} - ${String(h.hour).padStart(2, '0')}:59`, n(h.orders), c(h.total)]), [1, 2]);
  table('Tendencia mensual (12 meses)', ['Mes', 'Órdenes', 'Total'], r.monthly.map((m) => [m.month, n(m.orders), c(m.total)]), [1, 2]);
  doc.save(`reporte-ventas-${r.range.from}_${r.range.to}.pdf`);
}
