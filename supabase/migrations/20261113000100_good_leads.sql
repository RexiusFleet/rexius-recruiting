-- Good leads (2026-11-09).
--
-- Staff can flag an application as a "good lead": someone worth calling back later whatever
-- the outcome was (an experienced crew member there was no opening for, a strong applicant who
-- declined). The flag is separate from the stage, so the stage keeps recording what happened
-- and the reports are unchanged.
--
-- Retention: a good lead is exempt from the six-month contact and file purge (20261109000100,
-- 20261109000200) until `lead_keep_until`, which defaults to twelve months after the
-- application was submitted and can never be later than that. Staff may shorten it. On the
-- day after it passes, the daily purge job clears the flag (and its reason and dates), and the
-- normal six-month rule applies again. Removing the flag by hand does the same at the next run.
-- The file purge follows contact_purged_at, so the files are held for exactly as long.
--
-- Pieces:
--   * application_status.is_lead, lead_reason (required while flagged), lead_revisit_on (when
--     to look again; optional), lead_keep_until, lead_flagged_by, lead_flagged_at.
--   * recruiting.keep_lead_fields(): before insert or update on application_status. Stamps
--     who flagged and when, defaults and caps lead_keep_until, requires a reason, and blanks
--     every lead column when the flag is off.
--   * recruiting.expire_leads(): clears flags whose lead_keep_until has passed. Called by
--     purge_contact_details() before it purges, so one cron job does both in order.
--   * recruiting.purge_contact_details(): skips applications flagged as a good lead.
--   * applications_for_managers appends is_lead (create or replace may only append). Managers
--     see that an applicant is a good lead; the reason and dates stay HR and admin only.

alter table recruiting.application_status
  add column if not exists is_lead         boolean not null default false,
  add column if not exists lead_reason     text,
  add column if not exists lead_revisit_on date,
  add column if not exists lead_keep_until date,
  add column if not exists lead_flagged_by uuid references auth.users (id) on delete set null,
  add column if not exists lead_flagged_at timestamptz;

comment on column recruiting.application_status.is_lead is
  'Good lead: worth following up later, whatever the stage. Exempts the application from the six-month contact and file purge until lead_keep_until.';
comment on column recruiting.application_status.lead_reason is
  'Why this is a good lead. Required while is_lead; HR and admin only.';
comment on column recruiting.application_status.lead_revisit_on is
  'When staff mean to look at this lead again (for example the start of spring hiring). Optional.';
comment on column recruiting.application_status.lead_keep_until is
  'Last day (Oregon time) the lead flag holds the contact details and files. Defaults to twelve months after the application and cannot be later; the daily purge clears the flag after it.';
comment on column recruiting.application_status.lead_flagged_by is
  'Who set the flag. Stamped by trigger from the session.';
comment on column recruiting.application_status.lead_flagged_at is
  'When the flag was set. Stamped by trigger.';

create index if not exists application_status_lead_idx
  on recruiting.application_status (lead_revisit_on) where is_lead;

create or replace function recruiting.keep_lead_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_submitted timestamptz;
  v_today date := (now() at time zone 'America/Los_Angeles')::date;
  v_cap date;
  v_new_flag boolean;
begin
  if not new.is_lead then
    new.lead_reason := null; new.lead_revisit_on := null; new.lead_keep_until := null;
    new.lead_flagged_by := null; new.lead_flagged_at := null;
    return new;
  end if;

  new.lead_reason := nullif(btrim(new.lead_reason), '');
  if new.lead_reason is null then
    raise exception 'a good lead needs a reason' using errcode = 'check_violation';
  end if;

  select a.submitted_at into v_submitted from recruiting.applications a where a.id = new.application_id;
  v_cap := ((v_submitted at time zone 'America/Los_Angeles')::date + interval '12 months')::date;
  v_new_flag := tg_op = 'INSERT' or not old.is_lead;

  if v_new_flag then
    if v_cap < v_today then
      raise exception 'this application is more than twelve months old; it cannot be kept as a good lead'
        using errcode = 'check_violation';
    end if;
    new.lead_flagged_at := now();
    new.lead_flagged_by := auth.uid();
    new.lead_keep_until := coalesce(new.lead_keep_until, v_cap);
  else
    new.lead_flagged_at := old.lead_flagged_at;
    new.lead_flagged_by := old.lead_flagged_by;
    new.lead_keep_until := coalesce(new.lead_keep_until, old.lead_keep_until, v_cap);
  end if;

  if new.lead_keep_until > v_cap then
    raise exception 'a good lead is kept for at most twelve months after the application (until %)', v_cap
      using errcode = 'check_violation';
  end if;
  if (v_new_flag or new.lead_keep_until is distinct from old.lead_keep_until) and new.lead_keep_until < v_today then
    raise exception 'the keep-until date cannot be in the past' using errcode = 'check_violation';
  end if;
  return new;
end $$;
comment on function recruiting.keep_lead_fields() is
  'Before insert or update on application_status: a good lead needs a reason, gets who and when stamped, and is kept until at most twelve months after the application; with the flag off every lead column is null.';

drop trigger if exists application_status_keep_lead_fields on recruiting.application_status;
create trigger application_status_keep_lead_fields
  before insert or update on recruiting.application_status
  for each row execute function recruiting.keep_lead_fields();

create or replace function recruiting.expire_leads()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  with upd as (
    update recruiting.application_status st
    set is_lead = false
    where st.is_lead
      and st.lead_keep_until < (now() at time zone 'America/Los_Angeles')::date
    returning 1
  )
  select count(*) into n from upd;
  return n;
end $$;
comment on function recruiting.expire_leads() is
  'Clears the good-lead flag (and its reason and dates) once lead_keep_until has passed, so the six-month retention applies again. Called by purge_contact_details(); not callable by app users.';
revoke all on function recruiting.expire_leads() from public, anon, authenticated;
grant execute on function recruiting.expire_leads() to service_role;

-- Same as 20261109000100 with two changes: expired lead flags are cleared first, and an
-- application that is still a good lead is skipped.
create or replace function recruiting.purge_contact_details(retention interval default interval '6 months')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  perform recruiting.expire_leads();
  with due as (
    select a.id, f.field_map
    from recruiting.applications a
    left join recruiting.forms f on f.id = a.form_id
    join recruiting.application_status st on st.application_id = a.id
    join recruiting.stages s on s.id = st.stage_id
    where a.contact_purged_at is null
      and a.submitted_at < now() - retention
      and (s.is_terminal or st.stage_since < now() - retention)
      and not st.is_lead
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
  'Removes email, phone (and the alternate phone from answers) from applications submitted more than `retention` ago that are in a terminal stage or have not changed stage in that time; stamps contact_purged_at. Skips good leads (application_status.is_lead) and first clears lead flags whose lead_keep_until has passed. Daily pg_cron job; not callable by app users.';
revoke all on function recruiting.purge_contact_details(interval) from public, anon, authenticated;
grant execute on function recruiting.purge_contact_details(interval) to service_role;

-- ---------------------------------------------------------------------------------------------
-- applications_for_managers: append `is_lead` (create or replace view may only append)
-- ---------------------------------------------------------------------------------------------

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
  a.contact_purged_at,
  a.files_purged_at,
  (
    select jsonb_agg(
      jsonb_build_object('key', t ->> 'key', 'label', t ->> 'label', 'original', t ->> 'original', 'english', t ->> 'english')
      order by ord
    )
    from (
      select sm.translations
      from recruiting.applicant_summaries sm
      where sm.application_id = a.id and sm.finished_at is not null and sm.error is null
      order by sm.created_at desc
      limit 1
    ) latest
    cross join lateral jsonb_array_elements(latest.translations) with ordinality as tr(t, ord)
    where coalesce((t ->> 'manager')::boolean, false)
  ) as translation,
  st.is_lead
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
  'funnels), origin and who entered a manual row, and the English translation of the answers '
  'listed here when a summary has translated them. No notes, tags, raw answers, offers, '
  'referrals, contact log or summary. contact_purged_at and files_purged_at are set once the '
  'six-month retention has removed email and phone, then the files. is_lead says staff flagged the applicant as a good lead to follow up later (the reason and '
  'dates are not here). Any user with a profile may read it; managers have nothing else.';

grant select on recruiting.applications_for_managers to authenticated, service_role;
