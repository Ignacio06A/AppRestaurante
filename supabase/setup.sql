-- =============================================================
--  Comanda — instalación completa en Supabase (archivo generado)
--  Pegue TODO este archivo en Supabase → SQL Editor y ejecútelo una vez
--  en un proyecto nuevo. Regenerar con: npm run setup-sql
-- =============================================================

-- >>> migrations/20261126000001_schema.sql
-- =============================================================
--  Comanda — Sistema de gestión de restaurante (Supabase)
--  01. Esquema de datos
--  Montos: numeric(12,2). Fechas: timestamptz.
--  La información financiera nunca se borra: productos, usuarios
--  y mesas con historial se desactivan (active = false).
-- =============================================================

-- ---------------------------------------------------------------
--  Seguridad: roles, permisos y perfiles de usuario
-- ---------------------------------------------------------------
create table public.roles (
  id          serial primary key,
  code        varchar(30) not null unique,   -- ADMIN, WAITER, KITCHEN, BAR, CASHIER
  name        varchar(60) not null,
  description varchar(255)
);

create table public.permissions (
  id          serial primary key,
  code        varchar(60) not null unique,
  description varchar(255) not null,
  module      varchar(40) not null
);

create table public.role_permissions (
  role_id       int not null references public.roles(id) on delete cascade,
  permission_id int not null references public.permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

-- Un perfil por cada usuario de Supabase Auth
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete restrict,
  username      varchar(60) not null unique,
  name          varchar(120) not null,
  role_id       int not null references public.roles(id),
  active        boolean not null default true,
  last_login_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index on public.profiles(role_id);

-- ---------------------------------------------------------------
--  Menú
-- ---------------------------------------------------------------
create table public.preparation_areas (
  id   serial primary key,
  code varchar(20) not null unique,  -- KITCHEN | BAR
  name varchar(60) not null
);

create table public.categories (
  id              serial primary key,
  name            varchar(80) not null unique,
  description     varchar(255),
  sort_order      int not null default 0,
  active          boolean not null default true,
  default_area_id int references public.preparation_areas(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table public.products (
  id          serial primary key,
  name        varchar(120) not null,
  description varchar(500),
  price       numeric(12,2) not null check (price >= 0),
  image_url   varchar(500),
  category_id int not null references public.categories(id),
  area_id     int not null references public.preparation_areas(id),
  active      boolean not null default true,   -- desactivado: no se muestra, se conserva histórico
  available   boolean not null default true,   -- false = agotado
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index on public.products(category_id);
create index on public.products(area_id);
create index on public.products(active, available);

-- ---------------------------------------------------------------
--  Salón
-- ---------------------------------------------------------------
create table public.dining_tables (
  id         serial primary key,
  number     int not null unique check (number > 0),
  name       varchar(60) not null,
  zone       varchar(60),
  capacity   int not null default 4 check (capacity > 0),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------
--  Órdenes
-- ---------------------------------------------------------------
create type public.order_status as enum ('OPEN', 'BILL_REQUESTED', 'PAID', 'CANCELLED');
create type public.order_item_status as enum ('PENDING', 'IN_PREPARATION', 'READY', 'DELIVERED', 'CANCELLED');

create sequence public.order_number_seq;

create table public.orders (
  id                serial primary key,
  number            int not null unique default nextval('public.order_number_seq'),
  table_id          int not null references public.dining_tables(id),
  waiter_id         uuid not null references public.profiles(id),
  status            public.order_status not null default 'OPEN',
  guests            int not null default 1 check (guests > 0),
  notes             varchar(500),
  discount_type     varchar(10) check (discount_type in ('AMOUNT', 'PERCENT')),
  discount_value    numeric(12,2) not null default 0,
  discount_reason   varchar(255),
  -- Totales congelados al cerrar la cuenta (fuente de los reportes)
  subtotal          numeric(12,2) not null default 0,
  discount_amount   numeric(12,2) not null default 0,
  service_amount    numeric(12,2) not null default 0,
  tax_amount        numeric(12,2) not null default 0,
  total             numeric(12,2) not null default 0,
  opened_at         timestamptz not null default now(),
  bill_requested_at timestamptz,
  closed_at         timestamptz,
  closed_by_id      uuid references public.profiles(id),
  cancel_reason     varchar(255),
  version           int not null default 0
);
create index on public.orders(table_id, status);
create index on public.orders(waiter_id);
create index on public.orders(status, closed_at);
create index on public.orders(opened_at);
-- Regla 1: una mesa solo puede tener UNA orden abierta
create unique index orders_one_open_per_table on public.orders(table_id) where status in ('OPEN', 'BILL_REQUESTED');

-- Cada envío del mesero es una comanda nueva
create table public.order_batches (
  id            serial primary key,
  order_id      int not null references public.orders(id),
  sequence      int not null,
  created_by_id uuid not null references public.profiles(id),
  created_at    timestamptz not null default now(),
  unique (order_id, sequence)
);

create table public.order_items (
  id              serial primary key,
  order_id        int not null references public.orders(id),
  batch_id        int not null references public.order_batches(id),
  product_id      int not null references public.products(id),
  area_id         int not null references public.preparation_areas(id),
  -- snapshot del momento de la venta
  product_name    varchar(120) not null,
  unit_price      numeric(12,2) not null check (unit_price >= 0),
  quantity        int not null check (quantity > 0),
  notes           varchar(300),
  status          public.order_item_status not null default 'PENDING',
  parent_item_id  int references public.order_items(id),  -- cancelación parcial de otra línea
  modified_at     timestamptz,
  created_by_id   uuid not null references public.profiles(id),
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  ready_at        timestamptz,
  delivered_at    timestamptz,
  cancelled_at    timestamptz,
  cancelled_by_id uuid references public.profiles(id),
  cancel_reason   varchar(255)
);
create index on public.order_items(order_id);
create index on public.order_items(area_id, status);
create index on public.order_items(batch_id);
create index on public.order_items(product_id);

create table public.order_history (
  id            serial primary key,
  order_id      int not null references public.orders(id),
  order_item_id int references public.order_items(id),
  user_id       uuid not null references public.profiles(id),
  action        varchar(40) not null,
  description   varchar(500) not null,
  details       jsonb,
  created_at    timestamptz not null default now()
);
create index on public.order_history(order_id, created_at);

-- ---------------------------------------------------------------
--  Pagos
-- ---------------------------------------------------------------
create type public.payment_method_kind as enum ('CASH', 'CARD', 'TRANSFER', 'OTHER');
create type public.payment_status as enum ('COMPLETED', 'VOIDED');

create table public.payment_methods (
  id         serial primary key,
  code       varchar(30) not null unique,
  name       varchar(60) not null,
  kind       public.payment_method_kind not null,
  active     boolean not null default true,
  sort_order int not null default 0
);

create table public.cash_registers (
  id     serial primary key,
  name   varchar(60) not null unique,
  active boolean not null default true
);

create type public.cash_session_status as enum ('OPEN', 'CLOSED');

-- Apertura de caja
create table public.cash_sessions (
  id             serial primary key,
  register_id    int not null references public.cash_registers(id),
  opened_by_id   uuid not null references public.profiles(id),
  opened_at      timestamptz not null default now(),
  opening_amount numeric(12,2) not null check (opening_amount >= 0),
  opening_notes  varchar(500),
  status         public.cash_session_status not null default 'OPEN'
);
create index on public.cash_sessions(register_id, status);
create unique index cash_sessions_one_open_per_register on public.cash_sessions(register_id) where status = 'OPEN';

create table public.payments (
  id                serial primary key,
  order_id          int not null references public.orders(id),
  payment_method_id int not null references public.payment_methods(id),
  cash_session_id   int not null references public.cash_sessions(id),
  amount            numeric(12,2) not null check (amount > 0),
  received_amount   numeric(12,2),
  change_amount     numeric(12,2) not null default 0,
  reference         varchar(120),
  payer_label       varchar(60),
  split_mode        varchar(20) not null default 'FULL',
  status            public.payment_status not null default 'COMPLETED',
  idempotency_key   varchar(80) not null unique,   -- evita pagos/ventas duplicadas
  user_id           uuid not null references public.profiles(id),
  created_at        timestamptz not null default now()
);
create index on public.payments(order_id);
create index on public.payments(cash_session_id);
create index on public.payments(created_at);

create table public.payment_items (
  id            serial primary key,
  payment_id    int not null references public.payments(id),
  order_item_id int not null references public.order_items(id),
  quantity      int not null check (quantity > 0),
  amount        numeric(12,2) not null
);
create index on public.payment_items(order_item_id);

-- Cierre de caja (arqueo congelado)
create table public.cash_closings (
  id                 serial primary key,
  session_id         int not null unique references public.cash_sessions(id),
  closed_by_id       uuid not null references public.profiles(id),
  closed_at          timestamptz not null default now(),
  opening_amount     numeric(12,2) not null,
  total_sales        numeric(12,2) not null,
  cash_sales         numeric(12,2) not null,
  card_sales         numeric(12,2) not null,
  transfer_sales     numeric(12,2) not null,
  other_sales        numeric(12,2) not null,
  total_income       numeric(12,2) not null,
  total_withdrawals  numeric(12,2) not null,
  total_expenses     numeric(12,2) not null,
  total_adjustments  numeric(12,2) not null,
  expected_cash      numeric(12,2) not null,
  counted_cash       numeric(12,2) not null,
  difference         numeric(12,2) not null,
  notes              varchar(500)
);

create type public.cash_movement_type as enum ('SALE', 'INCOME', 'WITHDRAWAL', 'EXPENSE', 'ADJUSTMENT');

create table public.cash_movements (
  id                serial primary key,
  session_id        int not null references public.cash_sessions(id),
  type              public.cash_movement_type not null,
  amount            numeric(12,2) not null,   -- positivo entra, negativo sale
  payment_method_id int references public.payment_methods(id),
  payment_id        int unique references public.payments(id),
  description       varchar(255) not null,
  user_id           uuid not null references public.profiles(id),
  authorized_by_id  uuid references public.profiles(id),
  created_at        timestamptz not null default now()
);
create index on public.cash_movements(session_id, type);
create index on public.cash_movements(created_at);

-- ---------------------------------------------------------------
--  Notificaciones, auditoría y configuración
-- ---------------------------------------------------------------
create table public.notifications (
  id         serial primary key,
  user_id    uuid not null references public.profiles(id),
  type       varchar(40) not null,
  title      varchar(120) not null,
  message    varchar(500) not null,
  data       jsonb,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index on public.notifications(user_id, read_at);

create table public.audit_logs (
  id         serial primary key,
  user_id    uuid references public.profiles(id),
  action     varchar(60) not null,
  entity     varchar(40) not null,
  entity_id  varchar(40),
  details    jsonb,
  created_at timestamptz not null default now()
);
create index on public.audit_logs(created_at);
create index on public.audit_logs(user_id);
create index on public.audit_logs(entity, entity_id);

create table public.restaurant_settings (
  id                   int primary key default 1 check (id = 1),
  name                 varchar(120) not null,
  legal_name           varchar(160),
  legal_id             varchar(40),
  address              varchar(255),
  phone                varchar(40),
  email                varchar(120),
  logo_url             varchar(500),
  currency_code        varchar(3) not null default 'CRC',
  currency_symbol      varchar(4) not null default '₡',
  tax_rate             numeric(5,2) not null default 13 check (tax_rate between 0 and 100),
  service_rate         numeric(5,2) not null default 10 check (service_rate between 0 and 100),
  prices_include_tax   boolean not null default false,
  timezone             varchar(60) not null default 'America/Costa_Rica',
  receipt_footer       varchar(300),
  kds_warning_minutes  int not null default 10 check (kds_warning_minutes > 0),
  kds_critical_minutes int not null default 20 check (kds_critical_minutes > 0),
  updated_at           timestamptz not null default now()
);


-- >>> migrations/20261126000002_security.sql
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


-- >>> migrations/20261126000003_orders.sql
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


-- >>> migrations/20261126000004_payments_cash.sql
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


-- >>> migrations/20261126000005_reports_admin.sql
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


-- >>> migrations/20261126000006_realtime_storage.sql
-- =============================================================
--  06. Tiempo real (Supabase Realtime) y almacenamiento de imágenes
--  Se aplica solo si existen los componentes de Supabase.
-- =============================================================

-- Las pantallas se suscriben a cambios de estas tablas. Realtime respeta RLS:
-- cada usuario solo recibe los cambios de las filas que puede leer.
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['orders','order_items','payments','cash_sessions','cash_movements','notifications',
                             'products','categories','dining_tables','restaurant_settings'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- Bucket público para imágenes de productos y logo. Solo pueden subir quienes
-- administran el menú o la configuración.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('images', 'images', true, 3145728, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
    on conflict (id) do nothing;

    execute $p$create policy "images_read" on storage.objects for select to anon, authenticated using (bucket_id = 'images')$p$;
    execute $p$create policy "images_insert" on storage.objects for insert to authenticated
      with check (bucket_id = 'images' and public.has_any_perm(array['menu.manage','settings.manage']))$p$;
    execute $p$create policy "images_delete" on storage.objects for delete to authenticated
      using (bucket_id = 'images' and public.has_any_perm(array['menu.manage','settings.manage']))$p$;
  end if;
end $$;


-- >>> seed.sql
-- =============================================================
--  Datos iniciales: permisos, roles, áreas, menú, mesas, métodos de
--  pago, caja, configuración y usuarios de prueba.
--  Es idempotente: puede ejecutarse varias veces.
-- =============================================================

insert into public.permissions (code, module, description) values
  ('tables.view', 'Mesas', 'Ver el plano de mesas y su estado'),
  ('tables.manage', 'Mesas', 'Crear, editar y eliminar mesas'),
  ('orders.view', 'Pedidos', 'Consultar órdenes'),
  ('orders.create', 'Pedidos', 'Abrir mesas y enviar pedidos'),
  ('orders.edit', 'Pedidos', 'Modificar pedidos enviados (cantidades, notas, eliminar)'),
  ('orders.edit_any', 'Pedidos', 'Modificar pedidos de otros meseros'),
  ('orders.cancel', 'Pedidos', 'Anular órdenes completas'),
  ('orders.discount', 'Pedidos', 'Aplicar descuentos a una cuenta'),
  ('kds.kitchen', 'Cocina', 'Acceso a la pantalla de cocina (KDS)'),
  ('kds.bar', 'Bar', 'Acceso a la pantalla de bar'),
  ('payments.view', 'Caja', 'Consultar cuentas y pagos'),
  ('payments.create', 'Caja', 'Registrar pagos'),
  ('cash.operate', 'Caja', 'Abrir caja y registrar movimientos'),
  ('cash.close', 'Caja', 'Cerrar caja (arqueo)'),
  ('cash.adjust', 'Caja', 'Registrar ajustes autorizados de caja'),
  ('cash.history', 'Caja', 'Consultar historial de aperturas y cierres'),
  ('reports.view', 'Reportes', 'Ver reportes y estadísticas de ventas'),
  ('menu.manage', 'Administración', 'Gestionar productos, precios y categorías'),
  ('menu.availability', 'Administración', 'Marcar productos como agotados/disponibles'),
  ('users.manage', 'Administración', 'Gestionar usuarios, roles y permisos'),
  ('settings.manage', 'Administración', 'Configuración general del restaurante'),
  ('audit.view', 'Administración', 'Consultar bitácora de acciones')
on conflict (code) do update set module = excluded.module, description = excluded.description;

insert into public.roles (code, name) values
  ('ADMIN', 'Administrador'), ('WAITER', 'Mesero'), ('KITCHEN', 'Cocina'), ('BAR', 'Bar'), ('CASHIER', 'Cajero')
on conflict (code) do nothing;

-- Permisos por defecto (solo si el rol aún no tiene ninguno)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on
     r.code = 'ADMIN'
  or (r.code = 'WAITER'  and p.code in ('tables.view', 'orders.view', 'orders.create', 'orders.edit'))
  or (r.code = 'KITCHEN' and p.code in ('kds.kitchen', 'menu.availability'))
  or (r.code = 'BAR'     and p.code in ('kds.bar', 'menu.availability'))
  or (r.code = 'CASHIER' and p.code in ('tables.view', 'orders.view', 'payments.view', 'payments.create', 'cash.operate', 'cash.close', 'cash.history'))
where not exists (select 1 from public.role_permissions x where x.role_id = r.id)
on conflict do nothing;

insert into public.preparation_areas (code, name) values ('KITCHEN', 'Cocina'), ('BAR', 'Bar') on conflict (code) do nothing;

-- Menú
with cats(name, area, ord) as (values
  ('Entradas', 'KITCHEN', 1), ('Platos fuertes', 'KITCHEN', 2), ('Acompañamientos', 'KITCHEN', 3), ('Postres', 'KITCHEN', 4),
  ('Bebidas frías', 'BAR', 5), ('Bebidas calientes', 'BAR', 6), ('Cócteles', 'BAR', 7), ('Otros', 'KITCHEN', 8))
insert into public.categories (name, sort_order, default_area_id)
select c.name, c.ord, a.id from cats c join public.preparation_areas a on a.code = c.area
on conflict (name) do nothing;

with prods(cat, name, description, price, ord) as (values
  ('Entradas', 'Patacones con frijolitos', 'Plátano verde frito, frijol molido y pico de gallo', 3800, 1),
  ('Entradas', 'Ceviche de pescado', 'Corvina marinada en limón, culantro y chile dulce', 5200, 2),
  ('Entradas', 'Chifrijo', 'Arroz, frijoles, chicharrón, pico de gallo y aguacate', 4900, 3),
  ('Entradas', 'Nachos de la casa', 'Totopos con queso, frijol, carne y guacamole', 5600, 4),
  ('Platos fuertes', 'Casado con pollo', 'Arroz, frijoles, ensalada, plátano maduro y pollo a la plancha', 5900, 1),
  ('Platos fuertes', 'Casado con bistec', 'Arroz, frijoles, ensalada, plátano maduro y bistec encebollado', 6500, 2),
  ('Platos fuertes', 'Arroz con pollo', 'Arroz con pollo tradicional, papas tostadas y ensalada', 5400, 3),
  ('Platos fuertes', 'Hamburguesa clásica', 'Carne 180 g, queso cheddar, lechuga, tomate y salsa de la casa', 6200, 4),
  ('Platos fuertes', 'Filete de pescado al ajillo', 'Filete de corvina en mantequilla de ajo, arroz y vegetales', 8900, 5),
  ('Platos fuertes', 'Lomito a la parrilla', 'Lomito 250 g, chimichurri, papas y ensalada', 12500, 6),
  ('Acompañamientos', 'Orden de papas fritas', 'Papas fritas crujientes', 2200, 1),
  ('Acompañamientos', 'Yuca frita', 'Yuca frita con chimichurri', 2400, 2),
  ('Acompañamientos', 'Ensalada verde', 'Lechuga, tomate, pepino y vinagreta', 2500, 3),
  ('Acompañamientos', 'Gallo pinto', 'Arroz y frijoles salteados con natilla', 2300, 4),
  ('Postres', 'Tres leches', 'Queque bañado en tres leches con canela', 3200, 1),
  ('Postres', 'Flan de coco', 'Flan casero con coco rallado', 2900, 2),
  ('Postres', 'Brownie con helado', 'Brownie tibio con helado de vainilla', 3600, 3),
  ('Bebidas frías', 'Refresco natural', 'Cas, mora, fresa, piña o maracuyá', 1800, 1),
  ('Bebidas frías', 'Limonada con hierbabuena', 'Limonada frapé con hierbabuena', 2200, 2),
  ('Bebidas frías', 'Coca-Cola', 'Lata 355 ml', 1500, 3),
  ('Bebidas frías', 'Agua mineral', 'Botella 500 ml', 1300, 4),
  ('Bebidas frías', 'Cerveza nacional', 'Botella 350 ml', 2000, 5),
  ('Bebidas calientes', 'Café chorreado', 'Café costarricense de altura', 1500, 1),
  ('Bebidas calientes', 'Cappuccino', 'Espresso con leche espumada', 2300, 2),
  ('Bebidas calientes', 'Chocolate caliente', 'Chocolate con leche', 2100, 3),
  ('Cócteles', 'Guaro sour', 'Guaro, limón y azúcar', 3500, 1),
  ('Cócteles', 'Mojito', 'Ron, hierbabuena, limón y soda', 4200, 2),
  ('Cócteles', 'Piña colada', 'Ron, crema de coco y piña', 4500, 3),
  ('Cócteles', 'Margarita', 'Tequila, triple sec y limón', 4500, 4),
  ('Otros', 'Porción de pan', 'Pan artesanal con mantequilla', 1200, 1))
insert into public.products (name, description, price, category_id, area_id, sort_order)
select p.name, p.description, p.price, c.id, c.default_area_id, p.ord
from prods p join public.categories c on c.name = p.cat
where not exists (select 1 from public.products x where x.name = p.name and x.category_id = c.id);

insert into public.dining_tables (number, name, zone, capacity)
select n,
       case when n > 10 then 'Barra ' || (n - 10) else 'Mesa ' || n end,
       case when n <= 6 then 'Salón' when n <= 10 then 'Terraza' else 'Barra' end,
       case when n > 10 then 2 when n % 3 = 0 then 6 else 4 end
from generate_series(1, 12) n
on conflict (number) do nothing;

insert into public.payment_methods (code, name, kind, sort_order) values
  ('CASH', 'Efectivo', 'CASH', 1), ('CARD', 'Tarjeta', 'CARD', 2), ('SINPE', 'SINPE Móvil', 'TRANSFER', 3),
  ('TRANSFER', 'Transferencia bancaria', 'TRANSFER', 4), ('VOUCHER', 'Vale / Cupón', 'OTHER', 5)
on conflict (code) do nothing;

insert into public.cash_registers (name) values ('Caja Principal') on conflict (name) do nothing;

insert into public.restaurant_settings (id, name, legal_name, legal_id, address, phone, receipt_footer)
values (1, 'Restaurante La Esquina Tica', 'La Esquina Tica S.A.', '3-101-000000', 'San José, Costa Rica', '+506 2222-0000', '¡Gracias por su visita! Pura vida.')
on conflict (id) do nothing;

-- Usuarios de prueba (cambie sus contraseñas antes de usar el sistema en producción)
do $$
declare
  u record; v_id uuid;
begin
  for u in select * from (values
    ('admin', 'Administrador General', 'Admin123', 'ADMIN'),
    ('mesero', 'Carlos Mora', 'Mesero123', 'WAITER'),
    ('mesera2', 'Ana Jiménez', 'Mesero123', 'WAITER'),
    ('cocina', 'Luis Vargas', 'Cocina123', 'KITCHEN'),
    ('bar', 'Sofía Rojas', 'Bar12345', 'BAR'),
    ('cajero', 'María Solís', 'Cajero123', 'CASHIER')) as t(username, name, password, role)
  loop
    if not exists (select 1 from public.profiles where username = u.username) then
      v_id := public._create_auth_user(u.username, u.password);
      insert into public.profiles (id, username, name, role_id) select v_id, u.username, u.name, id from public.roles where code = u.role;
    end if;
  end loop;
end $$;
