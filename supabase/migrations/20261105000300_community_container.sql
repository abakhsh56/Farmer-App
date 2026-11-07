-- Farmer App · migration 20261105000300 · community container (M1)
--
-- WhatsApp Communities, backend only. The community container, its groups,
-- memberships, invites and join requests. The UI stays the app's own design;
-- this is the backend that must match WhatsApp Communities, each and every
-- feature, in every way.
--
-- Structure (WhatsApp model):
--   * a Community is an umbrella over groups, with one admin-only announcement
--     group on top (auto-created) and one general group (auto-created).
--   * sub-groups are the two-way conversation spaces (membership spaces).
--   * announcement membership is DERIVED from community membership, never
--     stored: a party who is an active member of a community IS a member of
--     its announcement group. Leaving the community therefore ends
--     announcement access automatically, which is the WhatsApp rule.
--
-- Limits (WhatsApp Help Center, Nov 2026): 100 groups per community, 2,000
-- members per community, 1,024 members per group, 20 admins per community,
-- names <= 100 chars. Enforced in the database (CHECKs for static values,
-- count checks inside the RPCs for counts), not in the UI.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.communities (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (length(btrim(name)) between 1 and 100),
  description     text,
  icon_media_id   uuid references public.media_assets (id),
  owner_id        uuid not null references public.parties (id),
  -- Who created it. The creator becomes the owner; after a transfer the
  -- creator (now an admin) may still deactivate, which is the WhatsApp rule.
  created_by      uuid references public.parties (id),
  -- AB has not decided whether posts show to all app users or only to users
  -- in the poster's location; he decides later. This is the switchable rule,
  -- default location-scoped per the core aim. One column; the feed honours
  -- it; no rework when he decides.
  visibility_scope text not null default 'location' check (visibility_scope in ('location', 'global')),
  -- WhatsApp is invite-only by default. Guests may read a public
  -- community's visible groups; an invite-only community is not listed to
  -- non-members. This keeps the PRD guest-read rule and the WhatsApp
  -- invite-only rule both true.
  join_policy     text not null default 'invite_only' check (join_policy in ('public', 'invite_only')),
  -- Who may create a new group: every member, or admins only.
  group_creation  text not null default 'members' check (group_creation in ('members', 'admins')),
  is_active       boolean not null default true,
  deactivated_at  timestamptz,
  deactivated_by  uuid references public.parties (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger communities_touch before update on public.communities
  for each row execute function public.touch_updated_at();

alter table public.communities enable row level security;

create table public.community_groups (
  id           uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities (id) on delete cascade,
  kind         text not null check (kind in ('announcement', 'general', 'group')),
  name         text not null check (length(btrim(name)) between 1 and 100),
  description  text,
  -- Visible: open to everyone in the community. Hidden: only invited
  -- members + community admins. Cannot be changed once the group has any
  -- member (enforced by the trigger in M2); to switch, remove and re-add.
  visibility   text not null default 'visible' check (visibility in ('visible', 'hidden')),
  created_by   uuid references public.parties (id),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger community_groups_touch before update on public.community_groups
  for each row execute function public.touch_updated_at();

-- Exactly one announcement group and one general group per community.
create unique index community_groups_one_announcement_idx
  on public.community_groups (community_id, kind)
  where kind = 'announcement';
create unique index community_groups_one_general_idx
  on public.community_groups (community_id, kind)
  where kind = 'general';
-- No two sub-groups share a name inside one community.
create unique index community_groups_name_idx
  on public.community_groups (community_id, name)
  where kind = 'group';

alter table public.community_groups enable row level security;

create table public.community_memberships (
  community_id uuid not null references public.communities (id) on delete cascade,
  party_id     uuid not null references public.parties (id) on delete cascade,
  role         text not null check (role in ('owner', 'admin', 'member')),
  status       text not null default 'active' check (status in ('active', 'left', 'removed', 'banned')),
  joined_via   text check (joined_via in ('invite', 'added', 'request', 'created')),
  joined_at    timestamptz not null default now(),
  left_at      timestamptz,
  primary key (community_id, party_id),
  -- The primary key already allows exactly one membership row per party per
  -- community; the status column is the lifecycle. A rejoin updates the row
  -- rather than inserting a second one. A banned party cannot rejoin.
  constraint community_memberships_left_consistency check (
    (status = 'active') = (left_at is null)
  )
);

alter table public.community_memberships enable row level security;

create table public.community_group_memberships (
  group_id   uuid not null references public.community_groups (id) on delete cascade,
  party_id   uuid not null references public.parties (id) on delete cascade,
  role       text not null default 'member' check (role in ('admin', 'member')),
  status     text not null default 'active' check (status in ('active', 'left', 'removed')),
  joined_at  timestamptz not null default now(),
  left_at    timestamptz,
  primary key (group_id, party_id),
  constraint community_group_memberships_left_consistency check (
    (status = 'active') = (left_at is null)
  )
);

comment on table public.community_group_memberships is
  'No rows for the announcement group. Announcement membership is derived from community_memberships, so leaving the community ends announcement access automatically.';

alter table public.community_group_memberships enable row level security;

create table public.community_invites (
  id           uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities (id) on delete cascade,
  -- NULL = community-wide invite; set = invite to that group.
  group_id     uuid references public.community_groups (id) on delete cascade,
  code         text not null unique,
  created_by   uuid not null references public.parties (id),
  expires_at   timestamptz,
  max_uses     integer check (max_uses is null or max_uses > 0),
  uses         integer not null default 0 check (uses >= 0),
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

alter table public.community_invites enable row level security;

create table public.community_join_requests (
  id           uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities (id) on delete cascade,
  group_id     uuid references public.community_groups (id) on delete cascade,
  party_id     uuid not null references public.parties (id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  decided_by   uuid references public.parties (id),
  decided_at   timestamptz,
  created_at   timestamptz not null default now()
);

-- One pending request per party per community/group. group_id is nullable
-- (a community-level request), so the index coalesces it to a fixed value
-- or Postgres would treat two NULLs as distinct and allow duplicates.
create unique index community_join_requests_one_pending_idx
  on public.community_join_requests (community_id, coalesce(group_id, '00000000-0000-0000-0000-000000000000'::uuid), party_id)
  where status = 'pending';

alter table public.community_join_requests enable row level security;

create table public.community_group_suggestions (
  id                   uuid primary key default gen_random_uuid(),
  community_id         uuid not null references public.communities (id) on delete cascade,
  suggested_group_name text not null check (length(btrim(suggested_group_name)) between 1 and 100),
  suggested_by         uuid not null references public.parties (id),
  status               text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  decided_by           uuid references public.parties (id),
  decided_at           timestamptz,
  created_at           timestamptz not null default now()
);

comment on table public.community_group_suggestions is
  'A member suggesting an existing group for approval. Approved suggestions appear in "Pending groups" for admins.';

alter table public.community_group_suggestions enable row level security;

-- ---------------------------------------------------------------------------
-- Alterations to existing tables
-- ---------------------------------------------------------------------------

-- A post belongs to a group AND a board. Boards stay the topic taxonomy;
-- groups are the membership spaces. Nullable in M1, backfilled below, made
-- NOT NULL in M3 once the feed is scoped.
alter table public.community_posts
  add column group_id uuid references public.community_groups (id);

-- Optional community scoping for stories later; unused in M1.
alter table public.community_stories
  add column community_id uuid references public.communities (id);

-- ---------------------------------------------------------------------------
-- Grants (mirrors migration 0013: revoke the blanket grants, then allow the
-- reads the policies describe; writes go only through the RPCs)
-- ---------------------------------------------------------------------------

revoke all on public.communities from anon;
grant select on public.communities to anon;
grant select, insert, update, delete on public.communities to authenticated;
revoke insert, update, delete on public.communities from authenticated;

revoke all on public.community_groups from anon;
grant select on public.community_groups to anon;
grant select, insert, update, delete on public.community_groups to authenticated;
revoke insert, update, delete on public.community_groups from authenticated;

revoke all on public.community_memberships from anon;
grant select, insert, update, delete on public.community_memberships to authenticated;
revoke insert, update, delete on public.community_memberships from authenticated;

revoke all on public.community_group_memberships from anon;
grant select, insert, update, delete on public.community_group_memberships to authenticated;
revoke insert, update, delete on public.community_group_memberships from authenticated;

revoke all on public.community_invites from anon;
grant select, insert, update, delete on public.community_invites to authenticated;
revoke insert, update, delete on public.community_invites from authenticated;

revoke all on public.community_join_requests from anon;
grant select, insert, update, delete on public.community_join_requests to authenticated;
revoke insert, update, delete on public.community_join_requests from authenticated;

revoke all on public.community_group_suggestions from anon;
grant select, insert, update, delete on public.community_group_suggestions to authenticated;
revoke insert, update, delete on public.community_group_suggestions from authenticated;

-- ---------------------------------------------------------------------------
-- Role helper
-- ---------------------------------------------------------------------------

-- NOTE (deviation from the plan, which says "security invoker"): this is
-- security definer, following the repo's own convention for RLS helpers
-- (current_party_id, has_capability). A security-invoker helper used inside
-- an RLS policy on community_memberships would recurse through that same
-- policy when checking whether the viewer is an admin. As a definer it reads
-- the membership row directly, so policies can call it safely. It only reads;
-- it never writes, and a role is visible to community members anyway.
create or replace function public.community_role(p_party_id uuid, p_community_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role
    from public.community_memberships
   where party_id = p_party_id
     and community_id = p_community_id
     and status = 'active'
   limit 1;
$$;

comment on function public.community_role(uuid, uuid) is
  'The caller''s role in a community: owner, admin, member, or NULL when not an active member. Security definer so RLS policies can call it without recursing through the membership policy.';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

-- Communities: guests read public ones; members read the ones they belong to.
create policy communities_read on public.communities
  for select to anon, authenticated
  using (
    is_active
    and (
      join_policy = 'public'
      or exists (
        select 1 from public.community_memberships m
         where m.community_id = communities.id
           and m.party_id = public.current_party_id()
           and m.status = 'active'
      )
    )
  );

-- Groups: anyone reads a visible group of a public community (except the
-- announcement group, which is members-only); a community member reads its
-- visible groups; a group member reads its groups; an admin/owner reads all.
create policy community_groups_read on public.community_groups
  for select to anon, authenticated
  using (
    is_active
    and exists (select 1 from public.communities c where c.id = community_groups.community_id and c.is_active)
    and (
      (community_groups.kind <> 'announcement'
       and community_groups.visibility = 'visible'
       and exists (select 1 from public.communities c where c.id = community_groups.community_id and c.join_policy = 'public'))
      or (community_groups.visibility = 'visible'
       and exists (select 1 from public.community_memberships m where m.community_id = community_groups.community_id and m.party_id = public.current_party_id() and m.status = 'active'))
      or exists (select 1 from public.community_group_memberships gm where gm.group_id = community_groups.id and gm.party_id = public.current_party_id() and gm.status = 'active')
      or public.community_role(public.current_party_id(), community_groups.community_id) in ('owner', 'admin')
    )
  );

-- Memberships: the member themselves, and the community admins/owners.
create policy community_memberships_read on public.community_memberships
  for select to authenticated
  using (
    party_id = public.current_party_id()
    or public.community_role(public.current_party_id(), community_id) in ('owner', 'admin')
  );

create policy community_group_memberships_read on public.community_group_memberships
  for select to authenticated
  using (
    party_id = public.current_party_id()
    or public.community_role(
      public.current_party_id(),
      (select community_id from public.community_groups where id = group_id)
    ) in ('owner', 'admin')
  );

-- Invites: the creator, and the community admins/owners.
create policy community_invites_read on public.community_invites
  for select to authenticated
  using (
    created_by = public.current_party_id()
    or public.community_role(public.current_party_id(), community_id) in ('owner', 'admin')
  );

-- Join requests: the requesting party, and the community admins/owners.
create policy community_join_requests_read on public.community_join_requests
  for select to authenticated
  using (
    party_id = public.current_party_id()
    or public.community_role(public.current_party_id(), community_id) in ('owner', 'admin')
  );

-- Group suggestions: the suggester, and the community admins/owners.
create policy community_group_suggestions_read on public.community_group_suggestions
  for select to authenticated
  using (
    suggested_by = public.current_party_id()
    or public.community_role(public.current_party_id(), community_id) in ('owner', 'admin')
  );

-- ---------------------------------------------------------------------------
-- Seed / backfill (idempotent)
-- ---------------------------------------------------------------------------

-- One default community. Guarded: if the parties table is empty at apply
-- time the seed is skipped and the first admin creates the community from
-- the app instead. Owner is the oldest party.
do $$
declare
  v_owner uuid;
  v_community uuid;
  v_general uuid;
begin
  select id into v_owner from public.parties order by created_at asc limit 1;

  if v_owner is null then
    raise notice 'No party exists yet; the default community seed is skipped. The first admin creates the community from the app.';
    return;
  end if;

  select id into v_community from public.communities where name = 'Farmer Community' limit 1;

  if v_community is null then
    insert into public.communities (name, description, owner_id, created_by, visibility_scope, join_policy, group_creation)
    values ('Farmer Community', 'The farmer community.', v_owner, v_owner, 'location', 'invite_only', 'members')
    returning id into v_community;
  end if;

  -- Announcement group (admin-only posting, every member is in it by derivation).
  if not exists (select 1 from public.community_groups where community_id = v_community and kind = 'announcement') then
    insert into public.community_groups (community_id, kind, name, description, visibility, created_by)
    values (v_community, 'announcement', 'Announcements', 'Announcements from the community admins.', 'visible', v_owner);
  end if;

  -- General group (the open conversation space; joining is optional).
  if not exists (select 1 from public.community_groups where community_id = v_community and kind = 'general') then
    insert into public.community_groups (community_id, kind, name, description, visibility, created_by)
    values (v_community, 'general', 'General', 'Open conversation about community topics.', 'visible', v_owner)
    returning id into v_general;
  else
    select id into v_general from public.community_groups where community_id = v_community and kind = 'general' limit 1;
  end if;

  -- The owner is a member of the community (and therefore of announcements).
  insert into public.community_memberships (community_id, party_id, role, status, joined_via)
  values (v_community, v_owner, 'owner', 'active', 'created')
  on conflict (community_id, party_id) do nothing;

  -- Existing posts belong to the general group, so no post is orphaned.
  update public.community_posts
     set group_id = v_general
   where group_id is null;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Create a community, its owner membership, its announcement group and its
-- general group, in one transaction.
create or replace function public.community_create(
  p_owner_id uuid,
  p_name text,
  p_description text default null,
  p_join_policy text default 'invite_only',
  p_visibility_scope text default 'location'
)
returns public.communities
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_community public.communities;
begin
  if p_owner_id is null then
    raise exception 'A community needs an owner.' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.parties where id = p_owner_id) then
    raise exception 'Owner % is not a party.', p_owner_id using errcode = 'no_data_found';
  end if;
  if p_join_policy not in ('public', 'invite_only') then
    raise exception 'join_policy must be public or invite_only.' using errcode = 'check_violation';
  end if;
  if p_visibility_scope not in ('location', 'global') then
    raise exception 'visibility_scope must be location or global.' using errcode = 'check_violation';
  end if;

  insert into public.communities (name, description, owner_id, created_by, visibility_scope, join_policy)
  values (p_name, p_description, p_owner_id, p_owner_id, p_visibility_scope, p_join_policy)
  returning * into v_community;

  insert into public.community_memberships (community_id, party_id, role, status, joined_via)
  values (v_community.id, p_owner_id, 'owner', 'active', 'created');

  insert into public.community_groups (community_id, kind, name, description, visibility, created_by)
  values
    (v_community.id, 'announcement', 'Announcements', 'Announcements from the community admins.', 'visible', p_owner_id),
    (v_community.id, 'general', 'General', 'Open conversation about community topics.', 'visible', p_owner_id);

  perform public.write_audit(
    'community.create', 'communities', v_community.id, v_community.name,
    null, 'active',
    jsonb_build_object('join_policy', p_join_policy, 'visibility_scope', p_visibility_scope),
    p_owner_id, 'owner'
  );

  return v_community;
end;
$$;

-- Create a sub-group. Enforces the group_creation setting, the 100-group cap
-- and the name rule. The creator becomes a group admin.
create or replace function public.community_add_group(
  p_actor_id uuid,
  p_community_id uuid,
  p_name text,
  p_description text default null,
  p_visibility text default 'visible'
)
returns public.community_groups
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_community public.communities;
  v_group public.community_groups;
  v_role text;
  v_count integer;
begin
  select * into v_community from public.communities where id = p_community_id for update;
  if not found then
    raise exception 'Community % not found.', p_community_id using errcode = 'no_data_found';
  end if;
  if not v_community.is_active then
    raise exception 'This community is deactivated.' using errcode = 'check_violation';
  end if;

  v_role := public.community_role(p_actor_id, p_community_id);
  if v_role is null then
    raise exception 'You must join the community before creating a group.' using errcode = 'insufficient_privilege';
  end if;
  if v_community.group_creation = 'admins' and v_role not in ('owner', 'admin') then
    raise exception 'Only community admins may create groups here.' using errcode = 'insufficient_privilege';
  end if;

  if p_visibility not in ('visible', 'hidden') then
    raise exception 'visibility must be visible or hidden.' using errcode = 'check_violation';
  end if;

  select count(*) into v_count
    from public.community_groups
   where community_id = p_community_id and kind = 'group' and is_active;
  if v_count >= 100 then
    raise exception 'This community already has 100 groups.' using errcode = 'check_violation';
  end if;

  insert into public.community_groups (community_id, kind, name, description, visibility, created_by)
  values (p_community_id, 'group', p_name, p_description, p_visibility, p_actor_id)
  returning * into v_group;

  insert into public.community_group_memberships (group_id, party_id, role, status)
  values (v_group.id, p_actor_id, 'admin', 'active');

  perform public.write_audit(
    'community.group_create', 'community_groups', v_group.id, v_group.name,
    null, 'active',
    jsonb_build_object('community_id', p_community_id, 'visibility', p_visibility),
    p_actor_id, v_role
  );

  return v_group;
exception
  when unique_violation then
    raise exception 'A group named % already exists in this community.', p_name using errcode = 'unique_violation';
end;
$$;

-- Join a community, by invite code or (for a public community) directly.
-- The caller is then in the announcement group by derivation. Enforces the
-- 2,000-member cap. A banned party cannot rejoin; a party who left may.
create or replace function public.community_join(
  p_party_id uuid,
  p_community_id uuid,
  p_invite_code text default null
)
returns public.community_memberships
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_community public.communities;
  v_membership public.community_memberships;
  v_invite public.community_invites;
  v_count integer;
  v_via text;
begin
  if p_party_id is null then
    raise exception 'Joining requires an identified farmer.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_community from public.communities where id = p_community_id for update;
  if not found then
    raise exception 'Community % not found.', p_community_id using errcode = 'no_data_found';
  end if;
  if not v_community.is_active then
    raise exception 'This community is deactivated.' using errcode = 'check_violation';
  end if;

  select * into v_membership
    from public.community_memberships
   where community_id = p_community_id and party_id = p_party_id;

  if found then
    if v_membership.status = 'active' then
      return v_membership;
    elsif v_membership.status = 'banned' then
      raise exception 'You are banned from this community.' using errcode = 'insufficient_privilege';
    end if;
    -- left / removed: rejoining is allowed; fall through to the checks below.
  end if;

  if p_invite_code is not null then
    select * into v_invite
      from public.community_invites
     where code = p_invite_code
       and community_id = p_community_id
       and revoked_at is null
       and (expires_at is null or expires_at > now())
       and (max_uses is null or uses < max_uses)
       for update;
    if not found then
      raise exception 'This invite is invalid, expired or used up.' using errcode = 'check_violation';
    end if;
    v_via := 'invite';
  elsif v_community.join_policy = 'public' then
    -- A public community is open; joining directly counts as an invite join.
    v_via := 'invite';
  else
    raise exception 'This community is invite-only. Ask for an invite link.' using errcode = 'insufficient_privilege';
  end if;

  if v_membership.status is distinct from 'active' then
    select count(*) into v_count
      from public.community_memberships
     where community_id = p_community_id and status = 'active';
    if v_count >= 2000 then
      raise exception 'This community is full (2,000 members).' using errcode = 'check_violation';
    end if;
  end if;

  if v_invite.id is not null then
    update public.community_invites set uses = uses + 1 where id = v_invite.id;
  end if;

  insert into public.community_memberships (community_id, party_id, role, status, joined_via)
  values (p_community_id, p_party_id, 'member', 'active', v_via)
  on conflict (community_id, party_id) do update
    set status = 'active', left_at = null, joined_via = excluded.joined_via, joined_at = now()
  returning * into v_membership;

  return v_membership;
end;
$$;

-- Join a visible sub-group. The caller must already be a community member.
-- Hidden groups are joined only by request (approved) or by an admin adding
-- the member directly; this RPC refuses them with a clear message.
create or replace function public.community_join_group(
  p_party_id uuid,
  p_group_id uuid
)
returns public.community_group_memberships
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_group public.community_groups;
  v_membership public.community_group_memberships;
  v_count integer;
begin
  if p_party_id is null then
    raise exception 'Joining a group requires an identified farmer.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_group from public.community_groups where id = p_group_id for update;
  if not found then
    raise exception 'Group % not found.', p_group_id using errcode = 'no_data_found';
  end if;
  if not v_group.is_active then
    raise exception 'This group is no longer active.' using errcode = 'check_violation';
  end if;
  if v_group.kind = 'announcement' then
    raise exception 'The announcement group is joined by joining the community.' using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from public.community_memberships m
     where m.community_id = v_group.community_id and m.party_id = p_party_id and m.status = 'active'
  ) then
    raise exception 'Join the community before joining its groups.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_membership
    from public.community_group_memberships
   where group_id = p_group_id and party_id = p_party_id;

  if found then
    if v_membership.status = 'active' then
      return v_membership;
    end if;
    -- left / removed: rejoining is allowed; fall through.
  end if;

  if v_group.visibility = 'hidden' then
    raise exception 'This group is hidden. Request to join, or ask an admin to add you.' using errcode = 'insufficient_privilege';
  end if;

  select count(*) into v_count
    from public.community_group_memberships
   where group_id = p_group_id and status = 'active';
  if v_count >= 1024 then
    raise exception 'This group is full (1,024 members).' using errcode = 'check_violation';
  end if;

  insert into public.community_group_memberships (group_id, party_id, role, status)
  values (p_group_id, p_party_id, 'member', 'active')
  on conflict (group_id, party_id) do update
    set status = 'active', left_at = null, joined_at = now()
  returning * into v_membership;

  return v_membership;
end;
$$;

-- Ask to join a community (group_id null) or one of its groups.
create or replace function public.community_request_join(
  p_party_id uuid,
  p_community_id uuid,
  p_group_id uuid default null
)
returns public.community_join_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.community_join_requests;
  v_community public.communities;
begin
  if p_party_id is null then
    raise exception 'Requesting to join requires an identified farmer.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_community from public.communities where id = p_community_id;
  if not found then
    raise exception 'Community % not found.', p_community_id using errcode = 'no_data_found';
  end if;
  if not v_community.is_active then
    raise exception 'This community is deactivated.' using errcode = 'check_violation';
  end if;

  if p_group_id is not null then
    if not exists (select 1 from public.community_groups where id = p_group_id and community_id = p_community_id) then
      raise exception 'Group % is not in this community.', p_group_id using errcode = 'no_data_found';
    end if;
  end if;

  -- Already a member: nothing to request.
  if p_group_id is null then
    if exists (select 1 from public.community_memberships where community_id = p_community_id and party_id = p_party_id and status = 'active') then
      raise exception 'You are already a member of this community.' using errcode = 'check_violation';
    end if;
  else
    if exists (select 1 from public.community_group_memberships where group_id = p_group_id and party_id = p_party_id and status = 'active') then
      raise exception 'You are already a member of this group.' using errcode = 'check_violation';
    end if;
  end if;

  -- A pending request already exists: return it (idempotent).
  select * into v_request
    from public.community_join_requests
   where community_id = p_community_id
     and group_id is not distinct from p_group_id
     and party_id = p_party_id
     and status = 'pending';
  if found then
    return v_request;
  end if;

  insert into public.community_join_requests (community_id, group_id, party_id)
  values (p_community_id, p_group_id, p_party_id)
  returning * into v_request;

  return v_request;
exception
  when unique_violation then
    select * into v_request
      from public.community_join_requests
     where community_id = p_community_id
       and group_id is not distinct from p_group_id
       and party_id = p_party_id
       and status = 'pending';
    if found then
      return v_request;
    end if;
    raise;
end;
$$;

-- Approve a join request (admin/owner). Approval creates the membership:
-- a community request makes a community member; a group request also makes
-- the party a community member first when they are not one yet.
create or replace function public.community_approve_request(
  p_actor_id uuid,
  p_request_id uuid
)
returns public.community_join_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.community_join_requests;
  v_role text;
begin
  select * into v_request from public.community_join_requests where id = p_request_id for update;
  if not found then
    raise exception 'Join request % not found.', p_request_id using errcode = 'no_data_found';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'This request has already been decided.' using errcode = 'check_violation';
  end if;

  v_role := public.community_role(p_actor_id, v_request.community_id);
  if v_role is distinct from 'owner' and v_role is distinct from 'admin' then
    raise exception 'Only community admins may approve join requests.' using errcode = 'insufficient_privilege';
  end if;

  if v_request.group_id is null then
    insert into public.community_memberships (community_id, party_id, role, status, joined_via)
    values (v_request.community_id, v_request.party_id, 'member', 'active', 'request')
    on conflict (community_id, party_id) do update
      set status = 'active', left_at = null, joined_via = 'request', joined_at = now();
  else
    -- A group member is a community member first.
    insert into public.community_memberships (community_id, party_id, role, status, joined_via)
    values (v_request.community_id, v_request.party_id, 'member', 'active', 'request')
    on conflict (community_id, party_id) do update
      set status = 'active', left_at = null, joined_via = 'request', joined_at = now();

    insert into public.community_group_memberships (group_id, party_id, role, status)
    values (v_request.group_id, v_request.party_id, 'member', 'active')
    on conflict (group_id, party_id) do update
      set status = 'active', left_at = null, joined_at = now();
  end if;

  update public.community_join_requests
     set status = 'approved', decided_by = p_actor_id, decided_at = now()
   where id = p_request_id
  returning * into v_request;

  perform public.write_audit(
    'community.request_approved', 'community_join_requests', p_request_id, null,
    'pending', 'approved',
    jsonb_build_object('community_id', v_request.community_id, 'group_id', v_request.group_id, 'party_id', v_request.party_id),
    p_actor_id, v_role
  );

  return v_request;
end;
$$;

-- Decline a join request (admin/owner). No membership is created.
create or replace function public.community_decline_request(
  p_actor_id uuid,
  p_request_id uuid
)
returns public.community_join_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.community_join_requests;
  v_role text;
begin
  select * into v_request from public.community_join_requests where id = p_request_id for update;
  if not found then
    raise exception 'Join request % not found.', p_request_id using errcode = 'no_data_found';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'This request has already been decided.' using errcode = 'check_violation';
  end if;

  v_role := public.community_role(p_actor_id, v_request.community_id);
  if v_role is distinct from 'owner' and v_role is distinct from 'admin' then
    raise exception 'Only community admins may decline join requests.' using errcode = 'insufficient_privilege';
  end if;

  update public.community_join_requests
     set status = 'declined', decided_by = p_actor_id, decided_at = now()
   where id = p_request_id
  returning * into v_request;

  perform public.write_audit(
    'community.request_declined', 'community_join_requests', p_request_id, null,
    'pending', 'declined',
    jsonb_build_object('community_id', v_request.community_id, 'group_id', v_request.group_id, 'party_id', v_request.party_id),
    p_actor_id, v_role
  );

  return v_request;
end;
$$;

-- Leave a community. Removes the member from everything, including
-- announcements (announcement membership is derived, so it ends here).
create or replace function public.community_leave(
  p_party_id uuid,
  p_community_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.community_memberships
     set status = 'left', left_at = now()
   where community_id = p_community_id and party_id = p_party_id and status = 'active';

  update public.community_group_memberships gm
     set status = 'left', left_at = now()
    from public.community_groups g
   where gm.group_id = g.id
     and g.community_id = p_community_id
     and gm.party_id = p_party_id
     and gm.status = 'active';
end;
$$;

-- Leave one group only. Community membership (and announcements) remain.
create or replace function public.community_leave_group(
  p_party_id uuid,
  p_group_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.community_group_memberships
     set status = 'left', left_at = now()
   where group_id = p_group_id and party_id = p_party_id and status = 'active';
end;
$$;

-- Create an invite link (admin/owner). Returns the invite row with its code.
create or replace function public.community_invite_create(
  p_actor_id uuid,
  p_community_id uuid,
  p_group_id uuid default null,
  p_expires_at timestamptz default null,
  p_max_uses integer default null
)
returns public.community_invites
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite public.community_invites;
  v_role text;
begin
  v_role := public.community_role(p_actor_id, p_community_id);
  if v_role is distinct from 'owner' and v_role is distinct from 'admin' then
    raise exception 'Only community admins may create invites.' using errcode = 'insufficient_privilege';
  end if;

  if p_group_id is not null then
    if not exists (select 1 from public.community_groups where id = p_group_id and community_id = p_community_id) then
      raise exception 'Group % is not in this community.', p_group_id using errcode = 'no_data_found';
    end if;
  end if;

  if p_max_uses is not null and p_max_uses <= 0 then
    raise exception 'max_uses must be positive.' using errcode = 'check_violation';
  end if;

  insert into public.community_invites (community_id, group_id, code, created_by, expires_at, max_uses)
  values (p_community_id, p_group_id, gen_random_uuid()::text, p_actor_id, p_expires_at, p_max_uses)
  returning * into v_invite;

  return v_invite;
end;
$$;
