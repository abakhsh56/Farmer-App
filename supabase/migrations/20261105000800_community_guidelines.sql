-- Farmer App · migration 20261105000800 · versioned guidelines + consent gate (M6)
--
-- Versioned community guidelines. A farmer may not post or reply until he
-- has accepted the current guideline version; the gate lives in a shared
-- helper called from the posting RPCs.
--
-- Coverage note: the gate is added to the 9-argument community_create_post
-- (M3, reproduced here verbatim plus the gate) and to
-- community_create_reply (M3, likewise). The 8-argument create_post (M3)
-- and the 15-argument rate-aware create_post (M4) both delegate to the
-- 9-argument creator, so they inherit the gate with no change of their own.
-- No default community or groups are re-seeded here (M1 already did that).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.community_guidelines (
  id             uuid primary key default gen_random_uuid(),
  version        integer not null unique,
  title          text not null,
  body_en        text not null,
  body_ur        text not null,
  effective_from timestamptz not null default now(),
  created_by     uuid references public.parties (id) on delete set null,
  created_at     timestamptz not null default now()
);

alter table public.community_guidelines enable row level security;

create table public.community_guideline_consents (
  party_id          uuid not null references public.parties (id) on delete cascade,
  guideline_version integer not null,
  consented_at      timestamptz not null default now(),
  primary key (party_id, guideline_version)
);

alter table public.community_guideline_consents enable row level security;

-- ---------------------------------------------------------------------------
-- Grants + RLS (consents are written only through the accept RPC)
-- ---------------------------------------------------------------------------

-- Guidelines are terms: anyone, including a guest deciding whether to join,
-- may read them.
revoke all on public.community_guidelines from anon;
grant select on public.community_guidelines to anon, authenticated;

revoke all on public.community_guideline_consents from anon;
grant select, insert, update, delete on public.community_guideline_consents to authenticated;
revoke insert, update, delete on public.community_guideline_consents from authenticated;

create policy community_guidelines_read on public.community_guidelines
  for select to anon, authenticated
  using (true);

-- A farmer reads only his own consents.
create policy community_guideline_consents_read_own on public.community_guideline_consents
  for select to authenticated
  using (party_id = public.current_party_id());

-- ---------------------------------------------------------------------------
-- Helpers + accept RPC
-- ---------------------------------------------------------------------------

-- The current guideline version: the highest published version, or NULL
-- when no guideline exists yet (posting stays open until one is published).
create or replace function public.community_current_guideline_version()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select max(version) from public.community_guidelines;
$$;

create or replace function public.community_has_accepted_guidelines(p_party_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.community_guideline_consents c
     where c.party_id = p_party_id
       and c.guideline_version = public.community_current_guideline_version()
  );
$$;

-- Refuse posting until the current guideline version is accepted. Called
-- from community_create_post and community_create_reply. Fails open when no
-- guideline version exists yet.
create or replace function public.community_require_guidelines(p_party_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_version integer;
begin
  v_version := public.community_current_guideline_version();
  if v_version is null then
    return;
  end if;
  if not public.community_has_accepted_guidelines(p_party_id) then
    raise exception 'Please accept the community guidelines (version %) before posting.', v_version
      using errcode = 'insufficient_privilege';
  end if;
end;
$$;

-- Accept a guideline version. Called on first join and whenever a new
-- version is published. Re-accepting the same version is a no-op.
create or replace function public.community_accept_guidelines(
  p_party_id uuid,
  p_version integer
)
returns public.community_guideline_consents
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_consent public.community_guideline_consents;
begin
  if p_party_id is null then
    raise exception 'Accepting the guidelines requires an identified farmer.' using errcode = 'insufficient_privilege';
  end if;
  if p_version is null or not exists (
    select 1 from public.community_guidelines where version = p_version
  ) then
    raise exception 'Guideline version % does not exist.', p_version using errcode = 'no_data_found';
  end if;

  insert into public.community_guideline_consents (party_id, guideline_version)
  values (p_party_id, p_version)
  on conflict (party_id, guideline_version) do nothing
  returning * into v_consent;

  if not found then
    select * into v_consent
      from public.community_guideline_consents
     where party_id = p_party_id and guideline_version = p_version;
  end if;

  return v_consent;
end;
$$;

-- ---------------------------------------------------------------------------
-- Posting gate (M3 creators, reproduced verbatim plus the guideline check)
-- ---------------------------------------------------------------------------

-- The group-aware post creator, as in M3, with one addition: the guideline
-- check right after the identified-farmer check. The 8-argument and the
-- 15-argument (M4) overloads delegate here, so they are gated too.
create or replace function public.community_create_post(
  p_author_id uuid,
  p_board_code text,
  p_title text,
  p_body text,
  p_crop_code text default null,
  p_area_label text default null,
  p_language text default 'ur',
  p_idempotency_key text default null,
  p_group_id uuid default null
)
returns public.community_posts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_post public.community_posts;
  v_name text;
  v_group_id uuid;
  v_group_kind text;
  v_group_community_id uuid;
  v_group_active boolean;
  v_role text;
begin
  if p_author_id is null then
    raise exception 'Posting requires an identified farmer.' using errcode = 'insufficient_privilege';
  end if;

  -- M6: posting is refused until the current guideline version is accepted.
  perform public.community_require_guidelines(p_author_id);

  if p_group_id is null then
    v_group_id := public.community_default_general_group_id();
    if v_group_id is null then
      raise exception 'No default community group is available to post in.' using errcode = 'no_data_found';
    end if;
  else
    v_group_id := p_group_id;
  end if;

  select kind, community_id, is_active
    into v_group_kind, v_group_community_id, v_group_active
    from public.community_groups
   where id = v_group_id;
  if not found then
    raise exception 'Group % not found.', v_group_id using errcode = 'no_data_found';
  end if;
  if not v_group_active then
    raise exception 'This group is no longer active.' using errcode = 'check_violation';
  end if;

  if v_group_kind = 'announcement' then
    v_role := public.community_role(p_author_id, v_group_community_id);
    if v_role is distinct from 'owner' and v_role is distinct from 'admin' then
      raise exception 'Only community admins may post announcements.' using errcode = 'insufficient_privilege';
    end if;
  elsif v_group_kind = 'general' then
    if not exists (
      select 1 from public.community_memberships m
       where m.community_id = v_group_community_id and m.party_id = p_author_id and m.status = 'active'
    ) then
      raise exception 'You must join the community before posting.' using errcode = 'insufficient_privilege';
    end if;
    insert into public.community_group_memberships (group_id, party_id, role, status)
    values (v_group_id, p_author_id, 'member', 'active')
    on conflict (group_id, party_id) do update
      set status = 'active', left_at = null;
  else
    if not exists (
      select 1 from public.community_group_memberships gm
       where gm.group_id = v_group_id and gm.party_id = p_author_id and gm.status = 'active'
    ) then
      raise exception 'You must join this group before posting in it.' using errcode = 'insufficient_privilege';
    end if;
  end if;

  select display_name into v_name from public.parties where id = p_author_id;

  insert into public.community_posts (
    board_code, author_id, author_name, title, body, crop_code, area_label, language, idempotency_key, group_id
  ) values (
    p_board_code, p_author_id, coalesce(v_name, 'Farmer'), p_title, p_body, p_crop_code, p_area_label, p_language, p_idempotency_key, v_group_id
  )
  returning * into v_post;

  return v_post;
exception
  when unique_violation then
    -- Offline queue replaying the same post.
    select * into v_post
      from public.community_posts
     where author_id = p_author_id and idempotency_key = p_idempotency_key;
    if found then
      return v_post;
    end if;
    raise;
end;
$$;

-- Replies, as in M3, with the same guideline check added.
create or replace function public.community_create_reply(
  p_author_id uuid,
  p_post_id uuid,
  p_body text,
  p_parent_id uuid default null,
  p_idempotency_key text default null
)
returns public.community_replies
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reply public.community_replies;
  v_name  text;
  v_post  public.community_posts;
begin
  if p_author_id is null then
    raise exception 'Replying requires an identified farmer.' using errcode = 'insufficient_privilege';
  end if;

  -- M6: replying is refused until the current guideline version is accepted.
  perform public.community_require_guidelines(p_author_id);

  select * into v_post from public.community_posts where id = p_post_id;
  if not found then
    raise exception 'Post % not found.', p_post_id using errcode = 'no_data_found';
  end if;

  if v_post.hidden_at is not null then
    raise exception 'This post has been hidden and is closed to replies.' using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from public.community_groups g
     where g.id = v_post.group_id and g.kind = 'announcement'
  ) then
    raise exception 'Announcements are read-only; you cannot reply to them.' using errcode = 'check_violation';
  end if;

  select display_name into v_name from public.parties where id = p_author_id;

  insert into public.community_replies (post_id, parent_id, author_id, author_name, body, idempotency_key)
  values (p_post_id, p_parent_id, p_author_id, coalesce(v_name, 'Farmer'), p_body, p_idempotency_key)
  returning * into v_reply;

  return v_reply;
exception
  when unique_violation then
    select * into v_reply
      from public.community_replies
     where author_id = p_author_id and idempotency_key = p_idempotency_key;
    if found then
      return v_reply;
    end if;
    raise;
end;
$$;

-- ---------------------------------------------------------------------------
-- Seed: v1 guidelines (one row; no community/group re-seed — M1 did that)
-- ---------------------------------------------------------------------------

insert into public.community_guidelines (version, title, body_en, body_ur, effective_from, created_by)
values (
  1,
  'Farmer Community Guidelines',
  'Be respectful to every farmer. Share only rates and advice you believe are true. No spam, no ads, and no buying or selling outside the community rules. Follow the law of your area. Admins may remove posts that break these rules.',
  'ہر کسان کا احترام کریں۔ صرف وہی نرخ اور مشورہ شیئر کریں جسے آپ سچ سمجھتے ہوں۔ کوئی سپیم، کوئی اشتہار، اور کمیونٹی کے اصولوں کے خلاف کوئی خرید و فروخت نہیں۔ اپنے علاقے کے قانون کی پابندی کریں۔ ایڈمن ان اصولوں کے خلاف پوسٹس ہٹا سکتے ہیں۔',
  now(),
  null
)
on conflict (version) do nothing;
