import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Armchair, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { TableInfo } from '../../lib/types';
import { TABLE_STATUS } from '../../lib/labels';
import { Badge, Button, Card, EmptyState, Field, IconButton, Input, Loading, Modal, PageHeader, Toggle, useConfirm } from '../../components/ui';

export default function TablesAdmin() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['tables', 'all'], queryFn: () => api.get<TableInfo[]>('/tables?all=1') });
  const [editing, setEditing] = useState<TableInfo | 'new' | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['tables'] });
  const del = useMutation({
    mutationFn: (id: number) => api.del<{ result: string }>(`/tables/${id}`),
    onSuccess: (r) => (toast.success(r.result === 'deleted' ? 'Mesa eliminada' : 'Mesa desactivada (tiene historial)'), refresh()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div>
      <PageHeader eyebrow="Administración" title="Mesas" subtitle="Configure la numeración, nombre, zona y capacidad." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>Nueva mesa</Button>} />
      <Card>
        {q.isLoading ? (
          <Loading />
        ) : !q.data?.length ? (
          <EmptyState icon={<Armchair className="h-7 w-7" />} title="Sin mesas" />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Número</th>
                <th>Nombre</th>
                <th>Zona</th>
                <th className="text-right">Capacidad</th>
                <th>Estado actual</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.map((t) => (
                <tr key={t.id} className={t.active ? '' : 'opacity-50'}>
                  <td className="font-bold tabular-nums">{t.number}</td>
                  <td className="font-semibold">{t.name}</td>
                  <td>{t.zone ?? '—'}</td>
                  <td className="text-right tabular-nums">{t.capacity}</td>
                  <td>{t.active ? <Badge className={TABLE_STATUS[t.status].chip} dot={TABLE_STATUS[t.status].dot}>{TABLE_STATUS[t.status].label}</Badge> : <Badge>Inactiva</Badge>}</td>
                  <td className="text-right">
                    <IconButton onClick={() => setEditing(t)}>
                      <Pencil className="h-4 w-4" />
                    </IconButton>
                    <IconButton
                      className="hover:text-rose-600"
                      onClick={async () => {
                        if (await confirm({ title: `Eliminar ${t.name}`, message: 'Si la mesa tiene órdenes históricas solo se desactivará.', danger: true, confirmText: 'Eliminar' })) del.mutate(t.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {editing && <TableForm table={editing === 'new' ? null : editing} nextNumber={Math.max(0, ...(q.data ?? []).map((t) => t.number)) + 1} onClose={() => setEditing(null)} onSaved={() => (refresh(), setEditing(null))} />}
    </div>
  );
}

function TableForm({ table, nextNumber, onClose, onSaved }: { table: TableInfo | null; nextNumber: number; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ number: table?.number ?? nextNumber, name: table?.name ?? `Mesa ${nextNumber}`, zone: table?.zone ?? '', capacity: table?.capacity ?? 4, active: table?.active ?? true });
  const save = useMutation({
    mutationFn: () => (table ? api.put(`/tables/${table.id}`, f) : api.post('/tables', f)),
    onSuccess: () => (toast.success('Mesa guardada'), onSaved()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={table ? 'Editar mesa' : 'Nueva mesa'}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!f.name.trim() || f.number < 1 || f.capacity < 1} loading={save.isPending} onClick={() => save.mutate()}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="Número">
          <Input type="number" min={1} value={f.number} onChange={(e) => setF({ ...f, number: Number(e.target.value) })} />
        </Field>
        <Field label="Capacidad">
          <Input type="number" min={1} value={f.capacity} onChange={(e) => setF({ ...f, capacity: Number(e.target.value) })} />
        </Field>
        <Field label="Nombre" className="col-span-2">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={60} />
        </Field>
        <Field label="Zona" className="col-span-2">
          <Input value={f.zone} onChange={(e) => setF({ ...f, zone: e.target.value })} placeholder="Salón, Terraza, Barra..." maxLength={60} />
        </Field>
        <div className="col-span-2">
          <Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Activa" />
        </div>
      </div>
    </Modal>
  );
}
