-- Tells a shop owner's phone the moment a farmer joins their shop.
--
-- The join already exists by the time this runs: `join_shop_with_code` has
-- written the link and spent one use of the sticker. So the notification is a
-- *consequence* of a join, never a condition of it — everything below is built so
-- that a delivery problem can only lose a notification, not a farmer.
--
-- How it reaches the phone:
--
--   dealer_farmer_links insert  ->  net.http_post (pg_net, asynchronous)
--      ->  Edge Function `notify-shop-owner`  ->  FCM HTTP v1  ->  device
--
-- The call is queued by pg_net inside the joining transaction and delivered after
-- it commits, so the farmer's join returns at the speed of the database and the
-- push arrives a moment later. A wrong URL, a dead function or FCM being down all
-- end in a log line, not a failed scan.
--
-- The token the function demands is read from Vault rather than written here:
-- this file is in version control, and a secret in version control is a secret
-- published. When the secret is absent the trigger does nothing — which is what a
-- development database should do, not crash a join.
--
-- It is the same value as the function's `SHOP_PUSH_TOKEN`: one secret for one
-- hop, so a leaked token can forge a notification but cannot read a table.

do $$
begin
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'Vault is required: create the secret shop_push_token first';
  end if;
end $$;

create or replace function public.notify_shop_owner_of_join()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  -- The Edge Function's address. One Supabase project backs every environment, so
  -- there is one address to name.
  endpoint constant text := 'https://swmbmtvwgksicfnfsehg.supabase.co/functions/v1/notify-shop-owner';
  service_key text;
  -- Prefixed, because a bare `shop_name` is ambiguous next to the column of the
  -- same name and PL/pgSQL resolves it as an error, not as a guess.
  v_farmer_name text;
  v_shop_name text;
begin
  select decrypted_secret into service_key
    from vault.decrypted_secrets
   where name = 'shop_push_token';

  -- No secret, no sender. A join must still commit.
  if service_key is null then
    raise warning 'shop push not configured: vault secret shop_push_token is missing';
    return new;
  end if;

  select p.display_name into v_farmer_name from public.parties p where p.id = new.farmer_id;
  select d.shop_name into v_shop_name from public.dealer_profiles d where d.id = new.dealer_id;

  perform net.http_post(
    url := endpoint,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := jsonb_build_object(
      'dealer_id', new.dealer_id,
      -- Urdu first, like the rest of the app: the phone on the counter shows this
      -- in a notification tray, where there is no room to explain a second
      -- language and no language switcher to reach for.
      'title', 'نیا کسان جڑ گیا',
      'body', coalesce(v_farmer_name, 'ایک کسان') || ' آپ کی دکان' ||
              coalesce(' «' || v_shop_name || '»', '') || ' سے جڑ گیا ہے',
      'data', jsonb_build_object(
        'dealer_id', new.dealer_id::text,
        'kind', 'shop_join'
      )
    ),
    timeout_milliseconds := 5000
  );

  return new;
end;
$$;

comment on function public.notify_shop_owner_of_join() is
  'Queues the shop-owner push for a QR join. Asynchronous: the join commits whether or not delivery succeeds.';

-- Only a join by code is news. A link a dealer created at the counter is not a
-- surprise to the dealer.
drop trigger if exists dealer_farmer_links_notify_shop on public.dealer_farmer_links;

create trigger dealer_farmer_links_notify_shop
  after insert on public.dealer_farmer_links
  for each row
  when (new.established_by = 'shop_qr')
  execute function public.notify_shop_owner_of_join();

-- A trigger function is not an API. Nothing should be able to call it directly.
revoke all on function public.notify_shop_owner_of_join() from public;
