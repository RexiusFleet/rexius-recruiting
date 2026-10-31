-- Contact-detail retention: six months (2026-10-30).
--
-- Email and phone are kept only while the tracker has a use for them. Six months after an
-- application was submitted, once it is no longer moving through the pipeline, this removes the
-- applicant's email, phone, their normalised forms and the alternate phone from `answers`, and
-- stamps `contact_purged_at`. Everything else stays (name, city, state, position, source,
-- stage, history), so reports are unchanged. Jotform keeps the original submission, and an
-- applicant who applies again arrives as a new row with fresh contact details.
--
-- "No longer moving" means the current stage is terminal (Hired, Not selected, Withdrawn,
-- Archived) or the stage has not changed in six months either. An application still being
-- worked keeps its contact details until it settles.
--
-- Pieces:
--   * applications.contact_purged_at: when the details were removed (null = still held).
--   * recruiting.purge_contact_details(retention interval): does the work, returns the count.
--     Security definer, callable only by the database owner and service_role, so no browser
--     session can run or reach it. A daily pg_cron job calls it at 10:20 UTC (02:20/03:20
--     Pacific).
--   * A before-update trigger keeps a purged row purged: a --refresh backfill, a webhook
--     redelivery or an edit cannot bring the details back.
--   * applications_for_managers appends contact_purged_at (create or replace may only append)
--     so the page can say "removed" instead of showing a blank.

alter table recruiting.applications
  add column if not exists contact_purged_at timestamptz;
comment on column recruiting.applications.contact_purged_at is
  'Set by recruiting.purge_contact_details() when the six-month contact retention removed email, phone and the alternate phone. Null while they are still held.';

create or replace function recruiting.purge_contact_details(retention interval default interval '6 months')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  with due as (
    select a.id, f.field_map
    from recruiting.applications a
    left join recruiting.forms f on f.id = a.form_id
    join recruiting.application_status st on st.application_id = a.id
    join recruiting.stages s on s.id = st.stage_id
    where a.contact_purged_at is null
      and a.submitted_at < now() - retention
      and (s.is_terminal or st.stage_since < now() - retention)
  ),
  upd as (
    update recruiting.applications a
    set email = null, email_norm = null, phone = null, phone_norm = null,
        answers = coalesce(a.answers, '{}'::jsonb)
                  - coalesce(due.field_map ->> 'email', '')
                  - coalesce(due.field_map ->> 'phone', '')
                  - coalesce(due.field_map ->> 'phone_alt', ''),
        contact_purged_at = now()
    from due
    where a.id = due.id
    returning 1
  )
  select count(*) into n from upd;
  return n;
end $$;
comment on function recruiting.purge_contact_details(interval) is
  'Removes email, phone (and the alternate phone from answers) from applications submitted more than `retention` ago that are in a terminal stage or have not changed stage in that time; stamps contact_purged_at. Daily pg_cron job; not callable by app users.';
revoke all on function recruiting.purge_contact_details(interval) from public, anon, authenticated;
grant execute on function recruiting.purge_contact_details(interval) to service_role;

-- A purged row stays purged whatever updates it later (backfill --refresh, webhook redelivery,
-- a staff edit): the contact columns are forced back to null and the answer keys dropped.
create or replace function recruiting.keep_contact_purged()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  fm jsonb;
begin
  if old.contact_purged_at is null then
    return new;
  end if;
  new.contact_purged_at := old.contact_purged_at;
  new.email := null; new.email_norm := null; new.phone := null; new.phone_norm := null;
  select f.field_map into fm from recruiting.forms f where f.id = new.form_id;
  new.answers := coalesce(new.answers, '{}'::jsonb)
                 - coalesce(fm ->> 'email', '') - coalesce(fm ->> 'phone', '') - coalesce(fm ->> 'phone_alt', '');
  return new;
end $$;
drop trigger if exists applications_keep_contact_purged on recruiting.applications;
create trigger applications_keep_contact_purged
  before update on recruiting.applications
  for each row execute function recruiting.keep_contact_purged();

-- Daily job. pg_cron is installed by 20261106000100_market_checks.sql.
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'recruiting-purge-contact-details';
  perform cron.schedule('recruiting-purge-contact-details', '20 10 * * *', 'select recruiting.purge_contact_details()');
end $$;

create or replace view recruiting.applications_for_managers
with (security_barrier = true)
as
select
  a.id,
  a.submitted_at,
  a.name,
  a.email,
  a.phone,
  a.city,
  a.state,
  a.location,
  a.position_text,
  a.position_id,
  p.title                           as position_title,
  a.source,
  a.referred_by,
  a.available_start,
  a.has_resume,
  a.language,
  f.label                           as form_label,
  st.stage_id,
  s.name                            as stage_name,
  s.is_terminal                     as stage_is_terminal,
  st.stage_since,
  st.assigned_to,
  a.answers -> (f.field_map ->> 'education')         as education,
  a.answers -> (f.field_map ->> 'relevant_skills')   as relevant_skills,
  a.answers -> (f.field_map ->> 'worked_before')     as worked_at_rexius_before,
  a.answers -> (f.field_map ->> 'applied_before')    as applied_before,
  (
    select jsonb_agg(
      jsonb_build_object(
        'employer',         a.answers -> (e ->> 'name'),
        'location',         a.answers -> (e ->> 'location'),
        'title',            a.answers -> (e ->> 'title'),
        'start',            a.answers -> (e ->> 'start'),
        'end',              a.answers -> (e ->> 'end'),
        'reason',           a.answers -> (e ->> 'reason'),
        'responsibilities', a.answers -> (e ->> 'responsibilities')
      ) order by ord
    )
    from jsonb_array_elements(coalesce(f.field_map -> 'employers', '[]'::jsonb)) with ordinality as emp(e, ord)
    where a.answers ? (e ->> 'name')
  ) as employment_history,
  (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id',            af.id,
        'storage_path',  af.storage_path,
        'original_name', af.original_name,
        'kind',          af.kind
      ) order by af.kind, af.created_at
    ), '[]'::jsonb)
    from recruiting.application_files af
    where af.application_id = a.id
  ) as files,
  (
    select hs.id
    from recruiting.status_history h
    join recruiting.stages hs on hs.id = h.to_stage_id
    where h.application_id = a.id
      and (not hs.is_terminal or hs.is_hired)
    order by hs.sort_order desc
    limit 1
  ) as furthest_stage_id,
  a.origin,
  a.entered_by,
  a.entered_at,
  a.answers ->> 'manual_notes'      as manual_notes,
  a.answers -> (f.field_map ->> 'licence_class')     as licence_class,
  a.contact_purged_at
from recruiting.applications a
left join recruiting.forms f on f.id = a.form_id
join recruiting.application_status st on st.application_id = a.id
join recruiting.stages s on s.id = st.stage_id
left join recruiting.positions p on p.id = a.position_id
where recruiting.current_role() is not null;

comment on view recruiting.applications_for_managers is
  'Curated applications for hiring managers: contact, position, availability, education, '
  'employment history, driver licence class, files (storage paths for signed URLs: resumes, '
  'portfolios and the scan of a manual entry), stage, assignee, the furthest stage reached (for '
  'funnels), origin and who entered a manual row. No notes, tags, raw answers, offers, referrals '
  'or contact log. contact_purged_at is set once the six-month contact retention has removed '
  'email and phone. Any user with a profile may read it; managers have nothing else.';

grant select on recruiting.applications_for_managers to authenticated, service_role;
