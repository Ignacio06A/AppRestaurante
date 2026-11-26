-- =============================================================
--  Borra TODA la información operativa y financiera (órdenes, pagos,
--  caja, notificaciones y bitácora) para empezar a operar en limpio.
--  Conserva: usuarios, roles/permisos, menú, mesas, métodos de pago y
--  configuración.
--
--  ⚠ IRREVERSIBLE. Úselo solo ANTES de empezar a operar de verdad
--  (por ejemplo, para quitar las pruebas o el historial de demostración).
-- =============================================================
truncate table
  public.payment_items, public.cash_movements, public.payments, public.cash_closings, public.cash_sessions,
  public.order_history, public.order_items, public.order_batches, public.orders,
  public.notifications, public.audit_logs
restart identity cascade;
alter sequence public.order_number_seq restart with 1;
