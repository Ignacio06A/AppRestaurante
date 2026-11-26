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
