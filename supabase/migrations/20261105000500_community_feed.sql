-- Farmer App · migration 20261105000500 · announcements and the scoped feed (M3)
--
-- Announcements are posts in the announcement group, not a separate table.
-- The feed is scoped by group membership (a member of one group cannot see
-- another group's posts), by the community's visibility scope (location or
-- global, switchable per AB's undecided decision), and by the guest rule
-- (public communities' visible groups stay guest-readable).
--
-- Backward compatibility: the old 4-argument community_feed keeps working;
-- with no group argument it reads the default community's general group (the
-- current global feed becomes that group's feed). Existing posts were
-- backfilled into the general group in M1, so no post is orphaned.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- The default community: the seeded 'Farmer Community' first, else the
-- oldest active community.
create or replace function public.community_default_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select id
    from public.communities
   where is_active
   order by (name = 'Farmer Community') desc, created_at asc
   limit 1;
$$;

create or replace function public.community_general_group_id(p_community_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select id
    from public.community_groups
   where community_id = p_community_id
     and kind = 'general'
     and is_active
   limit 1;
$$;

create or replace function public.community_default_general_group_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.community_general_group_id(public.community_default_id());
$$;

-- ---------------------------------------------------------------------------
-- Posting (extended: group-aware)
-- ---------------------------------------------------------------------------

-- The group-aware post creator. The 8-argument version below delegates here.
--   * announcement group: owner/admin only.
--   * general group: any active community member; auto-joins them as a group
--     member on first post, so group membership stays consistent.
--   * sub-group: must already be an active group member.
--   * no group given: the default community's general group.
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

-- The old 8-argument signature keeps working; it posts to the default
-- community's general group.
create or replace function public.community_create_post(
  p_author_id uuid,
  p_board_code text,
  p_title text,
  p_body text,
  p_crop_code text default null,
  p_area_label text default null,
  p_language text default 'ur',
  p_idempotency_key text default null
)
returns public.community_posts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.community_create_post(
    p_author_id, p_board_code, p_title, p_body, p_crop_code, p_area_label, p_language, p_idempotency_key, null::uuid
  );
end;
$$;

-- Replies are refused in the announcement group (members react, they do not
-- reply, which is the WhatsApp rule). Everything else is unchanged.
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
-- The scoped feed
-- ---------------------------------------------------------------------------

-- The group-aware feed. Filtering, in order: hidden/deleted excluded; group
-- or community filter; membership rule (group member, or community member
-- for announcements, or public community + visible group, or community
-- admin); location rule when the scope is location; blocks filter.
--   * scope 'location': the post author's area must be within the viewer's
--     location + range (the farmer's default location and radius_km). A
--     viewer with no location set falls back to global for that viewer. A
--     post whose author has no location is shown rather than silently
--     hidden (fail open, documented: the scope is the viewer's setting,
--     and hiding a farmer's post because they have not set a location yet
--     would be a silent suppression).
--   * scope 'global': no location filter.
--   * no group or community given: the default community's general group.
create or replace function public.community_feed(
  p_farmer_id uuid,
  p_board text,
  p_limit integer,
  p_before timestamptz,
  p_group_id uuid,
  p_community_id uuid,
  p_scope text
)
returns table (
  post_id      uuid,
  board_code   text,
  author_name  text,
  title        text,
  body         text,
  crop_code    text,
  area_label   text,
  reply_count  integer,
  reaction_count integer,
  is_mine      boolean,
  created_at   timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_group_id uuid;
  v_group_kind text;
  v_community_id uuid;
  v_community_scope text;
  v_scope text;
  v_viewer_geog extensions.geography;
  v_radius_m integer;
begin
  -- Resolve the group and community.
  if p_group_id is not null then
    select g.id, g.kind, g.community_id
      into v_group_id, v_group_kind, v_community_id
      from public.community_groups g
     where g.id = p_group_id;
    if not found then
      raise exception 'Group % not found.', p_group_id using errcode = 'no_data_found';
    end if;
    select c.visibility_scope into v_community_scope
      from public.communities c where c.id = v_community_id;
  elsif p_community_id is not null then
    select c.id, c.visibility_scope
      into v_community_id, v_community_scope
      from public.communities c
     where c.id = p_community_id;
    if not found then
      raise exception 'Community % not found.', p_community_id using errcode = 'no_data_found';
    end if;
  else
    v_community_id := public.community_default_id();
    if v_community_id is not null then
      select c.visibility_scope into v_community_scope
        from public.communities c where c.id = v_community_id;
      select g.id, g.kind into v_group_id, v_group_kind
        from public.community_groups g
       where g.community_id = v_community_id and g.kind = 'general' and g.is_active
       limit 1;
    end if;
  end if;

  v_scope := coalesce(p_scope, v_community_scope, 'location');
  if v_scope not in ('location', 'global') then
    raise exception 'Scope must be location or global.' using errcode = 'check_violation';
  end if;

  -- The viewer's location and range, for the location rule.
  if p_farmer_id is not null then
    select f.geog into v_viewer_geog
      from public.farmer_profiles f where f.party_id = p_farmer_id;
    select radius_km into v_radius_m
      from public.farmer_search_settings where farmer_id = p_farmer_id;
    v_radius_m := coalesce(v_radius_m, 10) * 1000;
  end if;

  return query
  select
    p.id,
    p.board_code,
    p.author_name,
    p.title,
    p.body,
    p.crop_code,
    p.area_label,
    p.reply_count,
    p.reaction_count,
    (p_farmer_id is not null and p.author_id = p_farmer_id),
    p.created_at
  from public.community_posts p
  join public.community_groups g on g.id = p.group_id
  join public.communities c on c.id = g.community_id
  left join public.farmer_profiles ap on ap.party_id = p.author_id
  where p.deleted_at is null
    and p.hidden_at is null
    and g.is_active
    and c.is_active
    and (p_board is null or p.board_code = p_board)
    and (p_before is null or p.created_at < p_before)
    and (p_group_id is null or p.group_id = p_group_id)
    and (p_community_id is null or g.community_id = p_community_id)
    and ((p_group_id is not null or p_community_id is not null)
         or (v_group_id is not null and p.group_id = v_group_id))
    and (
      exists (select 1 from public.community_group_memberships gm where gm.group_id = p.group_id and gm.party_id = p_farmer_id and gm.status = 'active')
      or (g.kind = 'announcement' and exists (select 1 from public.community_memberships m where m.community_id = g.community_id and m.party_id = p_farmer_id and m.status = 'active'))
      or (c.join_policy = 'public' and g.visibility = 'visible' and g.kind <> 'announcement')
      or public.community_role(p_farmer_id, g.community_id) in ('owner', 'admin')
    )
    and (
      v_scope = 'global'
      or v_viewer_geog is null
      or ap.geog is null
      or extensions.ST_DWithin(ap.geog, v_viewer_geog, v_radius_m)
    )
    and not exists (
      select 1 from public.community_blocks b
       where p_farmer_id is not null
         and b.blocker_id = p_farmer_id
         and b.blocked_id = p.author_id
    )
  order by p.created_at desc
  limit greatest(1, least(p_limit, 100));
end;
$$;

-- The old 4-argument signature keeps working; it reads the default
-- community's general group.
create or replace function public.community_feed(
  p_farmer_id uuid default null,
  p_board text default null,
  p_limit integer default 30,
  p_before timestamptz default null
)
returns table (
  post_id      uuid,
  board_code   text,
  author_name  text,
  title        text,
  body         text,
  crop_code    text,
  area_label   text,
  reply_count  integer,
  reaction_count integer,
  is_mine      boolean,
  created_at   timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  select * from public.community_feed(
    p_farmer_id, p_board, p_limit, p_before, null::uuid, null::uuid, null::text
  );
end;
$$;

-- Group discovery inside a community: visible groups, hidden groups the
-- party is in, plus groups the party has requested to join (marked
-- requested). Newest first, then by member count — the WhatsApp ordering.
create or replace function public.community_groups_for_member(
  p_party_id uuid,
  p_community_id uuid
)
returns table (
  group_id     uuid,
  name         text,
  description  text,
  visibility   text,
  member_count bigint,
  is_member    boolean,
  has_requested boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with groups as (
    select
      g.id as group_id,
      g.name,
      g.description,
      g.visibility,
      g.created_at,
      (select count(*) from public.community_group_memberships gm where gm.group_id = g.id and gm.status = 'active') as member_count,
      exists (select 1 from public.community_group_memberships gm where gm.group_id = g.id and gm.party_id = p_party_id and gm.status = 'active') as is_member,
      exists (select 1 from public.community_join_requests r where r.group_id = g.id and r.party_id = p_party_id and r.status = 'pending') as has_requested
    from public.community_groups g
    where g.community_id = p_community_id
      and g.is_active
      and g.kind <> 'announcement'
      and (
        g.visibility = 'visible'
        or exists (select 1 from public.community_group_memberships gm where gm.group_id = g.id and gm.party_id = p_party_id and gm.status = 'active')
        or public.community_role(p_party_id, p_community_id) in ('owner', 'admin')
        or exists (select 1 from public.community_join_requests r where r.group_id = g.id and r.party_id = p_party_id and r.status = 'pending')
      )
  )
  select group_id, name, description, visibility, member_count, is_member, has_requested
    from groups
   order by created_at desc, member_count desc;
$$;

-- The announcements for every community the farmer belongs to, newest
-- first. The one broadcast surface. Members only; no guest access.
create or replace function public.community_announcement_feed(
  p_party_id uuid,
  p_limit integer default 30,
  p_before timestamptz default null
)
returns table (
  post_id      uuid,
  board_code   text,
  author_name  text,
  title        text,
  body         text,
  crop_code    text,
  area_label   text,
  reply_count  integer,
  reaction_count integer,
  is_mine      boolean,
  created_at   timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p.id,
    p.board_code,
    p.author_name,
    p.title,
    p.body,
    p.crop_code,
    p.area_label,
    p.reply_count,
    p.reaction_count,
    (p.author_id = p_party_id),
    p.created_at
  from public.community_posts p
  join public.community_groups g on g.id = p.group_id
  join public.communities c on c.id = g.community_id
  where p.deleted_at is null
    and p.hidden_at is null
    and g.kind = 'announcement'
    and g.is_active
    and c.is_active
    and (p_before is null or p.created_at < p_before)
    and exists (
      select 1 from public.community_memberships m
       where m.community_id = g.community_id and m.party_id = p_party_id and m.status = 'active'
    )
    and not exists (
      select 1 from public.community_blocks b
       where b.blocker_id = p_party_id and b.blocked_id = p.author_id
    )
  order by p.created_at desc
  limit greatest(1, least(p_limit, 100));
$$;

-- ---------------------------------------------------------------------------
-- group_id becomes NOT NULL (backfill first, for any post created between
-- M1 and M3 without a group)
-- ---------------------------------------------------------------------------

do $$
begin
  update public.community_posts p
     set group_id = public.community_default_general_group_id()
   where p.group_id is null
     and public.community_default_general_group_id() is not null;

  if not exists (select 1 from public.community_posts where group_id is null) then
    alter table public.community_posts alter column group_id set not null;
  else
    raise notice 'community_posts still has rows without a group; group_id left nullable.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS: the read rules become membership-scoped
-- ---------------------------------------------------------------------------

-- The lint flags a policy name defined twice, and policies cannot be
-- redefined, so the scoped rules take new names and the old global ones
-- are dropped first.
drop policy if exists community_posts_read on public.community_posts;
drop policy if exists community_replies_read on public.community_replies;

create policy community_posts_read_scoped on public.community_posts
  for select to anon, authenticated
  using (
    deleted_at is null
    and hidden_at is null
    and (
      exists (select 1 from public.community_group_memberships gm where gm.group_id = community_posts.group_id and gm.party_id = public.current_party_id() and gm.status = 'active')
      or (exists (select 1 from public.community_groups g where g.id = community_posts.group_id and g.kind = 'announcement')
          and exists (select 1 from public.community_groups g join public.community_memberships m on m.community_id = g.community_id where g.id = community_posts.group_id and m.party_id = public.current_party_id() and m.status = 'active'))
      or exists (select 1 from public.community_groups g join public.communities c on c.id = g.community_id where g.id = community_posts.group_id and g.kind <> 'announcement' and g.visibility = 'visible' and c.join_policy = 'public' and c.is_active and g.is_active)
      or public.community_role(
        public.current_party_id(),
        (select community_id from public.community_groups where id = community_posts.group_id)
      ) in ('owner', 'admin')
    )
  );

create policy community_replies_read_scoped on public.community_replies
  for select to anon, authenticated
  using (
    hidden_at is null
    and exists (
      select 1
        from public.community_posts p
        join public.community_groups g on g.id = p.group_id
        join public.communities c on c.id = g.community_id
       where p.id = community_replies.post_id
         and p.deleted_at is null
         and p.hidden_at is null
         and g.is_active
         and c.is_active
         and (
           exists (select 1 from public.community_group_memberships gm where gm.group_id = p.group_id and gm.party_id = public.current_party_id() and gm.status = 'active')
           or (g.kind = 'announcement' and exists (select 1 from public.community_memberships m where m.community_id = g.community_id and m.party_id = public.current_party_id() and m.status = 'active'))
           or (c.join_policy = 'public' and g.visibility = 'visible' and g.kind <> 'announcement')
           or public.community_role(public.current_party_id(), g.community_id) in ('owner', 'admin')
         )
    )
  );
