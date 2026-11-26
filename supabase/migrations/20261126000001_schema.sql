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
