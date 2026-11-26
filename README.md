# Comanda — Sistema de gestión de restaurante

Aplicación web para operar un restaurante de punta a punta: el mesero toma la orden, **cocina y bar** la reciben al instante en sus pantallas (KDS), el mesero recibe una notificación cuando los productos están listos, **caja** cobra (pagos parciales, cuenta dividida, varios métodos de pago) y la venta queda registrada en el **control de caja** y en los **reportes**.

Moneda: colones costarricenses (CRC, ₡). IVA 13 % y servicio 10 %, configurables.

---

## 1. Arquitectura

| Pieza | Tecnología | Costo |
|---|---|---|
| Interfaz (todas las pantallas) | React 18 + TypeScript + Vite, Tailwind CSS, TanStack Query, Recharts | — |
| Base de datos | PostgreSQL de **Supabase** | Plan gratuito |
| Lógica de negocio | Funciones SQL (PL/pgSQL) en la base de datos, expuestas como RPC | incluido |
| Seguridad | **Supabase Auth** (usuarios) + **RLS** (seguridad por filas) + permisos por rol | incluido |
| Tiempo real | **Supabase Realtime** (cambios de tablas, respetando RLS) | incluido |
| Imágenes de productos y logo | **Supabase Storage** (bucket público `images`) | incluido |
| Publicación | **Cloudflare Pages** | Plan gratuito |

No hay servidor propio: el navegador habla directamente con Supabase.

```
 Meseros · Cocina · Bar · Caja · Admin        (React, publicado en Cloudflare Pages)
                     │  supabase-js (HTTPS + WebSocket)
                     ▼
 ┌──────────────── Supabase ────────────────┐
 │ Auth ── sesión del usuario (JWT)          │
 │ PostgREST ── RPC: open_order, send_items, │
 │   kds_set_items_status, register_payment, │
 │   cash_close, report_sales, …             │
 │ PostgreSQL ── tablas + RLS + funciones    │
 │ Realtime ── avisa de cambios a pantallas  │
 │ Storage ── imágenes                       │
 └───────────────────────────────────────────┘
```

### ¿Dónde está la lógica?

**Toda regla de negocio vive en la base de datos**, nunca en el navegador:

- El navegador solo puede **leer** lo que su rol permite (políticas RLS).
- Pedidos, cocina/bar, pagos, caja, usuarios y reportes se ejecutan con **funciones `SECURITY DEFINER`**. Cada una valida la sesión y los permisos, aplica las reglas y trabaja en una sola transacción, con bloqueo de fila cuando hay dinero de por medio.
- Solo los catálogos administrativos (productos, categorías, mesas, métodos de pago, configuración) se editan directamente. Están protegidos por RLS y quedan auditados por *triggers*.

```
AppRestaurante/
├── client/                          Frontend React
│   ├── public/_redirects            Rutas SPA para Cloudflare Pages
│   └── src/
│       ├── lib/supabase.ts          Cliente de Supabase
│       ├── lib/api.ts               Capa de datos: rutas → RPC / tablas de Supabase
│       ├── lib/socket.tsx           Supabase Realtime → actualización de pantallas
│       ├── lib/exporters.ts         Exportación PDF / Excel (en el navegador)
│       ├── components/              UI, layout, notificaciones
│       └── pages/                   waiter/, kds/, cashier/, admin/, print/
└── supabase/
    ├── migrations/                  Esquema, seguridad, funciones (orden numérico)
    │   ├── …01_schema.sql           Tablas, índices, restricciones
    │   ├── …02_security.sql         RLS, permisos, auditoría
    │   ├── …03_orders.sql           Mesas, menú, órdenes, KDS
    │   ├── …04_payments_cash.sql    Cuentas, pagos, división, caja
    │   ├── …05_reports_admin.sql    Reportes, usuarios, roles, bitácora
    │   └── …06_realtime_storage.sql Realtime y bucket de imágenes
    ├── seed.sql                     Permisos, roles, menú, mesas, usuarios de prueba
    ├── seed_demo.sql                (Opcional) 60 días de ventas de demostración
    ├── setup.sql                    Todo lo anterior en un archivo (para el SQL Editor)
    ├── reset_operational_data.sql   Borra pedidos/pagos/caja de prueba
    └── tests/                       Pruebas de integración
```

## 2. Modelo de datos

- **roles**, **permissions**, **role_permissions**, **profiles** (un perfil por usuario de Supabase Auth).
- **dining_tables** (mesas), **categories**, **products**, **preparation_areas** (COCINA / BAR).
- **orders**: estados `OPEN`, `BILL_REQUESTED`, `PAID`, `CANCELLED`. Al pagarse se **congelan** subtotal, descuento, servicio, IVA y total.
- **order_batches** (comandas): cada envío del mesero crea una nueva. Lo agregado después llega como solicitud nueva, sin reenviar lo anterior.
- **order_items**: guardan el nombre y el precio del momento de la venta (histórico inmutable), estado (`PENDING`, `IN_PREPARATION`, `READY`, `DELIVERED`, `CANCELLED`) y quién canceló y por qué.
- **order_history**: historial de cada orden con usuario, fecha y detalle.
- **payment_methods**, **payments** (con `idempotency_key` única, para que no haya ventas duplicadas) y **payment_items** (división por consumo).
- **cash_registers**, **cash_sessions** (apertura), **cash_closings** (arqueo), **cash_movements**.
- **notifications**, **audit_logs**, **restaurant_settings**.

Reglas que garantiza la propia base de datos:
- Índice único parcial: **una sola orden abierta por mesa**.
- Índice único parcial: **una sola caja abierta por caja registradora**.
- Restricciones `CHECK` de cantidades, precios y montos.
- La información financiera nunca se borra: productos, usuarios y mesas con historial se desactivan.

## 3. Tiempo real

Cada pantalla abre una suscripción de **Supabase Realtime** a las tablas `orders`, `order_items`, `payments`, `cash_sessions`, `cash_movements`, `notifications`, `products`, `categories`, `dining_tables` y `restaurant_settings`. Realtime aplica RLS, así que cada usuario solo recibe los cambios de las filas que puede ver. Las notificaciones personales se filtran por `user_id`.

La base **guarda primero (en una transacción)** y Realtime avisa después. Al recibir el aviso, la pantalla vuelve a pedir los datos afectados; tras una reconexión se resincroniza todo.

## 4. Flujos y reglas

1. **Abrir mesa** → *Esperando pedido*.
2. **Enviar pedido** → cada producto va a su área automáticamente. Cocina solo ve comida y bar solo bebidas.
3. **Cocina / bar** marcan *En preparación* → *Listo*, uno por uno o "Todo listo" por comanda. Pueden cancelar con motivo.
4. **El mesero es notificado** ("¡pedido completo listo!" cuando ya no queda nada pendiente) y marca lo entregado.
5. **Editar la orden**:

   | Cambio | Producto pendiente | En preparación / listo / entregado |
   |---|---|---|
   | Aumentar cantidad | se actualiza la misma línea (marcada MODIFICADO en el KDS) | solo la **diferencia** se envía como solicitud nueva |
   | Disminuir | la diferencia queda como línea **CANCELADA** con motivo | igual |
   | Cambiar notas | permitido | solo si está en preparación |
   | Eliminar | se cancela con motivo obligatorio (nunca se borra) | igual |

   No se pueden reducir ni cancelar unidades ya pagadas.
6. **Pedir la cuenta** → *Pendiente de pago*.
7. **Caja** cobra: total, partes iguales, por consumo o monto libre. Efectivo con vuelto, tarjeta, SINPE/transferencia u otros.
8. Saldo en cero → orden **PAGADA**, totales congelados, venta registrada en caja y **mesa disponible**.
9. **Cierre de caja**: efectivo esperado vs. contado y diferencia.

**Estados de mesa:** Disponible · Esperando pedido (sin productos enviados) · Pedido en preparación · Parcialmente listo · Pedido listo · Ocupada (todo entregado) · Pendiente de pago.

**Reglas de negocio:** cocina y bar no pueden cambiar precios ni cobrar (la base impide asignarles esos permisos). El cajero no edita pedidos ni productos. Los reportes usan solo órdenes `PAID`. Cada acción importante queda en el historial y en la bitácora.

## 5. Roles por defecto

| Rol | Puede |
|---|---|
| Administrador | todo |
| Mesero | ver mesas, abrir mesas, enviar y modificar **sus** pedidos, pedir la cuenta |
| Cocina / Bar | su pantalla KDS, marcar productos agotados |
| Cajero | mesas y cuentas, registrar pagos, abrir/operar/cerrar caja, historial de caja |

Se editan en **Administración → Roles y permisos**.

---

## 6. Instalación en Supabase (una sola vez)

1. Cree un proyecto en https://supabase.com (plan gratuito).
2. **SQL Editor** → pegue completo `supabase/setup.sql` → **Run**. Si el editor advierte "operaciones destructivas" o "tablas sin RLS", elija **"Ejecutar sin RLS"**: el script sí activa RLS en todas las tablas, solo que el analizador del editor no lo detecta.
3. (Opcional) Para tener datos en los reportes, ejecute también `supabase/seed_demo.sql`.
4. **Authentication → Sign In / Providers** → desactive **"Allow new users to sign up"**. Los usuarios se crean desde el panel de administración.
5. **Project Settings → API Keys** → copie la URL del proyecto y la clave **publishable** (o la *anon* de "Legacy API keys"). **Nunca use la clave `service_role` / `secret` en el frontend.**

> Verificación: `select count(*) from pg_tables where schemaname = 'public' and rowsecurity;` debe dar **22**.

## 7. Ejecutar en su computadora

Requisitos: Node.js 22+.

```bash
npm run install:all
cp client/.env.example client/.env.local   # complete VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY
npm run dev                                # http://localhost:5173
```

## 8. Publicar gratis en Cloudflare Pages

1. En https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** y elija el repositorio.
2. Configuración de compilación:

   | Campo | Valor |
   |---|---|
   | Rama de producción | la rama que desee publicar |
   | Framework preset | None (o Vite) |
   | Root directory | `client` |
   | Build command | `npm run build` |
   | Build output directory | `dist` |

3. **Variables de entorno** (Production y Preview):
   - `VITE_SUPABASE_URL` = `https://<su-proyecto>.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = su clave publishable / anon
   - `NODE_VERSION` = `22`
4. **Save and Deploy**. Obtendrá una dirección gratuita `https://<nombre>.pages.dev`.

El archivo `client/public/_redirects` hace que las rutas (`/mesas`, `/cocina`, …) funcionen al recargar la página. Cada `git push` vuelve a publicar automáticamente.

## 9. Usuarios de prueba

| Rol | Usuario | Contraseña |
|---|---|---|
| Administrador | `admin` | `Admin123` |
| Mesero | `mesero` | `Mesero123` |
| Mesera (2.ª) | `mesera2` | `Mesero123` |
| Cocina | `cocina` | `Cocina123` |
| Bar | `bar` | `Bar12345` |
| Cajero | `cajero` | `Cajero123` |

> **Cambie estas contraseñas** antes de usar el sistema de verdad (icono de llave en el menú de usuario, o Administración → Usuarios). El inicio de sesión es por usuario; internamente Supabase Auth usa el correo `<usuario>@comanda.local`.

**Antes de operar de verdad**, ejecute `supabase/reset_operational_data.sql` en el SQL Editor. Borra pedidos, pagos y caja de prueba y conserva menú, mesas, usuarios y configuración. Es irreversible.

## 10. Pruebas

```bash
# Requiere un PostgreSQL local con superusuario, por ejemplo:
docker run -d --name comanda-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
npm test
```

`supabase/tests/flows.test.js` crea una base local **`comanda_supabase_test`** que simula Supabase (roles `anon`/`authenticated`, `auth.uid()`, `auth.users`). Por seguridad solo actúa sobre bases cuyo nombre termina en `_test`; otra conexión se define con `TEST_DATABASE_URL`. Ahí aplica las migraciones y el seed, y ejecuta cada operación **como lo hace Supabase**: con rol `authenticated` y el usuario en el JWT. Así prueba la lógica, los permisos y las políticas RLS.

Cubre: permisos por rol y RLS (cocina no cobra, no cambia precios, no ve el bar ni los pagos; cada usuario ve solo sus notificaciones), creación y desactivación de usuarios, distribución cocina/bar, una orden abierta por mesa, órdenes ajenas, marcado de listos y notificaciones, edición de pedidos (nuevos sin duplicar, diferencias, cancelaciones con registro, notas), agotados, estados de mesa, cálculo de servicio e IVA, caja obligatoria, pago por consumo, idempotencia, sobrepago, partes iguales, efectivo con vuelto, cierre de cuenta y liberación de mesa, movimientos y cierre de caja, reportes (excluyen anuladas y pendientes) y bitácora.

Resultado actual: **24 pruebas, todas pasan**.

También se verificó en un navegador automatizado **contra el proyecto real de Supabase**:
- tiempo real entre mesero, cocina y bar;
- entrega y cuenta dividida en caja, con la mesa liberada al pagar;
- reportes y exportación PDF/Excel;
- subida de imágenes a Storage;
- creación de un usuario e inicio de sesión con él;
- bloqueo de un usuario desactivado.

## 11. Limitaciones

- **Plan gratuito de Supabase:** **sin copias de seguridad automáticas**, así que haga respaldos periódicos (Database → Backups, o `pg_dump`). El proyecto se pausa tras 7 días sin uso. Revise los límites vigentes en supabase.com/pricing.
- **Factura electrónica de Hacienda (CR):** no implementada; el comprobante es interno.
- **Anular un pago registrado:** no hay pantalla para hacerlo. Se corrige con un *ajuste autorizado* de caja.
- **Impresión:** desde el navegador (ticket 80 mm); no hay soporte directo para impresoras ESC/POS.
- **Varias cajas abiertas a la vez:** la base lo soporta, pero la interfaz usa la caja principal.
- **Permisos:** se asignan por rol, no por usuario individual.
- **Contraseña cambiada por el administrador:** el usuario no pierde su sesión abierta. Al **desactivarlo**, en cambio, sus operaciones se bloquean de inmediato.
- **Fuera de alcance:** inventario, reservas y pedidos a domicilio.
