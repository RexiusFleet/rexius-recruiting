-- Archived stage for applications that predate the tracker.
--
-- The hosted backfill (2026-10-27) imported every submission since the forms went live, all of
-- them in the first stage. The team decided to review only applications submitted on or after
-- 2026-10-01 and to keep the older ones for reference rather than reconstruct their outcomes.
-- "Archived" is a terminal stage that is neither a hire nor a rejection: the funnel and source
-- quality reports already ignore terminal stages that are not hires, and the time-in-stage
-- report is redefined below so a visit that ends by archiving is not counted as time spent in
-- Applied. Applicants per source and per month still count archived rows, which is real.
--
-- recruiting.archive_before(cutoff) moves the rows in one statement; the existing
-- status_history trigger records each move (changed_by null = done by the system, not a user).
-- Only applications still in the first stage move; anything someone has already worked stays.

alter table recruiting.stages
  add column if not exists is_archive boolean not null default false;

comment on column recruiting.stages.is_archive is
  'The one terminal stage that means "set aside without an outcome" (applications that predate '
  'the tracker). Not a hire, not a rejection; time-in-stage ignores moves into it.';

alter table recruiting.stages
  add constraint stages_archive_is_terminal check (not is_archive or (is_terminal and not is_hired));

create unique index if not exists stages_one_archive_idx on recruiting.stages ((true)) where is_archive;

insert into recruiting.stages (id, name, sort_order, is_terminal, is_hired, is_archive) values
  (9, 'Archived', 90, true, false, true)
on conflict (id) do nothing;

select setval(pg_get_serial_sequence('recruiting.stages', 'id'),
              (select max(id) from recruiting.stages));

-- ---------------------------------------------------------------------------------------------
-- archive_before(cutoff): first-stage applications submitted before the cutoff -> Archived.
-- ---------------------------------------------------------------------------------------------

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
    and a.submitted_at < p_cutoff;
  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function recruiting.archive_before(date) is
  'Move every application still in the first stage and submitted before the cutoff date to the '
  'Archived stage. Returns the number moved. The status_history trigger logs each move. Staff only.';

revoke execute on function recruiting.archive_before(date) from public;
grant execute on function recruiting.archive_before(date) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- report_time_in_stage: a visit that ends by archiving does not count as time in that stage.
-- ---------------------------------------------------------------------------------------------

create or replace view recruiting.report_time_in_stage
with (security_barrier = true)
as
with visits as (
  select
    h.application_id,
    h.to_stage_id as stage_id,
    h.changed_at  as entered_at,
    lead(h.changed_at)  over (partition by h.application_id order by h.changed_at, h.id) as left_at,
    lead(h.to_stage_id) over (partition by h.application_id order by h.changed_at, h.id) as next_stage_id
  from recruiting.status_history h
),
counted as (
  select v.*
  from visits v
  left join recruiting.stages nxt on nxt.id = v.next_stage_id
  where not coalesce(nxt.is_archive, false)
)
select
  s.id         as stage_id,
  s.name       as stage_name,
  s.sort_order,
  s.is_terminal,
  count(v.application_id) filter (where v.left_at is not null)::integer as completed_visits,
  round((avg(extract(epoch from (v.left_at - v.entered_at)) / 86400)
         filter (where v.left_at is not null))::numeric, 1)             as avg_days,
  round((percentile_cont(0.5) within group (order by extract(epoch from (v.left_at - v.entered_at)) / 86400)
         filter (where v.left_at is not null))::numeric, 1)             as median_days,
  count(v.application_id) filter (where v.left_at is null)::integer     as currently_in_stage,
  round((avg(extract(epoch from (now() - v.entered_at)) / 86400)
         filter (where v.left_at is null))::numeric, 1)                 as avg_days_so_far
from recruiting.stages s
left join counted v on v.stage_id = s.id
where recruiting.is_staff()
group by s.id, s.name, s.sort_order, s.is_terminal;

comment on view recruiting.report_time_in_stage is
  'Per stage: how many applications have left it and how long they stayed (average and median '
  'days), plus how many are in it now and for how long so far. From status_history; a stay that '
  'ended by archiving is left out. Staff only.';

grant select on recruiting.report_time_in_stage to authenticated, service_role;
