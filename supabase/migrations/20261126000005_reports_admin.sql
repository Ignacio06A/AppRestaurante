-- =============================================================
--  05. Reportes, administración de usuarios/roles y bitácora
-- =============================================================

-- ---------------------------------------------------------------
--  Reportes: SOLO órdenes PAID (cuenta pagada y cerrada) con sus
--  totales congelados. Fechas en hora de Costa Rica.
-- ---------------------------------------------------------------
create or replace function public._sales_totals(p_from date, p_to date)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'orders', count(*), 'total', coalesce(sum(total), 0), 'subtotal', coalesce(sum(subtotal), 0),
    'discount', coalesce(sum(discount_amount), 0), 'service', coalesce(sum(service_amount), 0),
    'tax', coalesce(sum(tax_amount), 0), 'guests', coalesce(sum(guests), 0))
  from orders
  where status = 'PAID'
    and closed_at >= (p_from::timestamp at time zone 'America/Costa_Rica')
    and closed_at < ((p_to + 1)::timestamp at time zone 'America/Costa_Rica')
$$;

create or replace function public.report_sales(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  tz constant text := 'America/Costa_Rica';
  v_start timestamptz; v_end timestamptz; v_days int; v_prev_from date; v_prev_to date;
  cur jsonb; prev jsonb; v_items int; v_cancelled int; v_total numeric; v_orders int; v_guests int;
begin
  perform _require('reports.view');
  if p_from is null or p_to is null then perform _err(400, 'Indique el rango de fechas'); end if;
  if p_from > p_to then perform _err(400, 'La fecha inicial no puede ser mayor a la final'); end if;
  if p_to - p_from > 366 then perform _err(400, 'El rango máximo es de 366 días'); end if;
  v_start := p_from::timestamp at time zone tz;
  v_end := (p_to + 1)::timestamp at time zone tz;
  v_days := p_to - p_from + 1;
  v_prev_to := p_from - 1;
  v_prev_from := v_prev_to - (v_days - 1);
  cur := _sales_totals(p_from, p_to);
  prev := _sales_totals(v_prev_from, v_prev_to);
  v_total := (cur ->> 'total')::numeric; v_orders := (cur ->> 'orders')::int; v_guests := (cur ->> 'guests')::int;

  select coalesce(sum(i.quantity), 0) into v_items
    from order_items i join orders o on o.id = i.order_id
    where o.status = 'PAID' and i.status <> 'CANCELLED' and o.closed_at >= v_start and o.closed_at < v_end;
  select count(*) into v_cancelled from orders where status = 'CANCELLED' and closed_at >= v_start and closed_at < v_end;

  return jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to, 'days', v_days),
    'previousRange', jsonb_build_object('from', v_prev_from, 'to', v_prev_to),
    'kpis', jsonb_build_object(
      'totalSales', v_total,
      'netSales', (cur ->> 'subtotal')::numeric - (cur ->> 'discount')::numeric,
      'orders', v_orders, 'guests', v_guests, 'itemsSold', v_items,
      'avgTicket', case when v_orders > 0 then round(v_total / v_orders, 2) else 0 end,
      'avgPerGuest', case when v_guests > 0 then round(v_total / v_guests, 2) else 0 end,
      'avgDailySales', round(v_total / v_days, 2),
      'discounts', (cur ->> 'discount')::numeric, 'service', (cur ->> 'service')::numeric, 'tax', (cur ->> 'tax')::numeric,
      'cancelledOrders', v_cancelled,
      'previousTotalSales', (prev ->> 'total')::numeric, 'previousOrders', (prev ->> 'orders')::int,
      'salesChangePct', case when (prev ->> 'total')::numeric = 0 then (case when v_total = 0 then 0 end)
                             else round((v_total - (prev ->> 'total')::numeric) / (prev ->> 'total')::numeric * 100, 2) end,
      'ordersChangePct', case when (prev ->> 'orders')::int = 0 then (case when v_orders = 0 then 0 end)
                              else round((v_orders - (prev ->> 'orders')::int)::numeric / (prev ->> 'orders')::int * 100, 2) end),
    'byDay', (
      select jsonb_agg(jsonb_build_object('day', to_char(d, 'YYYY-MM-DD'), 'orders', coalesce(x.orders, 0), 'total', coalesce(x.total, 0)) order by d)
      from generate_series(p_from, p_to, interval '1 day') d
      left join (select (closed_at at time zone tz)::date dd, count(*) orders, sum(total) total
                 from orders where status = 'PAID' and closed_at >= v_start and closed_at < v_end group by 1) x on x.dd = d::date),
    'byHour', (
      select jsonb_agg(jsonb_build_object('hour', h, 'orders', coalesce(x.orders, 0), 'total', coalesce(x.total, 0)) order by h)
      from generate_series(0, 23) h
      left join (select extract(hour from opened_at at time zone tz)::int hh, count(*) orders, sum(total) total
                 from orders where status = 'PAID' and closed_at >= v_start and closed_at < v_end group by 1) x on x.hh = h),
    'byPaymentMethod', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'kind', kind, 'count', cnt, 'total', total) order by total desc)
      from (select m.name, m.kind, count(p.id) cnt, sum(p.amount) total
            from payments p join orders o on o.id = p.order_id join payment_methods m on m.id = p.payment_method_id
            where p.status = 'COMPLETED' and o.status = 'PAID' and o.closed_at >= v_start and o.closed_at < v_end
            group by m.id, m.name, m.kind) x), '[]'::jsonb),
    'byWaiter', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'orders', orders, 'total', total, 'guests', guests, 'avgTicket', round(avg_ticket, 2)) order by total desc)
      from (select pr.id, pr.name, count(o.id) orders, sum(o.total) total, sum(o.guests) guests, avg(o.total) avg_ticket
            from orders o join profiles pr on pr.id = o.waiter_id
            where o.status = 'PAID' and o.closed_at >= v_start and o.closed_at < v_end
            group by pr.id, pr.name) x), '[]'::jsonb),
    'topProducts', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'category', category, 'quantity', quantity, 'revenue', revenue) order by quantity desc, revenue desc)
      from (select i.product_id id, i.product_name name, c.name category, sum(i.quantity) quantity, sum(i.quantity * i.unit_price) revenue
            from order_items i join orders o on o.id = i.order_id join products p on p.id = i.product_id join categories c on c.id = p.category_id
            where o.status = 'PAID' and i.status <> 'CANCELLED' and o.closed_at >= v_start and o.closed_at < v_end
            group by i.product_id, i.product_name, c.name order by sum(i.quantity) desc, sum(i.quantity * i.unit_price) desc limit 15) x), '[]'::jsonb),
    'byCategory', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'quantity', quantity, 'revenue', revenue) order by revenue desc)
      from (select c.id, c.name, sum(i.quantity) quantity, sum(i.quantity * i.unit_price) revenue
            from order_items i join orders o on o.id = i.order_id join products p on p.id = i.product_id join categories c on c.id = p.category_id
            where o.status = 'PAID' and i.status <> 'CANCELLED' and o.closed_at >= v_start and o.closed_at < v_end
            group by c.id, c.name) x), '[]'::jsonb),
    'monthly', (
      select jsonb_agg(jsonb_build_object('month', to_char(mm, 'YYYY-MM'), 'orders', coalesce(x.orders, 0), 'total', coalesce(x.total, 0)) order by mm)
      from generate_series(date_trunc('month', p_to::timestamp) - interval '11 months', date_trunc('month', p_to::timestamp), interval '1 month') mm
      left join (select date_trunc('month', closed_at at time zone tz) m2, count(*) orders, sum(total) total
                 from orders where status = 'PAID'
                   and closed_at >= ((date_trunc('month', p_to::timestamp) - interval '11 months') at time zone tz) and closed_at < v_end
                 group by 1) x on x.m2 = mm));
end $$;

create or replace function public.report_dashboard()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  tz constant text := 'America/Costa_Rica';
  v_today date := (now() at time zone tz)::date;
  t jsonb; y jsonb;
begin
  perform _require('reports.view');
  t := _sales_totals(v_today, v_today);
  y := _sales_totals(v_today - 1, v_today - 1);
  return jsonb_build_object(
    'today', t || jsonb_build_object('avgTicket', case when (t ->> 'orders')::int > 0 then round((t ->> 'total')::numeric / (t ->> 'orders')::int, 2) else 0 end),
    'yesterday', y,
    'week', (
      select jsonb_agg(jsonb_build_object('day', to_char(d, 'YYYY-MM-DD'), 'total', coalesce(x.total, 0), 'orders', coalesce(x.orders, 0)) order by d)
      from generate_series(v_today - 6, v_today, interval '1 day') d
      left join (select (closed_at at time zone tz)::date dd, sum(total) total, count(*) orders
                 from orders where status = 'PAID' and closed_at >= ((v_today - 6)::timestamp at time zone tz) group by 1) x on x.dd = d::date),
    'tables', jsonb_build_object(
      'total', (select count(*) from dining_tables where active),
      'occupied', (select count(*) from orders where status in ('OPEN', 'BILL_REQUESTED')),
      'billRequested', (select count(*) from orders where status = 'BILL_REQUESTED')),
    'kds', (select jsonb_object_agg(a.code, jsonb_build_object(
              'PENDING', (select count(*) from order_items i where i.area_id = a.id and i.status = 'PENDING'),
              'IN_PREPARATION', (select count(*) from order_items i where i.area_id = a.id and i.status = 'IN_PREPARATION'),
              'READY', (select count(*) from order_items i where i.area_id = a.id and i.status = 'READY')))
            from preparation_areas a),
    'cash', (select jsonb_build_object('id', s.id, 'register', r.name, 'openedBy', pr.name, 'openedAt', s.opened_at)
             from cash_sessions s join cash_registers r on r.id = s.register_id join profiles pr on pr.id = s.opened_by_id
             where s.status = 'OPEN' order by s.opened_at limit 1),
    'recentSales', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'number', number, 'table', tname, 'waiter', wname, 'total', total, 'closedAt', closed_at) order by closed_at desc)
      from (select o.id, o.number, t2.name tname, pr.name wname, o.total, o.closed_at
            from orders o join dining_tables t2 on t2.id = o.table_id join profiles pr on pr.id = o.waiter_id
            where o.status = 'PAID' order by o.closed_at desc limit 8) x), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------
--  Usuarios (Supabase Auth). El login es por "usuario"; internamente
--  se usa el correo sintético <usuario>@comanda.local.
-- ---------------------------------------------------------------
create or replace function public._forbidden_for_role(p_code text)
returns text[] language sql immutable as $$
  -- Regla 17: cocina y bar no pueden modificar precios ni registrar pagos
  select case when p_code in ('KITCHEN', 'BAR')
    then array['menu.manage', 'payments.create', 'cash.operate', 'cash.close', 'cash.adjust', 'orders.discount']
    else array[]::text[] end
$$;

create or replace function public._create_auth_user(p_username text, p_password text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid := gen_random_uuid(); v_email text := lower(p_username) || '@comanda.local';
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
          extensions.crypt(p_password, extensions.gen_salt('bf', 10)), now(),
          '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('username', lower(p_username)), now(), now(),
          '', '', '', '');
  insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id::text, v_id,
          jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true), 'email', now(), now(), now());
  return v_id;
end $$;

create or replace function public._user_row_json(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', pr.id, 'name', pr.name, 'username', pr.username, 'active', pr.active,
    'lastLoginAt', pr.last_login_at, 'createdAt', pr.created_at, 'role', jsonb_build_object('id', r.id, 'code', r.code, 'name', r.name))
  from profiles pr join roles r on r.id = pr.role_id where pr.id = p_id
$$;

create or replace function public.admin_list_users(p_search text default null, p_role_id int default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _require('users.manage', 'audit.view');
  return coalesce((
    select jsonb_agg(_user_row_json(pr.id) order by pr.active desc, pr.name)
    from profiles pr
    where (p_role_id is null or pr.role_id = p_role_id)
      and (p_search is null or p_search = '' or pr.name ilike '%' || p_search || '%' or pr.username ilike '%' || p_search || '%')), '[]'::jsonb);
end $$;

create or replace function public.admin_create_user(p_name text, p_username text, p_password text, p_role_id int, p_active boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _require('users.manage'); v_id uuid; v_username text := lower(btrim(coalesce(p_username, '')));
begin
  if length(btrim(coalesce(p_name, ''))) < 2 then perform _err(400, 'Nombre muy corto'); end if;
  if v_username !~ '^[a-z0-9._-]{3,60}$' then perform _err(400, 'Usuario: mínimo 3 caracteres; solo minúsculas, números, punto, guion y guion bajo'); end if;
  if length(coalesce(p_password, '')) < 8 then perform _err(400, 'La contraseña debe tener al menos 8 caracteres'); end if;
  if not exists (select 1 from roles where id = p_role_id) then perform _err(404, 'Rol no encontrado'); end if;
  if exists (select 1 from profiles where username = v_username) or exists (select 1 from auth.users where email = v_username || '@comanda.local') then
    perform _err(409, 'El nombre de usuario ya existe');
  end if;
  v_id := _create_auth_user(v_username, p_password);
  insert into profiles (id, username, name, role_id, active) values (v_id, v_username, left(btrim(p_name), 120), p_role_id, coalesce(p_active, true));
  if not coalesce(p_active, true) then update auth.users set banned_until = 'infinity' where id = v_id; end if;
  perform _audit(v_uid, 'USER_CREATED', 'User', v_id::text, jsonb_build_object('username', v_username, 'roleId', p_role_id));
  return _user_row_json(v_id);
end $$;

create or replace function public.admin_update_user(p_id uuid, p_name text default null, p_username text default null,
  p_password text default null, p_role_id int default null, p_active boolean default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid := _require('users.manage'); pr profiles; v_username text := lower(btrim(coalesce(p_username, '')));
begin
  select * into pr from profiles where id = p_id;
  if not found then perform _err(404, 'Usuario no encontrado'); end if;
  if p_id = v_uid and (p_active = false or (p_role_id is not null and p_role_id <> pr.role_id)) then
    perform _err(400, 'No puede desactivarse ni cambiar su propio rol');
  end if;
  if p_name is not null and length(btrim(p_name)) < 2 then perform _err(400, 'Nombre muy corto'); end if;
  if v_username <> '' and v_username <> pr.username then
    if v_username !~ '^[a-z0-9._-]{3,60}$' then perform _err(400, 'Usuario inválido'); end if;
    if exists (select 1 from profiles where username = v_username) then perform _err(409, 'El nombre de usuario ya existe'); end if;
    update auth.users set email = v_username || '@comanda.local', updated_at = now() where id = p_id;
    update auth.identities set identity_data = identity_data || jsonb_build_object('email', v_username || '@comanda.local') where user_id = p_id and provider = 'email';
  end if;
  if p_password is not null and p_password <> '' then
    if length(p_password) < 8 then perform _err(400, 'La contraseña debe tener al menos 8 caracteres'); end if;
    update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 10)), updated_at = now() where id = p_id;
  end if;
  if p_role_id is not null and not exists (select 1 from roles where id = p_role_id) then perform _err(404, 'Rol no encontrado'); end if;
  update profiles set
    name = coalesce(left(btrim(p_name), 120), name),
    username = case when v_username <> '' then v_username else username end,
    role_id = coalesce(p_role_id, role_id),
    active = coalesce(p_active, active)
  where id = p_id;
  if p_active is not null then
    update auth.users set banned_until = case when p_active then null else 'infinity'::timestamptz end where id = p_id;
  end if;
  perform _audit(v_uid, 'USER_UPDATED', 'User', p_id::text,
    jsonb_build_object('name', p_name, 'username', nullif(v_username, ''), 'roleId', p_role_id, 'active', p_active, 'passwordReset', coalesce(p_password, '') <> ''));
  return _user_row_json(p_id);
end $$;

-- Los usuarios nunca se eliminan (conservan su historial): solo se desactivan
create or replace function public.admin_deactivate_user(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _require('users.manage');
begin
  if p_id = v_uid then perform _err(400, 'No puede desactivar su propio usuario'); end if;
  update profiles set active = false where id = p_id;
  if not found then perform _err(404, 'Usuario no encontrado'); end if;
  update auth.users set banned_until = 'infinity' where id = p_id;
  perform _audit(v_uid, 'USER_DEACTIVATED', 'User', p_id::text, null);
end $$;

create or replace function public.admin_roles()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _require('users.manage');
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code, 'name', r.name, 'description', r.description,
      'userCount', (select count(*) from profiles p where p.role_id = r.id),
      'permissions', coalesce((select jsonb_agg(pe.code) from role_permissions rp join permissions pe on pe.id = rp.permission_id where rp.role_id = r.id), '[]'::jsonb),
      'forbidden', to_jsonb(_forbidden_for_role(r.code))) order by r.id)
    from roles r), '[]'::jsonb);
end $$;

create or replace function public.admin_set_role_permissions(p_role_id int, p_permissions text[])
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := _require('users.manage'); r roles; v_unknown text; v_blocked text[];
begin
  select * into r from roles where id = p_role_id;
  if not found then perform _err(404, 'Rol no encontrado'); end if;
  select string_agg(x, ', ') into v_unknown from unnest(p_permissions) x where not exists (select 1 from permissions where code = x);
  if v_unknown is not null then perform _err(400, 'Permisos desconocidos: ' || v_unknown); end if;
  select array_agg(x) into v_blocked from unnest(p_permissions) x where x = any (_forbidden_for_role(r.code));
  if v_blocked is not null then
    perform _err(400, format('El rol %s no puede tener estos permisos: %s', r.name, array_to_string(v_blocked, ', ')));
  end if;
  if r.code = 'ADMIN' and not ('users.manage' = any (p_permissions)) then
    perform _err(400, 'El rol Administrador debe conservar el permiso users.manage');
  end if;
  delete from role_permissions where role_id = r.id;
  insert into role_permissions (role_id, permission_id) select r.id, id from permissions where code = any (p_permissions);
  perform _audit(v_uid, 'ROLE_PERMISSIONS_UPDATED', 'Role', r.id::text, jsonb_build_object('permissions', to_jsonb(p_permissions)));
end $$;

create or replace function public.audit_list(p_user_id uuid default null, p_action text default null, p_from date default null, p_to date default null,
  p_page int default 1, p_page_size int default 50)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare tz constant text := 'America/Costa_Rica';
begin
  perform _require('audit.view');
  p_page_size := least(greatest(coalesce(p_page_size, 50), 1), 200);
  p_page := greatest(coalesce(p_page, 1), 1);
  return jsonb_build_object(
    'total', (select count(*) from audit_logs a
              where (p_user_id is null or a.user_id = p_user_id) and (p_action is null or p_action = '' or a.action ilike '%' || p_action || '%')
                and (p_from is null or a.created_at >= (p_from::timestamp at time zone tz)) and (p_to is null or a.created_at < ((p_to + 1)::timestamp at time zone tz))),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'action', a.action, 'entity', a.entity, 'entityId', a.entity_id, 'details', a.details,
        'createdAt', a.created_at, 'user', case when a.user_id is null then null else
          (select jsonb_build_object('id', pr.id, 'name', pr.name, 'username', pr.username) from profiles pr where pr.id = a.user_id) end)
        order by a.created_at desc, a.id desc)
      from (select * from audit_logs a
            where (p_user_id is null or a.user_id = p_user_id) and (p_action is null or p_action = '' or a.action ilike '%' || p_action || '%')
              and (p_from is null or a.created_at >= (p_from::timestamp at time zone tz)) and (p_to is null or a.created_at < ((p_to + 1)::timestamp at time zone tz))
            order by a.created_at desc, a.id desc offset (p_page - 1) * p_page_size limit p_page_size) a), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------
--  Privilegios de ejecución: solo usuarios autenticados, y nunca
--  las funciones internas (prefijo "_") directamente.
-- ---------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to authenticated;
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like '\_%' and p.proname <> '_err' loop
    execute format('revoke execute on function %s from authenticated', f.sig);
  end loop;
end $$;
