import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Printer } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { CashSession } from '../../lib/types';
import { dateTime, money } from '../../lib/format';
import { Badge, Card, EmptyState, Loading, PageHeader, Pagination } from '../../components/ui';

export default function CashHistory() {
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['cash', 'sessions', page],
    queryFn: () => api.get<{ total: number; page: number; pageSize: number; rows: CashSession[] }>(`/cash/sessions${qs({ page, pageSize: 20 })}`),
  });
  return (
    <div>
      <PageHeader eyebrow="Caja" title="Historial de aperturas y cierres" subtitle="Arqueos realizados con su diferencia entre el efectivo esperado y el contado." />
      <Card>
        {q.isLoading ? (
          <Loading />
        ) : !q.data?.rows.length ? (
          <EmptyState title="Aún no hay sesiones de caja" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Caja</th>
                    <th>Apertura</th>
                    <th>Cierre</th>
                    <th className="text-right">Inicial</th>
                    <th className="text-right">Vendido</th>
                    <th className="text-right">Efectivo esperado</th>
                    <th className="text-right">Contado</th>
                    <th className="text-right">Diferencia</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {q.data.rows.map((s) => {
                    const c = s.closing;
                    const diff = c ? Number(c.difference) : null;
                    return (
                      <tr key={s.id}>
                        <td>
                          <div className="font-semibold">{s.register.name}</div>
                          {s.status === 'OPEN' ? <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-200" dot="bg-emerald-500">Abierta</Badge> : <Badge>Cerrada</Badge>}
                        </td>
                        <td>
                          <div className="whitespace-nowrap">{dateTime(s.openedAt)}</div>
                          <div className="text-xs text-ink-500">{s.openedBy.name}</div>
                        </td>
                        <td>
                          {c ? (
                            <>
                              <div className="whitespace-nowrap">{dateTime(c.closedAt)}</div>
                              <div className="text-xs text-ink-500">{c.closedBy.name}</div>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="text-right tabular-nums">{money(s.openingAmount)}</td>
                        <td className="text-right font-semibold tabular-nums">{c ? money(c.totalSales) : '—'}</td>
                        <td className="text-right tabular-nums">{c ? money(c.expectedCash) : '—'}</td>
                        <td className="text-right tabular-nums">{c ? money(c.countedCash) : '—'}</td>
                        <td className={clsx('text-right font-bold tabular-nums', diff === null ? '' : Math.abs(diff) < 0.005 ? 'text-emerald-700' : diff > 0 ? 'text-sky-700' : 'text-rose-600')}>{diff === null ? '—' : money(diff)}</td>
                        <td className="text-right">
                          {c && (
                            <button className="text-ink-400 hover:text-ink-900" title="Imprimir cierre" onClick={() => window.open(`/imprimir/cierre/${s.id}`, '_blank')}>
                              <Printer className="h-4 w-4" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={20} total={q.data.total} onChange={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
