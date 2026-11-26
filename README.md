# Comanda — Sistema de gestión de restaurante

Aplicación web para operar un restaurante de punta a punta: el mesero toma la orden, **cocina y bar** la reciben al instante en sus pantallas (KDS), el mesero recibe una notificación cuando los productos están listos, **caja** cobra (pagos parciales, cuenta dividida, varios métodos de pago) y la venta queda registrada en el **control de caja** y en los **reportes**.

Moneda: colones costarricenses (CRC, ₡). IVA 13 % y servicio 10 % configurables.

---

## 1. Arquitectura

| Capa | Tecnología | Motivo |
|---|---|---|
| Frontend | React 18 + TypeScript + Vite, Tailwind CSS, React Router, TanStack Query, Recharts | SPA rápida y responsive (PC, tablet, celular). React Query mantiene el caché y se invalida desde los eventos de tiempo real. |
| Backend | Node.js 22 + Express + TypeScript, organizado por módulos | Un solo lenguaje en todo el stack; un módulo por dominio (pedidos, KDS, caja...). |
| Tiempo real | Socket.IO (WebSockets con respaldo a long-polling) | Reconexión automática, salas por rol/área/usuario, autenticación con la misma cookie de sesión. |
| Base de datos | PostgreSQL 16 + Prisma ORM (migraciones versionadas) | Relacional, transacciones, bloqueos de fila (`SELECT … FOR UPDATE`), índices parciales para reglas de negocio. |
| Seguridad | JWT en cookie `httpOnly` + `SameSite=Lax`, bcrypt (12 rondas), Helmet, rate-limit en login, validación Zod en todas las rutas | Ver sección 7. |
| Reportes | ExcelJS (Excel) y PDFKit (PDF) generados en el servidor | |

```
AppRestaurante/
├── server/                    API REST + WebSockets
│   ├── prisma/
│   │   ├── schema.prisma      Modelo de datos
│   │   ├── migrations/        Migraciones SQL (incluye índices parciales y CHECKs)
│   │   └── seed.ts            Datos iniciales + historial de demostración
│   ├── src/
│   │   ├── index.ts           Arranque HTTP + Socket.IO
│   │   ├── app.ts             Express: middlewares, rutas, manejo de errores
│   │   ├── realtime.ts        Salas y eventos de tiempo real
│   │   ├── middleware/auth.ts Autenticación JWT y autorización por permisos
│   │   ├── lib/               Dinero (céntimos), cálculo de totales, estado de mesa, auditoría...
│   │   └── modules/
│   │       ├── auth/          Login, logout, sesión, cambio de contraseña
│   │       ├── users/         Usuarios, roles y permisos
│   │       ├── tables/        Mesas y su estado
│   │       ├── menu/          Categorías, productos, áreas, disponibilidad
│   │       ├── orders/        Órdenes, comandas, edición, historial
│   │       ├── kds/           Pantallas de cocina y bar
│   │       ├── payments/      Cuentas, pagos, división, comprobantes
│   │       ├── cash/          Apertura, movimientos y cierre de caja
│   │       ├── reports/       Dashboard, reportes, exportación PDF/Excel
│   │       ├── notifications/ Notificaciones por usuario
│   │       ├── settings/      Configuración, métodos de pago, cajas
│   │       ├── audit/         Bitácora
│   │       └── uploads/       Imágenes de productos y logo
│   └── tests/flows.test.ts    Pruebas de integración de los flujos principales
└── client/                    Frontend React
    └── src/
        ├── lib/               API, autenticación, socket, formatos, tipos
        ├── components/        UI (botones, modales, confirmaciones…), layout, notificaciones
        └── pages/
            ├── waiter/        Plano de mesas, toma y edición de pedidos
            ├── kds/           Pantalla de cocina / bar
            ├── cashier/       Cuentas, cobro, control de caja, historial
            ├── admin/         Dashboard, reportes, menú, mesas, usuarios, roles, configuración, bitácora, órdenes
            └── print/         Comprobante (ticket 80 mm) y reporte de cierre de caja
```

## 2. Modelo de base de datos

Entidades principales (ver `server/prisma/schema.prisma`):

- **Role**, **Permission**, **RolePermission**, **User** — control de acceso basado en roles; los permisos de cada rol son editables.
- **DiningTable** (Mesa) — número único, nombre, zona, capacidad, activa.
- **Category**, **Product**, **PreparationArea** (COCINA / BAR) — cada producto tiene su área de destino; `active` (desactivado) y `available` (agotado).
- **Order** — una por visita a la mesa. Estados: `OPEN`, `BILL_REQUESTED`, `PAID`, `CANCELLED`. Al pagarse se **congelan** subtotal, descuento, servicio, IVA y total (fuente de los reportes).
- **OrderBatch** (comanda) — cada envío del mesero crea una comanda nueva; así lo agregado después llega como solicitud nueva sin reenviar lo anterior.
- **OrderItem** (DetalleOrden) — guarda nombre y precio **del momento** (histórico inmutable), cantidad, notas, área, estado (`PENDING`, `IN_PREPARATION`, `READY`, `DELIVERED`, `CANCELLED`), marcas de tiempo y quién canceló y por qué. Las reducciones de cantidad generan una línea `CANCELLED` enlazada (`parentItemId`).
- **OrderHistory** — historial de cada orden con usuario, fecha, acción y detalle.
- **PaymentMethod**, **Payment**, **PaymentItem** — pagos con `idempotencyKey` única (evita ventas duplicadas); `PaymentItem` asigna productos a un pago (división por consumo).
- **CashRegister**, **CashSession** (apertura), **CashClosing** (cierre / arqueo), **CashMovement** (ventas, entradas, retiros, gastos, ajustes).
- **Notification**, **AuditLog**, **RestaurantSettings**.

Reglas aplicadas en la propia base de datos (migración inicial):

- Índice único parcial: **una sola orden abierta por mesa** (`status IN ('OPEN','BILL_REQUESTED')`).
- Índice único parcial: **una sola apertura de caja abierta por caja registradora**.
- `CHECK` de cantidades > 0, precios ≥ 0, montos de pago > 0, etc.
- Claves foráneas sin borrado en cascada sobre datos financieros: productos, usuarios y mesas con historial **se desactivan, nunca se eliminan**.

## 3. Comunicación en tiempo real

El navegador abre una conexión Socket.IO autenticada con la cookie de sesión. Según sus permisos, el servidor la une a salas:

| Sala | Quién | Para qué |
|---|---|---|
| `area:KITCHEN` | permiso `kds.kitchen` | Comandas y cambios de productos de COCINA |
| `area:BAR` | permiso `kds.bar` | Comandas y cambios de productos de BAR |
| `user:<id>` | cada usuario | Notificaciones personales (p. ej. "Mesa 5: listo en Cocina") |
| `floor` | meseros, caja, admin | Estado de mesas y órdenes |
| `cash` | caja, admin | Pagos y movimientos de caja |

Eventos: `kds:ticket-new`, `kds:updated`, `tables:updated`, `order:updated`, `notification:new`, `cash:updated`, `menu:updated`.

El servidor siempre **guarda primero en la base de datos (en una transacción)** y después emite el evento. El cliente, al recibirlo, invalida las consultas afectadas y las vuelve a pedir; tras una reconexión se resincroniza todo. Así ninguna pantalla depende de haber recibido cada evento.

## 4. Flujos principales

1. **Abrir mesa** → la mesa pasa a *Esperando pedido*.
2. **Enviar pedido** → se crea la comanda; cada producto se envía a su área (COCINA / BAR) automáticamente. Cocina solo ve comida y bar solo bebidas.
3. **Cocina / bar** marcan cada producto *En preparación* → *Listo* (o la comanda completa con "Todo listo"). Pueden cancelar un producto con motivo.
4. **Mesero notificado** al quedar productos listos ("¡pedido completo listo!" cuando ya no queda nada pendiente). Marca lo entregado.
5. **Editar la orden** en cualquier momento (ver reglas abajo). Todo queda en el historial.
6. **Pedir la cuenta** → *Pendiente de pago*; aparece priorizada en caja.
7. **Caja** cobra: total, partes iguales, por consumo de cada persona o monto libre; efectivo con vuelto, tarjeta, SINPE/transferencia u otros métodos.
8. Al llegar el saldo a cero → la orden queda **PAGADA**, se congelan los totales, se registra la venta y la **mesa queda disponible**.
9. **Cierre de caja** con arqueo: efectivo esperado vs. contado y diferencia.

### Estados de la mesa (derivados del estado real de la orden)

| Estado | Condición |
|---|---|
| Disponible | sin orden abierta |
| Esperando pedido | mesa abierta, aún sin productos enviados |
| Pedido en preparación | hay productos pendientes o en preparación y ninguno listo |
| Pedido parcialmente listo | algunos listos y otros todavía pendientes |
| Pedido listo | todo lo que falta entregar está listo |
| Ocupada | todo fue entregado (clientes consumiendo) |
| Pendiente de pago | se pidió la cuenta o tiene pagos parciales |

### Reglas de edición de pedidos enviados

| Cambio | Producto *Pendiente* | *En preparación* / *Listo* / *Entregado* |
|---|---|---|
| Aumentar cantidad | se actualiza la misma línea y se marca **MODIFICADO** en el KDS | **solo la diferencia** se envía como solicitud nueva (comanda nueva) |
| Disminuir cantidad | la línea se reduce y la diferencia queda como línea **CANCELADA** con motivo | igual |
| Cambiar observaciones | permitido (marca MODIFICADO) | permitido en preparación; no permitido si ya está listo/entregado |
| Eliminar | se cancela con motivo obligatorio (nunca se borra) | igual; el área ve la cancelación |

No se permite reducir ni cancelar unidades ya pagadas.

## 5. Reglas de negocio implementadas

1. Una mesa tiene como máximo una orden abierta (validación + índice único parcial).
2–3. Una orden contiene múltiples productos y se envía en varias comandas.
4–5. Cada producto va a su área; cocina y bar gestionan sus productos de forma independiente (el backend filtra por área y verifica el permiso del área en cada cambio).
6–7. Agregar productos crea una comanda nueva; lo enviado antes no se duplica.
8. Las cancelaciones conservan registro (estado `CANCELLED`, usuario, fecha y motivo).
9. Una mesa/orden no figura como "lista" mientras haya productos pendientes o en preparación.
10–12. Varios pagos por cuenta, pagos parciales y división (iguales, por consumo, monto libre).
13. La mesa se libera solo cuando el saldo llega a cero y la orden se cierra.
14. No hay ventas duplicadas: clave de idempotencia única por pago + bloqueo de fila de la orden.
15. Pagos, movimientos y cierres de caja se ejecutan en transacciones con bloqueo pesimista; los montos se calculan en céntimos enteros.
16. Acciones importantes registradas en `OrderHistory` y `AuditLog` (usuario, fecha, IP).
17. Cocina y bar no pueden modificar precios ni registrar pagos: no tienen esos permisos y el servidor **impide asignárselos** aunque el administrador lo intente.
18. El cajero no tiene permisos de edición de pedidos ni de productos (puede recibir el permiso de descuentos si el admin lo decide).
19. Los reportes usan solo órdenes `PAID` con sus totales congelados.

## 6. Roles y permisos por defecto

| Rol | Puede |
|---|---|
| Administrador | todo |
| Mesero | ver mesas, abrir mesas, enviar y modificar **sus** pedidos, pedir la cuenta |
| Cocina | pantalla de cocina, marcar productos agotados |
| Bar | pantalla de bar, marcar productos agotados |
| Cajero | ver mesas y cuentas, registrar pagos, abrir/operar/cerrar caja, historial de caja |

Los permisos se editan en **Administración → Roles y permisos**. Todas las rutas del backend verifican permisos; la interfaz solo oculta lo que el usuario no puede usar.

## 7. Seguridad

- Contraseñas con **bcrypt** (12 rondas); mínimo 8 caracteres.
- Sesión con **JWT firmado en cookie `httpOnly`**, `SameSite=Lax`, `Secure` en producción, expiración 12 h. Al desactivar un usuario, cambiar su rol o su contraseña, sus sesiones se invalidan (`tokenVersion`).
- Validación de origen en peticiones que modifican datos (protección CSRF adicional).
- Límite de intentos de login (20 cada 15 min por IP) y registro de intentos fallidos.
- Validación con Zod de todos los parámetros y cuerpos; errores devueltos en formato uniforme.
- Helmet (cabeceras de seguridad, CSP en producción).
- Subida de imágenes restringida a PNG/JPG/WEBP/GIF de máximo 3 MB, con nombre aleatorio.

---

## 8. Instalación y ejecución

### Requisitos

- Node.js **22** o superior
- PostgreSQL **14+** (o Docker para levantarlo con `docker compose`)

### Paso a paso

```bash
# 1. Dependencias
npm run install:all

# 2. Base de datos (opción A: Docker)
docker compose up -d          # crea las bases "restaurante" y "restaurante_test"
#    (opción B: PostgreSQL propio)
#    CREATE USER restaurante WITH PASSWORD 'restaurante' CREATEDB;
#    CREATE DATABASE restaurante OWNER restaurante;
#    CREATE DATABASE restaurante_test OWNER restaurante;   -- solo para pruebas

# 3. Variables de entorno
cp server/.env.example server/.env
#    edite DATABASE_URL y JWT_SECRET (use un secreto largo y aleatorio)

# 4. Migraciones y datos iniciales
npm run db:migrate
npm run db:seed               # SEED_DEMO=0 para no crear el historial de 60 días de ventas de demostración

# 5. Desarrollo (dos terminales)
npm run dev:server            # API + WebSockets en http://localhost:4000
npm run dev:client            # Interfaz en http://localhost:5173
```

Abra **http://localhost:5173**. Para usarlo desde tablets o celulares en la misma red, abra `http://<IP-de-la-PC>:5173`.

### Producción

```bash
npm run build                 # compila backend y frontend
NODE_ENV=production npm start # el backend sirve también el frontend en http://localhost:4000
```

En producción defina `JWT_SECRET` (≥ 32 caracteres) y `CLIENT_ORIGIN` con la URL pública. Si se sirve por **HTTP** dentro de la red local (sin HTTPS), defina `COOKIE_SECURE=false`; de lo contrario el navegador no guardará la cookie de sesión.

### Variables de entorno (`server/.env`)

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | Conexión a PostgreSQL |
| `JWT_SECRET` | Secreto para firmar sesiones |
| `JWT_EXPIRES_IN` | Duración de la sesión (por defecto `12h`) |
| `PORT` | Puerto del backend (por defecto 4000) |
| `CLIENT_ORIGIN` | Origen(es) permitidos del frontend, separados por coma |
| `NODE_ENV` | `development` / `production` |
| `UPLOAD_DIR` | Carpeta de imágenes subidas (por defecto `uploads`) |
| `COOKIE_SECURE` | `true`/`false` — cookie solo por HTTPS |
| `SEED_DEMO` | `0` para no generar ventas de demostración al sembrar |

### Usuarios de prueba

| Rol | Usuario | Contraseña | Pantalla inicial |
|---|---|---|---|
| Administrador | `admin` | `Admin123` | Dashboard |
| Mesero | `mesero` | `Mesero123` | Mesas |
| Mesera (2.ª) | `mesera2` | `Mesero123` | Mesas |
| Cocina | `cocina` | `Cocina123` | KDS Cocina |
| Bar | `bar` | `Bar12345` | KDS Bar |
| Cajero | `cajero` | `Cajero123` | Cuentas por cobrar |

> Cambie estas contraseñas antes de usar el sistema en un restaurante real (menú de usuario → icono de llave, o Administración → Usuarios).

Para probar el tiempo real abra varias ventanas (o una ventana de incógnito por rol): por ejemplo mesero, cocina, bar y cajero lado a lado.

## 9. Pruebas

```bash
npm test
```

Ejecuta `server/tests/flows.test.ts` contra la base **`restaurante_test`** (definida en `server/.env.test`; por seguridad el script se niega a correr si el nombre de la base no termina en `_test`). Aplica migraciones, vacía las tablas, siembra los datos base y prueba, con HTTP real y clientes WebSocket reales:

- autenticación, rechazo de solicitudes sin sesión y permisos por rol (cocina no cobra ni cambia precios ni ve el bar; el cajero no edita pedidos; otro mesero no edita órdenes ajenas; el admin no puede dar permisos de pago a cocina);
- crear una orden y su distribución automática cocina/bar, con recepción del evento por WebSocket en cada área;
- una sola orden abierta por mesa;
- marcar productos listos (individual y por comanda) y notificación al mesero;
- modificar la orden: agregar productos sin duplicar, aumentar cantidad en preparación (solo la diferencia), disminuir con registro de cancelación, cambiar notas, eliminar con motivo; historial con usuario y fecha;
- bloqueo de productos agotados;
- estados de mesa (en preparación, parcialmente lista, lista, ocupada, pendiente de pago, disponible);
- cálculo de la cuenta con servicio e IVA excluyendo cancelados;
- exigir caja abierta, pago por consumo, idempotencia (sin pagos duplicados), sobrepago rechazado, partes iguales, pago en efectivo con vuelto, cierre de la cuenta y liberación de la mesa;
- movimientos de caja (gasto, entrada, retiro con fondos insuficientes, ajuste con y sin permiso) y cierre con arqueo;
- reportes que excluyen órdenes pendientes y anuladas; exportación PDF y Excel; bitácora.

Resultado actual: **23 pruebas, todas pasan**.

Además se verificó la interfaz con un navegador automatizado (Playwright): mesero → cocina/bar → notificación → entrega → cuenta dividida en caja → mesa disponible; pantallas de administración; vista móvil (iPhone) sin desbordes; y el modo producción (backend sirviendo el frontend, WebSocket con CSP activa).

## 10. Limitaciones y funciones no implementadas

Para no dar una impresión equivocada, esto **no** está implementado:

- **Factura electrónica de Hacienda (Costa Rica)**: el comprobante es interno/no fiscal. No hay integración con el Ministerio de Hacienda.
- **Anulación o reverso de un pago ya registrado**: el modelo incluye el estado `VOIDED`, pero no existe pantalla ni endpoint para anular pagos. Hoy un error de cobro se corrige con un *ajuste autorizado* de caja.
- **Impresión directa en impresoras térmicas/comanderas** (ESC/POS): se imprime desde el navegador (formato ticket de 80 mm para el comprobante).
- **Varias cajas abiertas a la vez desde la interfaz**: el backend soporta varias cajas registradoras (`/api/cash-registers`), pero la interfaz opera sobre la caja principal.
- **Permisos individuales por usuario**: los permisos se asignan por rol.
- Inventario, recetas, reservas, pedidos para llevar/a domicilio y propinas separadas.
- En la división "partes iguales", el contador "persona X de N" vive en la pantalla del cajero: si recarga la página se reinicia el contador (los montos siguen siendo correctos porque se calculan sobre el saldo real).
