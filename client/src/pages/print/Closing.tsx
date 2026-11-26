import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { CashMovement, CashSession, CashSummary } from '../../lib/types';
import { dateTime, money } from '../../lib/format';
import { useSettings } from '../../lib/hooks';
import { MOVEMENT_TYPE } from '../../lib/labels';
import { Button, Loading } from '../../components/ui';

export default function ClosingPrint() {
  const { sessionId } = useParams();
  const { data: settings } = useSettings();
  const q = useQuery({
    queryKey: ['cash', 'session', Number(sessionId)],
    queryFn: () => api.get<{ session: CashSession; summary: CashSummary; movements: CashMovement[] }>(`/cash/sessions/${sessionId}`),
  });
  useEffect(() => {
    if (q.data?.session.closing) setTimeout(() => window.print(), 400);
  }, [q.data]);
  if (q.isLoading || !q.data) return <Loading />;
  const { session: s, movements } = q.data;
  const c = s.closing;
  const rows: [string, string | number][] = c
    ? [
        ['Monto inicial', c.openingAmount],
        ['Total vendido', c.totalSales],
        ['Ventas en efectivo', c.cashSales],
        ['Ventas con tarjeta', c.cardSales],
        ['Ventas por transferencia', c.transferSales],
        ['Otros métodos de pago', c.otherSales],
        ['Entradas adicionales', c.totalIncome],
        ['Retiros', c.totalWithdrawals],
        ['Gastos', c.totalExpenses],
        ['Ajustes', c.totalAdjustments],
        ['Dinero esperado en efectivo', c.expectedCash],
        ['Dinero contado', c.countedCash],
        ['Diferencia', c.difference],
      ]
    : [];
  return (
    <div className="min-h-screen bg-ink-100 py-8 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-2xl justify-end gap-2">
        <Button onClick={() => window.print()}>Imprimir</Button>
        <Button variant="secondary" onClick={() => history.back()}>
          Volver
        </Button>
      </div>
      <div className="mx-auto max-w-2xl bg-white p-10 text-sm shadow print:max-w-none print:p-0 print:shadow-none">
        <div className="flex items-start justify-between border-b-2 border-ink-900 pb-4">
          <div>
            <div className="text-xl font-extrabold">{settings?.name}</div>
            <div className="text-ink-600">Reporte de cierre de caja — {s.register.name}</div>
          </div>
          <div className="text-right text-xs text-ink-600">
            <div>Sesión #{s.id}</div>
            <div>{s.status === 'OPEN' ? 'ABIERTA' : 'CERRADA'}</div>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 text-xs">
          <div>
            <div className="font-bold uppercase text-ink-500">Apertura</div>
            <div>{dateTime(s.openedAt)}</div>
            <div>Responsable: {s.openedBy.name}</div>
            {s.openingNotes && <div>Obs.: {s.openingNotes}</div>}
          </div>
          {c && (
            <div>
              <div className="font-bold uppercase text-ink-500">Cierre</div>
              <div>{dateTime(c.closedAt)}</div>
              <div>Responsable: {c.closedBy.name}</div>
              {c.notes && <div>Obs.: {c.notes}</div>}
            </div>
          )}
        </div>
        {c ? (
          <table className="mt-6 w-full">
            <tbody>
              {rows.map(([l, v], i) => (
                <tr key={l} className={i >= rows.length - 3 ? 'font-bold' : ''}>
                  <td className="border-b border-ink-200 py-1.5">{l}</td>
                  <td className="border-b border-ink-200 py-1.5 text-right tabular-nums">{money(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-6 text-ink-500">La sesión aún no se ha cerrado.</p>
        )}
        <h3 className="mt-8 font-bold">Movimientos ({movements.length})</h3>
        <table className="mt-2 w-full text-xs">
          <thead>
            <tr className="border-b border-ink-900 text-left">
              <th className="py-1">Fecha</th>
              <th>Tipo</th>
              <th>Descripción</th>
              <th>Usuario</th>
              <th className="text-right">Monto</th>
            </tr>
          </thead>
          <tbody>
            {movements.map((m) => (
              <tr key={m.id} className="border-b border-ink-100">
                <td className="py-1">{dateTime(m.createdAt)}</td>
                <td>{MOVEMENT_TYPE[m.type].label}</td>
                <td>{m.description}</td>
                <td>{m.user.name}</td>
                <td className="text-right tabular-nums">{money(m.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-16 grid grid-cols-2 gap-12 text-center text-xs">
          <div className="border-t border-ink-900 pt-2">Firma cajero</div>
          <div className="border-t border-ink-900 pt-2">Firma supervisor</div>
        </div>
      </div>
    </div>
  );
}
