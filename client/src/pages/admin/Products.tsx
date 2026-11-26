import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { toast } from 'sonner';
import { ChefHat, ImagePlus, Pencil, Plus, Search, Trash2, UtensilsCrossed, Wine } from 'lucide-react';
import { api, errorMessage, qs } from '../../lib/api';
import { Area, Category, Product } from '../../lib/types';
import { money } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import { useDebounced } from '../../lib/hooks';
import { Badge, Button, Card, EmptyState, Field, IconButton, Input, Loading, Modal, PageHeader, Select, Textarea, Toggle, useConfirm } from '../../components/ui';

export default function Products() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const confirm = useConfirm();
  const manage = can('menu.manage');
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState<number | ''>('');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const s = useDebounced(search);

  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api.get<Category[]>('/categories') });
  const q = useQuery({
    queryKey: ['products', s, categoryId, showInactive],
    queryFn: () => api.get<Product[]>(`/products${qs({ search: s, categoryId, includeInactive: showInactive ? '1' : '' })}`),
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['products'] });
    qc.invalidateQueries({ queryKey: ['menu'] });
  };
  const availability = useMutation({
    mutationFn: ({ id, available }: { id: number; available: boolean }) => api.patch(`/products/${id}/availability`, { available }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const del = useMutation({
    mutationFn: (id: number) => api.del<{ result: string }>(`/products/${id}`),
    onSuccess: (r) => (toast.success(r.result === 'deleted' ? 'Producto eliminado' : 'Producto desactivado (tiene ventas históricas)'), refresh()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const reactivate = useMutation({ mutationFn: (id: number) => api.put(`/products/${id}`, { active: true }), onSuccess: refresh, onError: (e) => toast.error(errorMessage(e)) });

  return (
    <div>
      <PageHeader
        eyebrow="Administración"
        title="Productos y menú"
        subtitle="Cada producto se envía automáticamente al área configurada (Cocina o Bar)."
        actions={manage && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>Nuevo producto</Button>}
      />
      <Card className="mb-4 flex flex-wrap items-center gap-3 p-4">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <Input className="pl-10" placeholder="Buscar producto..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select className="w-auto min-w-[200px]" value={categoryId} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : '')}>
          <option value="">Todas las categorías</option>
          {cats.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        {manage && <Toggle checked={showInactive} onChange={setShowInactive} label="Mostrar desactivados" />}
      </Card>
      <Card>
        {q.isLoading ? (
          <Loading />
        ) : !q.data?.length ? (
          <EmptyState icon={<UtensilsCrossed className="h-7 w-7" />} title="No hay productos" />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Categoría</th>
                  <th>Destino</th>
                  <th className="text-right">Precio</th>
                  <th>Disponibilidad</th>
                  {manage && <th />}
                </tr>
              </thead>
              <tbody>
                {q.data.map((p) => (
                  <tr key={p.id} className={clsx(!p.active && 'opacity-50')}>
                    <td>
                      <div className="flex items-center gap-3">
                        {p.imageUrl ? (
                          <img src={p.imageUrl} alt="" className="h-10 w-10 rounded-lg object-cover" />
                        ) : (
                          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-ink-100 text-ink-400">{p.area.code === 'BAR' ? <Wine className="h-4 w-4" /> : <ChefHat className="h-4 w-4" />}</div>
                        )}
                        <div className="min-w-0">
                          <div className="font-semibold">
                            {p.name} {!p.active && <Badge className="ml-1 bg-ink-100 text-ink-600 ring-ink-200">Desactivado</Badge>}
                          </div>
                          {p.description && <div className="max-w-xs truncate text-xs text-ink-500">{p.description}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="text-ink-600">{p.category?.name}</td>
                    <td>
                      <Badge className={p.area.code === 'BAR' ? 'bg-sky-50 text-sky-700 ring-sky-200' : 'bg-amber-50 text-amber-800 ring-amber-200'}>{p.area.name}</Badge>
                    </td>
                    <td className="text-right font-bold tabular-nums">{money(p.price)}</td>
                    <td>
                      <Toggle checked={p.available} disabled={!p.active} onChange={(v) => availability.mutate({ id: p.id, available: v })} label={p.available ? 'Disponible' : 'Agotado'} />
                    </td>
                    {manage && (
                      <td className="text-right">
                        <div className="flex justify-end gap-1">
                          {p.active ? (
                            <>
                              <IconButton title="Editar" onClick={() => setEditing(p)}>
                                <Pencil className="h-4 w-4" />
                              </IconButton>
                              <IconButton
                                title="Eliminar / desactivar"
                                className="hover:text-rose-600"
                                onClick={async () => {
                                  if (await confirm({ title: `Eliminar ${p.name}`, message: 'Si el producto tiene ventas registradas solo se desactivará para conservar el historial financiero.', danger: true, confirmText: 'Eliminar' })) del.mutate(p.id);
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </IconButton>
                            </>
                          ) : (
                            <Button size="sm" variant="secondary" onClick={() => reactivate.mutate(p.id)}>
                              Reactivar
                            </Button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <ProductForm product={editing === 'new' ? null : editing} categories={cats.data ?? []} onClose={() => setEditing(null)} onSaved={() => (refresh(), setEditing(null))} />}
    </div>
  );
}

function ProductForm({ product, categories, onClose, onSaved }: { product: Product | null; categories: Category[]; onClose: () => void; onSaved: () => void }) {
  const areas = useQuery({ queryKey: ['areas'], queryFn: () => api.get<Area[]>('/areas') });
  const [f, setF] = useState({
    name: product?.name ?? '',
    description: product?.description ?? '',
    price: product ? String(Number(product.price)) : '',
    categoryId: product?.categoryId ?? categories[0]?.id ?? 0,
    areaId: product?.areaId ?? categories[0]?.defaultAreaId ?? 0,
    imageUrl: product?.imageUrl ?? '',
    available: product?.available ?? true,
    sortOrder: product?.sortOrder ?? 0,
  });
  const [uploading, setUploading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, price: Number(f.price), description: f.description || null, imageUrl: f.imageUrl || null };
      return product ? api.put(`/products/${product.id}`, body) : api.post('/products', body);
    },
    onSuccess: () => (toast.success(product ? 'Producto actualizado' : 'Producto creado'), onSaved()),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const er: Record<string, string> = {};
    if (f.name.trim().length < 2) er.name = 'Ingrese un nombre válido';
    if (f.price === '' || Number(f.price) < 0 || Number.isNaN(Number(f.price))) er.price = 'Precio inválido';
    if (!f.categoryId) er.categoryId = 'Seleccione una categoría';
    if (!f.areaId) er.areaId = 'Seleccione el área de preparación';
    setErrors(er);
    if (!Object.keys(er).length) save.mutate();
  };

  const onFile = async (file?: File) => {
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) return toast.error('La imagen no debe superar 3 MB');
    setUploading(true);
    try {
      const r = await api.upload(file);
      set('imageUrl', r.url);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={product ? 'Editar producto' : 'Nuevo producto'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={save.isPending} onClick={submit}>
            Guardar
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Nombre" error={errors.name} className="sm:col-span-2">
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={120} autoFocus />
        </Field>
        <Field label="Descripción" className="sm:col-span-2">
          <Textarea value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={500} />
        </Field>
        <Field label="Precio (₡)" error={errors.price} hint="Precio de venta antes de servicio e IVA">
          <Input type="number" min={0} step="any" value={f.price} onChange={(e) => set('price', e.target.value)} />
        </Field>
        <Field label="Orden en el menú">
          <Input type="number" min={0} value={f.sortOrder} onChange={(e) => set('sortOrder', Number(e.target.value))} />
        </Field>
        <Field label="Categoría" error={errors.categoryId}>
          <Select
            value={f.categoryId}
            onChange={(e) => {
              const c = categories.find((x) => x.id === Number(e.target.value));
              setF((x) => ({ ...x, categoryId: Number(e.target.value), areaId: !product && c?.defaultAreaId ? c.defaultAreaId : x.areaId }));
            }}
          >
            <option value={0}>Seleccione...</option>
            {categories.filter((c) => c.active).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Área de preparación (destino)" error={errors.areaId}>
          <div className="grid grid-cols-2 gap-2">
            {areas.data?.map((a) => (
              <button
                type="button"
                key={a.id}
                onClick={() => set('areaId', a.id)}
                className={clsx('flex items-center justify-center gap-2 rounded-xl border-2 py-2.5 text-sm font-bold', f.areaId === a.id ? (a.code === 'BAR' ? 'border-sky-500 bg-sky-50 text-sky-800' : 'border-amber-500 bg-amber-50 text-amber-900') : 'border-ink-200 text-ink-600')}
              >
                {a.code === 'BAR' ? <Wine className="h-4 w-4" /> : <ChefHat className="h-4 w-4" />}
                {a.name.toUpperCase()}
              </button>
            ))}
          </div>
        </Field>
        <div className="sm:col-span-2">
          <span className="label">Imagen (opcional)</span>
          <div className="flex items-center gap-4">
            {f.imageUrl ? <img src={f.imageUrl} alt="" className="h-20 w-20 rounded-xl object-cover" /> : <div className="flex h-20 w-20 items-center justify-center rounded-xl bg-ink-100 text-ink-400"><ImagePlus className="h-6 w-6" /></div>}
            <div className="flex flex-col gap-2">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-ink-200 px-4 py-2 text-sm font-semibold hover:bg-ink-50">
                <ImagePlus className="h-4 w-4" /> {uploading ? 'Subiendo...' : 'Subir imagen'}
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
              </label>
              {f.imageUrl && (
                <button type="button" className="text-left text-xs font-semibold text-rose-600" onClick={() => set('imageUrl', '')}>
                  Quitar imagen
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="sm:col-span-2">
          <Toggle checked={f.available} onChange={(v) => set('available', v)} label={f.available ? 'Disponible para la venta' : 'Agotado'} />
        </div>
      </form>
    </Modal>
  );
}
