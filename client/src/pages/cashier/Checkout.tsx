import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { toast } from 'sonner';
import { AlertTriangle, ArrowLeft, Banknote, CheckCircle2, CreditCard, Divide, History, ListChecks, Percent, Printer, Smartphone, Wallet } from 'lucide-react';
import { api, errorMessage, uuid } from '../../lib/api';
import { Account, PaymentMethod } from '../../lib/types';
import { ITEM_STATUS, ORDER_STATUS } from '../../lib/labels';
import { dateTime, money, time } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import { Badge, Button, Card, CardHeader, ErrorState, Field, Input, Loading, Modal, Select, Stepper, Tabs } from '../../components/ui';
import { useCashCurrent } from './Accounts';
import { HistoryModal } from '../waiter/OrderScreen';

type Mode = 'FULL' | 'EQUAL' | 'ITEMS' | 'CUSTOM';

const METHOD_ICON: Record<string, JSX.Element> = {
  CASH: <Banknote className="h-5 w-5" />,
  CARD: <CreditCard className="h-5 w-5" />,
  TRANSFER: <Smartphone className="h-5 w-5" />,
  OTHER: <Wallet className="h-5 w-5" />,
};

export default function Checkout() {
  const { orderId } = useParams();
  const id = Number(orderId);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const accQ = useQuery({ queryKey: ['account', id], queryFn: () => api.get<Account>(`/cashier/orders/${id}/account`) });
  const methodsQ = useQuery({ queryKey: ['payment-methods'], queryFn: () => api.get<PaymentMethod[]>('/payment-methods') });
  const cash = useCashCurrent();

  const [mode, setMode] = useState<Mode>('FULL');
  const [methodId, setMethodId] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  const [received, setReceived] = useState('');
  const [reference, setReference] = useState('');
  const [payer, setPayer] = useState('');
  const [parts, setParts] = useState(2);
  const [paidParts, setPaidParts] = useState(0);
  const [selected, setSelected] = useState<Record<number, number>>({});
  const [discountOpen, setDiscountOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const idemKey = useRef(uuid());

  const acc = accQ.data;
  const methods = methodsQ.data ?? [];
  const method = methods.find((m) => m.id === methodId) ?? null;
  useEffect(() => {
    if (!methodId && methods.length) setMethodId(methods[0].id);
  }, [methods, methodId]);

  const remainingParts = Math.max(1, parts - paidParts);
  const splitQ = useQuery({
    queryKey: ['split', id, remainingParts, acc?.totals.balance],
    queryFn: () => api.get<{ amounts: number[] }>(`/cashier/orders/${id}/split?parts=${remainingParts}`),
    enabled: mode === 'EQUAL' && remainingParts >= 2 && !!acc && acc.totals.balance > 0,
  });

  const itemsAmount = useMemo(() => {
    if (!acc) return 0;
    return acc.items.reduce((a, i) => a + (selected[i.id] ?? 0) * (i.unitShare ?? 0), 0);
  }, [acc, selected]);

  const due = !acc
    ? 0
    : mode === 'FULL'
      ? acc.totals.balance
      : mode === 'EQUAL'
        ? remainingParts === 1
          ? acc.totals.balance
          : splitQ.data?.amounts[0] ?? 0
        : mode === 'ITEMS'
          ? Math.min(itemsAmount, acc.totals.balance)
          : Number(amount || 0);
  const receivedNum = Number(received || 0);
  const change = method?.kind === 'CASH' && receivedNum > due ? receivedNum - due : 0;

  const pay = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        paymentMethodId: methodId,
        splitMode: mode,
        idempotencyKey: idemKey.current,
        reference: reference || null,
        payerLabel: payer || (mode === 'EQUAL' ? `Persona ${paidParts + 1} de ${parts}` : null),
      };
      if (mode === 'EQUAL' || mode === 'CUSTOM') body.amount = Math.round(due * 100) / 100;
      if (mode === 'ITEMS') body.items = Object.entries(selected).filter(([, q]) => q > 0).map(([k, q]) => ({ orderItemId: Number(k), quantity: q }));
      if (method?.kind === 'CASH') body.receivedAmount = received ? receivedNum : null;
      return api.post<{ payment: { id: number; amount: string; changeAmount: string }; closed: boolean; account: Account }>(`/cashier/orders/${id}/payments`, body);
    },
    onSuccess: (r) => {
      idemKey.current = uuid(); // nueva clave solo tras éxito: reintentos fallidos no duplican
      qc.setQueryData(['account', id], r.account);
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['cash'] });
      qc.invalidateQueries({ queryKey: ['tables'] });
      const ch = Number(r.payment.changeAmount);
      toast.success(`Pago registrado: ${money(r.payment.amount)}`, { description: ch > 0 ? `Vuelto: ${money(ch)}` : undefined, duration: 8000 });
      if (mode === 'EQUAL') setPaidParts((p) => p + 1);
      setSelected({});
      setAmount('');
      setReceived('');
      setReference('');
      setPayer('');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (accQ.isLoading) return <Loading />;
  if (accQ.error || !acc) return <ErrorState error={accQ.error} onRetry={() => accQ.refetch()} />;

  const closed = acc.status === 'PAID';
  const noCash = !cash.data?.session;
  const t = acc.totals;
  const needsReference = method && (method.kind === 'CARD' || method.kind === 'TRANSFER');
  const invalid = !methodId || due <= 0 || due > t.balance + 0.001 || (method?.kind === 'CASH' && received !== '' && receivedNum < due) || (mode === 'ITEMS' && itemsAmount <= 0);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => navigate('/caja')}>
          Cuentas
        </Button>
        <div className="flex-1" />
        <Button variant="secondary" size="sm" icon={<History className="h-4 w-4" />} onClick={() => setHistoryOpen(true)}>
          Historial
        </Button>
        <Button variant="secondary" size="sm" icon={<Printer className="h-4 w-4" />} onClick={() => window.open(`/imprimir/comprobante/${id}`, '_blank')}>
          {closed ? 'Comprobante' : 'Pre-cuenta'}
        </Button>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_440px]">
        <div className="space-y-6">
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-ink-100 p-5">
              <div>
                <div className="text-xs font-bold uppercase tracking-[0.14em] text-brand-600">Cuenta</div>
                <h1 className="text-2xl font-extrabold tracking-tight">{acc.table.name}</h1>
                <div className="mt-1 text-sm text-ink-500">
                  Orden #{acc.number} · Mesero {acc.waiter.name} · {acc.guests} persona(s) · Abierta {time(acc.openedAt)}
                </div>
              </div>
              <Badge className={ORDER_STATUS[acc.status].chip}>{ORDER_STATUS[acc.status].label}</Badge>
            </div>
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Producto</th>
                    <th className="text-center">Cant.</th>
                    <th className="text-right">Precio unit.</th>
                    <th className="text-right">Subtotal</th>
                    <th className="text-center">Pagado</th>
                  </tr>
                </thead>
                <tbody>
                  {acc.items.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <div className="font-semibold">{i.productName}</div>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <Badge className={ITEM_STATUS[i.status].chip}>{ITEM_STATUS[i.status].label}</Badge>
                          {i.notes && <span className="text-xs text-ink-500">{i.notes}</span>}
                        </div>
                      </td>
                      <td className="text-center font-bold tabular-nums">{i.quantity}</td>
                      <td className="text-right tabular-nums">{money(i.unitPrice)}</td>
                      <td className="text-right font-semibold tabular-nums">{money(i.lineTotal)}</td>
                      <td className="text-center text-xs">{i.paidQuantity > 0 ? <span className="font-bold text-emerald-700">{i.paidQuantity}/{i.quantity}</span> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {acc.cancelledItems.length > 0 && (
              <div className="border-t border-ink-100 px-5 py-3 text-xs text-ink-500">
                No se cobran {acc.cancelledItems.length} producto(s) cancelado(s): {acc.cancelledItems.map((c) => `${c.quantity}x ${c.productName}`).join(', ')}
              </div>
            )}
            <div className="grid gap-6 border-t border-ink-100 bg-ink-50/50 p-5 sm:grid-cols-2">
              <div className="space-y-1.5 text-sm">
                <TotRow label="Subtotal" value={money(t.subtotal)} />
                <TotRow
                  label={
                    <span className="flex items-center gap-2">
                      Descuento{acc.discountType === 'PERCENT' ? ` (${Number(acc.discountValue)}%)` : ''}
                      {can('orders.discount') && !closed && t.paid === 0 && (
                        <button className="text-xs font-bold text-brand-600 hover:underline" onClick={() => setDiscountOpen(true)}>
                          {t.discount > 0 ? 'Editar' : 'Aplicar'}
                        </button>
                      )}
                    </span>
                  }
                  value={t.discount > 0 ? `-${money(t.discount)}` : money(0)}
                />
                <TotRow label={`Servicio (${t.serviceRate}%)`} value={money(t.service)} />
                <TotRow label={`IVA (${t.taxRate}%)${t.pricesIncludeTax ? ' incluido' : ''}`} value={money(t.tax)} />
                <div className="flex items-baseline justify-between border-t border-ink-200 pt-2">
                  <span className="font-bold">Total a pagar</span>
                  <span className="text-2xl font-extrabold">{money(t.total)}</span>
                </div>
              </div>
              <div className="space-y-1.5 text-sm">
                <TotRow label="Pagos realizados" value={money(t.paid)} />
                <div className={clsx('rounded-2xl p-4 text-center', t.balance > 0 ? 'bg-ink-900 text-white' : 'bg-emerald-600 text-white')}>
                  <div className="text-xs font-bold uppercase tracking-wider opacity-70">Saldo pendiente</div>
                  <div className="text-3xl font-extrabold tracking-tight">{money(t.balance)}</div>
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Pagos registrados" subtitle={`${acc.payments.length} pago(s)`} />
            {acc.payments.length === 0 ? (
              <p className="px-5 py-6 text-sm text-ink-500">Aún no hay pagos.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Hora</th>
                      <th>Método</th>
                      <th>Cliente</th>
                      <th>Referencia</th>
                      <th className="text-right">Monto</th>
                      <th className="text-right">Vuelto</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {acc.payments.map((p) => (
                      <tr key={p.id}>
                        <td className="whitespace-nowrap text-ink-500">{time(p.createdAt)}</td>
                        <td className="font-semibold">{p.paymentMethod.name}</td>
                        <td>{p.payerLabel ?? '—'}</td>
                        <td className="text-ink-500">{p.reference ?? '—'}</td>
                        <td className="text-right font-bold tabular-nums">{money(p.amount)}</td>
                        <td className="text-right tabular-nums text-ink-500">{Number(p.changeAmount) > 0 ? money(p.changeAmount) : '—'}</td>
                        <td className="text-right">
                          <button className="text-ink-400 hover:text-ink-900" title="Imprimir comprobante de este pago" onClick={() => window.open(`/imprimir/comprobante/${id}?paymentId=${p.id}`, '_blank')}>
                            <Printer className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        {/* Panel de cobro */}
        <div>
          <div className="card sticky top-20 overflow-hidden">
            {closed ? (
              <div className="flex flex-col items-center p-8 text-center">
                <CheckCircle2 className="h-16 w-16 text-emerald-500" />
                <h2 className="mt-4 text-xl font-extrabold">Cuenta pagada y cerrada</h2>
                <p className="mt-1 text-sm text-ink-500">La venta quedó registrada {acc.closedAt ? dateTime(acc.closedAt) : ''} y {acc.table.name} está disponible nuevamente.</p>
                <div className="mt-6 flex w-full flex-col gap-2">
                  <Button size="lg" icon={<Printer className="h-4 w-4" />} onClick={() => window.open(`/imprimir/comprobante/${id}`, '_blank')}>
                    Imprimir comprobante
                  </Button>
                  <Button size="lg" variant="secondary" onClick={() => navigate('/caja')}>
                    Volver a cuentas
                  </Button>
                </div>
              </div>
            ) : acc.status === 'CANCELLED' ? (
              <div className="p-8 text-center text-sm text-ink-500">Esta orden fue anulada: {acc.cancelReason}</div>
            ) : (
              <>
                <div className="border-b border-ink-100 p-5">
                  <h2 className="text-lg font-extrabold">Registrar pago</h2>
                  <Tabs<Mode>
                    className="mt-3 flex w-full [&>button]:flex-1"
                    value={mode}
                    onChange={(m) => {
                      setMode(m);
                      setSelected({});
                    }}
                    options={[
                      { value: 'FULL', label: 'Total' },
                      { value: 'EQUAL', label: <span className="inline-flex items-center gap-1"><Divide className="h-3.5 w-3.5" />Partes</span> },
                      { value: 'ITEMS', label: <span className="inline-flex items-center gap-1"><ListChecks className="h-3.5 w-3.5" />Consumo</span> },
                      { value: 'CUSTOM', label: 'Monto' },
                    ]}
                  />
                </div>
                <div className="space-y-5 p-5">
                  {noCash && (
                    <div className="flex items-start gap-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <div>
                        La caja está cerrada.{' '}
                        {can('cash.operate') && (
                          <Link to="/caja/control" className="font-bold underline">
                            Abrir caja
                          </Link>
                        )}
                      </div>
                    </div>
                  )}

                  {mode === 'EQUAL' && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-sm font-semibold">Dividir entre</div>
                          <div className="text-xs text-ink-500">{paidParts > 0 ? `${paidParts} de ${parts} ya pagaron` : 'personas'}</div>
                        </div>
                        <Stepper value={parts} onChange={(v) => setParts(Math.max(v, paidParts + 1))} min={2} max={50} />
                      </div>
                      <div className="rounded-xl bg-ink-50 p-3 text-sm">
                        {remainingParts === 1 ? (
                          <div className="flex justify-between font-semibold">
                            <span>Última parte</span>
                            <span>{money(t.balance)}</span>
                          </div>
                        ) : (
                          splitQ.data?.amounts.map((a, i) => (
                            <div key={i} className={clsx('flex justify-between', i === 0 && 'font-bold text-ink-900')}>
                              <span>
                                Persona {paidParts + i + 1} {i === 0 && '← cobrar ahora'}
                              </span>
                              <span className="tabular-nums">{money(a)}</span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )}

                  {mode === 'ITEMS' && (
                    <div className="max-h-64 space-y-2 overflow-y-auto">
                      {acc.items.filter((i) => (i.unpaidQuantity ?? 0) > 0).map((i) => (
                        <div key={i.id} className={clsx('flex items-center justify-between gap-3 rounded-xl border p-2.5', (selected[i.id] ?? 0) > 0 ? 'border-brand-300 bg-brand-50' : 'border-ink-200')}>
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold">{i.productName}</div>
                            <div className="text-xs text-ink-500">
                              {money(i.unitShare ?? 0)} c/u con impuestos · quedan {i.unpaidQuantity}
                            </div>
                          </div>
                          <Stepper size="sm" value={selected[i.id] ?? 0} min={0} max={i.unpaidQuantity} onChange={(v) => setSelected((s) => ({ ...s, [i.id]: v }))} />
                        </div>
                      ))}
                      {acc.items.every((i) => (i.unpaidQuantity ?? 0) === 0) && <p className="text-sm text-ink-500">Todos los productos ya fueron asignados a un pago.</p>}
                    </div>
                  )}

                  {mode === 'CUSTOM' && (
                    <Field label="Monto a pagar" hint={`Máximo ${money(t.balance)}`}>
                      <Input type="number" inputMode="decimal" min={0} step="any" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" className="text-lg font-bold" />
                    </Field>
                  )}

                  <div>
                    <span className="label">Método de pago</span>
                    <div className="grid grid-cols-2 gap-2">
                      {methods.map((m) => (
                        <button
                          key={m.id}
                          onClick={() => setMethodId(m.id)}
                          className={clsx('flex items-center gap-2 rounded-xl border-2 px-3 py-2.5 text-left text-sm font-bold transition', methodId === m.id ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-ink-200 text-ink-700 hover:border-ink-300')}
                        >
                          {METHOD_ICON[m.kind]}
                          <span className="truncate">{m.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {method?.kind === 'CASH' && (
                    <div>
                      <Field label="Efectivo recibido">
                        <Input type="number" inputMode="decimal" min={0} step="any" value={received} onChange={(e) => setReceived(e.target.value)} placeholder={due ? String(due) : '0'} className="text-lg font-bold" />
                      </Field>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {[due, ...[5000, 10000, 20000, 50000].map((b) => Math.ceil(due / b) * b)].filter((v, i, arr) => v > 0 && arr.indexOf(v) === i).slice(0, 5).map((v) => (
                          <button key={v} onClick={() => setReceived(String(v))} className="rounded-lg bg-ink-100 px-2.5 py-1 text-xs font-bold text-ink-700 hover:bg-ink-200">
                            {v === due ? 'Exacto' : money(v)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {needsReference && (
                    <Field label={method.kind === 'CARD' ? 'Nº de autorización / voucher' : 'Nº de comprobante'}>
                      <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} placeholder="Opcional" />
                    </Field>
                  )}
                  <Field label="Cliente (opcional)">
                    <Input value={payer} onChange={(e) => setPayer(e.target.value)} maxLength={60} placeholder={mode === 'EQUAL' ? `Persona ${paidParts + 1}` : 'Nombre o descripción'} />
                  </Field>

                  <div className="rounded-2xl bg-ink-900 p-4 text-white">
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm text-ink-300">A cobrar</span>
                      <span className="text-3xl font-extrabold tracking-tight">{money(due)}</span>
                    </div>
                    {change > 0 && (
                      <div className="mt-2 flex items-baseline justify-between border-t border-white/10 pt-2">
                        <span className="text-sm text-ink-300">Vuelto</span>
                        <span className="text-xl font-extrabold text-lime-300">{money(change)}</span>
                      </div>
                    )}
                    {mode === 'ITEMS' && itemsAmount > 0 && <div className="mt-1 text-xs text-ink-400">Incluye servicio e impuestos proporcionales. El servidor calcula el monto exacto.</div>}
                  </div>

                  <Button size="xl" variant="success" className="w-full" disabled={invalid || noCash || !can('payments.create')} loading={pay.isPending} onClick={() => pay.mutate()}>
                    {due >= t.balance - 0.001 && due > 0 ? 'Cobrar y cerrar cuenta' : 'Registrar pago parcial'}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <DiscountModal open={discountOpen} account={acc} onClose={() => setDiscountOpen(false)} />
      <HistoryModal orderId={id} open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </div>
  );
}

function TotRow({ label, value }: { label: React.ReactNode; value: string }) {
  return (
    <div className="flex items-center justify-between text-ink-600">
      <span>{label}</span>
      <span className="font-semibold tabular-nums text-ink-800">{value}</span>
    </div>
  );
}

function DiscountModal({ open, account, onClose }: { open: boolean; account: Account; onClose: () => void }) {
  const qc = useQueryClient();
  const [type, setType] = useState<'PERCENT' | 'AMOUNT'>((account.discountType as 'PERCENT' | 'AMOUNT') ?? 'PERCENT');
  const [value, setValue] = useState(account.discountType ? String(Number(account.discountValue)) : '');
  const [reason, setReason] = useState(account.discountReason ?? '');
  const m = useMutation({
    mutationFn: (remove?: boolean) => api.post(`/orders/${account.id}/discount`, remove ? { type: null, value: 0 } : { type, value: Number(value), reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['account', account.id] });
      toast.success('Descuento actualizado');
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const v = Number(value);
  const invalid = !(v > 0) || (type === 'PERCENT' && v > 100) || reason.trim().length < 3;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Aplicar descuento"
      size="sm"
      footer={
        <>
          {account.discountType && (
            <Button variant="ghost" className="mr-auto text-rose-600" onClick={() => m.mutate(true)}>
              Quitar descuento
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={invalid} loading={m.isPending} onClick={() => m.mutate(false)} icon={<Percent className="h-4 w-4" />}>
            Aplicar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Tipo">
          <Select value={type} onChange={(e) => setType(e.target.value as 'PERCENT' | 'AMOUNT')}>
            <option value="PERCENT">Porcentaje (%)</option>
            <option value="AMOUNT">Monto fijo (₡)</option>
          </Select>
        </Field>
        <Field label={type === 'PERCENT' ? 'Porcentaje' : 'Monto'}>
          <Input type="number" min={0} max={type === 'PERCENT' ? 100 : undefined} value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Field label="Motivo (obligatorio)">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} placeholder="Ej. cortesía de la casa" />
        </Field>
      </div>
    </Modal>
  );
}
