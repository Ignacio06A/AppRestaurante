import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil, Plus, Tags, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { Area, Category } from '../../lib/types';
import { Badge, Button, Card, EmptyState, Field, IconButton, Input, Loading, Modal, PageHeader, Select, Toggle, useConfirm } from '../../components/ui';

export default function Categories() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['categories'], queryFn: () => api.get<Category[]>('/categories') });
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  const refresh = () => ['categories', 'menu', 'products'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const del = useMutation({
    mutationFn: (id: number) => api.del<{ result: string }>(`/categories/${id}`),
    onSuccess: (r) => (toast.success(r.result === 'deleted' ? 'Categoría eliminada' : 'Categoría desactivada (tiene productos)'), refresh()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div>
      <PageHeader eyebrow="Administración" title="Categorías del menú" actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>Nueva categoría</Button>} />
      <Card>
        {q.isLoading ? (
          <Loading />
        ) : !q.data?.length ? (
          <EmptyState icon={<Tags className="h-7 w-7" />} title="Sin categorías" />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Orden</th>
                <th>Categoría</th>
                <th>Área por defecto</th>
                <th className="text-right">Productos</th>
                <th>Estado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.map((c) => (
                <tr key={c.id}>
                  <td className="w-16 tabular-nums text-ink-500">{c.sortOrder}</td>
                  <td>
                    <div className="font-semibold">{c.name}</div>
                    {c.description && <div className="text-xs text-ink-500">{c.description}</div>}
                  </td>
                  <td>{c.defaultArea?.name ?? '—'}</td>
                  <td className="text-right tabular-nums">{c._count?.products ?? 0}</td>
                  <td>{c.active ? <Badge className="bg-emerald-50 text-emerald-700 ring-emerald-200">Activa</Badge> : <Badge>Inactiva</Badge>}</td>
                  <td className="text-right">
                    <IconButton onClick={() => setEditing(c)}>
                      <Pencil className="h-4 w-4" />
                    </IconButton>
                    <IconButton
                      className="hover:text-rose-600"
                      onClick={async () => {
                        if (await confirm({ title: `Eliminar ${c.name}`, message: 'Si tiene productos asociados, la categoría solo se desactivará.', danger: true, confirmText: 'Eliminar' })) del.mutate(c.id);
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
      {editing && <CategoryForm category={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => (refresh(), setEditing(null))} />}
    </div>
  );
}

function CategoryForm({ category, onClose, onSaved }: { category: Category | null; onClose: () => void; onSaved: () => void }) {
  const areas = useQuery({ queryKey: ['areas'], queryFn: () => api.get<Area[]>('/areas') });
  const [f, setF] = useState({ name: category?.name ?? '', description: category?.description ?? '', sortOrder: category?.sortOrder ?? 0, active: category?.active ?? true, defaultAreaId: category?.defaultAreaId ?? null as number | null });
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, description: f.description || null };
      return category ? api.put(`/categories/${category.id}`, body) : api.post('/categories', body);
    },
    onSuccess: () => (toast.success('Categoría guardada'), onSaved()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={category ? 'Editar categoría' : 'Nueva categoría'}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={f.name.trim().length < 2} loading={save.isPending} onClick={() => save.mutate()}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Nombre">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} autoFocus />
        </Field>
        <Field label="Descripción">
          <Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={255} />
        </Field>
        <Field label="Área sugerida para nuevos productos">
          <Select value={f.defaultAreaId ?? ''} onChange={(e) => setF({ ...f, defaultAreaId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Ninguna</option>
            {areas.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Orden">
          <Input type="number" min={0} value={f.sortOrder} onChange={(e) => setF({ ...f, sortOrder: Number(e.target.value) })} />
        </Field>
        <Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Activa" />
      </div>
    </Modal>
  );
}
