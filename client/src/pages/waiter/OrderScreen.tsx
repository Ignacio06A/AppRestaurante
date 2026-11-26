import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { toast } from 'sonner';
import {
  ArrowLeft, ArrowRightLeft, BellRing, ChefHat, ClipboardList, HandPlatter, History, MessageSquarePlus, Pencil, Plus, Receipt, Search, Send,
  ShoppingBag, Trash2, Users, Wine, X,
} from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { Category, ItemStatus, Order, OrderItem, Product, TableInfo } from '../../lib/types';
import { ITEM_STATUS, ORDER_STATUS, TABLE_STATUS } from '../../lib/labels';
import { dateTime, elapsed, money, time } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import { useNow } from '../../lib/hooks';
import { Badge, Button, ErrorState, Field, IconButton, Input, Loading, Modal, Select, Stepper, Textarea, useConfirm } from '../../components/ui';

interface CartLine {
  key: string;
  product: Product;
  quantity: number;
  notes: string;
}

const QUICK_NOTES = ['Sin cebolla', 'Sin hielo', 'Término medio', 'Bien cocido', 'Sin picante', 'Aparte', 'Para llevar', 'Alergia: maní'];

export default function OrderScreen() {
  const { orderId } = useParams();
  const id = Number(orderId);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user, can } = useAuth();
  const confirm = useConfirm();
  const now = useNow(1000);

  const orderQ = useQuery({ queryKey: ['order', id], queryFn: () => api.get<Order>(`/orders/${id}`), enabled: !!id });
  const menuQ = useQuery({ queryKey: ['menu'], queryFn: () => api.get<Category[]>('/menu'), staleTime: 60_000 });

  const [cart, setCart] = useState<CartLine[]>([]);
  const [cat, setCat] = useState<number | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [noteFor, setNoteFor] = useState<CartLine | null>(null);
  const [editItem, setEditItem] = useState<OrderItem | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);

  const order = orderQ.data;
  const isOpen = order && (order.status === 'OPEN' || order.status === 'BILL_REQUESTED');
  const canEdit = !!order && isOpen && can('orders.edit') && (order.waiter.id === user?.id || can('orders.edit_any'));

  const setOrder = (o: Order) => {
    qc.setQueryData(['order', id], o);
    qc.invalidateQueries({ queryKey: ['tables'] });
    qc.invalidateQueries({ queryKey: ['history', id] });
  };
  const onErr = (e: unknown) => toast.error(errorMessage(e));

  const send = useMutation({
    mutationFn: () => api.post<Order>(`/orders/${id}/items`, { items: cart.map((c) => ({ productId: c.product.id, quantity: c.quantity, notes: c.notes || null })) }),
    onSuccess: (o) => {
      const k = cart.filter((c) => c.product.area.code === 'KITCHEN').reduce((a, c) => a + c.quantity, 0);
      const b = cart.filter((c) => c.product.area.code === 'BAR').reduce((a, c) => a + c.quantity, 0);
      toast.success('Pedido enviado', { description: [k && `${k} a cocina`, b && `${b} a bar`].filter(Boolean).join(' · ') });
      setCart([]);
      setOrder(o);
    },
    onError: onErr,
  });
  const deliver = useMutation({ mutationFn: (itemIds?: number[]) => api.post<Order>(`/orders/${id}/deliver`, { itemIds }), onSuccess: (o) => (setOrder(o), toast.success('Marcado como entregado')), onError: onErr });
  const cancelItem = useMutation({
    mutationFn: ({ itemId, reason }: { itemId: number; reason: string }) => api.del<Order>(`/orders/${id}/items/${itemId}`, { reason }),
    onSuccess: (o) => (setOrder(o), toast.success('Producto cancelado')),
    onError: onErr,
  });
  const requestBill = useMutation({ mutationFn: () => api.post<Order>(`/orders/${id}/request-bill`), onSuccess: (o) => (setOrder(o), toast.success('Cuenta solicitada a caja')), onError: onErr });
  const reopen = useMutation({ mutationFn: () => api.post<Order>(`/orders/${id}/reopen`), onSuccess: setOrder, onError: onErr });
  const updateGuests = useMutation({ mutationFn: (guests: number) => api.patch<Order>(`/orders/${id}`, { guests }), onSuccess: setOrder, onError: onErr });

  const categories = menuQ.data ?? [];
  const products = useMemo(() => {
    const all = categories.flatMap((c) => c.products ?? []);
    const s = search.trim().toLowerCase();
    return all.filter((p) => (cat === 'ALL' || p.categoryId === cat) && (!s || p.name.toLowerCase().includes(s) || p.description?.toLowerCase().includes(s)));
  }, [categories, cat, search]);

  const addToCart = (p: Product) => {
    if (!p.available) return toast.error(`${p.name} está agotado`);
    setCart((c) => {
      const ex = c.find((l) => l.product.id === p.id && !l.notes);
      if (ex) return c.map((l) => (l === ex ? { ...l, quantity: Math.min(99, l.quantity + 1) } : l));
      return [...c, { key: `${p.id}-${Date.now()}`, product: p, quantity: 1, notes: '' }];
    });
  };
  const cartCount = cart.reduce((a, c) => a + c.quantity, 0);
  const cartTotal = cart.reduce((a, c) => a + Number(c.product.price) * c.quantity, 0);

  if (orderQ.isLoading) return <Loading />;
  if (orderQ.error || !order) return <ErrorState error={orderQ.error} onRetry={() => orderQ.refetch()} />;

  const liveItems = order.items.filter((i) => i.status !== 'CANCELLED');
  const readyItems = order.items.filter((i) => i.status === 'READY');
  const cancelled = order.items.filter((i) => i.status === 'CANCELLED');
  const tableStatus = order.tableStatus ? TABLE_STATUS[order.tableStatus] : null;

  const panel = (
    <div className="flex h-full flex-col">
      {/* Nuevos productos (aún no enviados) */}
      {canEdit && (
        <div className="border-b border-ink-100">
          <div className="flex items-center justify-between px-5 pb-2 pt-4">
            <h3 className="flex items-center gap-2 text-sm font-bold">
              <ShoppingBag className="h-4 w-4 text-brand-500" /> Por enviar
              {cartCount > 0 && <span className="rounded-full bg-brand-500 px-2 py-0.5 text-[11px] font-extrabold text-white">{cartCount}</span>}
            </h3>
            {cart.length > 0 && (
              <button className="text-xs font-semibold text-ink-500 hover:text-rose-600" onClick={() => setCart([])}>
                Vaciar
              </button>
            )}
          </div>
          {cart.length === 0 ? (
            <p className="px-5 pb-4 text-sm text-ink-400">Toque productos del menú para agregarlos.</p>
          ) : (
            <div className="max-h-[38vh] space-y-2 overflow-y-auto px-5 pb-4">
              {cart.map((l) => (
                <div key={l.key} className="rounded-xl border border-brand-200 bg-brand-50/50 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-bold">{l.product.name}</div>
                      <div className="flex items-center gap-1.5 text-xs text-ink-500">
                        {l.product.area.code === 'BAR' ? <Wine className="h-3 w-3" /> : <ChefHat className="h-3 w-3" />}
                        {l.product.area.name} · {money(Number(l.product.price) * l.quantity)}
                      </div>
                    </div>
                    <IconButton className="h-7 w-7" onClick={() => setCart((c) => c.filter((x) => x !== l))}>
                      <X className="h-4 w-4" />
                    </IconButton>
                  </div>
                  {l.notes && <div className="mt-1.5 rounded-lg bg-white px-2 py-1 text-xs font-medium text-brand-800">📝 {l.notes}</div>}
                  <div className="mt-2 flex items-center justify-between">
                    <button className="flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline" onClick={() => setNoteFor(l)}>
                      <MessageSquarePlus className="h-3.5 w-3.5" /> {l.notes ? 'Editar nota' : 'Observación'}
                    </button>
                    <Stepper size="sm" value={l.quantity} onChange={(v) => setCart((c) => c.map((x) => (x === l ? { ...x, quantity: v } : x)))} />
                  </div>
                </div>
              ))}
            </div>
          )}
          {cart.length > 0 && (
            <div className="px-5 pb-4">
              <Button size="lg" className="w-full" icon={<Send className="h-4 w-4" />} loading={send.isPending} onClick={() => send.mutate()}>
                Enviar pedido · {money(cartTotal)}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Productos enviados */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-bold">
            <ClipboardList className="h-4 w-4 text-ink-500" /> En la orden
          </h3>
          {readyItems.length > 0 && canEdit && (
            <Button size="sm" variant="success" icon={<HandPlatter className="h-3.5 w-3.5" />} loading={deliver.isPending} onClick={() => deliver.mutate(undefined)}>
              Entregar {readyItems.length} listo(s)
            </Button>
          )}
        </div>
        {liveItems.length === 0 && <p className="text-sm text-ink-400">Aún no se ha enviado ningún producto.</p>}
        <div className="space-y-4">
          {order.batches.map((b) => {
            const items = order.items.filter((i) => i.batchId === b.id && !(i.status === 'CANCELLED' && i.parentItemId));
            if (!items.length) return null;
            return (
              <div key={b.id}>
                <div className="mb-1.5 flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-ink-400">
                  <span>Comanda {b.sequence}</span>
                  <span>
                    {time(b.createdAt)} · {b.createdBy.name.split(' ')[0]}
                  </span>
                </div>
                <div className="divide-y divide-ink-100 rounded-xl border border-ink-200 bg-white">
                  {items.map((i) => (
                    <SentItemRow
                      key={i.id}
                      item={i}
                      canEdit={!!canEdit}
                      onEdit={() => setEditItem(i)}
                      onDeliver={() => deliver.mutate([i.id])}
                      onCancel={async () => {
                        const reason = await confirm({
                          title: `Eliminar ${i.quantity}x ${i.productName}`,
                          message: i.status === 'PENDING' ? 'El producto aún no se ha empezado a preparar.' : `Atención: el producto está ${ITEM_STATUS[i.status].label.toLowerCase()}. ${i.area.name} será notificado de la cancelación.`,
                          danger: true,
                          confirmText: 'Eliminar producto',
                          prompt: { label: 'Motivo de la cancelación', placeholder: 'Ej. el cliente cambió de opinión' },
                        });
                        if (typeof reason === 'string') cancelItem.mutate({ itemId: i.id, reason });
                      }}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        {cancelled.length > 0 && (
          <details className="mt-4 rounded-xl border border-dashed border-ink-200 p-3 text-sm">
            <summary className="cursor-pointer text-xs font-bold uppercase tracking-wider text-ink-500">Cancelados ({cancelled.length})</summary>
            <ul className="mt-2 space-y-1.5">
              {cancelled.map((c) => (
                <li key={c.id} className="flex justify-between gap-2 text-xs text-ink-500">
                  <span className="line-through">
                    {c.quantity}x {c.productName}
                  </span>
                  <span className="truncate text-right italic">{c.cancelReason}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {/* Totales y acciones */}
      <div className="border-t border-ink-200 bg-ink-50/70 px-5 py-4">
        <div className="space-y-1 text-sm">
          <Row label="Subtotal" value={money(order.totals.subtotal)} />
          {order.totals.discount > 0 && <Row label="Descuento" value={`-${money(order.totals.discount)}`} />}
          {order.totals.service > 0 && <Row label={`Servicio ${order.totals.serviceRate}%`} value={money(order.totals.service)} />}
          {order.totals.tax > 0 && <Row label={`IVA ${order.totals.taxRate}%${order.totals.pricesIncludeTax ? ' (incluido)' : ''}`} value={money(order.totals.tax)} />}
          <div className="flex items-baseline justify-between pt-1">
            <span className="font-bold">Total</span>
            <span className="text-2xl font-extrabold tracking-tight">{money(order.totals.total)}</span>
          </div>
          {order.totals.paid > 0 && <Row label="Pagado" value={money(order.totals.paid)} />}
        </div>
        {isOpen && (
          <div className="mt-3 grid grid-cols-2 gap-2">
            {order.status === 'OPEN' ? (
              <Button
                variant="dark"
                icon={<Receipt className="h-4 w-4" />}
                className="col-span-2"
                disabled={liveItems.length === 0 || cart.length > 0}
                loading={requestBill.isPending}
                onClick={async () => {
                  const pending = order.items.filter((i) => i.status === 'PENDING' || i.status === 'IN_PREPARATION').length;
                  const ok = await confirm({
                    title: 'Solicitar la cuenta',
                    message: pending ? `Aún hay ${pending} producto(s) en preparación. ¿Desea enviar la cuenta a caja de todas formas?` : 'La mesa pasará a "Pendiente de pago" y aparecerá en caja.',
                    confirmText: 'Solicitar cuenta',
                  });
                  if (ok) requestBill.mutate();
                }}
              >
                Pedir la cuenta
              </Button>
            ) : (
              canEdit && (
                <Button variant="secondary" className="col-span-2" icon={<Plus className="h-4 w-4" />} loading={reopen.isPending} onClick={() => reopen.mutate()}>
                  Reabrir para agregar productos
                </Button>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="-mx-4 -my-6 sm:-mx-6 lg:-mx-8">
      {/* Cabecera de la orden */}
      <div className="border-b border-ink-200 bg-white px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center gap-3">
          <IconButton onClick={() => navigate('/mesas')} aria-label="Volver">
            <ArrowLeft className="h-5 w-5" />
          </IconButton>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-extrabold tracking-tight">{order.table.name}</h1>
              <span className="text-sm font-semibold text-ink-400">Orden #{order.number}</span>
              {tableStatus && <Badge className={tableStatus.chip} dot={tableStatus.dot}>{tableStatus.label}</Badge>}
              {!isOpen && <Badge className={ORDER_STATUS[order.status].chip}>{ORDER_STATUS[order.status].label}</Badge>}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-500">
              <span>Mesero: {order.waiter.name}</span>
              <span>Abierta {time(order.openedAt)} · {elapsed(order.openedAt, now)}</span>
              <span className="flex items-center gap-1">
                <Users className="h-3.5 w-3.5" />
                {canEdit ? (
                  <select value={order.guests} onChange={(e) => updateGuests.mutate(Number(e.target.value))} className="rounded bg-transparent font-semibold text-ink-700 outline-none">
                    {Array.from({ length: 30 }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        {n} persona{n > 1 ? 's' : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  `${order.guests} personas`
                )}
              </span>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" icon={<History className="h-4 w-4" />} onClick={() => setHistoryOpen(true)}>
              <span className="hidden sm:inline">Historial</span>
            </Button>
            {canEdit && (
              <Button variant="secondary" size="sm" icon={<ArrowRightLeft className="h-4 w-4" />} onClick={() => setTransferOpen(true)}>
                <span className="hidden sm:inline">Cambiar mesa</span>
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-[1fr_400px] xl:grid-cols-[1fr_440px]">
        {/* Menú */}
        <div className="min-w-0 px-4 py-5 sm:px-6 lg:px-8">
          {canEdit ? (
            <>
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                  <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
                  <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar producto..." className="pl-10" />
                </div>
              </div>
              <div className="scrollbar-thin -mx-1 mb-5 flex gap-2 overflow-x-auto px-1 pb-1">
                <CatChip active={cat === 'ALL'} onClick={() => setCat('ALL')}>
                  Todo
                </CatChip>
                {categories.map((c) => (
                  <CatChip key={c.id} active={cat === c.id} onClick={() => setCat(c.id)}>
                    {c.name}
                  </CatChip>
                ))}
              </div>
              {menuQ.isLoading ? (
                <Loading />
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                  {products.map((p) => {
                    const inCart = cart.filter((c) => c.product.id === p.id).reduce((a, c) => a + c.quantity, 0);
                    return (
                      <button
                        key={p.id}
                        onClick={() => addToCart(p)}
                        disabled={!p.available}
                        className={clsx(
                          'group relative flex flex-col overflow-hidden rounded-2xl border bg-white text-left shadow-card transition active:scale-[0.98]',
                          p.available ? 'border-ink-200 hover:border-brand-300 hover:shadow-lift' : 'cursor-not-allowed border-ink-200 opacity-50 grayscale',
                          inCart > 0 && 'border-brand-400 ring-2 ring-brand-200',
                        )}
                      >
                        {p.imageUrl ? (
                          <img src={p.imageUrl} alt="" className="h-24 w-full object-cover" loading="lazy" />
                        ) : (
                          <div className={clsx('flex h-14 items-center justify-center', p.area.code === 'BAR' ? 'bg-sky-50 text-sky-400' : 'bg-amber-50 text-amber-400')}>
                            {p.area.code === 'BAR' ? <Wine className="h-6 w-6" /> : <ChefHat className="h-6 w-6" />}
                          </div>
                        )}
                        <div className="flex flex-1 flex-col p-3">
                          <div className="text-sm font-bold leading-snug text-ink-900">{p.name}</div>
                          {p.description && <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-ink-500">{p.description}</div>}
                          <div className="flex-1" />
                          <div className="mt-2 flex items-center justify-between">
                            <span className="font-extrabold text-ink-900">{money(p.price)}</span>
                            <span className={clsx('rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase', p.area.code === 'BAR' ? 'bg-sky-100 text-sky-700' : 'bg-amber-100 text-amber-800')}>{p.area.name}</span>
                          </div>
                        </div>
                        {!p.available && <span className="absolute left-2 top-2 rounded-md bg-ink-900 px-2 py-0.5 text-[10px] font-bold uppercase text-white">Agotado</span>}
                        {inCart > 0 && <span className="absolute right-2 top-2 flex h-7 min-w-[28px] items-center justify-center rounded-full bg-brand-500 px-1.5 text-xs font-extrabold text-white shadow-lg">{inCart}</span>}
                      </button>
                    );
                  })}
                  {!products.length && <p className="col-span-full py-10 text-center text-sm text-ink-500">No hay productos que coincidan.</p>}
                </div>
              )}
            </>
          ) : (
            <div className="card p-6 text-sm text-ink-600">
              {isOpen ? 'Solo el mesero asignado puede modificar esta orden.' : `Esta orden está ${ORDER_STATUS[order.status].label.toLowerCase()}${order.closedAt ? ` desde ${dateTime(order.closedAt)}` : ''}.`}{' '}
              <Link to="/mesas" className="font-semibold text-brand-600 hover:underline">
                Volver a mesas
              </Link>
            </div>
          )}
        </div>

        {/* Panel de la orden: lateral en escritorio */}
        <aside className="hidden border-l border-ink-200 bg-white lg:block">
          <div className="sticky top-16 h-[calc(100vh-4rem-89px)]">{panel}</div>
        </aside>
      </div>

      {/* Móvil / tablet: botón flotante */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-200 bg-white/95 p-3 backdrop-blur lg:hidden">
        <Button size="lg" variant={cartCount ? 'primary' : 'dark'} className="w-full" onClick={() => setPanelOpen(true)} icon={<ClipboardList className="h-5 w-5" />}>
          {cartCount ? `Ver pedido · ${cartCount} por enviar` : `Ver orden · ${money(order.totals.total)}`}
          {readyItems.length > 0 && <span className="ml-1 rounded-full bg-lime-400 px-2 py-0.5 text-xs text-lime-950">{readyItems.length} listos</span>}
        </Button>
      </div>
      <div className="h-20 lg:hidden" />
      {panelOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink-950/50" onClick={() => setPanelOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 flex h-[88vh] animate-slide-in flex-col rounded-t-3xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-ink-100 px-5 py-3">
              <span className="font-bold">
                {order.table.name} · Orden #{order.number}
              </span>
              <IconButton onClick={() => setPanelOpen(false)}>
                <X className="h-5 w-5" />
              </IconButton>
            </div>
            <div className="min-h-0 flex-1">{panel}</div>
          </div>
        </div>
      )}

      <NoteModal
        line={noteFor}
        onClose={() => setNoteFor(null)}
        onSave={(notes) => {
          setCart((c) => c.map((x) => (x.key === noteFor?.key ? { ...x, notes } : x)));
          setNoteFor(null);
        }}
      />
      <EditItemModal item={editItem} orderId={id} onClose={() => setEditItem(null)} onSaved={(o) => (setOrder(o), setEditItem(null))} />
      <HistoryModal orderId={id} open={historyOpen} onClose={() => setHistoryOpen(false)} />
      <TransferModal open={transferOpen} order={order} onClose={() => setTransferOpen(false)} onDone={(o) => (setOrder(o), setTransferOpen(false))} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-ink-600">
      <span>{label}</span>
      <span className="font-semibold tabular-nums text-ink-800">{value}</span>
    </div>
  );
}

function CatChip({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className={clsx('shrink-0 rounded-full px-4 py-2 text-sm font-bold transition', active ? 'bg-ink-900 text-white shadow' : 'bg-white text-ink-600 ring-1 ring-ink-200 hover:ring-ink-300')}>
      {children}
    </button>
  );
}

function SentItemRow({ item, canEdit, onEdit, onCancel, onDeliver }: { item: OrderItem; canEdit: boolean; onEdit: () => void; onCancel: () => void; onDeliver: () => void }) {
  const st = ITEM_STATUS[item.status];
  const cancelled = item.status === 'CANCELLED';
  return (
    <div className={clsx('flex items-start gap-3 px-3 py-2.5', item.status === 'READY' && 'bg-lime-50')}>
      <div className={clsx('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-sm font-extrabold', cancelled ? 'bg-ink-100 text-ink-400' : 'bg-ink-900 text-white')}>{item.quantity}</div>
      <div className="min-w-0 flex-1">
        <div className={clsx('text-sm font-semibold', cancelled && 'text-ink-400 line-through')}>{item.productName}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <Badge className={st.chip}>{st.label}</Badge>
          <span className="text-[11px] text-ink-400">{item.area.name}</span>
          {item.modifiedAt && !cancelled && <span className="rounded bg-amber-100 px-1 text-[10px] font-bold uppercase text-amber-800">Modificado</span>}
          {item.paidQuantity > 0 && <span className="rounded bg-emerald-100 px-1 text-[10px] font-bold text-emerald-800">{item.paidQuantity} pagado(s)</span>}
        </div>
        {item.notes && <div className="mt-1 text-xs font-medium text-brand-800">📝 {item.notes}</div>}
        {cancelled && item.cancelReason && <div className="mt-1 text-xs italic text-rose-600">{item.cancelReason}</div>}
      </div>
      <div className="text-right">
        <div className="text-sm font-bold tabular-nums">{money(item.lineTotal)}</div>
        {canEdit && !cancelled && (
          <div className="mt-1 flex justify-end gap-0.5">
            {item.status === 'READY' && (
              <IconButton className="h-7 w-7 text-emerald-600" title="Entregado" onClick={onDeliver}>
                <HandPlatter className="h-3.5 w-3.5" />
              </IconButton>
            )}
            <IconButton className="h-7 w-7" title="Modificar" onClick={onEdit}>
              <Pencil className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton className="h-7 w-7 hover:text-rose-600" title="Eliminar" onClick={onCancel}>
              <Trash2 className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        )}
      </div>
    </div>
  );
}

function NoteModal({ line, onClose, onSave }: { line: CartLine | null; onClose: () => void; onSave: (n: string) => void }) {
  const [text, setText] = useState('');
  const [lastKey, setLastKey] = useState<string | null>(null);
  if (line && line.key !== lastKey) {
    setLastKey(line.key);
    setText(line.notes);
  }
  return (
    <Modal
      open={!!line}
      onClose={onClose}
      title="Observaciones"
      subtitle={line?.product.name}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => onSave(text.trim())}>Guardar</Button>
        </>
      }
    >
      <div className="mb-3 flex flex-wrap gap-2">
        {QUICK_NOTES.map((n) => (
          <button key={n} onClick={() => setText((t) => (t ? `${t}, ${n.toLowerCase()}` : n))} className="rounded-full bg-ink-100 px-3 py-1 text-xs font-semibold text-ink-700 hover:bg-brand-100 hover:text-brand-800">
            + {n}
          </button>
        ))}
      </div>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={300} placeholder="Instrucciones especiales para cocina o bar" autoFocus />
    </Modal>
  );
}

const STATUS_HINT: Record<ItemStatus, string> = {
  PENDING: 'Aún no se empieza a preparar: los cambios se aplican sobre la misma línea y se resaltan como MODIFICADO en el área.',
  IN_PREPARATION: 'Ya se está preparando. Si aumenta la cantidad, solo la diferencia se enviará como una solicitud nueva. Si la reduce, la diferencia queda registrada como cancelada.',
  READY: 'Ya está listo. Si aumenta la cantidad, la diferencia se enviará como solicitud nueva. Las observaciones ya no se pueden cambiar.',
  DELIVERED: 'Ya fue entregado. Si aumenta la cantidad, la diferencia se enviará como solicitud nueva.',
  CANCELLED: '',
};

function EditItemModal({ item, orderId, onClose, onSaved }: { item: OrderItem | null; orderId: number; onClose: () => void; onSaved: (o: Order) => void }) {
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [lastId, setLastId] = useState<number | null>(null);
  if (item && item.id !== lastId) {
    setLastId(item.id);
    setQty(item.quantity);
    setNotes(item.notes ?? '');
    setReason('');
  }
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {};
      if (qty !== item!.quantity) body.quantity = qty;
      if ((notes.trim() || null) !== (item!.notes ?? null)) body.notes = notes.trim() || null;
      if (qty < item!.quantity) body.reason = reason.trim() || 'Reducción de cantidad';
      return api.patch<Order>(`/orders/${orderId}/items/${item!.id}`, body);
    },
    onSuccess: (o) => {
      toast.success('Cambios enviados al área de preparación');
      onSaved(o);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!item) return null;
  const notesEditable = item.status === 'PENDING' || item.status === 'IN_PREPARATION';
  const changed = qty !== item.quantity || (notes.trim() || null) !== (item.notes ?? null);
  return (
    <Modal
      open={!!item}
      onClose={onClose}
      title={`Modificar ${item.productName}`}
      subtitle={`Estado actual: ${ITEM_STATUS[item.status].label} · ${item.area.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!changed} loading={save.isPending} onClick={() => save.mutate()}>
            Guardar cambios
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="rounded-xl bg-sky-50 p-3 text-sm text-sky-900">{STATUS_HINT[item.status]}</div>
        <div className="flex items-center justify-between">
          <div>
            <div className="font-semibold">Cantidad</div>
            <div className="text-xs text-ink-500">{item.paidQuantity > 0 ? `Mínimo ${item.paidQuantity} (ya pagado)` : 'Mínimo 1. Para quitarlo use Eliminar.'}</div>
          </div>
          <Stepper value={qty} onChange={setQty} min={Math.max(1, item.paidQuantity)} />
        </div>
        {qty < item.quantity && (
          <Field label="Motivo de la reducción">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej. cliente pidió menos" maxLength={255} />
          </Field>
        )}
        <Field label="Observaciones" hint={notesEditable ? undefined : 'No editable: el producto ya está listo o entregado'}>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!notesEditable} maxLength={300} />
        </Field>
      </div>
    </Modal>
  );
}

interface HistoryRow {
  id: number;
  action: string;
  description: string;
  createdAt: string;
  user: { name: string; role: { name: string } };
}

const ACTION_ICON: Record<string, string> = {
  ORDER_OPENED: '🟢', ITEMS_SENT: '📤', ITEMS_ADDED: '➕', ITEM_QTY_CHANGED: '🔢', ITEM_NOTES_CHANGED: '📝', ITEM_CANCELLED: '❌', ITEM_STATUS_CHANGED: '🍳',
  ITEMS_DELIVERED: '🍽️', BILL_REQUESTED: '🧾', ORDER_REOPENED: '↩️', DISCOUNT_APPLIED: '🏷️', PAYMENT_REGISTERED: '💳', ORDER_CLOSED: '✅', ORDER_CANCELLED: '⛔', TABLE_TRANSFERRED: '🔀', ORDER_UPDATED: '✏️',
};

export function HistoryModal({ orderId, open, onClose }: { orderId: number; open: boolean; onClose: () => void }) {
  const q = useQuery({ queryKey: ['history', orderId], queryFn: () => api.get<HistoryRow[]>(`/orders/${orderId}/history`), enabled: open });
  return (
    <Modal open={open} onClose={onClose} title="Historial de la orden" subtitle="Todas las acciones con usuario, fecha y hora" size="lg">
      {q.isLoading ? (
        <Loading />
      ) : (
        <ol className="relative space-y-4 border-l-2 border-ink-100 pl-6">
          {q.data?.map((h) => (
            <li key={h.id} className="relative">
              <span className="absolute -left-[35px] flex h-7 w-7 items-center justify-center rounded-full bg-white text-sm ring-2 ring-ink-100">{ACTION_ICON[h.action] ?? '•'}</span>
              <div className="text-sm font-medium text-ink-800">{h.description}</div>
              <div className="text-xs text-ink-500">
                {h.user.name} ({h.user.role.name}) · {dateTime(h.createdAt)}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}

function TransferModal({ open, order, onClose, onDone }: { open: boolean; order: Order; onClose: () => void; onDone: (o: Order) => void }) {
  const tablesQ = useQuery({ queryKey: ['tables'], queryFn: () => api.get<TableInfo[]>('/tables'), enabled: open });
  const [target, setTarget] = useState<number | ''>('');
  const m = useMutation({
    mutationFn: () => api.post<Order>(`/orders/${order.id}/transfer`, { tableId: target }),
    onSuccess: (o) => (toast.success(`Orden trasladada a ${o.table.name}`), onDone(o)),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const free = (tablesQ.data ?? []).filter((t) => t.status === 'AVAILABLE');
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Cambiar de mesa"
      subtitle={`Trasladar la orden #${order.number} desde ${order.table.name}`}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!target} loading={m.isPending} onClick={() => m.mutate()}>
            <BellRing className="h-4 w-4" /> Trasladar
          </Button>
        </>
      }
    >
      <Field label="Mesa destino (solo disponibles)">
        <Select value={target} onChange={(e) => setTarget(e.target.value ? Number(e.target.value) : '')}>
          <option value="">Seleccione...</option>
          {free.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} {t.zone ? `· ${t.zone}` : ''}
            </option>
          ))}
        </Select>
      </Field>
    </Modal>
  );
}
