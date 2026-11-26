import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { toast } from 'sonner';
import { ArrowDownCircle, ArrowUpCircle, Banknote, Calculator, CreditCard, Lock, MinusCircle, PlusCircle, Receipt, Scale, Smartphone, Unlock, Wallet } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { CashMovement, CashSession, CashSummary } from '../../lib/types';
import { MOVEMENT_TYPE } from '../../lib/labels';
import { dateTime, money, time } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Loading, Modal, PageHeader, StatCard, Textarea, useConfirm } from '../../components/ui';
import { useCashCurrent } from './Accounts';

type MovType = 'INCOME' | 'WITHDRAWAL' | 'EXPENSE' | 'ADJUSTMENT';

export default function CashControl() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { can } = useAuth();
  const confirm = useConfirm();
  const cur = useCashCurrent();
  const session = cur.data?.session;
  const detail = useQuery({
    queryKey: ['cash', 'session', session?.id],
    queryFn: () => api.get<{ session: CashSession; summary: CashSummary; movements: CashMovement[] }>(`/cash/sessions/${session!.id}`),
    enabled: !!session,
  });

  const [opening, setOpening] = useState('');
  const [openNotes, setOpenNotes] = useState('');
  const [mov, setMov] = useState<MovType | null>(null);
  const [closeOpen, setCloseOpen] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: ['cash'] });
  const openM = useMutation({
    mutationFn: () => api.post('/cash/open', { openingAmount: Number(opening || 0), notes: openNotes || null }),
    onSuccess: () => (toast.success('Caja abierta'), setOpening(''), setOpenNotes(''), refresh()),
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (cur.isLoading) return <Loading />;

  if (!session) {
    return (
      <div>
        <PageHeader eyebrow="Caja" title="Control de caja" subtitle="No hay una caja abierta en este momento." />
        <Card className="mx-auto max-w-lg">
          <CardHeader title="Apertura de caja" subtitle="Registre el fondo inicial con el que inicia el turno" icon={<Unlock className="h-5 w-5" />} />
          <div className="space-y-4 p-5">
            <Field label="Monto inicial (₡)">
              <Input type="number" inputMode="decimal" min={0} value={opening} onChange={(e) => setOpening(e.target.value)} placeholder="50000" className="text-lg font-bold" autoFocus />
            </Field>
            <Field label="Observaciones">
              <Textarea value={openNotes} onChange={(e) => setOpenNotes(e.target.value)} placeholder="Ej. fondo en billetes de ₡1000 y monedas" maxLength={500} />
            </Field>
            <Button
              size="lg"
              className="w-full"
              icon={<Unlock className="h-4 w-4" />}
              loading={openM.isPending}
              disabled={opening === '' || Number(opening) < 0}
              onClick={async () => {
                if (await confirm({ title: 'Abrir caja', message: `Se abrirá la caja con un fondo inicial de ${money(Number(opening))}.`, confirmText: 'Abrir caja' })) openM.mutate();
              }}
            >
              Abrir caja
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const s = detail.data?.summary ?? cur.data?.summary;
  const movements = detail.data?.movements ?? [];
  return (
    <div>
      <PageHeader
        eyebrow={session.register.name}
        title="Control de caja"
        subtitle={`Abierta por ${session.openedBy.name} · ${dateTime(session.openedAt)}${session.openingNotes ? ` · ${session.openingNotes}` : ''}`}
        actions={
          <>
            <Button variant="secondary" icon={<PlusCircle className="h-4 w-4" />} onClick={() => setMov('INCOME')}>
              Entrada
            </Button>
            <Button variant="secondary" icon={<ArrowUpCircle className="h-4 w-4" />} onClick={() => setMov('WITHDRAWAL')}>
              Retiro
            </Button>
            <Button variant="secondary" icon={<MinusCircle className="h-4 w-4" />} onClick={() => setMov('EXPENSE')}>
              Gasto
            </Button>
            {can('cash.adjust') && (
              <Button variant="secondary" icon={<Scale className="h-4 w-4" />} onClick={() => setMov('ADJUSTMENT')}>
                Ajuste
              </Button>
            )}
            {can('cash.close') && (
              <Button variant="dark" icon={<Lock className="h-4 w-4" />} onClick={() => setCloseOpen(true)}>
                Cerrar caja
              </Button>
            )}
          </>
        }
      />

      {s && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="Efectivo esperado" value={money(s.expectedCash)} icon={<Banknote className="h-5 w-5" />} accent="bg-emerald-100 text-emerald-700" hint="Fondo + ventas en efectivo + entradas − retiros − gastos ± ajustes" />
            <StatCard label="Total vendido" value={money(s.totalSales)} icon={<Receipt className="h-5 w-5" />} accent="bg-brand-100 text-brand-700" hint={`${s.paymentsCount} pagos`} />
            <StatCard label="Monto inicial" value={money(s.openingAmount)} icon={<Wallet className="h-5 w-5" />} />
            <StatCard label="Salidas (retiros + gastos)" value={money(s.totalWithdrawals + s.totalExpenses)} icon={<ArrowDownCircle className="h-5 w-5" />} accent="bg-rose-100 text-rose-700" />
          </div>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <MiniStat icon={<Banknote className="h-4 w-4" />} label="Efectivo" value={s.cashSales} />
            <MiniStat icon={<CreditCard className="h-4 w-4" />} label="Tarjeta" value={s.cardSales} />
            <MiniStat icon={<Smartphone className="h-4 w-4" />} label="Transferencia / SINPE" value={s.transferSales} />
            <MiniStat icon={<Wallet className="h-4 w-4" />} label="Otros medios" value={s.otherSales} />
          </div>
        </>
      )}

      <Card>
        <CardHeader title="Movimientos de la sesión" subtitle="Cada movimiento registra monto, tipo, descripción, usuario y fecha" />
        {detail.isLoading ? (
          <Loading />
        ) : !movements.length ? (
          <EmptyState title="Sin movimientos todavía" description="Las ventas cobradas y los movimientos manuales aparecerán aquí." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Hora</th>
                  <th>Tipo</th>
                  <th>Descripción</th>
                  <th>Método</th>
                  <th>Usuario</th>
                  <th className="text-right">Monto</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((m) => (
                  <tr key={m.id}>
                    <td className="whitespace-nowrap text-ink-500">{time(m.createdAt)}</td>
                    <td>
                      <Badge className={MOVEMENT_TYPE[m.type].chip}>{MOVEMENT_TYPE[m.type].label}</Badge>
                    </td>
                    <td>
                      {m.description}
                      {m.authorizedBy && <div className="text-xs text-ink-500">Autorizado por {m.authorizedBy.name}</div>}
                    </td>
                    <td className="text-ink-500">{m.paymentMethod?.name ?? '—'}</td>
                    <td className="text-ink-500">{m.user.name}</td>
                    <td className={clsx('text-right font-bold tabular-nums', Number(m.amount) < 0 ? 'text-rose-600' : 'text-ink-900')}>{money(m.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <MovementModal type={mov} sessionId={session.id} expected={s?.expectedCash ?? 0} onClose={() => setMov(null)} />
      {s && <CloseModal open={closeOpen} onClose={() => setCloseOpen(false)} session={session} summary={s} onClosed={() => navigate(`/imprimir/cierre/${session.id}`)} />}
    </div>
  );
}

function MiniStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-ink-200/70 bg-white px-4 py-3">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink-100 text-ink-600">{icon}</div>
      <div className="min-w-0">
        <div className="truncate text-[11px] font-semibold uppercase tracking-wide text-ink-500">{label}</div>
        <div className="font-extrabold tabular-nums">{money(value)}</div>
      </div>
    </div>
  );
}

const MOV_COPY: Record<MovType, { title: string; hint: string }> = {
  INCOME: { title: 'Entrada de dinero', hint: 'Dinero que ingresa a la caja (no proveniente de ventas)' },
  WITHDRAWAL: { title: 'Retiro de efectivo', hint: 'Dinero que se retira de la caja (p. ej. depósito bancario)' },
  EXPENSE: { title: 'Registrar gasto', hint: 'Pago de compras o servicios con efectivo de la caja' },
  ADJUSTMENT: { title: 'Ajuste autorizado', hint: 'Use montos negativos para faltantes y positivos para sobrantes. Queda registrado como autorizado por usted.' },
};

function MovementModal({ type, sessionId, expected, onClose }: { type: MovType | null; sessionId: number; expected: number; onClose: () => void }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [desc, setDesc] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/cash/sessions/${sessionId}/movements`, { type, amount: Number(amount), description: desc }),
    onSuccess: () => {
      toast.success('Movimiento registrado');
      qc.invalidateQueries({ queryKey: ['cash'] });
      setAmount('');
      setDesc('');
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!type) return null;
  const v = Number(amount);
  const outflow = type === 'WITHDRAWAL' || type === 'EXPENSE';
  const invalid = !amount || (type === 'ADJUSTMENT' ? v === 0 : v <= 0) || desc.trim().length < 3 || (outflow && v > expected);
  return (
    <Modal
      open
      onClose={onClose}
      title={MOV_COPY[type].title}
      subtitle={MOV_COPY[type].hint}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={invalid} loading={m.isPending} onClick={() => m.mutate()}>
            Registrar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Monto (₡)" error={outflow && v > expected ? `No puede exceder el efectivo disponible (${money(expected)})` : null}>
          <Input type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="text-lg font-bold" autoFocus />
        </Field>
        <Field label="Descripción">
          <Input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={255} placeholder="Ej. compra de hielo" />
        </Field>
      </div>
    </Modal>
  );
}

function CloseModal({ open, onClose, session, summary: s, onClosed }: { open: boolean; onClose: () => void; session: CashSession; summary: CashSummary; onClosed: () => void }) {
  const qc = useQueryClient();
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/cash/sessions/${session.id}/close`, { countedCash: Number(counted), notes: notes || null }),
    onSuccess: () => {
      toast.success('Caja cerrada correctamente');
      qc.invalidateQueries({ queryKey: ['cash'] });
      onClose();
      onClosed();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const diff = counted === '' ? null : Number(counted) - s.expectedCash;
  const rows: [string, number, string?][] = [
    ['Monto inicial', s.openingAmount],
    ['Total vendido', s.totalSales, 'font-bold'],
    ['  Ventas en efectivo', s.cashSales],
    ['  Ventas con tarjeta', s.cardSales],
    ['  Ventas por transferencia', s.transferSales],
    ['  Otros métodos', s.otherSales],
    ['Entradas adicionales', s.totalIncome],
    ['Retiros', -s.totalWithdrawals],
    ['Gastos', -s.totalExpenses],
    ['Ajustes', s.totalAdjustments],
  ];
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Cierre de caja (arqueo)"
      subtitle={`${session.register.name} · abierta ${dateTime(session.openedAt)}`}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="dark" icon={<Lock className="h-4 w-4" />} disabled={counted === '' || Number(counted) < 0} loading={m.isPending} onClick={() => m.mutate()}>
            Confirmar cierre
          </Button>
        </>
      }
    >
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-1.5 text-sm">
          {rows.map(([l, v, cls]) => (
            <div key={l} className={clsx('flex justify-between', l.startsWith('  ') ? 'pl-4 text-ink-500' : 'text-ink-700', cls)}>
              <span>{l.trim()}</span>
              <span className="tabular-nums">{money(v)}</span>
            </div>
          ))}
          <div className="flex justify-between border-t border-ink-200 pt-2 text-base font-extrabold">
            <span>Efectivo esperado</span>
            <span>{money(s.expectedCash)}</span>
          </div>
        </div>
        <div className="space-y-4">
          <Field label="Dinero contado en efectivo (₡)">
            <Input type="number" inputMode="decimal" min={0} value={counted} onChange={(e) => setCounted(e.target.value)} className="h-14 text-2xl font-extrabold" autoFocus />
          </Field>
          {diff !== null && (
            <div className={clsx('rounded-2xl p-4', Math.abs(diff) < 0.005 ? 'bg-emerald-50 text-emerald-800' : diff > 0 ? 'bg-sky-50 text-sky-800' : 'bg-rose-50 text-rose-800')}>
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider">
                <Calculator className="h-4 w-4" /> Diferencia
              </div>
              <div className="mt-1 text-2xl font-extrabold">{money(diff)}</div>
              <div className="text-sm">{Math.abs(diff) < 0.005 ? 'La caja cuadra.' : diff > 0 ? 'Sobrante de efectivo.' : 'Faltante de efectivo.'}</div>
            </div>
          )}
          <Field label="Observaciones">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
