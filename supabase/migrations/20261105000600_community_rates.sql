-- Farmer App · migration 20261105000600 · reactions as trust signals + community mandi rates (M4)
--
-- Two sources for mandi rates (AB's design, 2026-11-07): AMIS (government)
-- and community. A community rate is NEVER used immediately. The community's
-- interaction with the contributor is watched for at least 15-20 days
-- (likes/endorsements vs anyone calling it wrong). Only once the contributor
-- is trusted is that mandi's rate added to the rate widgets, labelled local
-- (community) vs govt. Improve the vetting later.
--
-- Trust is per contributor per mandi, over a rolling 20-day window, and lives
-- in its own tables — not inside posts. Promotion writes a row into
-- market_observations with a community source, so market_rates() serves it
-- with its source label and the widget shows "local" vs "govt" with no
-- serving change.
--
-- Trust rule (initial, tunable — the constants live in the function, not in
-- the UI): trusted when days_since_first >= 15 AND posts_20d >= 5 AND
-- endorsements_20d >= 5 AND disputes in the last 7 days = 0 AND
-- endorsements > disputes. A 'wrong' reaction or a 'misinformation' report
-- on any of the contributor's rate posts in the window blocks trust.

-- ---------------------------------------------------------------------------
-- Reactions become a stance (one per party per target)
-- ---------------------------------------------------------------------------

-- Extend the kind check: 'agree'/'helpful' = endorsement; 'disagree'/'wrong'
-- = dispute ("calling it wrong").
do $$
begin
  if exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where c.conname = 'community_reactions_kind_check'
      and t.relname = 'community_reactions'
  ) then
    alter table public.community_reactions drop constraint community_reactions_kind_check;
  end if;
end;
$$;

alter table public.community_reactions
  add constraint community_reactions_kind_check
  check (kind in ('helpful', 'thanks', 'agree', 'disagree', 'wrong'));

-- Collapse duplicates: if a party holds two kinds on one target, keep the
-- most recent (largest id) and drop the older rows.
delete from public.community_reactions r
 using public.community_reactions r2
 where r.id < r2.id
   and r.party_id = r2.party_id
   and r.post_id is not distinct from r2.post_id
   and r.reply_id is not distinct from r2.reply_id;

drop index if exists public.community_reactions_post_idx;
drop index if exists public.community_reactions_reply_idx;

-- One reaction (one stance) per party per target.
create unique index community_reactions_one_post_idx
  on public.community_reactions (party_id, post_id) where post_id is not null;
create unique index community_reactions_one_reply_idx
  on public.community_reactions (party_id, reply_id) where reply_id is not null;

-- Upsert a stance. This is the RPC the client calls to react.
create or replace function public.community_set_reaction(
  p_party_id uuid,
  p_post_id uuid default null,
  p_reply_id uuid default null,
  p_kind text default 'helpful'
)
returns public.community_reactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reaction public.community_reactions;
begin
  if p_party_id is null then
    raise exception 'Reacting requires an identified farmer.' using errcode = 'insufficient_privilege';
  end if;
  if (p_post_id is null)::int + (p_reply_id is null)::int <> 1 then
    raise exception 'A reaction targets exactly one post or one reply.' using errcode = 'check_violation';
  end if;
  if p_kind not in ('helpful', 'thanks', 'agree', 'disagree', 'wrong') then
    raise exception 'Unknown reaction kind %.', p_kind using errcode = 'check_violation';
  end if;

  if p_post_id is not null then
    insert into public.community_reactions (party_id, post_id, kind)
    values (p_party_id, p_post_id, p_kind)
    on conflict (party_id, post_id) where post_id is not null
    do update set kind = excluded.kind, created_at = now()
    returning * into v_reaction;

    update public.community_posts p
       set reaction_count = (select count(*) from public.community_reactions r where r.post_id = p.id)
     where p.id = p_post_id;
  else
    insert into public.community_reactions (party_id, reply_id, kind)
    values (p_party_id, p_reply_id, p_kind)
    on conflict (party_id, reply_id) where reply_id is not null
    do update set kind = excluded.kind, created_at = now()
    returning * into v_reaction;

    update public.community_replies r
       set reaction_count = (select count(*) from public.community_reactions x where x.reply_id = r.id)
     where r.id = p_reply_id;
  end if;

  return v_reaction;
end;
$$;

-- ---------------------------------------------------------------------------
-- Rate reports and trust
-- ---------------------------------------------------------------------------

create table public.community_rate_reports (
  id             uuid primary key default gen_random_uuid(),
  -- The mandi-rate post this structured rate came from.
  post_id        uuid not null references public.community_posts (id) on delete cascade,
  contributor_id uuid not null references public.parties (id) on delete cascade,
  community_id   uuid not null references public.communities (id) on delete cascade,
  group_id       uuid not null references public.community_groups (id) on delete cascade,
  commodity_code text not null references public.market_commodities (code),
  market_name    text not null,
  district       text,
  min_price      numeric check (min_price >= 0),
  max_price      numeric check (max_price >= 0),
  modal_price    numeric check (modal_price >= 0),
  observed_on    date not null,
  status         text not null default 'pending' check (status in ('pending', 'trusted', 'rejected', 'promoted')),
  created_at     timestamptz not null default now(),
  -- Same price rules as market_observations: at least one price present,
  -- never zero-for-missing, min <= max.
  constraint community_rate_reports_some_price check (
    min_price is not null or max_price is not null or modal_price is not null
  ),
  constraint community_rate_reports_price_order check (
    min_price is null or max_price is null or min_price <= max_price
  ),
  -- One structured rate per post.
  unique (post_id)
);

create index community_rate_reports_contributor_idx
  on public.community_rate_reports (contributor_id, market_name, created_at desc);

alter table public.community_rate_reports enable row level security;

create table public.community_rate_trust (
  contributor_id uuid not null references public.parties (id) on delete cascade,
  market_name    text not null,
  first_post_at  timestamptz,
  posts_20d      integer not null default 0 check (posts_20d >= 0),
  endorsements_20d integer not null default 0 check (endorsements_20d >= 0),
  disputes_20d   integer not null default 0 check (disputes_20d >= 0),
  trusted        boolean not null default false,
  trusted_at     timestamptz,
  trusted_by     text not null default 'system',
  last_computed_at timestamptz,
  primary key (contributor_id, market_name)
);

alter table public.community_rate_trust enable row level security;

-- Promotion runs, so a bad batch is traceable. Same shape as
-- market_ingestion_runs.
create table public.community_rate_promotion_runs (
  id             bigserial primary key,
  source_code    text not null default 'community_local',
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  status         text not null default 'running' check (status in ('running', 'ok', 'partial', 'failed')),
  rows_promoted  integer not null default 0,
  rows_skipped   integer not null default 0,
  error          text
);

alter table public.community_rate_promotion_runs enable row level security;

-- ---------------------------------------------------------------------------
-- Grants + RLS (writes only through the RPCs and the job)
-- ---------------------------------------------------------------------------

revoke all on public.community_rate_reports from anon;
grant select, insert, update, delete on public.community_rate_reports to authenticated;
revoke insert, update, delete on public.community_rate_reports from authenticated;

revoke all on public.community_rate_trust from anon;
grant select, insert, update, delete on public.community_rate_trust to authenticated;
revoke insert, update, delete on public.community_rate_trust from authenticated;

revoke all on public.community_rate_promotion_runs from anon;
grant select, insert, update, delete on public.community_rate_promotion_runs to authenticated;
revoke insert, update, delete on public.community_rate_promotion_runs from authenticated;

-- Rate reports: readable by members of that community (same rule as posts).
create policy community_rate_reports_read on public.community_rate_reports
  for select to authenticated
  using (
    exists (
      select 1 from public.community_memberships m
       where m.community_id = community_rate_reports.community_id
         and m.party_id = public.current_party_id()
         and m.status = 'active'
    )
  );

-- Trust: readable by anyone who can read the community the contributor
-- posted the rate in.
create policy community_rate_trust_read on public.community_rate_trust
  for select to authenticated
  using (
    exists (
      select 1
        from public.community_rate_reports r
        join public.community_memberships m on m.community_id = r.community_id
       where r.contributor_id = community_rate_trust.contributor_id
         and r.market_name = community_rate_trust.market_name
         and m.party_id = public.current_party_id()
         and m.status = 'active'
    )
  );

-- Promotion runs: the moderation queue staff, so a bad batch is traceable.
create policy community_rate_promotion_runs_staff on public.community_rate_promotion_runs
  for select to authenticated
  using (public.has_capability('moderator') or public.has_capability('admin'));

-- ---------------------------------------------------------------------------
-- Trust scoring
-- ---------------------------------------------------------------------------

-- The rolling 20-day trust picture for one contributor and one mandi.
-- Returns the counts, the days since their first rate post for this mandi,
-- and whether they are trusted under the initial rule. A 'wrong' reaction
-- (counted in disputes) or a 'misinformation' report on any of their rate
-- posts in the window blocks trust; the dispute must age out of the 7-day
-- window before trust can return.
create or replace function public.community_rate_trust_score(
  p_contributor_id uuid,
  p_market_name text
)
returns table (
  posts_20d integer,
  endorsements_20d integer,
  disputes_20d integer,
  disputes_7d integer,
  days_since_first integer,
  trusted boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with reports as (
    select r.id as post_id, r.created_at
      from public.community_rate_reports r
     where r.contributor_id = p_contributor_id
       and r.market_name = p_market_name
       and r.created_at >= now() - interval '20 days'
  ),
  first_post as (
    select min(created_at) as first_at
      from public.community_rate_reports
     where contributor_id = p_contributor_id
       and market_name = p_market_name
  ),
  agg as (
    select
      (select count(*) from reports) as posts_20d,
      (select first_at from first_post) as first_at,
      coalesce((select count(*) from public.community_reactions re where re.post_id in (select post_id from reports) and re.kind in ('helpful', 'thanks', 'agree')), 0) as endorsements_20d,
      coalesce((select count(*) from public.community_reactions re where re.post_id in (select post_id from reports) and re.kind in ('disagree', 'wrong')), 0) as disputes_20d,
      coalesce((select count(*) from public.community_reactions re where re.post_id in (select post_id from reports) and re.kind in ('disagree', 'wrong') and re.created_at >= now() - interval '7 days'), 0) as disputes_7d,
      coalesce((select count(*) from public.community_reports cr where cr.target_type = 'post' and cr.reason_code = 'misinformation' and cr.created_at >= now() - interval '20 days' and cr.target_id in (select post_id from reports)), 0) as misinfo_20d
  )
  select
    posts_20d::integer,
    endorsements_20d::integer,
    disputes_20d::integer,
    disputes_7d::integer,
    coalesce(floor(extract(epoch from (now() - first_at)) / 86400)::integer, 0),
    (coalesce(floor(extract(epoch from (now() - first_at)) / 86400)::integer, 0) >= 15
     and posts_20d >= 5
     and endorsements_20d >= 5
     and disputes_7d = 0
     and endorsements_20d > disputes_20d
     and misinfo_20d = 0)
    from agg;
$$;

-- Recompute the trust table for every contributor+mandi pair. Called by the
-- daily promotion job; also callable by hand to investigate.
create or replace function public.community_recompute_rate_trust()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
  v_pair record;
  v_score record;
begin
  for v_pair in
    select distinct contributor_id, market_name from public.community_rate_reports
  loop
    select * into v_score
      from public.community_rate_trust_score(v_pair.contributor_id, v_pair.market_name);

    insert into public.community_rate_trust (
      contributor_id, market_name, first_post_at,
      posts_20d, endorsements_20d, disputes_20d,
      trusted, trusted_at, trusted_by, last_computed_at
    ) values (
      v_pair.contributor_id, v_pair.market_name,
      (select min(created_at) from public.community_rate_reports
        where contributor_id = v_pair.contributor_id and market_name = v_pair.market_name),
      v_score.posts_20d, v_score.endorsements_20d, v_score.disputes_20d,
      v_score.trusted,
      case when v_score.trusted then now() else null end,
      'system',
      now()
    )
    on conflict (contributor_id, market_name) do update
      set first_post_at = excluded.first_post_at,
          posts_20d = excluded.posts_20d,
          endorsements_20d = excluded.endorsements_20d,
          disputes_20d = excluded.disputes_20d,
          trusted = excluded.trusted,
          trusted_at = case
            when excluded.trusted then coalesce(public.community_rate_trust.trusted_at, now())
            else null
          end,
          last_computed_at = now();

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- Daily promotion: for each trusted contributor+mandi, take the latest rate
-- report for today/yesterday and upsert it into market_observations with
-- source_code 'community_local'. The report is marked promoted. A run row is
-- written so a bad batch is traceable.
create or replace function public.community_promote_trusted_rates()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_id bigint;
  v_promoted integer := 0;
  v_skipped integer := 0;
  v_pair record;
  v_report public.community_rate_reports;
begin
  perform public.community_recompute_rate_trust();

  insert into public.community_rate_promotion_runs (source_code, status)
  values ('community_local', 'running')
  returning id into v_run_id;

  for v_pair in
    select contributor_id, market_name from public.community_rate_trust where trusted
  loop
    select * into v_report
      from public.community_rate_reports
     where contributor_id = v_pair.contributor_id
       and market_name = v_pair.market_name
       and observed_on >= current_date - 1
       and status in ('pending', 'trusted')
     order by observed_on desc, created_at desc
     limit 1;

    if not found then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    insert into public.market_observations (
      source_code, commodity_code, market_name, district, observed_on,
      min_price, max_price, modal_price, raw
    ) values (
      'community_local', v_report.commodity_code, v_report.market_name, v_report.district, v_report.observed_on,
      v_report.min_price, v_report.max_price, v_report.modal_price,
      jsonb_build_object(
        'post_id', v_report.post_id,
        'contributor_id', v_report.contributor_id,
        'community_id', v_report.community_id,
        'group_id', v_report.group_id,
        'trusted', true,
        'promoted_at', now()
      )
    )
    on conflict (source_code, commodity_code, market_name, observed_on) do update
      set min_price = excluded.min_price,
          max_price = excluded.max_price,
          modal_price = excluded.modal_price,
          district = excluded.district,
          raw = excluded.raw,
          ingested_at = now();

    update public.community_rate_reports
       set status = 'promoted'
     where id = v_report.id;

    v_promoted := v_promoted + 1;
  end loop;

  update public.community_rate_promotion_runs
     set finished_at = now(),
         status = 'ok',
         rows_promoted = v_promoted,
         rows_skipped = v_skipped
   where id = v_run_id;

  return v_promoted;
exception
  when others then
    update public.community_rate_promotion_runs
       set finished_at = now(), status = 'failed', error = sqlerrm
     where id = v_run_id;
    raise;
end;
$$;

-- Cron entry point, following the job_* pattern in migration 0014.
create or replace function public.job_promote_trusted_rates()
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.community_promote_trusted_rates();
$$;

-- Daily schedule, same pattern as migration 0014: unschedule first so the
-- migration is re-runnable; skip scheduling entirely where pg_cron is absent.
do $$
declare
  v_has_cron boolean;
begin
  select exists (select 1 from pg_extension where extname = 'pg_cron') into v_has_cron;

  if not v_has_cron then
    raise notice 'pg_cron is not installed in this database; the trusted-rate promotion job is not scheduled here. The job function remains callable by hand or by an external scheduler.';
    return;
  end if;

  perform cron.unschedule(jobname)
    from cron.job
   where jobname in ('farmer-promote-trusted-rates');

  perform cron.schedule('farmer-promote-trusted-rates', '15 3 * * *', $job$select public.job_promote_trusted_rates();$job$);
end;
$$;

-- ---------------------------------------------------------------------------
-- Market source row
-- ---------------------------------------------------------------------------

-- A community-vetted rate is a different provenance from a dealer pushing
-- figures, so it gets its own kind and the widget label is unambiguous.
-- NOTE: the name is 'Community (local)' (the label the acceptance test
-- expects); the plan's M4 text also writes 'Community vetted (local)'.
do $$
begin
  if exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where c.conname = 'market_sources_kind_check'
      and t.relname = 'market_sources'
  ) then
    alter table public.market_sources drop constraint market_sources_kind_check;
  end if;
end;
$$;

alter table public.market_sources
  add constraint market_sources_kind_check
  check (kind in ('amis_punjab', 'dealer_submitted', 'manual_entry', 'research_feed', 'community_vetted'));

insert into public.market_sources (code, name, kind, notes)
values (
  'community_local',
  'Community (local)',
  'community_vetted',
  'Community-vetted mandi rates. A rate is promoted here only after its contributor earned trust over 15-20 days of endorsed posts; the widget labels it local, distinct from the AMIS government rate.'
)
on conflict (code) do nothing;

-- market_rates() needs NO change: it already returns source_code and
-- source_name, so the widget labels the row "Community (local)" vs
-- "AMIS Punjab" and is_recent still applies.

-- ---------------------------------------------------------------------------
-- Posting with rate fields (M4 extension of community_create_post)
-- ---------------------------------------------------------------------------

-- The rate-aware post creator. It calls the 9-argument creator from M3 and
-- then, when rate fields are present and the board is 'market', inserts the
-- structured rate report in the same transaction. One structured rate per
-- post (the unique index on post_id makes a replay a no-op).
create or replace function public.community_create_post(
  p_author_id uuid,
  p_board_code text,
  p_title text,
  p_body text,
  p_crop_code text default null,
  p_area_label text default null,
  p_language text default 'ur',
  p_idempotency_key text default null,
  p_group_id uuid default null,
  p_rate_commodity text default null,
  p_rate_market text default null,
  p_rate_min numeric default null,
  p_rate_max numeric default null,
  p_rate_modal numeric default null,
  p_rate_observed_on date default null
)
returns public.community_posts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_post public.community_posts;
  v_group_community_id uuid;
begin
  v_post := public.community_create_post(
    p_author_id, p_board_code, p_title, p_body, p_crop_code, p_area_label, p_language, p_idempotency_key, p_group_id
  );

  if p_board_code = 'market'
     and p_rate_commodity is not null
     and p_rate_market is not null
     and (p_rate_min is not null or p_rate_max is not null or p_rate_modal is not null)
     and p_rate_observed_on is not null then
    select community_id into v_group_community_id
      from public.community_groups where id = v_post.group_id;

    insert into public.community_rate_reports (
      post_id, contributor_id, community_id, group_id, commodity_code, market_name,
      min_price, max_price, modal_price, observed_on
    ) values (
      v_post.id, p_author_id, v_group_community_id, v_post.group_id, p_rate_commodity, p_rate_market,
      p_rate_min, p_rate_max, p_rate_modal, p_rate_observed_on
    )
    on conflict (post_id) do nothing;
  end if;

  return v_post;
end;
$$;
