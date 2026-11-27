-- Review hardening (2026-11-26): the second batch of fixes from the project review.
--
--   1. applications: a signed-in user can add only a paper application (origin 'manual'), and
--      cannot change the columns that say where a row came from or that drive retention.
--   2. archive_before and report_seasonality read dates in Oregon time, not UTC.
--   3. "Hired" means the same in every report: the application is in a hired stage now. The
--      funnel and time-to-fill used to count a Hired click that was later corrected.
--   4. The daily market-check job no longer takes a run that never finished for a good one, and
--      marks such a run as failed.
--   5. profiles: only admins read other people's sign-in settings; everyone else gets names and
--      roles from the view profile_names.
--   6. retention_backlog(): how many applications are overdue for the file purge, so the tracker
--      can say when the daily job is not getting through.

-- ---------------------------------------------------------------------------------------------
-- 1. applications: what a signed-in user may write
-- ---------------------------------------------------------------------------------------------
-- Jotform rows are written by the webhook and the backfill with the service role. From the
-- browser staff add paper applications only: a row that claimed origin 'jotform' with someone
-- else's submission id would make the webhook skip the real submission.

drop policy "applications: staff can add applications" on recruiting.applications;
create policy "applications: staff can add applications"
  on recruiting.applications for insert to authenticated
  with check (recruiting.is_staff() and origin = 'manual');

-- On update the columns below go back to what they were when a signed-in user writes the row.
-- contact_purged_at and files_purged_at are stamped by the retention jobs; setting one by hand
-- would stop the purge from ever looking at the row. submitted_at on a Jotform row is Jotform's
-- time and starts the six-month clock (the received date of a paper application stays editable).
-- auth.uid() is null for the service role, pg_cron and the SQL Editor, which are not held back.
create or replace function recruiting.guard_application_writes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  new.origin := old.origin;
  new.jotform_submission_id := old.jotform_submission_id;
  new.form_id := old.form_id;
  new.contact_purged_at := old.contact_purged_at;
  new.files_purged_at := old.files_purged_at;
  if old.origin = 'jotform' then
    new.submitted_at := old.submitted_at;
  end if;
  return new;
end;
$$;

revoke all on function recruiting.guard_application_writes() from public;

create trigger applications_guard_writes
  before update on recruiting.applications
  for each row execute function recruiting.guard_application_writes();

-- ---------------------------------------------------------------------------------------------
-- 2. Oregon dates
-- ---------------------------------------------------------------------------------------------
-- The cutoff is an Oregon calendar date. Compared as a bare date it meant midnight UTC, so
-- applications from the last evening before the cutoff were left out.

create or replace function recruiting.archive_before(p_cutoff date)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  n integer;
  v_archive smallint;
begin
  if recruiting.current_role() is not null and not recruiting.is_staff() then
    raise exception 'only admin and hr can archive applications' using errcode = 'insufficient_privilege';
  end if;
  select id into v_archive from recruiting.stages where is_archive;
  if v_archive is null then
    raise exception 'no stage has is_archive set';
  end if;
  update recruiting.application_status st
  set stage_id = v_archive
  from recruiting.applications a
  where a.id = st.application_id
    and st.stage_id = recruiting.first_stage_id()
    and a.submitted_at < (p_cutoff::timestamp at time zone 'America/Los_Angeles');
  get diagnostics n = row_count;
  return n;
end;
$$;

-- An application at 9 pm on the last day of a month belongs to that month.
create or replace view recruiting.report_seasonality
with (security_barrier = true)
as
select
  date_trunc('month', a.submitted_at at time zone 'America/Los_Angeles')::date as month,
  coalesce(a.location, '(blank)')           as location,
  count(*)::integer                         as applications,
  count(*) filter (where s.is_hired)::integer as hired
from recruiting.applications a
join recruiting.application_status st on st.application_id = a.id
join recruiting.stages s on s.id = st.stage_id
where recruiting.is_staff()
group by 1, 2;

-- ---------------------------------------------------------------------------------------------
-- 3. Hired = in a hired stage now
-- ---------------------------------------------------------------------------------------------
-- A move to Hired in the history counts only while the application is still hired, so a
-- mis-click that was corrected no longer shows as a hire (or as having reached the stages
-- before it). The other stages still count as reached whatever happened afterwards.

create or replace view recruiting.report_position_funnel
with (security_barrier = true)
as
with reached as (
  select
    h.application_id,
    max(s.sort_order)  as max_sort_order,
    bool_or(s.is_hired) as hired
  from recruiting.status_history h
  join recruiting.stages s on s.id = h.to_stage_id
  join recruiting.application_status st on st.application_id = h.application_id
  join recruiting.stages cs on cs.id = st.stage_id
  where not s.is_terminal or (s.is_hired and cs.is_hired)
  group by h.application_id
)
select
  a.position_id,
  p.title                                          as position_title,
  coalesce(p.location, a.location, '(blank)')      as location,
  p.status                                         as position_status,
  coalesce(nullif(btrim(a.source), ''), '(blank)') as source,
  recruiting.source_channel(a.source)              as channel,
  s.id                                             as stage_id,
  s.name                                           as stage_name,
  s.sort_order,
  count(*) filter (
    where (s.is_hired and r.hired)
       or (not s.is_terminal and r.max_sort_order >= s.sort_order)
  )::integer                                       as applications
from recruiting.applications a
left join recruiting.positions p on p.id = a.position_id
join reached r on r.application_id = a.id
cross join recruiting.stages s
where recruiting.is_staff()
  and (not s.is_terminal or s.is_hired)
group by 1, 2, 3, 4, 5, 6, 7, 8, 9;

create or replace view recruiting.report_time_to_fill
with (security_barrier = true)
as
with o as (
  select po.*,
         lead(po.opened_at) over (partition by po.position_id order by po.opened_at) as next_opened_at
  from recruiting.position_openings po
),
apps as (
  select o.id as opening_id, a.id as application_id
  from o
  join recruiting.applications a on a.position_id = o.position_id
  where (a.submitted_at at time zone 'America/Los_Angeles')::date >= o.opened_at
    and (o.next_opened_at is null or (a.submitted_at at time zone 'America/Los_Angeles')::date < o.next_opened_at)
),
hires as (
  select ap.opening_id,
         count(distinct h.application_id)::integer as hires,
         min((h.changed_at at time zone 'America/Los_Angeles')::date) as first_hired_at
  from apps ap
  join recruiting.status_history h on h.application_id = ap.application_id
  join recruiting.stages s on s.id = h.to_stage_id and s.is_hired
  join recruiting.application_status st on st.application_id = ap.application_id
  join recruiting.stages cs on cs.id = st.stage_id and cs.is_hired
  group by ap.opening_id
),
counts as (
  select opening_id, count(*)::integer as applicants from apps group by opening_id
)
select
  o.id                                   as opening_id,
  p.id                                   as position_id,
  p.title,
  p.location,
  p.status,
  o.opened_at,
  o.closed_at,
  o.note,
  coalesce(c.applicants, 0)              as applicants,
  coalesce(hi.hires, 0)                  as hires,
  hi.first_hired_at,
  hi.first_hired_at - o.opened_at        as days_to_first_hire,
  o.closed_at - o.opened_at              as days_open,
  case when o.closed_at is null
       then (now() at time zone 'America/Los_Angeles')::date - o.opened_at end as days_open_so_far
from o
join recruiting.positions p on p.id = o.position_id
left join counts c  on c.opening_id = o.id
left join hires  hi on hi.opening_id = o.id
where recruiting.is_staff();

comment on view recruiting.report_time_to_fill is
  'One row per opening: opened and closed dates, days open, applicants who applied from the day it '
  'opened until the position next opened, how many of them are hired now and days from opening to '
  'the first such hire. Staff only.';

-- ---------------------------------------------------------------------------------------------
-- 4. Market checks that never finished
-- ---------------------------------------------------------------------------------------------
-- A run row starts with summary and error both null and is filled in when the Edge Function
-- finishes. If the function is stopped first, the row stayed that way for good, and the schedule
-- read "error is null" as a good recent run and skipped the position for its week or month.
-- The job now marks a run with no result after an hour as failed, and a run counts as good only
-- when it has a summary.

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
  update recruiting.market_checks
  set error = 'The check did not finish: it was stopped before it could save a result.',
      finished_at = now()
  where summary is null and error is null
    and ran_at < now() - interval '1 hour';

  for r in
    select p.id
    from recruiting.positions p
    where p.status = 'open'
      and p.market_tracking
      and not exists (
        select 1 from recruiting.market_checks c
        where c.position_id = p.id
          and c.error is null
          and c.summary is not null
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

-- ---------------------------------------------------------------------------------------------
-- 5. profiles: sign-in settings are for admins
-- ---------------------------------------------------------------------------------------------
-- Every tracker user could read every profile row, which since the testing window includes who
-- signs in without a second factor and who still has a temporary password. Names and roles are
-- all the tracker needs for "changed by" and assignees, so they move to a view; the table itself
-- is readable by admins, and by each user for their own row (the policy from 20261102000100).

drop policy "profiles: app users can read all profiles" on recruiting.profiles;
create policy "profiles: admins can read all profiles"
  on recruiting.profiles
  for select
  to authenticated
  using (recruiting.current_role() = 'admin');

create view recruiting.profile_names
with (security_barrier = true)
as
select p.user_id, p.name, p.role
from recruiting.profiles p
where recruiting.current_role() is not null;

comment on view recruiting.profile_names is
  'Name and role of every tracker user, for anyone with a profile. The sign-in settings on profiles are not here.';

grant select on recruiting.profile_names to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. retention_backlog()
-- ---------------------------------------------------------------------------------------------
-- The file purge runs the day contact details are removed. Applications whose details went more
-- than two days ago and that still have files mean the daily call to recruiting-retention is
-- failing (a missing vault secret, a function error), which nothing else reports.

create or replace function recruiting.retention_backlog()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case when recruiting.is_staff() then (
    select count(*)::integer
    from recruiting.applications a
    where a.contact_purged_at < now() - interval '2 days'
      and a.files_purged_at is null)
  end;
$$;

comment on function recruiting.retention_backlog() is
  'Applications whose contact details were purged more than two days ago and whose files are still stored: above zero means the daily file purge is not getting through. Null for anyone but admin and hr.';

revoke execute on function recruiting.retention_backlog() from public;
grant execute on function recruiting.retention_backlog() to authenticated, service_role;
