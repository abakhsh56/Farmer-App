-- Farmer App · migration 20261105000400 · community admin controls (M2)
--
-- Roles and admin controls for WhatsApp Communities, backend only.
-- Owner / admin / member. Promote and dismiss admins, transfer ownership,
-- deactivate the community, edit it, restrict group creation, remove groups,
-- remove and ban members. Every admin RPC writes an audit_log row.
--
-- Community admin removal is separate from the global moderation queue: a
-- community admin removing or banning a member is a community action (RPC,
-- audited, reversible via unban), not a moderation case. Content reports
-- still go through the existing report -> case -> human action path.

-- ---------------------------------------------------------------------------
-- Enum extension
-- ---------------------------------------------------------------------------

-- A whole community or group can be reported into the existing moderation
-- queue. The new values are not used anywhere in this migration itself
-- (Postgres forbids using a value added in the same transaction), only by
-- later callers.
alter type public.moderation_target add value if not exists 'community';
alter type public.moderation_target add value if not exists 'group';

-- ---------------------------------------------------------------------------
-- Visibility guard (WhatsApp: visibility cannot change once the group is added)
-- ---------------------------------------------------------------------------

create or replace function public.community_groups_visibility_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.visibility is distinct from new.visibility
     and exists (select 1 from public.community_group_memberships where group_id = new.id) then
    raise exception 'Group visibility cannot be changed once the group has members. Remove the group and add it again.';
  end if;
  return new;
end;
$$;

create trigger community_groups_visibility_immutable
  before update of visibility on public.community_groups
  for each row execute function public.community_groups_visibility_guard();

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Promote an active member to admin. Actor must be owner or admin.
-- Enforces the 20-admin cap.
create or replace function public.community_promote_admin(
  p_actor_id uuid,
  p_community_id uuid,
  p_party_id uuid
)
returns public.community_memberships
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_role text;
  v_target public.community_memberships;
  v_admin_count integer;
begin
  v_actor_role := public.community_role(p_actor_id, p_community_id);
  if v_actor_role is distinct from 'owner' and v_actor_role is distinct from 'admin' then
    raise exception 'Only community owners and admins may promote admins.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_target
    from public.community_memberships
   where community_id = p_community_id and party_id = p_party_id
   for update;
  if not found then
    raise exception 'Party % is not a member of this community.', p_party_id using errcode = 'no_data_found';
  end if;
  if v_target.status <> 'active' then
    raise exception 'Only an active member can be promoted.' using errcode = 'check_violation';
  end if;
  if v_target.role = 'owner' then
    raise exception 'The owner is already above admin.' using errcode = 'check_violation';
  end if;
  if v_target.role = 'admin' then
    raise exception 'Party % is already an admin.', p_party_id using errcode = 'check_violation';
  end if;

  select count(*) into v_admin_count
    from public.community_memberships
   where community_id = p_community_id and role = 'admin' and status = 'active';
  if v_admin_count >= 20 then
    raise exception 'This community already has 20 admins.' using errcode = 'check_violation';
  end if;

  update public.community_memberships
     set role = 'admin'
   where community_id = p_community_id and party_id = p_party_id
  returning * into v_target;

  perform public.write_audit(
    'community.admin_promoted', 'community_memberships', null, null,
    'member', 'admin',
    jsonb_build_object('community_id', p_community_id, 'party_id', p_party_id),
    p_actor_id, v_actor_role
  );

  return v_target;
end;
$$;

-- Dismiss an admin back to member. Owner or admin. Cannot dismiss the owner,
-- and cannot dismiss yourself if you are the last admin.
create or replace function public.community_dismiss_admin(
  p_actor_id uuid,
  p_community_id uuid,
  p_party_id uuid
)
returns public.community_memberships
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_role text;
  v_target public.community_memberships;
  v_admin_count integer;
begin
  v_actor_role := public.community_role(p_actor_id, p_community_id);
  if v_actor_role is distinct from 'owner' and v_actor_role is distinct from 'admin' then
    raise exception 'Only community owners and admins may dismiss admins.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_target
    from public.community_memberships
   where community_id = p_community_id and party_id = p_party_id
   for update;
  if not found then
    raise exception 'Party % is not a member of this community.', p_party_id using errcode = 'no_data_found';
  end if;
  if v_target.role = 'owner' then
    raise exception 'The owner cannot be dismissed.' using errcode = 'check_violation';
  end if;
  if v_target.role <> 'admin' then
    raise exception 'Party % is not an admin.', p_party_id using errcode = 'check_violation';
  end if;

  if p_actor_id = p_party_id then
    select count(*) into v_admin_count
      from public.community_memberships
     where community_id = p_community_id and role = 'admin' and status = 'active';
    if v_admin_count <= 1 then
      raise exception 'You are the last admin and cannot dismiss yourself.' using errcode = 'check_violation';
    end if;
  end if;

  update public.community_memberships
     set role = 'member'
   where community_id = p_community_id and party_id = p_party_id
  returning * into v_target;

  perform public.write_audit(
    'community.admin_dismissed', 'community_memberships', null, null,
    'admin', 'member',
    jsonb_build_object('community_id', p_community_id, 'party_id', p_party_id),
    p_actor_id, v_actor_role
  );

  return v_target;
end;
$$;

-- Transfer ownership to another admin. Actor must be the owner. The old
-- owner becomes an admin. (WhatsApp: transfer only to another admin.)
create or replace function public.community_transfer_ownership(
  p_actor_id uuid,
  p_community_id uuid,
  p_new_owner_id uuid
)
returns public.communities
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_community public.communities;
  v_new_owner public.community_memberships;
begin
  select * into v_community from public.communities where id = p_community_id for update;
  if not found then
    raise exception 'Community % not found.', p_community_id using errcode = 'no_data_found';
  end if;
  if v_community.owner_id is distinct from p_actor_id then
    raise exception 'Only the owner may transfer ownership.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_new_owner
    from public.community_memberships
   where community_id = p_community_id and party_id = p_new_owner_id
   for update;
  if not found or v_new_owner.status <> 'active' then
    raise exception 'The new owner must be an active member of the community.' using errcode = 'check_violation';
  end if;
  if v_new_owner.role <> 'admin' then
    raise exception 'Ownership can only be transferred to an admin.' using errcode = 'check_violation';
  end if;

  update public.community_memberships
     set role = 'admin'
   where community_id = p_community_id and party_id = p_actor_id;

  update public.community_memberships
     set role = 'owner'
   where community_id = p_community_id and party_id = p_new_owner_id;

  update public.communities
     set owner_id = p_new_owner_id
   where id = p_community_id
  returning * into v_community;

  perform public.write_audit(
    'community.ownership_transferred', 'communities', p_community_id, v_community.name,
    p_actor_id::text, p_new_owner_id::text,
    jsonb_build_object('community_id', p_community_id),
    p_actor_id, 'owner'
  );

  return v_community;
end;
$$;

-- Deactivate the whole community. Owner, or the admin who created it.
-- A deactivated community is invisible in every feed and rejects all writes.
create or replace function public.community_deactivate(
  p_actor_id uuid,
  p_community_id uuid
)
returns public.communities
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_community public.communities;
  v_role text;
begin
  select * into v_community from public.communities where id = p_community_id for update;
  if not found then
    raise exception 'Community % not found.', p_community_id using errcode = 'no_data_found';
  end if;

  v_role := public.community_role(p_actor_id, p_community_id);
  if v_community.owner_id is distinct from p_actor_id
     and not (v_role = 'admin' and v_community.created_by is not distinct from p_actor_id) then
    raise exception 'Only the owner, or the admin who created it, may deactivate a community.' using errcode = 'insufficient_privilege';
  end if;

  update public.communities
     set is_active = false, deactivated_at = now(), deactivated_by = p_actor_id
   where id = p_community_id
  returning * into v_community;

  perform public.write_audit(
    'community.deactivated', 'communities', p_community_id, v_community.name,
    'active', 'deactivated',
    jsonb_build_object('community_id', p_community_id),
    p_actor_id, v_role
  );

  return v_community;
end;
$$;

-- Edit a community's name, description or icon. Owner/admin.
create or replace function public.community_update(
  p_actor_id uuid,
  p_community_id uuid,
  p_name text default null,
  p_description text default null,
  p_icon_media_id uuid default null
)
returns public.communities
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_community public.communities;
  v_role text;
begin
  v_role := public.community_role(p_actor_id, p_community_id);
  if v_role is distinct from 'owner' and v_role is distinct from 'admin' then
    raise exception 'Only community owners and admins may edit it.' using errcode = 'insufficient_privilege';
  end if;

  update public.communities
     set name = coalesce(p_name, name),
         description = coalesce(p_description, description),
         icon_media_id = coalesce(p_icon_media_id, icon_media_id)
   where id = p_community_id
  returning * into v_community;
  if not found then
    raise exception 'Community % not found.', p_community_id using errcode = 'no_data_found';
  end if;

  perform public.write_audit(
    'community.updated', 'communities', p_community_id, v_community.name,
    null, null,
    jsonb_build_object('community_id', p_community_id),
    p_actor_id, v_role
  );

  return v_community;
end;
$$;

-- Restrict group creation to admins-only, or open it to all members.
create or replace function public.community_set_group_creation(
  p_actor_id uuid,
  p_community_id uuid,
  p_mode text
)
returns public.communities
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_community public.communities;
  v_role text;
begin
  if p_mode not in ('members', 'admins') then
    raise exception 'group_creation must be members or admins.' using errcode = 'check_violation';
  end if;

  v_role := public.community_role(p_actor_id, p_community_id);
  if v_role is distinct from 'owner' and v_role is distinct from 'admin' then
    raise exception 'Only community owners and admins may change this setting.' using errcode = 'insufficient_privilege';
  end if;

  update public.communities
     set group_creation = p_mode
   where id = p_community_id
  returning * into v_community;
  if not found then
    raise exception 'Community % not found.', p_community_id using errcode = 'no_data_found';
  end if;

  perform public.write_audit(
    'community.group_creation_set', 'communities', p_community_id, v_community.name,
    null, p_mode,
    jsonb_build_object('community_id', p_community_id),
    p_actor_id, v_role
  );

  return v_community;
end;
$$;

-- Remove a group (soft: the group is deactivated, posts stay readable to
-- members who were in it, matching the soft-delete rule). Cannot remove the
-- announcement group.
create or replace function public.community_remove_group(
  p_actor_id uuid,
  p_group_id uuid
)
returns public.community_groups
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_group public.community_groups;
  v_role text;
begin
  select * into v_group from public.community_groups where id = p_group_id for update;
  if not found then
    raise exception 'Group % not found.', p_group_id using errcode = 'no_data_found';
  end if;
  if v_group.kind = 'announcement' then
    raise exception 'The announcement group cannot be removed.' using errcode = 'check_violation';
  end if;

  v_role := public.community_role(p_actor_id, v_group.community_id);
  if v_role is distinct from 'owner' and v_role is distinct from 'admin' then
    raise exception 'Only community owners and admins may remove a group.' using errcode = 'insufficient_privilege';
  end if;

  update public.community_groups
     set is_active = false
   where id = p_group_id
  returning * into v_group;

  perform public.write_audit(
    'community.group_removed', 'community_groups', p_group_id, v_group.name,
    'active', 'removed',
    jsonb_build_object('community_id', v_group.community_id),
    p_actor_id, v_role
  );

  return v_group;
end;
$$;

-- Add a member directly to a group (admin/owner). The party becomes a
-- community member first when they are not one yet. Enforces the group cap.
create or replace function public.community_add_member(
  p_actor_id uuid,
  p_community_id uuid,
  p_party_id uuid,
  p_group_id uuid default null
)
returns public.community_memberships
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
  v_membership public.community_memberships;
  v_count integer;
begin
  v_role := public.community_role(p_actor_id, p_community_id);
  if v_role is distinct from 'owner' and v_role is distinct from 'admin' then
    raise exception 'Only community owners and admins may add members.' using errcode = 'insufficient_privilege';
  end if;

  if p_group_id is not null then
    if not exists (select 1 from public.community_groups where id = p_group_id and community_id = p_community_id and is_active) then
      raise exception 'Group % is not an active group of this community.', p_group_id using errcode = 'no_data_found';
    end if;
  end if;

  insert into public.community_memberships (community_id, party_id, role, status, joined_via)
  values (p_community_id, p_party_id, 'member', 'active', 'added')
  on conflict (community_id, party_id) do update
    set status = 'active', left_at = null, joined_via = 'added', joined_at = now()
  returning * into v_membership;

  if p_group_id is not null then
    select count(*) into v_count
      from public.community_group_memberships
     where group_id = p_group_id and status = 'active';
    if v_count >= 1024 then
      raise exception 'This group is full (1,024 members).' using errcode = 'check_violation';
    end if;

    insert into public.community_group_memberships (group_id, party_id, role, status)
    values (p_group_id, p_party_id, 'member', 'active')
    on conflict (group_id, party_id) do update
      set status = 'active', left_at = null, joined_at = now();
  end if;

  perform public.write_audit(
    'community.member_added', 'community_memberships', null, null,
    null, 'active',
    jsonb_build_object('community_id', p_community_id, 'party_id', p_party_id, 'group_id', p_group_id),
    p_actor_id, v_role
  );

  return v_membership;
end;
$$;

-- Remove a member from the community. Loses all groups and announcements;
-- their posts stay (soft-delete rule). Does NOT delete content.
create or replace function public.community_remove_member(
  p_actor_id uuid,
  p_community_id uuid,
  p_party_id uuid,
  p_reason text
)
returns public.community_memberships
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_role text;
  v_target public.community_memberships;
begin
  v_actor_role := public.community_role(p_actor_id, p_community_id);
  if v_actor_role is distinct from 'owner' and v_actor_role is distinct from 'admin' then
    raise exception 'Only community owners and admins may remove members.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_target
    from public.community_memberships
   where community_id = p_community_id and party_id = p_party_id
   for update;
  if not found then
    raise exception 'Party % is not a member of this community.', p_party_id using errcode = 'no_data_found';
  end if;
  if v_target.role = 'owner' then
    raise exception 'The owner cannot be removed. Transfer ownership first.' using errcode = 'check_violation';
  end if;
  if v_target.status <> 'active' then
    raise exception 'Party % is not an active member.', p_party_id using errcode = 'check_violation';
  end if;

  update public.community_memberships
     set status = 'removed', left_at = now()
   where community_id = p_community_id and party_id = p_party_id
  returning * into v_target;

  update public.community_group_memberships gm
     set status = 'removed', left_at = now()
    from public.community_groups g
   where gm.group_id = g.id
     and g.community_id = p_community_id
     and gm.party_id = p_party_id
     and gm.status = 'active';

  perform public.write_audit(
    'community.member_removed', 'community_memberships', null, null,
    'active', 'removed',
    jsonb_build_object('community_id', p_community_id, 'party_id', p_party_id, 'reason', p_reason),
    p_actor_id, v_actor_role
  );

  return v_target;
end;
$$;

-- Ban a member. A banned party cannot rejoin (enforced in community_join).
create or replace function public.community_ban_member(
  p_actor_id uuid,
  p_community_id uuid,
  p_party_id uuid,
  p_reason text
)
returns public.community_memberships
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_role text;
  v_target public.community_memberships;
begin
  v_actor_role := public.community_role(p_actor_id, p_community_id);
  if v_actor_role is distinct from 'owner' and v_actor_role is distinct from 'admin' then
    raise exception 'Only community owners and admins may ban members.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_target
    from public.community_memberships
   where community_id = p_community_id and party_id = p_party_id
   for update;
  if not found then
    raise exception 'Party % is not a member of this community.', p_party_id using errcode = 'no_data_found';
  end if;
  if v_target.role = 'owner' then
    raise exception 'The owner cannot be banned. Transfer ownership first.' using errcode = 'check_violation';
  end if;
  if v_target.status = 'banned' then
    raise exception 'Party % is already banned.', p_party_id using errcode = 'check_violation';
  end if;

  update public.community_memberships
     set status = 'banned', left_at = now()
   where community_id = p_community_id and party_id = p_party_id
  returning * into v_target;

  update public.community_group_memberships gm
     set status = 'removed', left_at = now()
    from public.community_groups g
   where gm.group_id = g.id
     and g.community_id = p_community_id
     and gm.party_id = p_party_id
     and gm.status = 'active';

  perform public.write_audit(
    'community.member_banned', 'community_memberships', null, null,
    'active', 'banned',
    jsonb_build_object('community_id', p_community_id, 'party_id', p_party_id, 'reason', p_reason),
    p_actor_id, v_actor_role
  );

  return v_target;
end;
$$;

-- Unban a member. Back to 'left': they must rejoin.
create or replace function public.community_unban_member(
  p_actor_id uuid,
  p_community_id uuid,
  p_party_id uuid
)
returns public.community_memberships
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_role text;
  v_target public.community_memberships;
begin
  v_actor_role := public.community_role(p_actor_id, p_community_id);
  if v_actor_role is distinct from 'owner' and v_actor_role is distinct from 'admin' then
    raise exception 'Only community owners and admins may unban members.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_target
    from public.community_memberships
   where community_id = p_community_id and party_id = p_party_id
   for update;
  if not found then
    raise exception 'Party % is not a member of this community.', p_party_id using errcode = 'no_data_found';
  end if;
  if v_target.status <> 'banned' then
    raise exception 'Party % is not banned.', p_party_id using errcode = 'check_violation';
  end if;

  update public.community_memberships
     set status = 'left', left_at = now()
   where community_id = p_community_id and party_id = p_party_id
  returning * into v_target;

  perform public.write_audit(
    'community.member_unbanned', 'community_memberships', null, null,
    'banned', 'left',
    jsonb_build_object('community_id', p_community_id, 'party_id', p_party_id),
    p_actor_id, v_actor_role
  );

  return v_target;
end;
$$;
