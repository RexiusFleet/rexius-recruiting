-- Phase 9a: the per-position market check (CLAUDE.md section 8, "Phase 9 decisions").
--
-- One run answers two questions from public job postings: what others pay for this role in
-- this location, and who else is hiring for it right now. The run itself happens in the Edge
-- Function recruiting-market-check (Claude with web search). This migration adds:
--
--   * positions.market_tracking / market_interval_days: opt-in per position, off by default.
--     HR turns it on for urgent roles and picks weekly (7) or monthly (30).
--   * market_checks: one row per run, never overwritten, so the position page shows the latest
--     run and a history across seasons. A row is inserted when the run starts (summary and
--     error both null = running) and filled in when it finishes; an error is stored on the
--     row, never swallowed.
--   * request_market_check(position_id, trigger): asks the Edge Function to run a check, from
--     inside Postgres through pg_net. The function URL and the shared secret it expects come
--     from Supabase Vault (names below), so nothing secret is in this file or the repo.
--   * run_due_market_checks(): picks open, tracked positions whose last successful run is
--     older than their interval and requests one check each. A daily pg_cron job calls it, so
--     no position needs its own job.
--   * a trigger on positions: a position that becomes open with tracking on (or has tracking
--     turned on while open) is checked at once; closed and draft positions are skipped.
--
-- Access (CLAUDE.md section 7): admin and hr read and write market_checks and the two new
-- columns (the existing positions policies cover the columns); managers read; no profile,
-- nothing; service_role everything (the Edge Function writes the rows).
--
-- Vault secrets the schedule needs (README "What Phase 9a created", step 15), created in the
-- SQL editor, never here:
--   recruiting_market_check_url      https://<ref>.supabase.co/functions/v1/recruiting-market-check
--   recruiting_market_check_secret   the same value as the function secret MARKET_CHECK_SECRET
-- Until both exist the schedule and the trigger do nothing (a warning in the Postgres logs).

-- ---------------------------------------------------------------------------------------------
-- Extensions. pg_cron lives in pg_catalog and pg_net in extensions on Supabase; both are
-- preloaded on the hosted project and on the local stack, so this is an enable, not an install.
-- ---------------------------------------------------------------------------------------------

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------------------------------------
-- positions: opt-in tracking
-- ---------------------------------------------------------------------------------------------

alter table recruiting.positions
  add column market_tracking boolean not null default false,
  add column market_interval_days integer not null default 30
    check (market_interval_days in (7, 30));

comment on column recruiting.positions.market_tracking is
  'Opt-in: run a market check on a schedule while the position is open. Off by default.';
comment on column recruiting.positions.market_interval_days is
  'Days between scheduled market checks: 7 (weekly) or 30 (monthly). Ignored when market_tracking is off.';

-- ---------------------------------------------------------------------------------------------
-- market_checks: one row per run
-- ---------------------------------------------------------------------------------------------

create type recruiting.market_check_trigger as enum ('manual', 'schedule', 'opened');

comment on type recruiting.market_check_trigger is
  'manual: the Check now button. schedule: the daily pg_cron job. opened: the position became open with tracking on.';

create table recruiting.market_checks (
  id            uuid primary key default gen_random_uuid(),
  position_id   uuid not null references recruiting.positions (id) on delete cascade,
  ran_at        timestamptz not null default now(),
  trigger       recruiting.market_check_trigger not null default 'manual',
  requested_by  uuid references auth.users (id) on delete set null,
  summary       text,
  pay_ranges    jsonb not null default '[]'::jsonb,
  postings      jsonb not null default '[]'::jsonb,
  sources       jsonb not null default '[]'::jsonb,
  comparison    jsonb,
  below_market  boolean,
  input_tokens  integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  searches      integer check (searches is null or searches >= 0),
  model         text,
  error         text,
  finished_at   timestamptz,
  check (pay_ranges is null or jsonb_typeof(pay_ranges) = 'array'),
  check (postings is null or jsonb_typeof(postings) = 'array'),
  check (sources is null or jsonb_typeof(sources) = 'array')
);

comment on table recruiting.market_checks is
  'One row per market-check run for a position (Edge Function recruiting-market-check). '
  'summary and error both null: still running. The result is a sample from web search results, '
  'never a complete count; the useful signal is the change between runs.';
comment on column recruiting.market_checks.pay_ranges is
  'Pay references found: [{employer, title, min, max, unit (hour|year), url}]. Figures as advertised by others, never a Rexius wage.';
comment on column recruiting.market_checks.postings is
  'Competing postings found: [{employer, title, pay_text, location, posted, url}].';
comment on column recruiting.market_checks.sources is
  'Pages the web search returned: [{url, title, age}], collected from the tool results, not written by the model.';
comment on column recruiting.market_checks.comparison is
  'How the position''s own advertised range compares with what was found: {unit, position_min, position_max, market_low_median, market_high_median, ranges_compared}.';
comment on column recruiting.market_checks.below_market is
  'True when the top of the position''s advertised range is below the median low end that others advertise. Null when nothing comparable was found or the position has no range.';
comment on column recruiting.market_checks.searches is
  'Web searches the run used (usage.server_tool_use.web_search_requests), for cost.';

create index market_checks_position_idx on recruiting.market_checks (position_id, ran_at desc);

alter table recruiting.market_checks enable row level security;

create policy "market_checks: app users can read market checks"
  on recruiting.market_checks for select to authenticated
  using (recruiting.current_role() is not null);

create policy "market_checks: staff can add market checks"
  on recruiting.market_checks for insert to authenticated
  with check (recruiting.is_staff());

create policy "market_checks: staff can change market checks"
  on recruiting.market_checks for update to authenticated
  using (recruiting.is_staff())
  with check (recruiting.is_staff());

create policy "market_checks: staff can remove market checks"
  on recruiting.market_checks for delete to authenticated
  using (recruiting.is_staff());

grant select, insert, update, delete on recruiting.market_checks to authenticated;
grant all on recruiting.market_checks to service_role;

-- ---------------------------------------------------------------------------------------------
-- Asking the Edge Function to run, from inside Postgres
-- ---------------------------------------------------------------------------------------------

-- Posts {position_id, trigger} to the function with the shared secret in a header. Returns the
-- pg_net request id, or null when the vault has no URL or secret yet (logged as a warning).
-- Owned by postgres and granted to nobody else: only the schedule and the trigger call it.
create or replace function recruiting.request_market_check(
  p_position_id uuid,
  p_trigger recruiting.market_check_trigger default 'schedule'
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_request_id bigint;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'recruiting_market_check_url' limit 1;
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'recruiting_market_check_secret' limit 1;
  if v_url is null or v_secret is null then
    raise warning 'recruiting.request_market_check: vault secrets recruiting_market_check_url / recruiting_market_check_secret are not set; position % not checked', p_position_id;
    return null;
  end if;
  select net.http_post(
    url := v_url,
    body := jsonb_build_object('position_id', p_position_id, 'trigger', p_trigger::text),
    headers := jsonb_build_object('content-type', 'application/json', 'x-market-check-secret', v_secret),
    timeout_milliseconds := 15000
  ) into v_request_id;
  return v_request_id;
end;
$$;

comment on function recruiting.request_market_check(uuid, recruiting.market_check_trigger) is
  'Asks the Edge Function recruiting-market-check to run for a position (pg_net POST with the shared secret from the vault). Returns the pg_net request id, or null when the vault is not set up.';

revoke execute on function recruiting.request_market_check(uuid, recruiting.market_check_trigger) from public;

-- Open, tracked positions whose last successful run is older than their interval, skipping any
-- position with a run (finished or not) in the last day so a failing key does not pile up
-- rows. Returns the number of checks requested. Called by the daily cron job.
create or replace function recruiting.run_due_market_checks()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select p.id
    from recruiting.positions p
    where p.status = 'open'
      and p.market_tracking
      and not exists (
        select 1 from recruiting.market_checks c
        where c.position_id = p.id
          and c.error is null
          and c.ran_at > now() - make_interval(days => p.market_interval_days))
      and not exists (
        select 1 from recruiting.market_checks c
        where c.position_id = p.id
          and c.ran_at > now() - interval '1 day')
    order by p.location, p.title
  loop
    if recruiting.request_market_check(r.id, 'schedule') is not null then
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

comment on function recruiting.run_due_market_checks() is
  'Requests a market check for every open, tracked position whose last successful run is older than its interval (daily pg_cron job). Returns how many were requested.';

revoke execute on function recruiting.run_due_market_checks() from public;

-- A position that becomes open with tracking on, or has tracking turned on while open, is
-- checked at once (unless it was checked in the last day). Closed and draft positions never
-- trigger a run.
create or replace function recruiting.positions_market_check_on_open()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'open' and new.market_tracking
     and (tg_op = 'INSERT' or old.status <> 'open' or not old.market_tracking)
     and not exists (
       select 1 from recruiting.market_checks c
       where c.position_id = new.id and c.ran_at > now() - interval '1 day')
  then
    perform recruiting.request_market_check(new.id, 'opened');
  end if;
  return new;
end;
$$;

revoke execute on function recruiting.positions_market_check_on_open() from public;

create trigger positions_market_check_on_open
  after insert or update of status, market_tracking on recruiting.positions
  for each row execute function recruiting.positions_market_check_on_open();

-- ---------------------------------------------------------------------------------------------
-- The daily schedule: 13:00 UTC is 6 am Pacific (5 am in winter), before anyone opens the
-- tracker. Re-running this migration elsewhere replaces the job rather than adding a second.
-- ---------------------------------------------------------------------------------------------

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'recruiting-market-checks';
  perform cron.schedule('recruiting-market-checks', '0 13 * * *', 'select recruiting.run_due_market_checks()');
end $$;
