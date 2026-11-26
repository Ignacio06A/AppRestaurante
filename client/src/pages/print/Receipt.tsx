import { useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Account, Payment, Settings } from '../../lib/types';
import { dateTime, money } from '../../lib/format';
import { Button, Loading } from '../../components/ui';

interface ReceiptData {
  settings: Settings;
  order: Account;
  payment: Payment | null;
  generatedAt: string;
}

/** Comprobante en formato ticket (80 mm) listo para imprimir. */
export default function ReceiptPrint() {
  const { orderId } = useParams();
  const [sp] = useSearchParams();
  const paymentId = sp.get('paymentId');
  const q = useQuery({
    queryKey: ['receipt', orderId, paymentId],
    queryFn: () => api.get<ReceiptData>(`/cashier/orders/${orderId}/receipt${paymentId ? `?paymentId=${paymentId}` : ''}`),
  });
  useEffect(() => {
    if (q.data) setTimeout(() => window.print(), 400);
  }, [q.data]);
  if (q.isLoading || !q.data) return <Loading />;
  const { settings: s, order: o, payment } = q.data;
  const t = o.totals;
  const paid = o.status === 'PAID';
  return (
    <div className="min-h-screen bg-ink-100 py-8 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-[320px] justify-center gap-2">
        <Button onClick={() => window.print()}>Imprimir</Button>
        <Button variant="secondary" onClick={() => window.close()}>
          Cerrar
        </Button>
      </div>
      <div className="mx-auto w-[302px] bg-white p-4 font-mono text-[12px] leading-snug text-black shadow print:shadow-none">
        <div className="text-center">
          {s.logoUrl && <img src={s.logoUrl} alt="" className="mx-auto mb-2 h-12 w-12 object-contain grayscale" />}
          <div className="text-base font-bold">{s.name}</div>
          {s.legalName && <div>{s.legalName}</div>}
          {s.legalId && <div>Céd. jurídica {s.legalId}</div>}
          {s.address && <div>{s.address}</div>}
          {s.phone && <div>Tel. {s.phone}</div>}
        </div>
        <Divider />
        <div className="text-center font-bold">{payment ? 'COMPROBANTE DE PAGO' : paid ? 'COMPROBANTE DE VENTA' : 'PRE-CUENTA (NO ES COMPROBANTE)'}</div>
        <Divider />
        <Line l="Orden" r={`#${o.number}`} />
        <Line l="Mesa" r={o.table.name} />
        <Line l="Mesero" r={o.waiter.name} />
        <Line l="Personas" r={String(o.guests)} />
        <Line l="Fecha" r={dateTime(paid && o.closedAt ? o.closedAt : q.data.generatedAt)} />
        <Divider />
        {o.items.map((i) => (
          <div key={i.id} className="mb-1">
            <div>{i.productName}</div>
            <Line l={`  ${i.quantity} x ${money(i.unitPrice)}`} r={money(i.lineTotal)} />
          </div>
        ))}
        <Divider />
        <Line l="Subtotal" r={money(t.subtotal)} />
        {t.discount > 0 && <Line l={`Descuento${o.discountReason ? ` (${o.discountReason})` : ''}`} r={`-${money(t.discount)}`} />}
        {t.service > 0 && <Line l={`Servicio ${t.serviceRate}%`} r={money(t.service)} />}
        {t.tax > 0 && <Line l={`IVA ${t.taxRate}%${t.pricesIncludeTax ? ' (incl.)' : ''}`} r={money(t.tax)} />}
        <div className="mt-1 flex justify-between text-[15px] font-bold">
          <span>TOTAL</span>
          <span>{money(t.total)}</span>
        </div>
        {o.payments.length > 0 && (
          <>
            <Divider />
            <div className="font-bold">Pagos</div>
            {(payment ? [payment] : o.payments).map((p) => (
              <div key={p.id}>
                <Line l={`${p.paymentMethod.name}${p.payerLabel ? ` · ${p.payerLabel}` : ''}`} r={money(p.amount)} />
                {p.receivedAmount && Number(p.changeAmount) > 0 && (
                  <>
                    <Line l="  Recibido" r={money(p.receivedAmount)} />
                    <Line l="  Vuelto" r={money(p.changeAmount)} />
                  </>
                )}
                {p.reference && <Line l="  Ref." r={p.reference} />}
              </div>
            ))}
            <Line l="Total pagado" r={money(t.paid)} />
            <Line l="Saldo pendiente" r={money(t.balance)} />
          </>
        )}
        <Divider />
        {s.receiptFooter && <div className="text-center">{s.receiptFooter}</div>}
        <div className="mt-2 text-center text-[10px]">Moneda: {s.currencyCode} · Impreso {dateTime(q.data.generatedAt)}</div>
      </div>
    </div>
  );
}

function Line({ l, r }: { l: string; r: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="whitespace-pre">{l}</span>
      <span className="text-right">{r}</span>
    </div>
  );
}
function Divider() {
  return <div className="my-2 border-t border-dashed border-black" />;
}
