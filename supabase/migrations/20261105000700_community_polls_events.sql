-- Farmer App · migration 20261105000700 · community polls and events (M5)
--
-- Group-chat features, after M1–M4. Polls (one changeable vote per party)
-- and events (going/maybe/not_going RSVP), both scoped to group members.
-- Announcement-group membership is derived from community membership (M1),
-- so the membership check below treats the announcement group that way,
-- exactly like the M3 feed does.
--
-- Writes go only through the RPCs; the tables are read-only for clients.

-- ---------------------------------------------------------------------------
-- Group-membership helper (announcement membership is derived)
-- ---------------------------------------------------------------------------

-- True when the party may see a group's content: an active community member
-- for the announcement group (derived, M1), an active group member otherwise.
-- Security definer like community_role, so RLS policies can call it safely.
create or replace function public.community_is_group_member(p_party_id uuid, p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.community_groups g
     where g.id = p_group_id
       and (
         (g.kind = 'announcement' and exists (
           select 1 from public.community_memberships m
            where m.community_id = g.community_id
              and m.party_id = p_party_id
              and m.status = 'active'
         ))
         or exists (
           select 1 from public.community_group_memberships gm
            where gm.group_id = g.id
              and gm.party_id = p_party_id
              and gm.status = 'active'
         )
       )
  );
$$;

comment on function public.community_is_group_member(uuid, uuid) is
  'True when the party is an active member of the group. Announcement membership is derived from community membership (M1); other groups use community_group_memberships.';

-- Shared creation gate for polls and events. Mirrors the M3 posting rules:
-- announcement group is owner/admin only; the general group takes any active
-- community member (auto-joining them as a group member, as M3 does);
-- any other group requires active group membership.
create or replace function public.community_require_group_write_access(p_party_id uuid, p_group_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text;
  v_community_id uuid;
  v_active boolean;
  v_role text;
begin
  if p_party_id is null then
    raise exception 'An identified farmer is required.' using errcode = 'insufficient_privilege';
  end if;

  select kind, community_id, is_active
    into v_kind, v_community_id, v_active
    from public.community_groups
   where id = p_group_id;
  if not found then
    raise exception 'Group % not found.', p_group_id using errcode = 'no_data_found';
  end if;
  if not v_active then
    raise exception 'This group is no longer active.' using errcode = 'check_violation';
  end if;

  if v_kind = 'announcement' then
    v_role := public.community_role(p_party_id, v_community_id);
    if v_role is distinct from 'owner' and v_role is distinct from 'admin' then
      raise exception 'Only community admins may post in the announcement group.' using errcode = 'insufficient_privilege';
    end if;
  elsif v_kind = 'general' then
    if not exists (
      select 1 from public.community_memberships m
       where m.community_id = v_community_id and m.party_id = p_party_id and m.status = 'active'
    ) then
      raise exception 'You must join the community first.' using errcode = 'insufficient_privilege';
    end if;
    insert into public.community_group_memberships (group_id, party_id, role, status)
    values (p_group_id, p_party_id, 'member', 'active')
    on conflict (group_id, party_id) do update
      set status = 'active', left_at = null;
  else
    if not exists (
      select 1 from public.community_group_memberships gm
       where gm.group_id = p_group_id and gm.party_id = p_party_id and gm.status = 'active'
    ) then
      raise exception 'You must join this group first.' using errcode = 'insufficient_privilege';
    end if;
  end if;

  return v_community_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.community_polls (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.community_groups (id) on delete cascade,
  post_id    uuid references public.community_posts (id) on delete cascade,
  question   text not null check (char_length(btrim(question)) > 0),
  options    jsonb not null
             check (jsonb_typeof(options) = 'array'
                    and jsonb_array_length(options) >= 2
                    and jsonb_array_length(options) <= 12),
  created_by uuid not null references public.parties (id) on delete cascade,
  closes_at  timestamptz,
  created_at timestamptz not null default now()
);

create index community_polls_group_idx
  on public.community_polls (group_id, created_at desc);

alter table public.community_polls enable row level security;

-- One vote per party per poll; changeable via upsert. voted_at records the
-- latest vote, so a changed vote is visible as a fresh one.
create table public.community_poll_votes (
  poll_id      uuid not null references public.community_polls (id) on delete cascade,
  party_id     uuid not null references public.parties (id) on delete cascade,
  option_index integer not null check (option_index >= 0),
  voted_at     timestamptz not null default now(),
  primary key (poll_id, party_id)
);

alter table public.community_poll_votes enable row level security;

create table public.community_events (
  id             uuid primary key default gen_random_uuid(),
  group_id       uuid not null references public.community_groups (id) on delete cascade,
  title          text not null check (char_length(btrim(title)) > 0),
  description    text,
  starts_at      timestamptz not null,
  ends_at        timestamptz,
  location_label text,
  created_by     uuid not null references public.parties (id) on delete cascade,
  created_at     timestamptz not null default now(),
  constraint community_events_ends_after_starts check (
    ends_at is null or ends_at > starts_at
  )
);

create index community_events_group_idx
  on public.community_events (group_id, starts_at);

alter table public.community_events enable row level security;

create table public.community_event_rsvps (
  event_id   uuid not null references public.community_events (id) on delete cascade,
  party_id   uuid not null references public.parties (id) on delete cascade,
  status     text not null check (status in ('going', 'maybe', 'not_going')),
  updated_at timestamptz not null default now(),
  primary key (event_id, party_id)
);

alter table public.community_event_rsvps enable row level security;

-- ---------------------------------------------------------------------------
-- Grants + RLS (writes only through the RPCs)
-- ---------------------------------------------------------------------------

revoke all on public.community_polls from anon;
grant select, insert, update, delete on public.community_polls to authenticated;
revoke insert, update, delete on public.community_polls from authenticated;

revoke all on public.community_poll_votes from anon;
grant select, insert, update, delete on public.community_poll_votes to authenticated;
revoke insert, update, delete on public.community_poll_votes from authenticated;

revoke all on public.community_events from anon;
grant select, insert, update, delete on public.community_events to authenticated;
revoke insert, update, delete on public.community_events from authenticated;

revoke all on public.community_event_rsvps from anon;
grant select, insert, update, delete on public.community_event_rsvps to authenticated;
revoke insert, update, delete on public.community_event_rsvps from authenticated;

-- Polls and events: readable only by group members (or community owner/admin).
-- Deliberately members-only, unlike M3 posts, which stay guest-readable in
-- public communities.
create policy community_polls_read on public.community_polls
  for select to authenticated
  using (
    public.community_is_group_member(public.current_party_id(), group_id)
    or public.community_role(
      public.current_party_id(),
      (select community_id from public.community_groups where id = community_polls.group_id)
    ) in ('owner', 'admin')
  );

create policy community_poll_votes_read on public.community_poll_votes
  for select to authenticated
  using (
    exists (
      select 1 from public.community_polls p
       where p.id = community_poll_votes.poll_id
         and (
           public.community_is_group_member(public.current_party_id(), p.group_id)
           or public.community_role(
             public.current_party_id(),
             (select community_id from public.community_groups where id = p.group_id)
           ) in ('owner', 'admin')
         )
    )
  );

create policy community_events_read on public.community_events
  for select to authenticated
  using (
    public.community_is_group_member(public.current_party_id(), group_id)
    or public.community_role(
      public.current_party_id(),
      (select community_id from public.community_groups where id = community_events.group_id)
    ) in ('owner', 'admin')
  );

create policy community_event_rsvps_read on public.community_event_rsvps
  for select to authenticated
  using (
    exists (
      select 1 from public.community_events e
       where e.id = community_event_rsvps.event_id
         and (
           public.community_is_group_member(public.current_party_id(), e.group_id)
           or public.community_role(
             public.current_party_id(),
             (select community_id from public.community_groups where id = e.group_id)
           ) in ('owner', 'admin')
         )
    )
  );

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Create a poll. Options must be a JSON array of 2-12 non-empty strings.
-- post_id is optional: a poll may stand alone or ride on a post.
create or replace function public.community_create_poll(
  p_party_id uuid,
  p_group_id uuid,
  p_question text,
  p_options jsonb,
  p_closes_at timestamptz default null,
  p_post_id uuid default null
)
returns public.community_polls
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_poll public.community_polls;
begin
  perform public.community_require_group_write_access(p_party_id, p_group_id);

  if p_question is null or char_length(btrim(p_question)) = 0 then
    raise exception 'A poll needs a question.' using errcode = 'check_violation';
  end if;
  if p_options is null
     or jsonb_typeof(p_options) <> 'array'
     or jsonb_array_length(p_options) < 2
     or jsonb_array_length(p_options) > 12
     or exists (
       select 1 from jsonb_array_elements_text(p_options) o
        where o is null or char_length(btrim(o)) = 0
     ) then
    raise exception 'A poll needs 2 to 12 non-empty options.' using errcode = 'check_violation';
  end if;
  if p_post_id is not null and not exists (
    select 1 from public.community_posts where id = p_post_id and group_id = p_group_id
  ) then
    raise exception 'Post % is not in this group.', p_post_id using errcode = 'check_violation';
  end if;

  insert into public.community_polls (group_id, post_id, question, options, created_by, closes_at)
  values (p_group_id, p_post_id, p_question, p_options, p_party_id, p_closes_at)
  returning * into v_poll;

  return v_poll;
end;
$$;

-- Vote, or change a vote (upsert on the (poll_id, party_id) key).
create or replace function public.community_vote_poll(
  p_party_id uuid,
  p_poll_id uuid,
  p_option_index integer
)
returns public.community_poll_votes
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_poll public.community_polls;
  v_vote public.community_poll_votes;
begin
  if p_party_id is null then
    raise exception 'Voting requires an identified farmer.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_poll from public.community_polls where id = p_poll_id;
  if not found then
    raise exception 'Poll % not found.', p_poll_id using errcode = 'no_data_found';
  end if;
  if v_poll.closes_at is not null and now() >= v_poll.closes_at then
    raise exception 'This poll is closed.' using errcode = 'check_violation';
  end if;
  if p_option_index is null
     or p_option_index < 0
     or p_option_index >= jsonb_array_length(v_poll.options) then
    raise exception 'Option % is not on this poll.', p_option_index using errcode = 'check_violation';
  end if;
  if not public.community_is_group_member(p_party_id, v_poll.group_id) then
    raise exception 'Only group members may vote in this poll.' using errcode = 'insufficient_privilege';
  end if;

  insert into public.community_poll_votes (poll_id, party_id, option_index)
  values (p_poll_id, p_party_id, p_option_index)
  on conflict (poll_id, party_id) do update
    set option_index = excluded.option_index, voted_at = now()
  returning * into v_vote;

  return v_vote;
end;
$$;

-- Create an event in a group.
create or replace function public.community_create_event(
  p_party_id uuid,
  p_group_id uuid,
  p_title text,
  p_starts_at timestamptz,
  p_description text default null,
  p_ends_at timestamptz default null,
  p_location_label text default null
)
returns public.community_events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.community_events;
begin
  perform public.community_require_group_write_access(p_party_id, p_group_id);

  if p_title is null or char_length(btrim(p_title)) = 0 then
    raise exception 'An event needs a title.' using errcode = 'check_violation';
  end if;
  if p_starts_at is null then
    raise exception 'An event needs a start time.' using errcode = 'check_violation';
  end if;
  if p_ends_at is not null and p_ends_at <= p_starts_at then
    raise exception 'An event must end after it starts.' using errcode = 'check_violation';
  end if;

  insert into public.community_events (group_id, title, description, starts_at, ends_at, location_label, created_by)
  values (p_group_id, p_title, p_description, p_starts_at, p_ends_at, p_location_label, p_party_id)
  returning * into v_event;

  return v_event;
end;
$$;

-- RSVP, or change an RSVP (upsert on the (event_id, party_id) key).
create or replace function public.community_rsvp_event(
  p_party_id uuid,
  p_event_id uuid,
  p_status text
)
returns public.community_event_rsvps
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.community_events;
  v_rsvp public.community_event_rsvps;
begin
  if p_party_id is null then
    raise exception 'RSVP requires an identified farmer.' using errcode = 'insufficient_privilege';
  end if;
  if p_status not in ('going', 'maybe', 'not_going') then
    raise exception 'Unknown RSVP status %.', p_status using errcode = 'check_violation';
  end if;

  select * into v_event from public.community_events where id = p_event_id;
  if not found then
    raise exception 'Event % not found.', p_event_id using errcode = 'no_data_found';
  end if;
  if not public.community_is_group_member(p_party_id, v_event.group_id) then
    raise exception 'Only group members may RSVP to this event.' using errcode = 'insufficient_privilege';
  end if;

  insert into public.community_event_rsvps (event_id, party_id, status)
  values (p_event_id, p_party_id, p_status)
  on conflict (event_id, party_id) do update
    set status = excluded.status, updated_at = now()
  returning * into v_rsvp;

  return v_rsvp;
end;
$$;
