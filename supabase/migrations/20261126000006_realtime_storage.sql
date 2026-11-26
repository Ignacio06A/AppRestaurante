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
