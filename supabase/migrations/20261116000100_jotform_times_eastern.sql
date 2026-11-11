-- Jotform submission times were stored three hours late (README "What the Jotform time fix did").
--
-- Jotform's REST API writes a submission's `created_at` in US Eastern time, whatever the account's
-- own time zone setting says. The Rexius account is set to America/Los_Angeles, and the webhook and
-- the backfill read `created_at` as Pacific, so every Jotform application's `submitted_at` was three
-- hours later than the real moment. Checked on 2026-11-11: a submission that reached the webhook at
-- 2026-11-08 01:20:08 UTC (17:20 Pacific) had created_at "2026-11-07 20:20:04" and was stored as
-- 04:20:04 UTC. Since 2026-11-11 21:09:59 UTC the hosted webhook reads Eastern (function secret
-- JOTFORM_TIMEZONE=America/New_York, and the code default JOTFORM_CLOCK from this change on).
--
-- This migration re-reads each affected time: the stored instant, shown on a Pacific clock, is the
-- string Jotform sent; read that string on the Eastern clock instead. Rows corrected:
--   * Jotform applications imported before 2026-11-11 21:09:59 UTC (all of them were read as
--     Pacific), plus any later row whose stored time is after its own import, which only a
--     Pacific reading can produce. Paper applications (origin manual) are untouched.
--   * their first status_history row (the "Applied" entry, written by trigger with the submitted
--     time), and stage_since where it still equals the submitted time;
--   * a position opening dated from a position's first application (the reopenable-positions
--     migration started each existing opening at the earlier of the day the position was added
--     and the day its first application arrived), when that date moves a day earlier, so the
--     first application still counts towards its opening. Only openings that migration created
--     (no opened_by, created before 2026-11-02) and that still carry that date move. On the hosted
--     data (2026-11-11) that is two: Landscape Construction Lead (Central Oregon) and Digital
--     Marketer (Eugene/Springfield), each one day earlier.
-- The "last updated" stamps are left alone: the two set_updated_at triggers are switched off for
-- this transaction only, so a corrected row does not look edited today.
--
-- On the local stack this runs before supabase/seed.sql loads, so it changes nothing there.
-- To undo: the inverse is ((t at time zone 'America/New_York') at time zone 'America/Los_Angeles').

create temporary table jotform_time_fix on commit drop as
select a.id,
       a.position_id,
       a.submitted_at as old_at,
       (a.submitted_at at time zone 'America/Los_Angeles') at time zone 'America/New_York' as new_at
from recruiting.applications a
where a.origin = 'jotform'
  and (a.imported_at < timestamptz '2026-11-11 21:09:59+00' or a.submitted_at > a.imported_at);

alter table recruiting.applications disable trigger applications_set_updated_at;
alter table recruiting.application_status disable trigger application_status_set_updated_at;

-- Openings first, while the old times are still in place to compare against.
with first_app as (
  select f.position_id,
         min((f.old_at at time zone 'America/Los_Angeles')::date) as old_first,
         min((f.new_at at time zone 'America/Los_Angeles')::date) as new_first
  from jotform_time_fix f
  where f.position_id is not null
  group by f.position_id
),
earlier as (
  select a.position_id, min((a.submitted_at at time zone 'America/Los_Angeles')::date) as first_other
  from recruiting.applications a
  where a.position_id is not null and a.id not in (select id from jotform_time_fix)
  group by a.position_id
)
update recruiting.position_openings o
set opened_at = fa.new_first
from first_app fa
left join earlier e on e.position_id = fa.position_id
where o.position_id = fa.position_id
  and o.opened_at = fa.old_first
  and fa.new_first < fa.old_first
  and o.opened_by is null
  and o.created_at < timestamptz '2026-11-02 00:00+00' -- made by 20261111000100, applied to hosted 2026-11-01
  and (e.first_other is null or e.first_other >= fa.old_first);

update recruiting.status_history h
set changed_at = f.new_at
from jotform_time_fix f
where h.application_id = f.id
  and h.from_stage_id is null
  and h.changed_at = f.old_at;

update recruiting.application_status st
set stage_since = f.new_at
from jotform_time_fix f
where st.application_id = f.id
  and st.stage_since = f.old_at;

update recruiting.applications a
set submitted_at = f.new_at
from jotform_time_fix f
where a.id = f.id;

alter table recruiting.applications enable trigger applications_set_updated_at;
alter table recruiting.application_status enable trigger application_status_set_updated_at;
