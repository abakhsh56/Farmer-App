-- Farmer App · migration 20261105000900 · dealer messaging transport (Phase 4)
--
-- Phase 4 credit flows need the farmer and the shop owner to talk about a
-- credit request (or a field visit) inside the app. Until now there was no
-- dealer messaging table at all: the only message-shaped rows were
-- notification_events (one-way pings) and community posts/replies (public).
-- This migration adds the missing transport and nothing else.
--
-- Design, following the existing patterns:
--   * one row per message, append-only; no update/delete path for clients
--     (same as credit_decisions / credit_consents: writes go through an RPC).
--   * parties are the same ids the credit and visit flows use: farmer_id is a
--     farmer_profiles party_id, dealer_id is a dealer_profiles id, and the
--     dealer's party is reached via dealer_profiles.party_id (migration 0002).
--   * RLS mirrors credit_requests_party_read (migration 0013): only the
--     farmer and the dealer in that thread (plus admin) can read it.
--   * sending a message is an explicit act, so the first message establishes
--     the dealer_farmer_links row with established_by='farmer_initiated_message'
--     -- that enum value has existed since migration 0002, waiting for this.
--   * transport is PostgREST realtime on this table, falling back to polling
--     by created_at (see the comment on the publication block below). There
--     is deliberately no separate realtime service to build or run.
--
-- Deliberately NOT in this migration:
--   * request_field_visit and every credit_* RPC already exist and are
--     already granted to `authenticated` in migration 0013 (lines 520-542);
--     verified against the migration sources on development, no wiring fix
--     was needed, so no grant is re-issued here.
--   * no notification_events insert: that table's kind values were not
--     verified in this pass, and a wrong kind would fail the send. If a
--     'dealer_message' notification is wanted, add it once the kind list
--     is confirmed (see SELFTEST.md).

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table public.dealer_messages (
  id                uuid primary key default gen_random_uuid(),
  dealer_id         uuid not null references public.dealer_profiles (id) on delete cascade,
  farmer_id         uuid not null references public.farmer_profiles (party_id) on delete cascade,
  sender_party_id   uuid not null references public.parties (id) on delete cascade,
  -- Which side of the thread sent it; the credit_actor_role enum is reused
  -- so 'farmer' / 'shop_owner' mean the same thing everywhere.
  sender_role       public.credit_actor_role not null,
  -- Derived from sender_role, never supplied by the caller, so the two can
  -- never disagree. Kept as a column (not computed client-side) because the
  -- thread list filters and displays on it.
  direction         text generated always as (
    case when sender_role = 'farmer' then 'farmer_to_dealer' else 'dealer_to_farmer' end
  ) stored,
  body              text not null check (length(btrim(body)) between 1 and 2000),
  -- Optional context: the credit request or field visit this message is
  -- about. Nullable on purpose: a thread may start before either exists
  -- (e.g. "can I pay in two parts?"), and the link is informational, not
  -- a workflow state.
  credit_request_id uuid references public.credit_requests (id) on delete set null,
  visit_id          uuid references public.field_visits (id) on delete set null,
  created_at        timestamptz not null default now()
  -- NOTE: no CHECK constrains credit_request_id / visit_id to this thread:
  -- Postgres CHECK constraints cannot contain subqueries. The belonging
  -- check lives in dealer_send_message, which refuses a context id from
  -- another farmer/dealer pair before inserting.
);

create index dealer_messages_thread_idx
  on public.dealer_messages (farmer_id, dealer_id, created_at desc);
create index dealer_messages_credit_request_idx
  on public.dealer_messages (credit_request_id, created_at) where credit_request_id is not null;
create index dealer_messages_visit_idx
  on public.dealer_messages (visit_id, created_at) where visit_id is not null;

comment on table public.dealer_messages is
  'Append-only farmer <-> shop-owner messages. Transport is PostgREST realtime on this table, or polling by created_at; there is no separate realtime service.';

-- ---------------------------------------------------------------------------
-- RLS: only the farmer and the dealer in that thread can read it
-- ---------------------------------------------------------------------------

alter table public.dealer_messages enable row level security;

create policy dealer_messages_thread_read on public.dealer_messages
  for select to authenticated
  using (
    farmer_id = public.current_farmer_id()
    or dealer_id in (select dp.id from public.dealer_profiles dp where dp.party_id = public.current_party_id())
    or public.has_capability('admin')
  );

-- Every write goes through dealer_send_message, which checks the sender is
-- actually a party to the thread. There is no direct insert, update or
-- delete path for a client, exactly as for credit_requests (migration 0013).
revoke insert, update, delete on public.dealer_messages from authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: opt the table into the supabase_realtime publication
-- ---------------------------------------------------------------------------
-- Realtime transport: a client subscribes to postgres_changes on
-- public.dealer_messages filtered by farmer_id / dealer_id. Polling fallback
-- is a plain select ordered by created_at (RLS already scopes it to the
-- caller's threads), so a client that cannot hold a realtime channel still
-- sees every message. Guarded so re-applying the migration is a no-op.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'dealer_messages'
  ) then
    alter publication supabase_realtime add table public.dealer_messages;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Send entry point
-- ---------------------------------------------------------------------------

create or replace function public.dealer_send_message(
  p_dealer_id         uuid,
  p_farmer_id         uuid,
  p_body              text,
  p_credit_request_id uuid default null,
  p_visit_id          uuid default null
)
returns public.dealer_messages
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor       uuid := public.current_party_id();
  v_dealer      public.dealer_profiles;
  v_role        public.credit_actor_role;
  v_message     public.dealer_messages;
begin
  if v_actor is null then
    raise exception 'A signed-in party is required to send a dealer message.'
      using errcode = 'insufficient_privilege';
  end if;

  if p_body is null or length(btrim(p_body)) < 1 or length(btrim(p_body)) > 2000 then
    raise exception 'A message must be between 1 and 2000 characters.'
      using errcode = 'check_violation';
  end if;

  select * into v_dealer from public.dealer_profiles where id = p_dealer_id;
  if not found then
    raise exception 'Dealer % not found.', p_dealer_id using errcode = 'no_data_found';
  end if;

  if not exists (select 1 from public.farmer_profiles where party_id = p_farmer_id) then
    raise exception 'Farmer % not found.', p_farmer_id using errcode = 'no_data_found';
  end if;

  -- The sender must be a party to this thread: either the farmer themself,
  -- or the dealer (via the dealer's party id). Anyone else is refused here,
  -- not by the policy alone. Unlike credit_submit_request / request_field_visit,
  -- which trust a caller-supplied farmer id, the sender here is derived from
  -- auth, so a caller cannot send as the other side.
  if v_actor = p_farmer_id then
    v_role := 'farmer';
  elsif v_dealer.party_id is not null and v_actor = v_dealer.party_id then
    v_role := 'shop_owner';
  elsif public.has_capability('admin') then
    -- Admins may send on behalf of the shop only for support, audited below.
    v_role := 'shop_owner';
  else
    raise exception 'Only the farmer or the dealer in this thread may send a message.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Context, when given, must belong to this exact farmer/dealer pair; this
  -- is the only enforcement (a CHECK cannot hold a subquery), so it runs
  -- here before the insert rather than in the table definition.
  if p_credit_request_id is not null and not exists (
    select 1 from public.credit_requests r
    where r.id = p_credit_request_id and r.farmer_id = p_farmer_id and r.dealer_id = p_dealer_id
  ) then
    raise exception 'Credit request % does not belong to this farmer and dealer.', p_credit_request_id
      using errcode = 'check_violation';
  end if;

  if p_visit_id is not null and not exists (
    select 1 from public.field_visits v
    where v.id = p_visit_id and v.farmer_id = p_farmer_id and v.dealer_id = p_dealer_id
  ) then
    raise exception 'Field visit % does not belong to this farmer and dealer.', p_visit_id
      using errcode = 'check_violation';
  end if;

  insert into public.dealer_messages (
    dealer_id, farmer_id, sender_party_id, sender_role, body, credit_request_id, visit_id
  ) values (
    p_dealer_id, p_farmer_id, v_actor, v_role, btrim(p_body), p_credit_request_id, p_visit_id
  )
  returning * into v_message;

  -- First message establishes the dealer/farmer link, exactly as a field
  -- visit or a credit request does. Later messages are a no-op here.
  insert into public.dealer_farmer_links (dealer_id, farmer_id, established_by, source_id)
  values (p_dealer_id, p_farmer_id, 'farmer_initiated_message', v_message.id)
  on conflict do nothing;

  perform public.write_audit(
    'dealer.message_sent', 'dealer_messages', v_message.id, p_dealer_id::text,
    null, v_role::text,
    jsonb_build_object('farmer_id', p_farmer_id, 'credit_request_id', p_credit_request_id, 'visit_id', p_visit_id)
  );

  return v_message;
end;
$$;

comment on function public.dealer_send_message(uuid, uuid, text, uuid, uuid) is
  'Sends one message in a farmer/dealer thread. Sender is derived from auth (never caller-supplied); the first message creates the dealer_farmer_links row with established_by=farmer_initiated_message. Read path is a direct select on dealer_messages under RLS, via realtime or polling by created_at.';

grant execute on function public.dealer_send_message(uuid, uuid, text, uuid, uuid) to authenticated;
