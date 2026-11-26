-- =============================================================
--  02. Seguridad: funciones auxiliares, RLS y privilegios
--
--  Principio: el navegador solo puede LEER lo que su rol permite
--  (políticas RLS). Toda operación de negocio (pedidos, cocina,
--  pagos, caja) se ejecuta mediante funciones SECURITY DEFINER que
--  validan permisos y reglas en la base de datos. Solo los catálogos
--  administrativos (menú, mesas, métodos de pago, configuración)
--  se editan directamente, protegidos por RLS y auditados por trigger.
-- =============================================================

-- ---------------------------------------------------------------
--  Errores con código HTTP: PostgREST traduce SQLSTATE "PTxyz" → HTTP xyz
-- ---------------------------------------------------------------
create or replace function public._err(p_status int, p_message text)
returns void language plpgsql as $$
begin
  raise exception using message = p_message, errcode = 'PT' || p_status::text;
end $$;

-- ¿El usuario actual tiene un perfil activo?
create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active)
$$;

create or replace function public.has_perm(p_code text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from profiles pr
    join role_permissions rp on rp.role_id = pr.role_id
    join permissions pe on pe.id = rp.permission_id
    where pr.id = auth.uid() and pr.active and pe.code = p_code
  )
$$;

create or replace function public.has_any_perm(p_codes text[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from profiles pr
    join role_permissions rp on rp.role_id = pr.role_id
    join permissions pe on pe.id = rp.permission_id
    where pr.id = auth.uid() and pr.active and pe.code = any (p_codes)
  )
$$;

-- Devuelve el id del usuario si está activo y tiene alguno de los permisos; si no, error 401/403.
create or replace function public._require(variadic p_codes text[])
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or not exists (select 1 from profiles where id = v_uid and active) then
    perform _err(401, 'Sesión inválida o usuario desactivado');
  end if;
  if array_length(p_codes, 1) is not null and not has_any_perm(p_codes) then
    perform _err(403, 'No tiene permisos para realizar esta acción');
  end if;
  return v_uid;
end $$;

create or replace function public._audit(p_user uuid, p_action text, p_entity text, p_entity_id text, p_details jsonb default null)
returns void language sql security definer set search_path = public as $$
  insert into audit_logs (user_id, action, entity, entity_id, details) values (p_user, p_action, p_entity, p_entity_id, p_details);
$$;

-- ---------------------------------------------------------------
--  Triggers genéricos
-- ---------------------------------------------------------------
create or replace function public._touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger trg_touch before update on public.profiles for each row execute function public._touch_updated_at();
create trigger trg_touch before update on public.categories for each row execute function public._touch_updated_at();
create trigger trg_touch before update on public.products for each row execute function public._touch_updated_at();
create trigger trg_touch before update on public.dining_tables for each row execute function public._touch_updated_at();
create trigger trg_touch before update on public.restaurant_settings for each row execute function public._touch_updated_at();

-- Auditoría automática de catálogos editados directamente
create or replace function public._audit_catalog()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_action text;
  v_details jsonb;
  v_id text;
begin
  if tg_op = 'INSERT' then
    v_action := upper(tg_argv[0]) || '_CREATED';
    v_details := to_jsonb(new);
    v_id := (to_jsonb(new) ->> 'id');
  elsif tg_op = 'UPDATE' then
    v_action := upper(tg_argv[0]) || '_UPDATED';
    select jsonb_object_agg(n.key, jsonb_build_object('from', o.value, 'to', n.value))
      into v_details
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o on o.key = n.key
     where n.value is distinct from o.value and n.key <> 'updated_at';
    if v_details is null then return new; end if;
    if tg_table_name = 'products' and v_details ? 'price' then v_action := 'PRODUCT_PRICE_CHANGED'; end if;
    v_id := (to_jsonb(new) ->> 'id');
  else
    v_action := upper(tg_argv[0]) || '_DELETED';
    v_details := to_jsonb(old);
    v_id := (to_jsonb(old) ->> 'id');
  end if;
  perform _audit(auth.uid(), v_action, tg_argv[0], v_id, v_details);
  return coalesce(new, old);
end $$;

create trigger trg_audit after insert or update or delete on public.categories for each row execute function public._audit_catalog('Category');
create trigger trg_audit after insert or update or delete on public.products for each row execute function public._audit_catalog('Product');
create trigger trg_audit after insert or update or delete on public.dining_tables for each row execute function public._audit_catalog('DiningTable');
create trigger trg_audit after insert or update or delete on public.payment_methods for each row execute function public._audit_catalog('PaymentMethod');
create trigger trg_audit after insert or update or delete on public.cash_registers for each row execute function public._audit_catalog('CashRegister');
create trigger trg_audit after update on public.restaurant_settings for each row execute function public._audit_catalog('RestaurantSettings');

-- No desactivar una mesa con cuenta abierta
create or replace function public._guard_table_deactivate()
returns trigger language plpgsql as $$
begin
  if new.active = false and old.active = true and exists (
    select 1 from public.orders where table_id = new.id and status in ('OPEN', 'BILL_REQUESTED')
  ) then
    perform public._err(409, 'No se puede desactivar una mesa con una orden abierta');
  end if;
  return new;
end $$;
create trigger trg_guard before update on public.dining_tables for each row execute function public._guard_table_deactivate();

-- ---------------------------------------------------------------
--  Row Level Security
-- ---------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'roles','permissions','role_permissions','profiles','preparation_areas','categories','products','dining_tables',
    'orders','order_batches','order_items','order_history','payment_methods','cash_registers','cash_sessions',
    'payments','payment_items','cash_closings','cash_movements','notifications','audit_logs','restaurant_settings'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- Lectura para todo el personal activo
do $$
declare t text;
begin
  foreach t in array array[
    'roles','permissions','role_permissions','profiles','preparation_areas','categories','products','dining_tables',
    'orders','order_batches','order_items','order_history','payment_methods','cash_registers'
  ] loop
    execute format('create policy staff_read on public.%I for select to authenticated using (public.is_staff())', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- Información financiera: solo caja, reportes y administración
create policy finance_read on public.payments for select to authenticated
  using (public.has_any_perm(array['payments.view','reports.view','cash.operate','cash.history']));
create policy finance_read on public.payment_items for select to authenticated
  using (public.has_any_perm(array['payments.view','reports.view','cash.operate','cash.history']));
create policy finance_read on public.cash_sessions for select to authenticated
  using (public.has_any_perm(array['payments.view','reports.view','cash.operate','cash.history']));
create policy finance_read on public.cash_closings for select to authenticated
  using (public.has_any_perm(array['reports.view','cash.operate','cash.history']));
create policy finance_read on public.cash_movements for select to authenticated
  using (public.has_any_perm(array['payments.view','reports.view','cash.operate','cash.history']));
grant select on public.payments, public.payment_items, public.cash_sessions, public.cash_closings, public.cash_movements to authenticated;

-- Notificaciones: cada usuario solo ve y marca como leídas las suyas
create policy own_read on public.notifications for select to authenticated using (user_id = auth.uid() and public.is_staff());
create policy own_update on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

-- Bitácora
create policy audit_read on public.audit_logs for select to authenticated using (public.has_perm('audit.view'));
grant select on public.audit_logs to authenticated;

-- Configuración: lectura pública (nombre y logo en la pantalla de inicio de sesión)
create policy public_read on public.restaurant_settings for select to anon, authenticated using (true);
create policy admin_write on public.restaurant_settings for update to authenticated using (public.has_perm('settings.manage')) with check (public.has_perm('settings.manage'));
grant select on public.restaurant_settings to anon, authenticated;
grant update (name, legal_name, legal_id, address, phone, email, logo_url, currency_code, currency_symbol, tax_rate, service_rate,
              prices_include_tax, receipt_footer, kds_warning_minutes, kds_critical_minutes) on public.restaurant_settings to authenticated;

-- Catálogos editables directamente por quien tenga el permiso
create policy menu_insert on public.categories for insert to authenticated with check (public.has_perm('menu.manage'));
create policy menu_update on public.categories for update to authenticated using (public.has_perm('menu.manage')) with check (public.has_perm('menu.manage'));
create policy menu_insert on public.products for insert to authenticated with check (public.has_perm('menu.manage'));
create policy menu_update on public.products for update to authenticated using (public.has_perm('menu.manage')) with check (public.has_perm('menu.manage'));
grant insert, update on public.categories, public.products to authenticated;

create policy tables_insert on public.dining_tables for insert to authenticated with check (public.has_perm('tables.manage'));
create policy tables_update on public.dining_tables for update to authenticated using (public.has_perm('tables.manage')) with check (public.has_perm('tables.manage'));
grant insert, update on public.dining_tables to authenticated;

create policy pm_insert on public.payment_methods for insert to authenticated with check (public.has_perm('settings.manage'));
create policy pm_update on public.payment_methods for update to authenticated using (public.has_perm('settings.manage')) with check (public.has_perm('settings.manage'));
grant insert, update on public.payment_methods to authenticated;
create policy reg_insert on public.cash_registers for insert to authenticated with check (public.has_perm('settings.manage'));
grant insert on public.cash_registers to authenticated;

grant usage on all sequences in schema public to authenticated;
