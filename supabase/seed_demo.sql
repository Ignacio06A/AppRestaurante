-- =============================================================
--  OPCIONAL: historial de ventas de demostración (60 días) para que
--  los reportes muestren datos. Solo se ejecuta si no hay órdenes.
--  No lo ejecute en un restaurante real.
-- =============================================================
do $$
declare
  tz constant text := 'America/Costa_Rica';
  v_today date := (now() at time zone tz)::date;
  d int; n int; k int; g int;
  v_day date; v_dow int; v_orders int;
  v_session int; v_order int; v_batch int; v_waiter uuid; v_cashier uuid; v_register int;
  v_opened timestamptz; v_closed timestamptz; p record; m record;
  v_sub bigint; v_serv bigint; v_tax bigint; v_total bigint; v_pay int;
  v_cash bigint; v_card bigint; v_transfer bigint; v_other bigint; v_expense bigint; v_expected bigint; v_counted bigint;
  v_code text;
  hours int[] := array[11,12,12,13,13,13,14,14,15,17,18,19,19,19,20,20,21];
begin
  if exists (select 1 from public.orders) then
    raise notice 'Ya existen órdenes: se omite el historial de demostración';
    return;
  end if;
  perform setseed(0.42);
  select id into v_cashier from public.profiles where username = 'cajero';
  select id into v_register from public.cash_registers order by id limit 1;

  for d in reverse 60 .. 1 loop
    v_day := v_today - d;
    v_dow := extract(dow from v_day);
    v_orders := round((case when v_dow in (5, 6) then 26 when v_dow = 0 then 20 else 14 end) * (0.8 + random() * 0.4));
    insert into public.cash_sessions (register_id, opened_by_id, opened_at, opening_amount, status)
    values (v_register, v_cashier, (v_day + time '10:30') at time zone tz, 50000, 'CLOSED') returning id into v_session;
    v_cash := 0; v_card := 0; v_transfer := 0; v_other := 0;

    for n in 1 .. v_orders loop
      v_opened := (v_day + make_interval(hours => hours[1 + floor(random() * array_length(hours, 1))::int], mins => floor(random() * 60)::int)) at time zone tz;
      v_closed := v_opened + make_interval(mins => 40 + floor(random() * 50)::int);
      g := 1 + floor(random() * 5)::int;
      select id into v_waiter from public.profiles pr where pr.role_id = (select id from public.roles where code = 'WAITER') order by random() limit 1;
      insert into public.orders (table_id, waiter_id, guests, status, opened_at, closed_at, closed_by_id)
      values ((select id from public.dining_tables order by random() limit 1), v_waiter, g, 'PAID', v_opened, v_closed, v_cashier)
      returning id into v_order;
      insert into public.order_batches (order_id, sequence, created_by_id, created_at) values (v_order, 1, v_waiter, v_opened) returning id into v_batch;
      -- comida
      for k in 1 .. greatest(1, round(g * (0.8 + random() * 0.5))::int) loop
        select pr.* into p from public.products pr join public.preparation_areas a on a.id = pr.area_id where a.code = 'KITCHEN' order by random() limit 1;
        insert into public.order_items (order_id, batch_id, product_id, area_id, product_name, unit_price, quantity, status, created_by_id, created_at, ready_at, delivered_at)
        values (v_order, v_batch, p.id, p.area_id, p.name, p.price, 1, 'DELIVERED', v_waiter, v_opened, v_opened, v_opened);
      end loop;
      -- bebidas
      for k in 1 .. g loop
        select pr.* into p from public.products pr join public.preparation_areas a on a.id = pr.area_id where a.code = 'BAR' order by random() limit 1;
        insert into public.order_items (order_id, batch_id, product_id, area_id, product_name, unit_price, quantity, status, created_by_id, created_at, ready_at, delivered_at)
        values (v_order, v_batch, p.id, p.area_id, p.name, p.price, case when random() > 0.8 then 2 else 1 end, 'DELIVERED', v_waiter, v_opened, v_opened, v_opened);
      end loop;
      select sum(round(unit_price * 100)::bigint * quantity) into v_sub from public.order_items where order_id = v_order;
      v_serv := round(v_sub * 0.10); v_tax := round(v_sub * 0.13); v_total := v_sub + v_serv + v_tax;
      update public.orders set subtotal = v_sub / 100.0, service_amount = v_serv / 100.0, tax_amount = v_tax / 100.0, total = v_total / 100.0 where id = v_order;
      v_code := case when random() < 0.4 then 'CASH' when random() < 0.67 then 'CARD' when random() < 0.95 then 'SINPE' else 'VOUCHER' end;
      select * into m from public.payment_methods where code = v_code;
      insert into public.payments (order_id, payment_method_id, cash_session_id, amount, received_amount, user_id, idempotency_key, created_at)
      values (v_order, m.id, v_session, v_total / 100.0, case when m.kind = 'CASH' then v_total / 100.0 end, v_cashier, 'demo-' || v_order, v_closed)
      returning id into v_pay;
      insert into public.cash_movements (session_id, type, amount, payment_method_id, payment_id, description, user_id, created_at)
      values (v_session, 'SALE', v_total / 100.0, m.id, v_pay, 'Venta orden #' || (select number from public.orders where id = v_order), v_cashier, v_closed);
      case m.kind when 'CASH' then v_cash := v_cash + v_total; when 'CARD' then v_card := v_card + v_total;
                  when 'TRANSFER' then v_transfer := v_transfer + v_total; else v_other := v_other + v_total; end case;
    end loop;

    v_expense := round(5000 + random() * 15000) * 100;
    insert into public.cash_movements (session_id, type, amount, description, user_id, created_at)
    values (v_session, 'EXPENSE', -v_expense / 100.0, 'Compra de insumos (verdulería)', v_cashier, (v_day + time '15:00') at time zone tz);
    v_expected := 5000000 + v_cash - v_expense;
    v_counted := v_expected + case when random() > 0.85 then -100000 else 0 end;
    insert into public.cash_closings (session_id, closed_by_id, closed_at, opening_amount, total_sales, cash_sales, card_sales, transfer_sales,
                                      other_sales, total_income, total_withdrawals, total_expenses, total_adjustments, expected_cash, counted_cash, difference)
    values (v_session, v_cashier, (v_day + time '22:30') at time zone tz, 50000, (v_cash + v_card + v_transfer + v_other) / 100.0,
            v_cash / 100.0, v_card / 100.0, v_transfer / 100.0, v_other / 100.0, 0, 0, v_expense / 100.0, 0,
            v_expected / 100.0, v_counted / 100.0, (v_counted - v_expected) / 100.0);
  end loop;
  raise notice 'Historial de demostración creado: % órdenes', (select count(*) from public.orders);
end $$;
