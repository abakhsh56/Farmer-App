-- Shop self-join by QR, and the device tokens a shop owner's phone needs.
--
-- Two features, one file, because they meet in the same place: the moment a
-- farmer joins a shop, that shop's owner is the party who must be told. Splitting
-- them would leave the notification without a token table and the token table
-- without a reason to exist.
--
-- What is deliberately *not* here: a `shop_members` table. A farmer joining a
-- shop is the same relationship the platform already models as
-- `dealer_farmer_links`, and a second membership table would mean two answers to
-- "is this farmer connected to this dealer", which is how accounts end up merged
-- by accident. The join adds one provenance value to that table instead.

-- ---------------------------------------------------------------------------
-- 1. A link may now be established by scanning the shop's code
-- ---------------------------------------------------------------------------

-- The original constraint names the three acts that could create a link. A QR is
-- a fourth, and it is an explicit act in exactly the sense the table's comment
-- demands: the farmer pointed a phone at a specific shop.
do $$
declare
  constraint_name text;
begin
  select con.conname
    into constraint_name
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
   where rel.oid = 'public.dealer_farmer_links'::regclass
     and con.contype = 'c'
     and pg_get_constraintdef(con.oid) like '%field_visit%';

  if constraint_name is not null then
    execute format('alter table public.dealer_farmer_links drop constraint %I', constraint_name);
  end if;
end $$;

alter table public.dealer_farmer_links
  add constraint dealer_farmer_links_established_by_check
  check (established_by in ('field_visit', 'credit_request', 'farmer_initiated_message', 'shop_qr'));

-- ---------------------------------------------------------------------------
-- 2. A shop's code
-- ---------------------------------------------------------------------------

-- One row is one sticker. A shop can have several (a counter, a bag of fertiliser,
-- a printed board) and revoke any of them without touching the others, which one
-- shared secret per shop could not express.
--
-- The alphabet omits 0/O, 1/I/L, 5/S and 2/Z: these codes are read out loud and
-- typed from smudged prints, and a code that can be misread joins the wrong shop.
create table public.shop_join_codes (
  id          uuid primary key default gen_random_uuid(),
  dealer_id   uuid not null references public.dealer_profiles (id) on delete cascade,
  -- Same alphabet as src/shop/joinLink.ts, character for character: no 0/O,
  -- 1/I/L, 5/S or 2/Z pairs, so a code read aloud or typed from a smudge is
  -- still one shop and not another.
  code        text not null unique check (code ~ '^[A-HJKMNPQRTUVWXY349]{8}$'),
  -- A sticker in a window is not a permanent grant; it expires unless renewed.
  expires_at  timestamptz not null default now() + interval '90 days',
  max_uses    integer not null default 500 check (max_uses between 1 and 100000),
  uses        integer not null default 0 check (uses >= 0),
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  constraint shop_join_codes_uses_within_limit check (uses <= max_uses)
);

comment on table public.shop_join_codes is
  'One row per printed or displayed shop code. Revoking a code stops new joins and leaves the links it already created in place.';

create index shop_join_codes_dealer_idx on public.shop_join_codes (dealer_id);

alter table public.shop_join_codes enable row level security;

-- The owner of the shop sees and issues their own codes. A farmer never reads this
-- table directly — the join goes through a function, so a leaked anon key cannot
-- enumerate every shop's code.
create policy shop_join_codes_owner_read on public.shop_join_codes
  for select using (
    exists (
      select 1 from public.dealer_profiles d
       where d.id = shop_join_codes.dealer_id
         and d.party_id = public.current_party_id()
    )
  );

create policy shop_join_codes_owner_write on public.shop_join_codes
  for insert with check (
    exists (
      select 1 from public.dealer_profiles d
       where d.id = shop_join_codes.dealer_id
         and d.party_id = public.current_party_id()
    )
  );

create policy shop_join_codes_owner_update on public.shop_join_codes
  for update using (
    exists (
      select 1 from public.dealer_profiles d
       where d.id = shop_join_codes.dealer_id
         and d.party_id = public.current_party_id()
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Issuing a code
-- ---------------------------------------------------------------------------

-- The code is generated here rather than by the client: a client-chosen code is a
-- client-chosen collision, and the uniqueness the farmer depends on would be
-- advisory only.
create or replace function public.issue_shop_join_code(
  p_dealer_id uuid,
  p_expires_at timestamptz default null,
  p_max_uses integer default 500
)
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRTUVWXY349';
  candidate text;
  attempt integer := 0;
  v_expires timestamptz := coalesce(p_expires_at, now() + interval '90 days');
begin
  if not exists (
    select 1 from public.dealer_profiles d
     where d.id = p_dealer_id
       and d.party_id = public.current_party_id()
  ) then
    raise exception 'not_shop_owner' using errcode = '42501';
  end if;

  if v_expires <= now() then
    raise exception 'code_expiry_in_the_past' using errcode = '22007';
  end if;

  loop
    attempt := attempt + 1;
        candidate := '';
      for i in 1..8 loop
        candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::integer, 1);
      end loop;

    begin
      insert into public.shop_join_codes (dealer_id, code, expires_at, max_uses)
      values (p_dealer_id, candidate, v_expires, p_max_uses);
      return query select candidate, v_expires;
      return;
    exception when unique_violation then
      -- A collision is a retry, not an error the shop owner should ever see.
      if attempt >= 10 then
        raise exception 'could_not_allocate_code' using errcode = '23505';
      end if;
    end;
  end loop;
end;
$$;

comment on function public.issue_shop_join_code(uuid, timestamptz, integer) is
  'Issues a shop code. Only the shop''s own party may call it.';

-- ---------------------------------------------------------------------------
-- 4. Joining with a code
-- ---------------------------------------------------------------------------

-- Returns what the app needs to confirm the join in words the farmer recognises,
-- and nothing else: a farmer who scanned a sticker learns which shop they joined,
-- not how many other farmers that shop has.
create or replace function public.join_shop_with_code(p_code text)
returns table (dealer_id uuid, shop_name text, already_joined boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_party uuid := public.current_party_id();
  v_code public.shop_join_codes%rowtype;
  v_name text;
  v_exists boolean;
begin
  if v_party is null then
    raise exception 'not_signed_in' using errcode = '42501';
  end if;

  if not exists (select 1 from public.farmer_profiles f where f.party_id = v_party) then
    raise exception 'not_a_farmer' using errcode = '42501';
  end if;

  select c.* into v_code
    from public.shop_join_codes c
   where c.code = upper(regexp_replace(coalesce(p_code, ''), '[\s-]', '', 'g'))
     for update;

  if not found then
    raise exception 'unknown_code' using errcode = 'P0002';
  end if;

  if v_code.revoked_at is not null then
    raise exception 'code_revoked' using errcode = 'P0002';
  end if;

  if v_code.expires_at <= now() then
    raise exception 'code_expired' using errcode = 'P0002';
  end if;

  if v_code.uses >= v_code.max_uses then
    raise exception 'code_exhausted' using errcode = 'P0002';
  end if;

  select d.shop_name into v_name from public.dealer_profiles d where d.id = v_code.dealer_id;

  select exists (
    select 1 from public.dealer_farmer_links l
     where l.dealer_id = v_code.dealer_id
       and l.farmer_id = v_party
  ) into v_exists;

  if v_exists then
    -- Scanning the same sticker twice is the most likely thing a farmer does.
    -- It is not an error and it must not burn a use.
    return query select v_code.dealer_id, v_name, true;
    return;
  end if;

  insert into public.dealer_farmer_links (dealer_id, farmer_id, established_by, source_id)
  values (v_code.dealer_id, v_party, 'shop_qr', v_code.id);

  update public.shop_join_codes c
     set uses = c.uses + 1
   where c.id = v_code.id;

  return query select v_code.dealer_id, v_name, false;
end;
$$;

comment on function public.join_shop_with_code(text) is
  'Joins the calling farmer to the shop that owns the code. Idempotent: a repeat scan reports already_joined without consuming another use.';

revoke all on function public.join_shop_with_code(text) from public;
grant execute on function public.join_shop_with_code(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The shop owner's phone
-- ---------------------------------------------------------------------------

-- One row per device, not per party: the same owner often has a counter phone and
-- a personal one, and a token is tied to an install that can be wiped at any time.
-- A stale token is deleted by the sender when the provider reports it gone.
create table public.device_push_tokens (
  id           uuid primary key default gen_random_uuid(),
  party_id     uuid not null references public.parties (id) on delete cascade,
  token        text not null unique check (length(token) between 16 and 4096),
  platform     text not null check (platform in ('android', 'ios', 'web')),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at   timestamptz
);

comment on table public.device_push_tokens is
  'Push registrations per device. The token is the device''s, the row is the party''s; a signed-out phone keeps no row.';

create index device_push_tokens_party_idx on public.device_push_tokens (party_id);

alter table public.device_push_tokens enable row level security;

create policy device_push_tokens_own_read on public.device_push_tokens
  for select using (party_id = public.current_party_id());

create policy device_push_tokens_own_write on public.device_push_tokens
  for insert with check (party_id = public.current_party_id());

create policy device_push_tokens_own_update on public.device_push_tokens
  for update using (party_id = public.current_party_id());

create policy device_push_tokens_own_delete on public.device_push_tokens
  for delete using (party_id = public.current_party_id());

-- Registering the same phone twice must not create two rows, or the owner gets
-- every notification twice.
create or replace function public.register_push_token(p_token text, p_platform text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_party uuid := public.current_party_id();
begin
  if v_party is null then
    raise exception 'not_signed_in' using errcode = '42501';
  end if;

  if p_platform not in ('android', 'ios', 'web') then
    raise exception 'unknown_platform' using errcode = '22023';
  end if;

  insert into public.device_push_tokens (party_id, token, platform)
  values (v_party, p_token, p_platform)
  on conflict (token) do update
     set party_id = excluded.party_id,
         platform = excluded.platform,
         last_seen_at = now(),
         revoked_at = null;
end;
$$;

grant execute on function public.register_push_token(text, text) to authenticated;
