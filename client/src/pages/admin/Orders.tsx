import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, Eye, Printer } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { Order, OrderStatus } from '../../lib/types';
import { ITEM_STATUS, ORDER_STATUS } from '../../lib/labels';
import { dateTime, money } from '../../lib/format';
import { Badge, Card, EmptyState, IconButton, Input, Loading, Modal, PageHeader, Pagination, Select } from '../../components/ui';
import { HistoryModal } from '../waiter/OrderScreen';

interface Row {
  id: number;
  number: number;
  status: OrderStatus;
  guests: number;
  openedAt: string;
  closedAt: string | null;
  total: string;
  table: { name: string };
  waiter: { name: string };
  _count: { items: number };
}

export default function OrdersPage() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [detail, setDetail] = useState<number | null>(null);
  const [history, setHistory] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['orders', page, status, from, to], queryFn: () => api.get<{ total: number; rows: Row[] }>(`/orders${qs({ page, pageSize: 25, status, from, to })}`) });
  return (
    <div>
      <PageHeader eyebrow="Administración" title="Historial de órdenes" subtitle="Consulte cualquier orden, sus productos, pagos y el historial completo de modificaciones." />
      <Card className="mb-4 flex flex-wrap items-end gap-3 p-4">
        <label className="min-w-[180px]">
          <span className="label">Estado</span>
          <Select value={status} onChange={(e) => (setPage(1), setStatus(e.target.value))}>
            <option value="">Todos</option>
            {Object.entries(ORDER_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <span className="label">Desde</span>
          <Input type="date" value={from} onChange={(e) => (setPage(1), setFrom(e.target.value))} />
        </label>
        <label>
          <span className="label">Hasta</span>
          <Input type="date" value={to} onChange={(e) => (setPage(1), setTo(e.target.value))} />
        </label>
      </Card>
      <Card>
        {q.isLoading ? (
          <Loading />
        ) : !q.data?.rows.length ? (
          <EmptyState icon={<ClipboardList className="h-7 w-7" />} title="Sin órdenes" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Orden</th>
                    <th>Mesa</th>
                    <th>Mesero</th>
                    <th>Apertura</th>
                    <th>Cierre</th>
                    <th>Estado</th>
                    <th className="text-right">Total</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {q.data.rows.map((o) => (
                    <tr key={o.id}>
                      <td className="font-bold">#{o.number}</td>
                      <td>{o.table.name}</td>
                      <td>{o.waiter.name}</td>
                      <td className="whitespace-nowrap text-ink-500">{dateTime(o.openedAt)}</td>
                      <td className="whitespace-nowrap text-ink-500">{dateTime(o.closedAt)}</td>
                      <td>
                        <Badge className={ORDER_STATUS[o.status].chip}>{ORDER_STATUS[o.status].label}</Badge>
                      </td>
                      <td className="text-right font-semibold tabular-nums">{o.status === 'PAID' ? money(o.total) : '—'}</td>
                      <td className="whitespace-nowrap text-right">
                        <IconButton title="Ver detalle" onClick={() => setDetail(o.id)}>
                          <Eye className="h-4 w-4" />
                        </IconButton>
                        <IconButton title="Historial" onClick={() => setHistory(o.id)}>
                          <ClipboardList className="h-4 w-4" />
                        </IconButton>
                        {o.status === 'PAID' && (
                          <IconButton title="Comprobante" onClick={() => window.open(`/imprimir/comprobante/${o.id}`, '_blank')}>
                            <Printer className="h-4 w-4" />
                          </IconButton>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={25} total={q.data.total} onChange={setPage} />
          </>
        )}
      </Card>
      {detail && <OrderDetailModal id={detail} onClose={() => setDetail(null)} />}
      {history && <HistoryModal orderId={history} open onClose={() => setHistory(null)} />}
    </div>
  );
}

function OrderDetailModal({ id, onClose }: { id: number; onClose: () => void }) {
  const q = useQuery({ queryKey: ['order', id], queryFn: () => api.get<Order>(`/orders/${id}`) });
  const o = q.data;
  return (
    <Modal open onClose={onClose} title={o ? `Orden #${o.number} · ${o.table.name}` : 'Orden'} subtitle={o ? `${o.waiter.name} · ${dateTime(o.openedAt)}` : undefined} size="lg">
      {!o ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          <table className="table-base">
            <thead>
              <tr>
                <th>Producto</th>
                <th>Estado</th>
                <th className="text-right">Cant.</th>
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {o.items.map((i) => (
                <tr key={i.id}>
                  <td>
                    <div className={i.status === 'CANCELLED' ? 'line-through text-ink-400' : 'font-semibold'}>{i.productName}</div>
                    {i.cancelReason && <div className="text-xs italic text-rose-600">{i.cancelReason}</div>}
                  </td>
                  <td>
                    <Badge className={ITEM_STATUS[i.status].chip}>{ITEM_STATUS[i.status].label}</Badge>
                  </td>
                  <td className="text-right">{i.quantity}</td>
                  <td className="text-right tabular-nums">{money(i.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ml-auto max-w-xs space-y-1 text-sm">
            <div className="flex justify-between"><span>Subtotal</span><span>{money(o.totals.subtotal)}</span></div>
            {o.totals.discount > 0 && <div className="flex justify-between"><span>Descuento</span><span>-{money(o.totals.discount)}</span></div>}
            <div className="flex justify-between"><span>Servicio</span><span>{money(o.totals.service)}</span></div>
            <div className="flex justify-between"><span>IVA</span><span>{money(o.totals.tax)}</span></div>
            <div className="flex justify-between font-bold"><span>Total</span><span>{money(o.totals.total)}</span></div>
          </div>
          {o.payments.length > 0 && (
            <div>
              <h4 className="mb-2 text-sm font-bold">Pagos</h4>
              <ul className="space-y-1 text-sm">
                {o.payments.map((p) => (
                  <li key={p.id} className="flex justify-between rounded-lg bg-ink-50 px-3 py-2">
                    <span>
                      {p.paymentMethod.name} {p.payerLabel && `· ${p.payerLabel}`} · {p.user.name}
                    </span>
                    <span className="font-semibold">{money(p.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
