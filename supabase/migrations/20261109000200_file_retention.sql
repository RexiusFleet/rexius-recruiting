-- File retention: resumes, portfolios and scans follow the contact details (2026-10-30).
--
-- A resume carries the street address, phone and email the tracker no longer keeps, and a
-- scan of a paper application shows the whole form. Once the six-month contact purge
-- (20261109000100) has reached an application, its files go too: every application_files row
-- and the objects behind them in bucket recruiting-files, for every applicant including hires
-- (the personnel record lives in HR's own system, and Jotform keeps the original).
--
-- Deleting a storage.objects row from SQL leaves the file bytes behind, so the deletion runs in
-- the Edge Function recruiting-retention through the Storage API. The pieces here:
--   * applications.files_purged_at: when the files were removed (null = still held, or none).
--   * recruiting.request_file_purge(): posts to the function through pg_net with the URL and
--     shared secret the market-check jobs keep in the vault (recruiting_market_check_url with
--     the function name swapped, recruiting_market_check_secret). Daily pg_cron job at 10:40
--     UTC, twenty minutes after the contact purge.
--   * A before-insert trigger on application_files refuses a file for an application whose
--     files were purged (a --refresh backfill re-copies files; the backfill also skips them).
--   * keep_contact_purged() also keeps files_purged_at.
--   * applications_for_managers appends files_purged_at.

alter table recruiting.applications
  add column if not exists files_purged_at timestamptz;
comment on column recruiting.applications.files_purged_at is
  'Set by the recruiting-retention Edge Function once the six-month retention removed the application''s files (resumes, portfolios, scans) from Storage. Null while they are still held.';

create or replace function recruiting.request_file_purge()
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
  if not exists (select 1 from recruiting.applications where contact_purged_at is not null and files_purged_at is null) then
    return null;
  end if;
  select replace(decrypted_secret, 'recruiting-market-check', 'recruiting-retention') into v_url
    from vault.decrypted_secrets where name = 'recruiting_market_check_url' limit 1;
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'recruiting_market_check_secret' limit 1;
  if v_url is null or v_secret is null then
    raise warning 'recruiting.request_file_purge: vault secrets recruiting_market_check_url / recruiting_market_check_secret are not set; files not purged';
    return null;
  end if;
  select net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('content-type', 'application/json', 'x-market-check-secret', v_secret),
    timeout_milliseconds := 15000
  ) into v_request_id;
  return v_request_id;
end;
$$;
comment on function recruiting.request_file_purge() is
  'Asks the recruiting-retention Edge Function to remove the files of applications whose contact details were purged (daily pg_cron job). Returns the pg_net request id, or null when nothing is due or the vault is not set up.';
revoke all on function recruiting.request_file_purge() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'recruiting-purge-files';
  perform cron.schedule('recruiting-purge-files', '40 10 * * *', 'select recruiting.request_file_purge()');
end $$;

-- No new file for an application whose files were purged.
create or replace function recruiting.refuse_file_after_purge()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from recruiting.applications a where a.id = new.application_id and a.files_purged_at is not null) then
    raise exception 'application % had its files removed by the six-month retention; no new file may be attached', new.application_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists application_files_refuse_after_purge on recruiting.application_files;
create trigger application_files_refuse_after_purge
  before insert on recruiting.application_files
  for each row execute function recruiting.refuse_file_after_purge();

-- The contact-purge guard also keeps files_purged_at and has_resume.
create or replace function recruiting.keep_contact_purged()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  fm jsonb;
begin
  if old.files_purged_at is not null then
    new.files_purged_at := old.files_purged_at;
    new.has_resume := false;
  end if;
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
  a.files_purged_at
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
  'or contact log. contact_purged_at and files_purged_at are set once the six-month retention '
  'has removed email and phone, then the files. Any user with a profile may read it; managers '
  'have nothing else.';

grant select on recruiting.applications_for_managers to authenticated, service_role;
