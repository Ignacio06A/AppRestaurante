-- =============================================================
--  04. Caja: cuentas, pagos, división y control de caja
--  Pagos y cierres son transaccionales (bloqueo de fila) e
--  idempotentes (clave única por pago → sin ventas duplicadas).
-- =============================================================

create or replace function public._require()
returns uuid language sql stable security definer set search_path = public as $$
  select public._require(variadic '{}'::text[])
$$;

-- ---------------------------------------------------------------
--  Cuentas
-- ---------------------------------------------------------------
create or replace function public.cashier_accounts()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _require('payments.view');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id, 'number', o.number, 'status', o.status, 'guests', o.guests, 'openedAt', o.opened_at, 'billRequestedAt', o.bill_requested_at,
      'table', jsonb_build_object('id', t.id, 'name', t.name, 'zone', t.zone), 'waiter', _user_json(o.waiter_id),
      'itemCount', (select coalesce(sum(quantity), 0) from order_items where order_id = o.id and status <> 'CANCELLED'),
      'pendingPrep', (select count(*) from order_items where order_id = o.id and status in ('PENDING', 'IN_PREPARATION')),
      'total', _m(tt.total), 'paid', _m(tt.paid), 'balance', _m(tt.balance))
      order by (o.status = 'BILL_REQUESTED') desc, o.opened_at)
    from orders o join dining_tables t on t.id = o.table_id
    cross join lateral _totals(o.id) tt
    where o.status in ('OPEN', 'BILL_REQUESTED')), '[]'::jsonb);
end $$;

create or replace function public._account_json(p_order int)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb; v_factor numeric;
begin
  v := _order_json(p_order);
  if v is null then perform _err(404, 'Orden no encontrada'); end if;
  select factor into v_factor from _totals(p_order);
  return v
    || jsonb_build_object('items', coalesce((
         select jsonb_agg(e || jsonb_build_object(
           'unpaidQuantity', (e ->> 'quantity')::int - (e ->> 'paidQuantity')::int,
           'unitShare', _m(round(_c((e ->> 'unitPrice')::numeric) * v_factor)::bigint)) order by (e ->> 'id')::int)
         from jsonb_array_elements(v -> 'items') e where e ->> 'status' <> 'CANCELLED'), '[]'::jsonb))
    || jsonb_build_object('cancelledItems', coalesce((
         select jsonb_agg(e order by (e ->> 'id')::int) from jsonb_array_elements(v -> 'items') e where e ->> 'status' = 'CANCELLED'), '[]'::jsonb));
end $$;

create or replace function public.get_account(p_order_id int)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _require('payments.view');
  return _account_json(p_order_id);
end $$;

-- Divide el saldo en N partes iguales redondeadas a colones; la última absorbe el redondeo
create or replace function public.split_equal(p_order_id int, p_parts int)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_balance bigint; v_base bigint; v_arr jsonb := '[]'::jsonb;
begin
  perform _require('payments.view');
  if p_parts is null or p_parts < 2 or p_parts > 50 then perform _err(400, 'Número de partes inválido (2 a 50)'); end if;
  select balance into v_balance from _totals(p_order_id);
  v_base := floor(v_balance::numeric / p_parts / 100) * 100;
  for k in 1 .. p_parts - 1 loop v_arr := v_arr || to_jsonb(_m(v_base)); end loop;
  v_arr := v_arr || to_jsonb(_m(v_balance - v_base * (p_parts - 1)));
  return jsonb_build_object('parts', p_parts, 'balance', _m(v_balance), 'amounts', v_arr);
end $$;

-- ---------------------------------------------------------------
--  Caja: utilidades
-- ---------------------------------------------------------------
create or replace function public._default_register()
returns int language plpgsql stable security definer set search_path = public as $$
declare v int;
begin
  select id into v from cash_registers where active order by id limit 1;
  if v is null then perform _err(404, 'No hay cajas registradoras configuradas'); end if;
  return v;
end $$;

create or replace function public._session_summary(p_session int)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  s cash_sessions;
  v_cash bigint; v_card bigint; v_transfer bigint; v_other bigint; v_count int;
  v_income bigint; v_withdrawals bigint; v_expenses bigint; v_adjust bigint; v_opening bigint; v_expected bigint;
begin
  select * into s from cash_sessions where id = p_session;
  if not found then perform _err(404, 'Sesión de caja no encontrada'); end if;
  select coalesce(sum(_c(p.amount)) filter (where m.kind = 'CASH'), 0),
         coalesce(sum(_c(p.amount)) filter (where m.kind = 'CARD'), 0),
         coalesce(sum(_c(p.amount)) filter (where m.kind = 'TRANSFER'), 0),
         coalesce(sum(_c(p.amount)) filter (where m.kind = 'OTHER'), 0),
         count(*)
    into v_cash, v_card, v_transfer, v_other, v_count
    from payments p join payment_methods m on m.id = p.payment_method_id
    where p.cash_session_id = p_session and p.status = 'COMPLETED';
  select coalesce(sum(_c(amount)) filter (where type = 'INCOME'), 0),
         -coalesce(sum(_c(amount)) filter (where type = 'WITHDRAWAL'), 0),
         -coalesce(sum(_c(amount)) filter (where type = 'EXPENSE'), 0),
         coalesce(sum(_c(amount)) filter (where type = 'ADJUSTMENT'), 0)
    into v_income, v_withdrawals, v_expenses, v_adjust
    from cash_movements where session_id = p_session;
  v_opening := _c(s.opening_amount);
  v_expected := v_opening + v_cash + v_income - v_withdrawals - v_expenses + v_adjust;
  return jsonb_build_object(
    'openingAmount', _m(v_opening), 'totalSales', _m(v_cash + v_card + v_transfer + v_other),
    'cashSales', _m(v_cash), 'cardSales', _m(v_card), 'transferSales', _m(v_transfer), 'otherSales', _m(v_other),
    'totalIncome', _m(v_income), 'totalWithdrawals', _m(v_withdrawals), 'totalExpenses', _m(v_expenses),
    'totalAdjustments', _m(v_adjust), 'expectedCash', _m(v_expected), 'paymentsCount', v_count,
    'byMethod', coalesce((
      select jsonb_agg(jsonb_build_object('code', x.code, 'name', x.name, 'kind', x.kind, 'total', _m(x.total), 'count', x.cnt))
      from (select m.code, m.name, m.kind, sum(_c(p.amount))::bigint total, count(*) cnt
            from payments p join payment_methods m on m.id = p.payment_method_id
            where p.cash_session_id = p_session and p.status = 'COMPLETED' group by m.code, m.name, m.kind) x), '[]'::jsonb));
end $$;

create or replace function public._session_json(p_session int)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', s.id, 'registerId', s.register_id, 'openedAt', s.opened_at, 'openingAmount', s.opening_amount,
    'openingNotes', s.opening_notes, 'status', s.status,
    'register', jsonb_build_object('id', r.id, 'name', r.name), 'openedBy', _user_json(s.opened_by_id),
    'closing', (select jsonb_build_object(
        'id', c.id, 'closedAt', c.closed_at, 'closedBy', _user_json(c.closed_by_id), 'openingAmount', c.opening_amount,
        'totalSales', c.total_sales, 'cashSales', c.cash_sales, 'cardSales', c.card_sales, 'transferSales', c.transfer_sales,
        'otherSales', c.other_sales, 'totalIncome', c.total_income, 'totalWithdrawals', c.total_withdrawals,
        'totalExpenses', c.total_expenses, 'totalAdjustments', c.total_adjustments, 'expectedCash', c.expected_cash,
        'countedCash', c.counted_cash, 'difference', c.difference, 'notes', c.notes)
      from cash_closings c where c.session_id = s.id))
  from cash_sessions s join cash_registers r on r.id = s.register_id where s.id = p_session
$$;

-- ---------------------------------------------------------------
--  Pagos
-- ---------------------------------------------------------------
/*
  Registra un pago (FULL, EQUAL, ITEMS, CUSTOM).
  - Bloquea la fila de la orden (evita pagos concurrentes sobre la misma cuenta).
  - Idempotente por p_idempotency_key: un reintento devuelve el pago ya registrado.
  - Requiere caja abierta; genera el movimiento de caja tipo VENTA.
  - Al llegar el saldo a cero: congela totales, cierra la orden y libera la mesa.
*/
create or replace function public.register_payment(
  p_order_id int, p_payment_method_id int, p_split_mode text, p_idempotency_key text,
  p_amount numeric default null, p_received_amount numeric default null, p_reference text default null,
  p_payer_label text default null, p_items jsonb default null, p_register_id int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := _require('payments.create');
  o orders; t dining_tables; m payment_methods; v_session int; tt record; existing payments;
  v_amount bigint := 0; v_received bigint; v_change bigint := 0; v_payment int; e jsonb; it order_items;
  v_unpaid int; v_share bigint; v_alloc jsonb := '[]'::jsonb; v_remaining_units int; v_selected_units int := 0; v_closed boolean := false;
begin
  if p_split_mode not in ('FULL', 'EQUAL', 'ITEMS', 'CUSTOM') then perform _err(400, 'Modo de pago inválido'); end if;
  if p_idempotency_key is null or length(p_idempotency_key) < 8 or length(p_idempotency_key) > 80 then
    perform _err(400, 'Clave de idempotencia inválida');
  end if;

  o := _lock_order(p_order_id);

  -- Reintento con la misma clave: devolver el pago existente sin duplicar
  select * into existing from payments where idempotency_key = p_idempotency_key;
  if found then
    if existing.order_id <> o.id then perform _err(409, 'Clave de idempotencia ya utilizada en otra orden'); end if;
    return jsonb_build_object('payment', _payment_json(existing), 'closed', o.status = 'PAID', 'duplicated', true, 'account', _account_json(o.id));
  end if;

  if o.status not in ('OPEN', 'BILL_REQUESTED') then perform _err(409, 'La cuenta ya fue pagada o está anulada'); end if;

  select id into v_session from cash_sessions where register_id = coalesce(p_register_id, _default_register()) and status = 'OPEN';
  if v_session is null then perform _err(409, 'Debe abrir la caja antes de registrar pagos'); end if;

  select * into m from payment_methods where id = p_payment_method_id;
  if not found or not m.active then perform _err(400, 'Método de pago inválido'); end if;

  select * into tt from _totals(o.id);
  if tt.total <= 0 then perform _err(409, 'La cuenta no tiene monto por cobrar'); end if;
  if tt.balance <= 0 then perform _err(409, 'La cuenta no tiene saldo pendiente'); end if;

  if p_split_mode = 'ITEMS' then
    if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
      perform _err(400, 'Seleccione los productos a pagar');
    end if;
    for e in select * from jsonb_array_elements(p_items) loop
      select * into it from order_items where id = (e ->> 'orderItemId')::int;
      if not found or it.order_id <> o.id or it.status = 'CANCELLED' then perform _err(400, 'Producto inválido'); end if;
      if (e ->> 'quantity')::int is null or (e ->> 'quantity')::int < 1 then perform _err(400, 'Cantidad inválida'); end if;
      v_unpaid := it.quantity - _paid_qty(it.id);
      if (e ->> 'quantity')::int > v_unpaid then
        perform _err(409, format('"%s": solo quedan %s unidad(es) por pagar', it.product_name, v_unpaid));
      end if;
      v_share := round(_c(it.unit_price) * (e ->> 'quantity')::int * tt.factor);
      v_alloc := v_alloc || jsonb_build_object('id', it.id, 'q', (e ->> 'quantity')::int, 'a', v_share);
      v_amount := v_amount + v_share;
      v_selected_units := v_selected_units + (e ->> 'quantity')::int;
    end loop;
    select coalesce(sum(quantity - _paid_qty(id)), 0) into v_remaining_units from order_items where order_id = o.id and status <> 'CANCELLED';
    -- Si se pagan todos los productos restantes, se liquida el saldo exacto (sin residuos de redondeo)
    if v_selected_units = v_remaining_units then v_amount := tt.balance; end if;
    v_amount := least(v_amount, tt.balance);
  elsif p_split_mode = 'FULL' then
    v_amount := tt.balance;
  else
    if p_amount is null then perform _err(400, 'Indique el monto a pagar'); end if;
    v_amount := _c(p_amount);
  end if;
  if v_amount <= 0 then perform _err(400, 'El monto debe ser mayor a cero'); end if;
  if v_amount > tt.balance then
    perform _err(409, format('El monto excede el saldo pendiente (₡%s)', to_char(_m(tt.balance), 'FM999G999G999D00')));
  end if;

  if m.kind = 'CASH' then
    v_received := coalesce(_c(p_received_amount), v_amount);
    if p_received_amount is null then v_received := v_amount; end if;
    if v_received < v_amount then perform _err(400, 'El efectivo recibido es menor al monto a pagar'); end if;
    v_change := v_received - v_amount;
  end if;

  begin
    insert into payments (order_id, payment_method_id, cash_session_id, amount, received_amount, change_amount, reference,
                          payer_label, split_mode, idempotency_key, user_id)
    values (o.id, m.id, v_session, _m(v_amount), case when v_received is null then null else _m(v_received) end, _m(v_change),
            nullif(left(btrim(coalesce(p_reference, '')), 120), ''), nullif(left(btrim(coalesce(p_payer_label, '')), 60), ''),
            p_split_mode, p_idempotency_key, v_uid)
    returning id into v_payment;
  exception when unique_violation then
    select * into existing from payments where idempotency_key = p_idempotency_key;
    return jsonb_build_object('payment', _payment_json(existing), 'closed', false, 'duplicated', true, 'account', _account_json(o.id));
  end;

  insert into payment_items (payment_id, order_item_id, quantity, amount)
  select v_payment, (a ->> 'id')::int, (a ->> 'q')::int, _m((a ->> 'a')::bigint) from jsonb_array_elements(v_alloc) a;

  select * into t from dining_tables where id = o.table_id;
  insert into cash_movements (session_id, type, amount, payment_method_id, payment_id, description, user_id)
  values (v_session, 'SALE', _m(v_amount), m.id, v_payment,
          left(format('Venta orden #%s — %s%s', o.number, t.name, coalesce(' (' || nullif(btrim(coalesce(p_payer_label, '')), '') || ')', '')), 255), v_uid);

  perform _hist(o.id, v_uid, 'PAYMENT_REGISTERED',
    format('Pago %s ₡%s%s', m.name, to_char(_m(v_amount), 'FM999G999G999D00'), coalesce(' — ' || nullif(btrim(coalesce(p_payer_label, '')), ''), '')),
    null, jsonb_build_object('paymentId', v_payment, 'amount', _m(v_amount), 'method', m.code, 'splitMode', p_split_mode));

  if tt.balance - v_amount <= 0 then
    update orders set status = 'PAID', closed_at = now(), closed_by_id = v_uid,
      subtotal = _m(tt.subtotal), discount_amount = _m(tt.discount), service_amount = _m(tt.service),
      tax_amount = _m(tt.tax), total = _m(tt.total)
      where id = o.id;
    perform _hist(o.id, v_uid, 'ORDER_CLOSED', format('Cuenta pagada y cerrada. Total ₡%s. Mesa liberada.', to_char(_m(tt.total), 'FM999G999G999D00')));
    v_closed := true;
  elsif o.status = 'OPEN' then
    update orders set status = 'BILL_REQUESTED', bill_requested_at = coalesce(bill_requested_at, now()) where id = o.id;
  end if;

  perform _audit(v_uid, 'PAYMENT_REGISTERED', 'Payment', v_payment::text,
                 jsonb_build_object('orderId', o.id, 'amount', _m(v_amount), 'method', m.code, 'closed', v_closed));

  return jsonb_build_object('payment', (select _payment_json(p) from payments p where p.id = v_payment),
                            'closed', v_closed, 'duplicated', false, 'account', _account_json(o.id));
end $$;

create or replace function public.get_receipt(p_order_id int, p_payment_id int default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_acc jsonb; v_pay jsonb;
begin
  perform _require('payments.view', 'orders.view');
  v_acc := _account_json(p_order_id);
  if p_payment_id is not null then
    select e into v_pay from jsonb_array_elements(v_acc -> 'payments') e where (e ->> 'id')::int = p_payment_id;
    if v_pay is null then perform _err(404, 'Pago no encontrado en esta orden'); end if;
  end if;
  return jsonb_build_object('order', v_acc, 'payment', v_pay, 'generatedAt', now(),
    'settings', (select to_jsonb(s) from restaurant_settings s where s.id = 1));
end $$;

-- ---------------------------------------------------------------
--  Control de caja
-- ---------------------------------------------------------------
create or replace function public.cash_current(p_register_id int default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v int;
begin
  perform _require('cash.operate', 'payments.view', 'payments.create');
  select id into v from cash_sessions where register_id = coalesce(p_register_id, _default_register()) and status = 'OPEN';
  if v is null then return jsonb_build_object('session', null); end if;
  return jsonb_build_object('session', _session_json(v), 'summary', _session_summary(v));
end $$;

create or replace function public.cash_open(p_opening_amount numeric, p_notes text default null, p_register_id int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _require('cash.operate'); v_reg cash_registers; v_id int;
begin
  if p_opening_amount is null or p_opening_amount < 0 then perform _err(400, 'Monto inicial inválido'); end if;
  select * into v_reg from cash_registers where id = coalesce(p_register_id, _default_register());
  if not found or not v_reg.active then perform _err(404, 'Caja registradora no encontrada'); end if;
  if exists (select 1 from cash_sessions where register_id = v_reg.id and status = 'OPEN') then
    perform _err(409, format('La %s ya está abierta', v_reg.name));
  end if;
  begin
    insert into cash_sessions (register_id, opened_by_id, opening_amount, opening_notes)
    values (v_reg.id, v_uid, round(p_opening_amount, 2), nullif(left(btrim(coalesce(p_notes, '')), 500), ''))
    returning id into v_id;
  exception when unique_violation then
    perform _err(409, format('La %s ya está abierta', v_reg.name));
  end;
  perform _audit(v_uid, 'CASH_OPENED', 'CashSession', v_id::text, jsonb_build_object('registerId', v_reg.id, 'openingAmount', p_opening_amount));
  return _session_json(v_id);
end $$;

create or replace function public.cash_add_movement(p_session_id int, p_type text, p_amount numeric, p_description text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _require('cash.operate'); s cash_sessions; v_cents bigint; v_id int;
begin
  if p_type not in ('INCOME', 'WITHDRAWAL', 'EXPENSE', 'ADJUSTMENT') then perform _err(400, 'Tipo de movimiento inválido'); end if;
  if p_type = 'ADJUSTMENT' and not has_perm('cash.adjust') then
    perform _err(403, 'Los ajustes de caja requieren autorización (permiso cash.adjust)');
  end if;
  if length(btrim(coalesce(p_description, ''))) < 3 then perform _err(400, 'Describa el movimiento (mín. 3 caracteres)'); end if;
  v_cents := _c(p_amount);
  if p_type <> 'ADJUSTMENT' and v_cents <= 0 then perform _err(400, 'El monto debe ser mayor a cero'); end if;
  if p_type = 'ADJUSTMENT' and v_cents = 0 then perform _err(400, 'El ajuste no puede ser cero'); end if;
  select * into s from cash_sessions where id = p_session_id for update;
  if not found then perform _err(404, 'Sesión de caja no encontrada'); end if;
  if s.status <> 'OPEN' then perform _err(409, 'La caja está cerrada'); end if;
  if p_type in ('WITHDRAWAL', 'EXPENSE') then
    if v_cents > _c((_session_summary(p_session_id) ->> 'expectedCash')::numeric) then
      perform _err(409, format('Fondos insuficientes en caja. Efectivo disponible: ₡%s', to_char((_session_summary(p_session_id) ->> 'expectedCash')::numeric, 'FM999G999G999D00')));
    end if;
    v_cents := -v_cents;
  end if;
  insert into cash_movements (session_id, type, amount, description, user_id, authorized_by_id)
  values (p_session_id, p_type::cash_movement_type, _m(v_cents), left(btrim(p_description), 255), v_uid, case when p_type = 'ADJUSTMENT' then v_uid end)
  returning id into v_id;
  perform _audit(v_uid, 'CASH_' || p_type, 'CashMovement', v_id::text, jsonb_build_object('sessionId', p_session_id, 'amount', _m(v_cents), 'description', p_description));
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.cash_close(p_session_id int, p_counted_cash numeric, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _require('cash.close'); s cash_sessions; sm jsonb; v_counted bigint; v_expected bigint;
begin
  if p_counted_cash is null or p_counted_cash < 0 then perform _err(400, 'Monto contado inválido'); end if;
  select * into s from cash_sessions where id = p_session_id for update;
  if not found then perform _err(404, 'Sesión de caja no encontrada'); end if;
  if s.status <> 'OPEN' then perform _err(409, 'La caja ya fue cerrada'); end if;
  sm := _session_summary(p_session_id);
  v_counted := _c(p_counted_cash);
  v_expected := _c((sm ->> 'expectedCash')::numeric);
  insert into cash_closings (session_id, closed_by_id, opening_amount, total_sales, cash_sales, card_sales, transfer_sales, other_sales,
                             total_income, total_withdrawals, total_expenses, total_adjustments, expected_cash, counted_cash, difference, notes)
  values (p_session_id, v_uid, (sm ->> 'openingAmount')::numeric, (sm ->> 'totalSales')::numeric, (sm ->> 'cashSales')::numeric,
          (sm ->> 'cardSales')::numeric, (sm ->> 'transferSales')::numeric, (sm ->> 'otherSales')::numeric, (sm ->> 'totalIncome')::numeric,
          (sm ->> 'totalWithdrawals')::numeric, (sm ->> 'totalExpenses')::numeric, (sm ->> 'totalAdjustments')::numeric,
          _m(v_expected), _m(v_counted), _m(v_counted - v_expected), nullif(left(btrim(coalesce(p_notes, '')), 500), ''));
  update cash_sessions set status = 'CLOSED' where id = p_session_id;
  perform _audit(v_uid, 'CASH_CLOSED', 'CashSession', p_session_id::text,
                 jsonb_build_object('expected', _m(v_expected), 'counted', _m(v_counted), 'difference', _m(v_counted - v_expected)));
  return _session_json(p_session_id) -> 'closing';
end $$;

create or replace function public.cash_session_detail(p_session_id int)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _require('cash.history', 'cash.operate');
  if not exists (select 1 from cash_sessions where id = p_session_id) then perform _err(404, 'Sesión de caja no encontrada'); end if;
  return jsonb_build_object(
    'session', _session_json(p_session_id),
    'summary', _session_summary(p_session_id),
    'movements', coalesce((
      select jsonb_agg(jsonb_build_object('id', mv.id, 'type', mv.type, 'amount', mv.amount, 'description', mv.description,
        'createdAt', mv.created_at, 'user', _user_json(mv.user_id), 'authorizedBy', _user_json(mv.authorized_by_id),
        'paymentMethod', (select jsonb_build_object('id', m.id, 'code', m.code, 'name', m.name, 'kind', m.kind) from payment_methods m where m.id = mv.payment_method_id))
        order by mv.created_at desc, mv.id desc)
      from cash_movements mv where mv.session_id = p_session_id), '[]'::jsonb));
end $$;

create or replace function public.cash_sessions_list(p_page int default 1, p_page_size int default 20)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _require('cash.history');
  p_page_size := least(greatest(coalesce(p_page_size, 20), 1), 100);
  p_page := greatest(coalesce(p_page, 1), 1);
  return jsonb_build_object(
    'total', (select count(*) from cash_sessions), 'page', p_page, 'pageSize', p_page_size,
    'rows', coalesce((select jsonb_agg(_session_json(x.id) order by x.opened_at desc)
                      from (select id, opened_at from cash_sessions order by opened_at desc offset (p_page - 1) * p_page_size limit p_page_size) x), '[]'::jsonb));
end $$;
