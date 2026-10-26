-- Manual applications, part 2 of 3: let recruiting.applications hold an application that did not
-- come through Jotform (a paper form handed in at a yard or mailed in), typed in by admin or hr
-- in the tracker with a scan of the paper attached.
--
-- What changes:
--   * applications.origin (enum application_origin: jotform | manual, default jotform). Every
--     existing row is a Jotform row and keeps the default.
--   * jotform_submission_id and form_id become nullable. A manual row has neither; a Jotform row
--     must still have both (check constraint). Uniqueness of the submission id moves from the
--     table constraint to a partial unique index that ignores nulls. The backfill inserts and
--     updates by row id, never with an ON CONFLICT clause, so it is unaffected.
--   * entered_by (auth user) and entered_at: who typed a manual row in and when. Null for Jotform
--     rows. A before-insert trigger stamps both from the session so the browser cannot claim
--     another user did it. jotform_url stays null for manual rows (check constraint).
--   * One storage policy letting admin and hr upload objects under the `manual/` prefix of
--     bucket recruiting-files (object key manual/<application id>/<file name>). No update or
--     delete policy, so a scan cannot be replaced or removed from the browser; reads keep the
--     Phase 4 rule (any user with a profile), which is what lets managers open scans too.
--
-- Nothing changes for managers here; part 3 (20261030000300) adds the new columns to the
-- curated view. Staff already have insert on applications and application_files (Phase 3b),
-- and the applications_init_status trigger creates the status and history rows, so the frontend
-- inserts one applications row, uploads the files, and inserts their application_files rows.
--
-- Personal information (CLAUDE.md section 5): a scanned paper application may show a Social
-- Security number, driver licence number or signature. The scan is stored as an image only;
-- nothing is read out of it into a column, and the README tells staff to redact those fields
-- before uploading. The typed fields are the same ones the Jotform import keeps.

-- ---------------------------------------------------------------------------------------------
-- Enum
-- ---------------------------------------------------------------------------------------------

create type recruiting.application_origin as enum ('jotform', 'manual');

comment on type recruiting.application_origin is
  'jotform: imported from a Jotform submission by the backfill or the webhook. manual: typed '
  'into the tracker by admin or hr from a paper application.';

-- ---------------------------------------------------------------------------------------------
-- applications: origin, entered_by, entered_at; nullable Jotform columns
-- ---------------------------------------------------------------------------------------------

alter table recruiting.applications
  add column origin     recruiting.application_origin not null default 'jotform',
  add column entered_by uuid references auth.users (id) on delete set null,
  add column entered_at timestamptz;

comment on column recruiting.applications.origin is
  'jotform (default; backfill and webhook) or manual (typed in by staff from a paper form).';
comment on column recruiting.applications.entered_by is
  'For manual rows: the app user who typed it in (stamped by trigger from the session). Null '
  'for Jotform rows.';
comment on column recruiting.applications.entered_at is
  'For manual rows: when it was typed in (stamped by trigger). submitted_at is the date the '
  'paper application was received, which staff enter. Null for Jotform rows.';

alter table recruiting.applications
  alter column jotform_submission_id drop not null,
  alter column form_id drop not null,
  drop constraint applications_jotform_submission_id_key;

create unique index applications_jotform_submission_id_key
  on recruiting.applications (jotform_submission_id)
  where jotform_submission_id is not null;

alter table recruiting.applications
  add constraint applications_jotform_rows_have_ids check (
    origin <> 'jotform' or (jotform_submission_id is not null and form_id is not null)
  ),
  add constraint applications_manual_rows_have_no_jotform_ids check (
    origin <> 'manual' or (jotform_submission_id is null and jotform_url is null and entered_at is not null)
  );

create index applications_origin_idx on recruiting.applications (origin) where origin <> 'jotform';

comment on table recruiting.applications is
  'One row per application. origin = jotform: one per Jotform submission, written only by the '
  'backfill and the webhook, with Jotform as the source of record for the raw submission. '
  'origin = manual: typed in by admin or hr from a paper application, with the scan in Storage '
  'under manual/<id>/ and recorded in application_files as kind scan.';

-- Stamp who entered a manual row and when. Runs before insert so entered_at is set before the
-- check constraint is evaluated. Jotform rows (service_role) are left alone. The trigger uses
-- the session's user, so a browser request cannot attribute the entry to someone else.
create or replace function recruiting.stamp_manual_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.origin = 'manual' then
    new.entered_at := coalesce(new.entered_at, now());
    new.entered_by := coalesce(auth.uid(), new.entered_by);
  end if;
  return new;
end;
$$;

comment on function recruiting.stamp_manual_entry() is
  'Before insert on applications: for origin = manual, set entered_at to now() when missing and '
  'entered_by to the signed-in user.';

revoke execute on function recruiting.stamp_manual_entry() from public;

create trigger applications_stamp_manual_entry
  before insert on recruiting.applications
  for each row execute function recruiting.stamp_manual_entry();

-- ---------------------------------------------------------------------------------------------
-- Storage: staff may upload scans and resumes for manual entries under manual/ only
-- ---------------------------------------------------------------------------------------------

create policy "recruiting-files: staff can upload manual scans"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'recruiting-files'
    and name like 'manual/%'
    and recruiting.is_staff()
  );

-- Deliberately no update or delete policy for manual/: a scan, once uploaded, is not replaced
-- or removed from the browser. Keys under applications/ stay service_role-only (Phase 4).
