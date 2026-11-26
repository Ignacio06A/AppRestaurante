import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Building2, CreditCard, ImagePlus, MonitorSmartphone, Pencil, Plus, Receipt } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { PaymentMethod, Settings } from '../../lib/types';
import { PM_KIND } from '../../lib/labels';
import { money } from '../../lib/format';
import { Badge, Button, Card, CardHeader, Field, IconButton, Input, Loading, Modal, PageHeader, Select, Textarea, Toggle } from '../../components/ui';

export default function SettingsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/settings') });
  const [f, setF] = useState<Settings | null>(null);
  useEffect(() => {
    if (q.data && !f) setF(q.data);
  }, [q.data, f]);

  const save = useMutation({
    mutationFn: () =>
      api.put<Settings>('/settings', {
        name: f!.name,
        legalName: f!.legalName || null,
        legalId: f!.legalId || null,
        address: f!.address || null,
        phone: f!.phone || null,
        email: f!.email || '',
        logoUrl: f!.logoUrl || null,
        currencyCode: f!.currencyCode,
        currencySymbol: f!.currencySymbol,
        taxRate: Number(f!.taxRate),
        serviceRate: Number(f!.serviceRate),
        pricesIncludeTax: f!.pricesIncludeTax,
        receiptFooter: f!.receiptFooter || null,
        kdsWarningMinutes: Number(f!.kdsWarningMinutes),
        kdsCriticalMinutes: Number(f!.kdsCriticalMinutes),
      }),
    onSuccess: (s) => {
      qc.setQueryData(['settings'], s);
      setF(s);
      toast.success('Configuración guardada');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (q.isLoading || !f) return <Loading />;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setF({ ...f, [k]: v });
  const example = 10000;
  const service = (example * Number(f.serviceRate)) / 100;
  const tax = f.pricesIncludeTax ? example - example / (1 + Number(f.taxRate) / 100) : (example * Number(f.taxRate)) / 100;
  const total = f.pricesIncludeTax ? example + service : example + service + tax;

  return (
    <div>
      <PageHeader
        eyebrow="Administración"
        title="Configuración"
        actions={
          <Button loading={save.isPending} onClick={() => save.mutate()} disabled={f.name.trim().length < 2}>
            Guardar configuración
          </Button>
        }
      />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader icon={<Building2 className="h-5 w-5" />} title="Datos del restaurante" subtitle="Aparecen en comprobantes y reportes" />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <Field label="Nombre comercial" className="sm:col-span-2">
              <Input value={f.name} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Razón social">
              <Input value={f.legalName ?? ''} onChange={(e) => set('legalName', e.target.value)} />
            </Field>
            <Field label="Cédula jurídica">
              <Input value={f.legalId ?? ''} onChange={(e) => set('legalId', e.target.value)} />
            </Field>
            <Field label="Teléfono">
              <Input value={f.phone ?? ''} onChange={(e) => set('phone', e.target.value)} />
            </Field>
            <Field label="Correo">
              <Input type="email" value={f.email ?? ''} onChange={(e) => set('email', e.target.value)} />
            </Field>
            <Field label="Dirección" className="sm:col-span-2">
              <Input value={f.address ?? ''} onChange={(e) => set('address', e.target.value)} />
            </Field>
            <div className="sm:col-span-2">
              <span className="label">Logo</span>
              <div className="flex items-center gap-4">
                {f.logoUrl ? <img src={f.logoUrl} className="h-16 w-16 rounded-xl object-cover" alt="" /> : <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-ink-100 text-ink-400"><ImagePlus className="h-6 w-6" /></div>}
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-ink-200 px-4 py-2 text-sm font-semibold hover:bg-ink-50">
                  Subir logo
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      try {
                        set('logoUrl', (await api.upload(file)).url);
                      } catch (err) {
                        toast.error(errorMessage(err));
                      }
                    }}
                  />
                </label>
                {f.logoUrl && (
                  <button className="text-xs font-semibold text-rose-600" onClick={() => set('logoUrl', null)}>
                    Quitar
                  </button>
                )}
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader icon={<Receipt className="h-5 w-5" />} title="Moneda e impuestos" />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <Field label="Moneda">
              <Select value={f.currencyCode} onChange={(e) => set('currencyCode', e.target.value)}>
                <option value="CRC">CRC — Colón costarricense</option>
              </Select>
            </Field>
            <Field label="Símbolo">
              <Input value={f.currencySymbol} onChange={(e) => set('currencySymbol', e.target.value)} maxLength={4} />
            </Field>
            <Field label="IVA (%)">
              <Input type="number" min={0} max={100} step="0.01" value={f.taxRate} onChange={(e) => set('taxRate', e.target.value)} />
            </Field>
            <Field label="Servicio (%)" hint="Impuesto de servicio (10% habitual en CR)">
              <Input type="number" min={0} max={100} step="0.01" value={f.serviceRate} onChange={(e) => set('serviceRate', e.target.value)} />
            </Field>
            <div className="sm:col-span-2">
              <Toggle checked={f.pricesIncludeTax} onChange={(v) => set('pricesIncludeTax', v)} label="Los precios del menú ya incluyen IVA" />
            </div>
            <div className="rounded-xl bg-ink-50 p-4 text-sm sm:col-span-2">
              <div className="mb-2 text-xs font-bold uppercase tracking-wider text-ink-500">Ejemplo con un consumo de {money(example)}</div>
              <div className="flex justify-between"><span>Servicio</span><span>{money(service)}</span></div>
              <div className="flex justify-between"><span>IVA{f.pricesIncludeTax ? ' (incluido)' : ''}</span><span>{money(Math.round(tax * 100) / 100)}</span></div>
              <div className="flex justify-between font-bold"><span>Total</span><span>{money(Math.round(total * 100) / 100)}</span></div>
            </div>
            <Field label="Pie del comprobante" className="sm:col-span-2">
              <Textarea value={f.receiptFooter ?? ''} onChange={(e) => set('receiptFooter', e.target.value)} maxLength={300} />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader icon={<MonitorSmartphone className="h-5 w-5" />} title="Pantallas de cocina y bar" subtitle="Colores de alerta por tiempo de espera" />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <Field label="Alerta amarilla (minutos)">
              <Input type="number" min={1} value={f.kdsWarningMinutes} onChange={(e) => set('kdsWarningMinutes', Number(e.target.value))} />
            </Field>
            <Field label="Alerta roja (minutos)">
              <Input type="number" min={1} value={f.kdsCriticalMinutes} onChange={(e) => set('kdsCriticalMinutes', Number(e.target.value))} />
            </Field>
          </div>
        </Card>

        <PaymentMethods />
      </div>
    </div>
  );
}

function PaymentMethods() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['payment-methods', 'all'], queryFn: () => api.get<PaymentMethod[]>('/payment-methods?all=1') });
  const [editing, setEditing] = useState<PaymentMethod | 'new' | null>(null);
  const [f, setF] = useState({ code: '', name: '', kind: 'OTHER' as PaymentMethod['kind'], active: true, sortOrder: 0 });
  const open = (pm: PaymentMethod | 'new') => {
    setEditing(pm);
    setF(pm === 'new' ? { code: '', name: '', kind: 'OTHER', active: true, sortOrder: (q.data?.length ?? 0) + 1 } : { code: pm.code, name: pm.name, kind: pm.kind, active: pm.active, sortOrder: pm.sortOrder });
  };
  const save = useMutation({
    mutationFn: () => (editing === 'new' ? api.post('/payment-methods', f) : api.put(`/payment-methods/${(editing as PaymentMethod).id}`, { name: f.name, kind: f.kind, active: f.active, sortOrder: f.sortOrder })),
    onSuccess: () => {
      toast.success('Método de pago guardado');
      qc.invalidateQueries({ queryKey: ['payment-methods'] });
      setEditing(null);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card>
      <CardHeader icon={<CreditCard className="h-5 w-5" />} title="Métodos de pago" actions={<Button size="sm" variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => open('new')}>Agregar</Button>} />
      <ul className="divide-y divide-ink-100">
        {q.data?.map((pm) => (
          <li key={pm.id} className="flex items-center gap-3 px-5 py-3">
            <div className="flex-1">
              <div className="font-semibold">{pm.name}</div>
              <div className="font-mono text-[11px] text-ink-500">{pm.code}</div>
            </div>
            <Badge>{PM_KIND[pm.kind]}</Badge>
            {pm.active ? <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-200">Activo</Badge> : <Badge>Inactivo</Badge>}
            <IconButton onClick={() => open(pm)}>
              <Pencil className="h-4 w-4" />
            </IconButton>
          </li>
        ))}
      </ul>
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Nuevo método de pago' : 'Editar método de pago'}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancelar
            </Button>
            <Button disabled={f.name.trim().length < 2 || (editing === 'new' && !/^[A-Z0-9_]{2,}$/.test(f.code))} loading={save.isPending} onClick={() => save.mutate()}>
              Guardar
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Código" hint="Mayúsculas, números y _ (no editable después)">
            <Input value={f.code} disabled={editing !== 'new'} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} maxLength={30} />
          </Field>
          <Field label="Nombre">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={60} />
          </Field>
          <Field label="Tipo (para el arqueo de caja)">
            <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as PaymentMethod['kind'] })}>
              {Object.entries(PM_KIND).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Orden">
            <Input type="number" value={f.sortOrder} onChange={(e) => setF({ ...f, sortOrder: Number(e.target.value) })} />
          </Field>
          <Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Activo" />
        </div>
      </Modal>
    </Card>
  );
}
