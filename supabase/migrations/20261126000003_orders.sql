-- =============================================================
--  03. Lógica de negocio: utilidades, mesas, menú, órdenes y KDS
--  Todas las funciones públicas son SECURITY DEFINER: validan
--  sesión y permisos con _require() y aplican las reglas aquí,
--  en una sola transacción, con bloqueo de fila de la orden.
-- =============================================================

-- ---------------------------------------------------------------
--  Utilidades
-- ---------------------------------------------------------------
create or replace function public._m(p_cents bigint)
returns numeric language sql immutable as $$ select round(p_cents::numeric / 100, 2) $$;

create or replace function public._c(p_amount numeric)
returns bigint language sql immutable as $$ select round(coalesce(p_amount, 0) * 100)::bigint $$;

create or replace function public._user_json(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when p_id is null then null else (select jsonb_build_object('id', id, 'name', name) from profiles where id = p_id) end
$$;

create or replace function public._hist(p_order int, p_user uuid, p_action text, p_description text, p_item int default null, p_details jsonb default null)
returns void language sql security definer set search_path = public as $$
  insert into order_history (order_id, user_id, action, description, order_item_id, details)
  values (p_order, p_user, p_action, left(p_description, 500), p_item, p_details);
$$;

create or replace function public._notify(p_user uuid, p_type text, p_title text, p_message text, p_data jsonb default null)
returns void language sql security definer set search_path = public as $$
  insert into notifications (user_id, type, title, message, data) values (p_user, p_type, left(p_title, 120), left(p_message, 500), p_data);
$$;

create or replace function public._lock_order(p_order int)
returns public.orders language plpgsql security definer set search_path = public as $$
declare o orders;
begin
  select * into o from orders where id = p_order for update;
  if not found then perform _err(404, 'Orden no encontrada'); end if;
  return o;
end $$;

create or replace function public._assert_open(o public.orders)
returns void language plpgsql as $$
begin
  if o.status not in ('OPEN', 'BILL_REQUESTED') then perform public._err(409, 'La orden ya está cerrada o anulada'); end if;
end $$;

create or replace function public._assert_can_edit(p_uid uuid, o public.orders)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not has_perm('orders.edit') then perform _err(403, 'No tiene permiso para modificar pedidos'); end if;
  if o.waiter_id <> p_uid and not has_perm('orders.edit_any') then
    perform _err(403, 'Solo el mesero asignado puede modificar esta orden');
  end if;
end $$;

create or replace function public._paid_qty(p_item int)
returns int language sql stable security definer set search_path = public as $$
  select coalesce(sum(pi.quantity), 0)::int
  from payment_items pi join payments p on p.id = pi.payment_id
  where pi.order_item_id = p_item and p.status = 'COMPLETED'
$$;

-- Totales en céntimos. Las órdenes pagadas usan los totales congelados al cierre.
create or replace function public._totals(p_order int)
returns table (subtotal bigint, discount bigint, service bigint, tax bigint, total bigint, paid bigint, balance bigint, factor numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  o orders;
  s restaurant_settings;
  v_sub bigint; v_disc bigint := 0; v_base bigint; v_serv bigint; v_tax bigint; v_total bigint; v_paid bigint;
begin
  select * into o from orders where id = p_order;
  select coalesce(sum(round(p.amount * 100)::bigint), 0) into v_paid from payments p where p.order_id = p_order and p.status = 'COMPLETED';
  if o.status = 'PAID' then
    v_sub := _c(o.subtotal); v_disc := _c(o.discount_amount); v_serv := _c(o.service_amount); v_tax := _c(o.tax_amount); v_total := _c(o.total);
  else
    select * into s from restaurant_settings where id = 1;
    select coalesce(sum(round(i.unit_price * 100)::bigint * i.quantity), 0) into v_sub
      from order_items i where i.order_id = p_order and i.status <> 'CANCELLED';
    if o.discount_type = 'PERCENT' then v_disc := round(v_sub * least(o.discount_value, 100) / 100);
    elsif o.discount_type = 'AMOUNT' then v_disc := least(_c(o.discount_value), v_sub);
    end if;
    v_base := v_sub - v_disc;
    v_serv := round(v_base * s.service_rate / 100);
    if s.prices_include_tax then
      v_tax := v_base - round(v_base / (1 + s.tax_rate / 100));
      v_total := v_base + v_serv;
    else
      v_tax := round(v_base * s.tax_rate / 100);
      v_total := v_base + v_serv + v_tax;
    end if;
  end if;
  return query select v_sub, v_disc, v_serv, v_tax, v_total, v_paid, greatest(0, v_total - v_paid),
    case when v_sub > 0 then v_total::numeric / v_sub else 1 end;
end $$;

create or replace function public._totals_json(p_order int)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'subtotal', _m(t.subtotal), 'discount', _m(t.discount), 'service', _m(t.service), 'tax', _m(t.tax),
    'total', _m(t.total), 'paid', _m(t.paid), 'balance', _m(t.balance), 'factor', t.factor,
    'taxRate', s.tax_rate, 'serviceRate', s.service_rate, 'pricesIncludeTax', s.prices_include_tax)
  from _totals(p_order) t, restaurant_settings s where s.id = 1
$$;

/*
  Estado visual de la mesa:
  AVAILABLE · WAITING_ORDER (abierta sin productos) · IN_PREPARATION · PARTIALLY_READY ·
  READY (todo lo pendiente está listo) · OCCUPIED (todo entregado) · PENDING_PAYMENT
*/
create or replace function public._table_status(p_order int)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_status order_status; v_live int; v_nd int; v_ready int;
begin
  if p_order is null then return 'AVAILABLE'; end if;
  select status into v_status from orders where id = p_order;
  if v_status = 'BILL_REQUESTED' or exists (select 1 from payments where order_id = p_order and status = 'COMPLETED') then
    return 'PENDING_PAYMENT';
  end if;
  select count(*) filter (where status <> 'CANCELLED'),
         count(*) filter (where status not in ('CANCELLED', 'DELIVERED')),
         count(*) filter (where status = 'READY')
    into v_live, v_nd, v_ready
    from order_items where order_id = p_order;
  if v_live = 0 then return 'WAITING_ORDER'; end if;
  if v_nd = 0 then return 'OCCUPIED'; end if;
  if v_ready = 0 then return 'IN_PREPARATION'; end if;
  if v_ready = v_nd then return 'READY'; end if;
  return 'PARTIALLY_READY';
end $$;

create or replace function public._item_json(i public.order_items)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', i.id, 'orderId', i.order_id, 'batchId', i.batch_id, 'productId', i.product_id, 'productName', i.product_name,
    'unitPrice', i.unit_price, 'quantity', i.quantity, 'notes', i.notes, 'status', i.status, 'parentItemId', i.parent_item_id,
    'modifiedAt', i.modified_at, 'createdAt', i.created_at, 'startedAt', i.started_at, 'readyAt', i.ready_at,
    'deliveredAt', i.delivered_at, 'cancelledAt', i.cancelled_at, 'cancelReason', i.cancel_reason,
    'area', (select jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name) from preparation_areas a where a.id = i.area_id),
    'createdBy', _user_json(i.created_by_id), 'cancelledBy', _user_json(i.cancelled_by_id),
    'paidQuantity', _paid_qty(i.id), 'lineTotal', _m(round(i.unit_price * 100)::bigint * i.quantity))
$$;

create or replace function public._payment_json(p public.payments)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p.id, 'amount', p.amount, 'receivedAmount', p.received_amount, 'changeAmount', p.change_amount,
    'reference', p.reference, 'payerLabel', p.payer_label, 'splitMode', p.split_mode, 'status', p.status, 'createdAt', p.created_at,
    'paymentMethod', (select to_jsonb(m) - 'sort_order' || jsonb_build_object('sortOrder', m.sort_order) from payment_methods m where m.id = p.payment_method_id),
    'user', _user_json(p.user_id))
$$;

create or replace function public._order_json(p_order int)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', o.id, 'number', o.number, 'status', o.status, 'guests', o.guests, 'notes', o.notes,
    'openedAt', o.opened_at, 'closedAt', o.closed_at, 'billRequestedAt', o.bill_requested_at,
    'discountType', o.discount_type, 'discountValue', o.discount_value, 'discountReason', o.discount_reason, 'cancelReason', o.cancel_reason,
    'table', (select jsonb_build_object('id', t.id, 'name', t.name, 'number', t.number) from dining_tables t where t.id = o.table_id),
    'waiter', _user_json(o.waiter_id), 'closedBy', _user_json(o.closed_by_id),
    'batches', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'sequence', b.sequence, 'createdAt', b.created_at, 'createdBy', _user_json(b.created_by_id)) order by b.sequence)
                         from order_batches b where b.order_id = o.id), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(_item_json(i) order by i.id) from order_items i where i.order_id = o.id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(_payment_json(p) order by p.created_at) from payments p where p.order_id = o.id), '[]'::jsonb),
    'totals', _totals_json(o.id),
    'tableStatus', case when o.status in ('OPEN', 'BILL_REQUESTED') then _table_status(o.id) end)
  from orders o where o.id = p_order
$$;

-- ---------------------------------------------------------------
--  Sesión
-- ---------------------------------------------------------------
create or replace function public.me()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  select jsonb_build_object(
    'id', pr.id, 'name', pr.name, 'username', pr.username, 'role', r.code, 'roleName', r.name,
    'permissions', coalesce((select jsonb_agg(pe.code) from role_permissions rp join permissions pe on pe.id = rp.permission_id where rp.role_id = r.id), '[]'::jsonb))
  into v
  from profiles pr join roles r on r.id = pr.role_id
  where pr.id = auth.uid() and pr.active;
  if v is null then perform _err(401, 'Usuario sin perfil activo en el sistema'); end if;
  return v;
end $$;

create or replace function public.log_login()
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _require();
begin
  update profiles set last_login_at = now() where id = v_uid;
  perform _audit(v_uid, 'LOGIN', 'User', v_uid::text, null);
end $$;

-- ---------------------------------------------------------------
--  Mesas y menú
-- ---------------------------------------------------------------
create or replace function public.get_tables(p_all boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _require('tables.view', 'tables.manage', 'payments.view', 'orders.create');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id, 'number', t.number, 'name', t.name, 'zone', t.zone, 'capacity', t.capacity, 'active', t.active,
      'status', _table_status(o.id),
      'order', case when o.id is null then null else jsonb_build_object(
        'id', o.id, 'number', o.number, 'status', o.status, 'guests', o.guests, 'openedAt', o.opened_at,
        'waiter', _user_json(o.waiter_id),
        'itemCounts', coalesce((select jsonb_object_agg(x.status, x.q) from (select status, sum(quantity) q from order_items where order_id = o.id group by status) x), '{}'::jsonb),
        'total', _m(tt.total), 'paid', _m(tt.paid), 'balance', _m(tt.balance)) end)
      order by t.number)
    from dining_tables t
    left join orders o on o.table_id = t.id and o.status in ('OPEN', 'BILL_REQUESTED')
    left join lateral (select * from _totals(o.id)) tt on o.id is not null
    where p_all or t.active), '[]'::jsonb);
end $$;

create or replace function public._product_json(p public.products)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p.id, 'name', p.name, 'description', p.description, 'price', p.price, 'imageUrl', p.image_url,
    'categoryId', p.category_id, 'areaId', p.area_id, 'active', p.active, 'available', p.available, 'sortOrder', p.sort_order,
    'area', (select jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name) from preparation_areas a where a.id = p.area_id),
    'category', (select jsonb_build_object('id', c.id, 'name', c.name) from categories c where c.id = p.category_id))
$$;

create or replace function public.get_menu()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _require();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'description', c.description, 'sortOrder', c.sort_order,
      'active', c.active, 'defaultAreaId', c.default_area_id,
      'products', (select jsonb_agg(_product_json(p) order by p.sort_order, p.name) from products p where p.category_id = c.id and p.active))
      order by c.sort_order, c.name)
    from categories c
    where c.active and exists (select 1 from products p where p.category_id = c.id and p.active)), '[]'::jsonb);
end $$;

create or replace function public.list_products(p_search text default null, p_category_id int default null, p_include_inactive boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _require();
  return coalesce((
    select jsonb_agg(_product_json(p) order by c.sort_order, p.sort_order, p.name)
    from products p join categories c on c.id = p.category_id
    where (p_include_inactive or p.active)
      and (p_category_id is null or p.category_id = p_category_id)
      and (p_search is null or p_search = '' or p.name ilike '%' || p_search || '%')), '[]'::jsonb);
end $$;

create or replace function public.list_categories()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _require();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'description', c.description, 'sortOrder', c.sort_order,
      'active', c.active, 'defaultAreaId', c.default_area_id,
      'defaultArea', (select jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name) from preparation_areas a where a.id = c.default_area_id),
      '_count', jsonb_build_object('products', (select count(*) from products p where p.category_id = c.id)))
      order by c.sort_order, c.name)
    from categories c), '[]'::jsonb);
end $$;

create or replace function public.set_product_availability(p_product_id int, p_available boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _require('menu.manage', 'menu.availability');
begin
  update products set available = p_available where id = p_product_id;
  if not found then perform _err(404, 'Producto no encontrado'); end if;
  perform _audit(v_uid, case when p_available then 'PRODUCT_AVAILABLE' else 'PRODUCT_SOLD_OUT' end, 'Product', p_product_id::text, null);
end $$;

-- Si tiene ventas se desactiva (se conserva el histórico); si no, se elimina
create or replace function public.delete_product(p_id int)
returns text language plpgsql security definer set search_path = public as $$
begin
  perform _require('menu.manage');
  if not exists (select 1 from products where id = p_id) then perform _err(404, 'Producto no encontrado'); end if;
  if exists (select 1 from order_items where product_id = p_id) then
    update products set active = false where id = p_id;
    return 'deactivated';
  end if;
  delete from products where id = p_id;
  return 'deleted';
end $$;

create or replace function public.delete_category(p_id int)
returns text language plpgsql security definer set search_path = public as $$
begin
  perform _require('menu.manage');
  if not exists (select 1 from categories where id = p_id) then perform _err(404, 'Categoría no encontrada'); end if;
  if exists (select 1 from products where category_id = p_id) then
    update categories set active = false where id = p_id;
    return 'deactivated';
  end if;
  delete from categories where id = p_id;
  return 'deleted';
end $$;

create or replace function public.delete_table(p_id int)
returns text language plpgsql security definer set search_path = public as $$
begin
  perform _require('tables.manage');
  if not exists (select 1 from dining_tables where id = p_id) then perform _err(404, 'Mesa no encontrada'); end if;
  if exists (select 1 from orders where table_id = p_id and status in ('OPEN', 'BILL_REQUESTED')) then
    perform _err(409, 'No se puede eliminar una mesa con una orden abierta');
  end if;
  if exists (select 1 from orders where table_id = p_id) then
    update dining_tables set active = false where id = p_id;
    return 'deactivated';
  end if;
  delete from dining_tables where id = p_id;
  return 'deleted';
end $$;

-- ---------------------------------------------------------------
--  Órdenes
-- ---------------------------------------------------------------

/*
  Crea una comanda nueva con los productos indicados ([{productId, quantity, notes}]).
  Cada producto hereda su área de preparación (COCINA / BAR). Solo se insertan
  productos NUEVOS: lo enviado antes nunca se reenvía.
*/
create or replace function public._add_batch(p_order int, p_uid uuid, p_items jsonb, p_action text default 'ITEMS_SENT')
returns int language plpgsql security definer set search_path = public as $$
declare
  v_batch int; v_seq int; e jsonb; p products; a preparation_areas;
  v_qty int; v_notes text; v_desc text := ''; v_details jsonb := '[]'::jsonb; v_item int;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    perform _err(400, 'Debe incluir al menos un producto');
  end if;
  if jsonb_array_length(p_items) > 100 then perform _err(400, 'Demasiados productos en una sola comanda'); end if;
  -- validar todo antes de insertar
  for e in select * from jsonb_array_elements(p_items) loop
    v_qty := (e ->> 'quantity')::int;
    if v_qty is null or v_qty < 1 or v_qty > 99 then perform _err(400, 'La cantidad debe estar entre 1 y 99'); end if;
    if length(coalesce(e ->> 'notes', '')) > 300 then perform _err(400, 'Las observaciones admiten máximo 300 caracteres'); end if;
    select * into p from products where id = (e ->> 'productId')::int;
    if not found or not p.active then perform _err(400, 'Un producto no existe o fue desactivado'); end if;
    if not p.available then perform _err(409, format('"%s" está agotado y no puede solicitarse', p.name)); end if;
  end loop;

  select coalesce(max(sequence), 0) + 1 into v_seq from order_batches where order_id = p_order;
  insert into order_batches (order_id, sequence, created_by_id) values (p_order, v_seq, p_uid) returning id into v_batch;

  for e in select * from jsonb_array_elements(p_items) loop
    select * into p from products where id = (e ->> 'productId')::int;
    select * into a from preparation_areas where id = p.area_id;
    v_qty := (e ->> 'quantity')::int;
    v_notes := nullif(btrim(coalesce(e ->> 'notes', '')), '');
    insert into order_items (order_id, batch_id, product_id, area_id, product_name, unit_price, quantity, notes, created_by_id)
    values (p_order, v_batch, p.id, p.area_id, p.name, p.price, v_qty, v_notes, p_uid)
    returning id into v_item;
    v_desc := v_desc || case when v_desc = '' then '' else ', ' end || format('%sx %s (%s)', v_qty, p.name, a.name);
    v_details := v_details || jsonb_build_object('id', v_item, 'productName', p.name, 'quantity', v_qty, 'area', a.code, 'notes', v_notes);
  end loop;

  perform _hist(p_order, p_uid, p_action, format('Comanda #%s: %s', v_seq, v_desc), null, jsonb_build_object('batchId', v_batch, 'items', v_details));
  return v_batch;
end $$;

create or replace function public.open_order(p_table_id int, p_guests int default 1, p_notes text default null, p_items jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := _require('orders.create');
  t dining_tables; v_order int; v_existing int;
begin
  if p_guests is null or p_guests < 1 or p_guests > 50 then perform _err(400, 'Número de personas inválido (1 a 50)'); end if;
  select * into t from dining_tables where id = p_table_id;
  if not found or not t.active then perform _err(404, 'Mesa no encontrada'); end if;
  select number into v_existing from orders where table_id = t.id and status in ('OPEN', 'BILL_REQUESTED');
  if found then perform _err(409, format('La mesa %s ya tiene una orden abierta (#%s)', t.name, v_existing)); end if;
  begin
    insert into orders (table_id, waiter_id, guests, notes) values (t.id, v_uid, p_guests, nullif(btrim(coalesce(p_notes, '')), ''))
    returning id into v_order;
  exception when unique_violation then
    perform _err(409, format('La mesa %s ya tiene una orden abierta', t.name));
  end;
  perform _hist(v_order, v_uid, 'ORDER_OPENED', format('%s abierta para %s persona(s)', t.name, p_guests));
  if p_items is not null and jsonb_typeof(p_items) = 'array' and jsonb_array_length(p_items) > 0 then
    perform _add_batch(v_order, v_uid, p_items);
  end if;
  return _order_json(v_order);
end $$;

create or replace function public.send_items(p_order_id int, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _require('orders.edit', 'orders.create'); o orders;
begin
  o := _lock_order(p_order_id);
  perform _assert_open(o);
  perform _assert_can_edit(v_uid, o);
  if o.status = 'BILL_REQUESTED' then
    update orders set status = 'OPEN', bill_requested_at = null where id = o.id;
  end if;
  perform _add_batch(o.id, v_uid, p_items);
  update orders set version = version + 1 where id = o.id;
  return _order_json(o.id);
end $$;

/*
  Reglas de modificación de un producto ya enviado:
  - Notas: solo si está Pendiente o En preparación (se marca MODIFICADO en el KDS).
  - Aumentar cantidad: Pendiente → misma línea; En preparación/Listo/Entregado → comanda
    nueva SOLO por la diferencia.
  - Disminuir: la línea se reduce y la diferencia queda registrada como CANCELADA.
*/
create or replace function public.update_order_item(
  p_order_id int, p_item_id int, p_quantity int default null, p_notes text default null,
  p_set_notes boolean default false, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := _require('orders.edit');
  o orders; i order_items; v_new_notes text; v_paid int; v_delta int; v_changed boolean := false; v_cancel int;
begin
  o := _lock_order(p_order_id);
  perform _assert_open(o);
  perform _assert_can_edit(v_uid, o);
  select * into i from order_items where id = p_item_id;
  if not found or i.order_id <> o.id then perform _err(404, 'Producto no encontrado en la orden'); end if;
  if i.status = 'CANCELLED' then perform _err(409, 'El producto ya fue cancelado'); end if;

  v_new_notes := case when p_set_notes then nullif(btrim(coalesce(p_notes, '')), '') else i.notes end;
  if length(coalesce(v_new_notes, '')) > 300 then perform _err(400, 'Las observaciones admiten máximo 300 caracteres'); end if;

  -- Notas
  if p_set_notes and v_new_notes is distinct from i.notes then
    if i.status not in ('PENDING', 'IN_PREPARATION') then
      perform _err(409, 'No se pueden cambiar las observaciones de un producto que ya está listo o entregado');
    end if;
    update order_items set notes = v_new_notes, modified_at = now() where id = i.id;
    perform _hist(o.id, v_uid, 'ITEM_NOTES_CHANGED', format('%s: observación "%s" → "%s"', i.product_name, coalesce(i.notes, '—'), coalesce(v_new_notes, '—')),
                  i.id, jsonb_build_object('before', i.notes, 'after', v_new_notes));
    v_changed := true;
  end if;

  -- Cantidad
  if p_quantity is not null and p_quantity <> i.quantity then
    if p_quantity < 1 or p_quantity > 99 then perform _err(400, 'Para eliminar el producto utilice la opción Eliminar (cantidad mínima 1)'); end if;
    v_paid := _paid_qty(i.id);
    if p_quantity < v_paid then perform _err(409, format('No se puede reducir por debajo de %s unidad(es) ya pagada(s)', v_paid)); end if;
    if p_quantity > i.quantity then
      v_delta := p_quantity - i.quantity;
      if i.status = 'PENDING' then
        update order_items set quantity = p_quantity, modified_at = now() where id = i.id;
        perform _hist(o.id, v_uid, 'ITEM_QTY_CHANGED', format('%s: cantidad %s → %s', i.product_name, i.quantity, p_quantity),
                      i.id, jsonb_build_object('before', i.quantity, 'after', p_quantity));
      else
        perform _add_batch(o.id, v_uid, jsonb_build_array(jsonb_build_object('productId', i.product_id, 'quantity', v_delta, 'notes', v_new_notes)), 'ITEMS_ADDED');
      end if;
    else
      v_delta := i.quantity - p_quantity;
      update order_items set quantity = p_quantity,
        modified_at = case when i.status in ('PENDING', 'IN_PREPARATION') then now() else modified_at end
        where id = i.id;
      insert into order_items (order_id, batch_id, product_id, area_id, product_name, unit_price, quantity, notes, status,
                               parent_item_id, created_by_id, cancelled_at, cancelled_by_id, cancel_reason)
      values (o.id, i.batch_id, i.product_id, i.area_id, i.product_name, i.unit_price, v_delta, i.notes, 'CANCELLED',
              i.id, v_uid, now(), v_uid, coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Reducción de cantidad'))
      returning id into v_cancel;
      perform _hist(o.id, v_uid, 'ITEM_QTY_CHANGED', format('%s: cantidad %s → %s (%s cancelada(s))', i.product_name, i.quantity, p_quantity, v_delta),
                    i.id, jsonb_build_object('before', i.quantity, 'after', p_quantity, 'cancelledItemId', v_cancel, 'reason', p_reason));
    end if;
    v_changed := true;
  end if;

  if not v_changed then perform _err(400, 'No hay cambios para guardar'); end if;
  update orders set version = version + 1 where id = o.id;
  return _order_json(o.id);
end $$;

create or replace function public._cancel_item(p_uid uuid, p_order int, p_item int, p_reason text, p_from_kds boolean)
returns void language plpgsql security definer set search_path = public as $$
declare o orders; i order_items; a preparation_areas; t dining_tables;
begin
  if length(btrim(coalesce(p_reason, ''))) < 3 then perform _err(400, 'Indique un motivo (mín. 3 caracteres)'); end if;
  o := _lock_order(p_order);
  perform _assert_open(o);
  if not p_from_kds then perform _assert_can_edit(p_uid, o); end if;
  select * into i from order_items where id = p_item;
  if not found or i.order_id <> o.id then perform _err(404, 'Producto no encontrado en la orden'); end if;
  if i.status = 'CANCELLED' then perform _err(409, 'El producto ya estaba cancelado'); end if;
  if _paid_qty(i.id) > 0 then perform _err(409, 'No se puede cancelar un producto que ya fue pagado'); end if;
  select * into a from preparation_areas where id = i.area_id;
  update order_items set status = 'CANCELLED', cancelled_at = now(), cancelled_by_id = p_uid, cancel_reason = left(btrim(p_reason), 255) where id = i.id;
  perform _hist(o.id, p_uid, 'ITEM_CANCELLED',
    format('%sx %s cancelado%s: %s', i.quantity, i.product_name, case when p_from_kds then ' por ' || a.name else '' end, btrim(p_reason)),
    i.id, jsonb_build_object('previousStatus', i.status, 'reason', p_reason, 'fromKds', p_from_kds));
  update orders set version = version + 1 where id = o.id;
  if p_from_kds and o.waiter_id <> p_uid then
    select * into t from dining_tables where id = o.table_id;
    perform _notify(o.waiter_id, 'ITEM_CANCELLED', format('%s: producto cancelado', t.name),
      format('%s canceló %sx %s. Motivo: %s', a.name, i.quantity, i.product_name, btrim(p_reason)),
      jsonb_build_object('orderId', o.id, 'itemId', i.id, 'tableId', o.table_id));
  end if;
end $$;

create or replace function public.cancel_order_item(p_order_id int, p_item_id int, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _require('orders.edit');
begin
  perform _cancel_item(v_uid, p_order_id, p_item_id, p_reason, false);
  return _order_json(p_order_id);
end $$;

create or replace function public.deliver_items(p_order_id int, p_item_ids int[] default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _require('orders.edit'); o orders; v_desc text;
begin
  o := _lock_order(p_order_id);
  perform _assert_open(o);
  perform _assert_can_edit(v_uid, o);
  select string_agg(format('%sx %s', quantity, product_name), ', ') into v_desc
    from order_items where order_id = o.id and status = 'READY' and (p_item_ids is null or id = any (p_item_ids));
  if v_desc is null then perform _err(409, 'No hay productos listos para entregar'); end if;
  update order_items set status = 'DELIVERED', delivered_at = now()
    where order_id = o.id and status = 'READY' and (p_item_ids is null or id = any (p_item_ids));
  perform _hist(o.id, v_uid, 'ITEMS_DELIVERED', 'Entregado: ' || v_desc);
  return _order_json(o.id);
end $$;

create or replace function public.update_order_info(p_order_id int, p_guests int default null, p_notes text default null, p_set_notes boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _require('orders.edit'); o orders;
begin
  o := _lock_order(p_order_id);
  perform _assert_open(o);
  perform _assert_can_edit(v_uid, o);
  if p_guests is not null and (p_guests < 1 or p_guests > 50) then perform _err(400, 'Número de personas inválido'); end if;
  update orders set guests = coalesce(p_guests, guests),
    notes = case when p_set_notes then nullif(btrim(coalesce(p_notes, '')), '') else notes end
    where id = o.id;
  perform _hist(o.id, v_uid, 'ORDER_UPDATED', 'Datos de la orden actualizados', null, jsonb_build_object('guests', p_guests, 'notes', p_notes));
  return _order_json(o.id);
end $$;

create or replace function public.request_bill(p_order_id int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _require('orders.edit', 'payments.create'); o orders;
begin
  o := _lock_order(p_order_id);
  if o.status <> 'OPEN' then perform _err(409, 'La cuenta ya fue solicitada o la orden está cerrada'); end if;
  if not exists (select 1 from order_items where order_id = o.id and status <> 'CANCELLED') then
    perform _err(409, 'La orden no tiene productos para cobrar');
  end if;
  update orders set status = 'BILL_REQUESTED', bill_requested_at = now() where id = o.id;
  perform _hist(o.id, v_uid, 'BILL_REQUESTED', 'Cuenta solicitada (pendiente de pago)');
  return _order_json(o.id);
end $$;

create or replace function public.reopen_order(p_order_id int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _require('orders.edit'); o orders;
begin
  o := _lock_order(p_order_id);
  if o.status <> 'BILL_REQUESTED' then perform _err(409, 'Solo se puede reabrir una cuenta solicitada'); end if;
  perform _assert_can_edit(v_uid, o);
  update orders set status = 'OPEN', bill_requested_at = null where id = o.id;
  perform _hist(o.id, v_uid, 'ORDER_REOPENED', 'Cuenta reabierta para agregar productos');
  return _order_json(o.id);
end $$;

create or replace function public.apply_discount(p_order_id int, p_type text, p_value numeric default 0, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _require('orders.discount'); o orders;
begin
  o := _lock_order(p_order_id);
  perform _assert_open(o);
  if exists (select 1 from payments where order_id = o.id and status = 'COMPLETED') then
    perform _err(409, 'No se puede modificar el descuento después de registrar pagos');
  end if;
  if p_type is not null then
    if p_type not in ('AMOUNT', 'PERCENT') then perform _err(400, 'Tipo de descuento inválido'); end if;
    if p_value is null or p_value <= 0 then perform _err(400, 'El descuento debe ser mayor a cero'); end if;
    if p_type = 'PERCENT' and p_value > 100 then perform _err(400, 'El porcentaje no puede ser mayor a 100'); end if;
    if length(btrim(coalesce(p_reason, ''))) < 3 then perform _err(400, 'Indique el motivo del descuento'); end if;
  end if;
  update orders set discount_type = p_type,
    discount_value = case when p_type is null then 0 else p_value end,
    discount_reason = case when p_type is null then null else left(btrim(p_reason), 255) end
    where id = o.id;
  perform _hist(o.id, v_uid, 'DISCOUNT_APPLIED',
    case when p_type is null then 'Descuento eliminado'
         else format('Descuento %s — %s', case when p_type = 'PERCENT' then p_value || '%' else '₡' || p_value end, p_reason) end,
    null, jsonb_build_object('type', p_type, 'value', p_value, 'reason', p_reason));
  return _order_json(o.id);
end $$;

create or replace function public.cancel_order(p_order_id int, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _require('orders.cancel'); o orders;
begin
  if length(btrim(coalesce(p_reason, ''))) < 3 then perform _err(400, 'Indique un motivo (mín. 3 caracteres)'); end if;
  o := _lock_order(p_order_id);
  perform _assert_open(o);
  if exists (select 1 from payments where order_id = o.id and status = 'COMPLETED') then
    perform _err(409, 'No se puede anular una orden con pagos registrados');
  end if;
  update order_items set status = 'CANCELLED', cancelled_at = now(), cancelled_by_id = v_uid, cancel_reason = left('Orden anulada: ' || btrim(p_reason), 255)
    where order_id = o.id and status <> 'CANCELLED';
  update orders set status = 'CANCELLED', closed_at = now(), closed_by_id = v_uid, cancel_reason = left(btrim(p_reason), 255) where id = o.id;
  perform _hist(o.id, v_uid, 'ORDER_CANCELLED', 'Orden anulada: ' || btrim(p_reason));
  perform _audit(v_uid, 'ORDER_CANCELLED', 'Order', o.id::text, jsonb_build_object('reason', p_reason));
  return _order_json(o.id);
end $$;

create or replace function public.transfer_order(p_order_id int, p_table_id int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _require('orders.edit'); o orders; src dining_tables; dst dining_tables;
begin
  o := _lock_order(p_order_id);
  perform _assert_open(o);
  perform _assert_can_edit(v_uid, o);
  select * into src from dining_tables where id = o.table_id;
  select * into dst from dining_tables where id = p_table_id;
  if not found or not dst.active then perform _err(404, 'Mesa destino no encontrada'); end if;
  if exists (select 1 from orders where table_id = dst.id and status in ('OPEN', 'BILL_REQUESTED')) then
    perform _err(409, format('La mesa %s está ocupada', dst.name));
  end if;
  update orders set table_id = dst.id where id = o.id;
  perform _hist(o.id, v_uid, 'TABLE_TRANSFERRED', format('Orden trasladada de %s a %s', src.name, dst.name));
  return _order_json(o.id);
end $$;

create or replace function public.get_order(p_order_id int)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform _require('orders.view', 'payments.view', 'reports.view');
  v := _order_json(p_order_id);
  if v is null then perform _err(404, 'Orden no encontrada'); end if;
  return v;
end $$;

create or replace function public.get_order_history(p_order_id int)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _require('orders.view', 'payments.view', 'reports.view');
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', h.id, 'action', h.action, 'description', h.description, 'createdAt', h.created_at,
      'user', jsonb_build_object('id', pr.id, 'name', pr.name, 'role', jsonb_build_object('name', r.name))) order by h.created_at desc, h.id desc)
    from order_history h join profiles pr on pr.id = h.user_id join roles r on r.id = pr.role_id
    where h.order_id = p_order_id), '[]'::jsonb);
end $$;

create or replace function public.list_orders(p_status text default null, p_from date default null, p_to date default null, p_page int default 1, p_page_size int default 25)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_total int; v_rows jsonb; tz text := 'America/Costa_Rica';
begin
  perform _require('orders.view', 'reports.view', 'payments.view');
  p_page_size := least(greatest(coalesce(p_page_size, 25), 1), 100);
  p_page := greatest(coalesce(p_page, 1), 1);
  select count(*) into v_total from orders o
    where (p_status is null or p_status = '' or o.status::text = p_status)
      and (p_from is null or o.opened_at >= (p_from::timestamp at time zone tz))
      and (p_to is null or o.opened_at < ((p_to + 1)::timestamp at time zone tz));
  select coalesce(jsonb_agg(r), '[]'::jsonb) into v_rows from (
    select jsonb_build_object('id', o.id, 'number', o.number, 'status', o.status, 'guests', o.guests, 'openedAt', o.opened_at,
      'closedAt', o.closed_at, 'total', o.total, 'table', jsonb_build_object('name', t.name), 'waiter', _user_json(o.waiter_id)) r
    from orders o join dining_tables t on t.id = o.table_id
    where (p_status is null or p_status = '' or o.status::text = p_status)
      and (p_from is null or o.opened_at >= (p_from::timestamp at time zone tz))
      and (p_to is null or o.opened_at < ((p_to + 1)::timestamp at time zone tz))
    order by o.opened_at desc
    offset (p_page - 1) * p_page_size limit p_page_size) x;
  return jsonb_build_object('total', v_total, 'page', p_page, 'pageSize', p_page_size, 'rows', v_rows);
end $$;

-- ---------------------------------------------------------------
--  KDS — Cocina y Bar (cada área solo ve sus propios productos)
-- ---------------------------------------------------------------
create or replace function public._assert_area(p_area text)
returns uuid language plpgsql stable security definer set search_path = public as $$
begin
  if p_area not in ('KITCHEN', 'BAR') then perform _err(400, 'Área inválida'); end if;
  return _require(case p_area when 'KITCHEN' then 'kds.kitchen' else 'kds.bar' end);
end $$;

create or replace function public.kds_tickets(p_area text, p_recent_minutes int default 20)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_area int; v_since timestamptz := now() - make_interval(mins => p_recent_minutes);
begin
  perform _assert_area(p_area);
  select id into v_area from preparation_areas where code = p_area;
  return coalesce((
    select jsonb_agg(tk order by tk ->> 'receivedAt')
    from (
      select jsonb_build_object(
        'batchId', b.id, 'sequence', b.sequence, 'receivedAt', b.created_at, 'sentBy', _user_json(b.created_by_id),
        'order', jsonb_build_object('id', o.id, 'number', o.number, 'status', o.status, 'guests', o.guests,
                   'table', jsonb_build_object('id', t.id, 'name', t.name, 'number', t.number), 'waiter', _user_json(o.waiter_id)),
        'items', items.list,
        'state', case when items.pending = 0 then 'DONE' when items.started > 0 then 'IN_PROGRESS' else 'NEW' end,
        'modified', items.modified,
        'progress', jsonb_build_object('ready', items.ready, 'total', items.live)) tk
      from order_batches b
      join orders o on o.id = b.order_id
      join dining_tables t on t.id = o.table_id
      cross join lateral (
        select
          jsonb_agg(jsonb_build_object(
            'id', i.id, 'productName', i.product_name, 'quantity', i.quantity, 'notes', i.notes, 'status', i.status,
            'modifiedAt', i.modified_at, 'createdAt', i.created_at, 'startedAt', i.started_at, 'readyAt', i.ready_at,
            'cancelledAt', i.cancelled_at, 'cancelReason', i.cancel_reason,
            'cancelledQuantity', (select coalesce(sum(s.quantity), 0) from order_items s where s.parent_item_id = i.id)) order by i.id) as list,
          count(*) filter (where i.status in ('PENDING', 'IN_PREPARATION')) as pending,
          count(*) filter (where i.status in ('IN_PREPARATION', 'READY', 'DELIVERED')) as started,
          count(*) filter (where i.status in ('READY', 'DELIVERED')) as ready,
          count(*) filter (where i.status <> 'CANCELLED') as live,
          bool_or(i.modified_at is not null and i.status not in ('READY', 'DELIVERED', 'CANCELLED'))
            or exists (select 1 from order_items s where s.batch_id = b.id and s.area_id = v_area and s.parent_item_id is not null and s.cancelled_at >= v_since) as modified
        from order_items i
        where i.batch_id = b.id and i.area_id = v_area and i.parent_item_id is null
      ) items
      where items.list is not null
        and exists (
          select 1 from order_items x
          where x.batch_id = b.id and x.area_id = v_area
            and (x.status in ('PENDING', 'IN_PREPARATION') or x.ready_at >= v_since or x.cancelled_at >= v_since))
    ) q), '[]'::jsonb);
end $$;

create or replace function public.kds_set_items_status(p_area text, p_item_ids int[], p_status text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := _assert_area(p_area);
  v_order int; o orders; t dining_tables; i record; v_changed int[] := '{}'; v_desc text := ''; v_remaining int;
  v_area_name text := case p_area when 'KITCHEN' then 'Cocina' else 'Bar' end;
  v_label text := case p_status when 'PENDING' then 'Pendiente' when 'IN_PREPARATION' then 'En preparación' when 'READY' then 'Listo' end;
begin
  if p_status not in ('PENDING', 'IN_PREPARATION', 'READY') then perform _err(400, 'Estado no permitido desde KDS'); end if;
  if p_item_ids is null or array_length(p_item_ids, 1) is null then perform _err(400, 'Sin productos'); end if;
  select order_id into v_order from order_items where id = p_item_ids[1];
  if not found then perform _err(404, 'Producto no encontrado'); end if;
  o := _lock_order(v_order);
  if (select count(*) from order_items where id = any (p_item_ids)) <> (select count(distinct x) from unnest(p_item_ids) x) then
    perform _err(404, 'Algún producto no existe');
  end if;
  if exists (select 1 from order_items where id = any (p_item_ids) and order_id <> v_order) then
    perform _err(400, 'Los productos deben pertenecer a la misma orden');
  end if;
  for i in select oi.*, a.code as area_code from order_items oi join preparation_areas a on a.id = oi.area_id where oi.id = any (p_item_ids) order by oi.id loop
    if i.area_code <> p_area then perform _err(403, format('"%s" no pertenece a esta área', i.product_name)); end if;
    continue when i.status::text = p_status;
    if not (
      (i.status = 'PENDING' and p_status in ('IN_PREPARATION', 'READY')) or
      (i.status = 'IN_PREPARATION' and p_status in ('READY', 'PENDING')) or
      (i.status = 'READY' and p_status = 'IN_PREPARATION')
    ) then
      perform _err(409, format('"%s" no puede pasar de %s a %s', i.product_name, i.status, v_label));
    end if;
    v_changed := v_changed || i.id;
    v_desc := v_desc || case when v_desc = '' then '' else ', ' end || format('%sx %s', i.quantity, i.product_name);
  end loop;
  if array_length(v_changed, 1) is null then return jsonb_build_object('changed', 0); end if;

  update order_items set
    status = p_status::order_item_status,
    started_at = case p_status when 'IN_PREPARATION' then now() when 'PENDING' then null else coalesce(started_at, now()) end,
    ready_at = case p_status when 'READY' then now() else null end
  where id = any (v_changed);

  perform _hist(o.id, v_uid, 'ITEM_STATUS_CHANGED', format('%s: %s → %s', v_area_name, v_desc, v_label), null,
                jsonb_build_object('itemIds', to_jsonb(v_changed), 'status', p_status));

  if p_status = 'READY' then
    select count(*) into v_remaining from order_items where order_id = o.id and status in ('PENDING', 'IN_PREPARATION');
    select * into t from dining_tables where id = o.table_id;
    perform _notify(o.waiter_id,
      case when v_remaining = 0 then 'ORDER_READY' else 'ITEMS_READY' end,
      case when v_remaining = 0 then format('%s: ¡pedido completo listo!', t.name) else format('%s: listo en %s', t.name, v_area_name) end,
      v_desc,
      jsonb_build_object('orderId', o.id, 'tableId', o.table_id, 'area', p_area, 'itemIds', to_jsonb(v_changed), 'allReady', v_remaining = 0));
  end if;
  return jsonb_build_object('changed', array_length(v_changed, 1));
end $$;

create or replace function public.kds_set_batch_status(p_area text, p_batch_id int, p_status text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ids int[];
begin
  perform _assert_area(p_area);
  if p_status not in ('IN_PREPARATION', 'READY') then perform _err(400, 'Estado inválido'); end if;
  select array_agg(i.id) into v_ids
    from order_items i join preparation_areas a on a.id = i.area_id
    where i.batch_id = p_batch_id and a.code = p_area and i.parent_item_id is null
      and i.status = any (case when p_status = 'READY' then array['PENDING', 'IN_PREPARATION']::order_item_status[] else array['PENDING']::order_item_status[] end);
  if v_ids is null then perform _err(409, 'No hay productos para actualizar en esta comanda'); end if;
  return kds_set_items_status(p_area, v_ids, p_status);
end $$;

create or replace function public.kds_cancel_item(p_area text, p_item_id int, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _assert_area(p_area); i record;
begin
  select oi.order_id, a.code into i from order_items oi join preparation_areas a on a.id = oi.area_id where oi.id = p_item_id;
  if not found then perform _err(404, 'Producto no encontrado'); end if;
  if i.code <> p_area then perform _err(403, 'El producto no pertenece a esta área'); end if;
  perform _cancel_item(v_uid, i.order_id, p_item_id, p_reason, true);
end $$;
