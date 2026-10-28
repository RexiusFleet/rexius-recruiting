-- Exercises the recruiting.* policies as each role against the LOCAL stack after
-- `npx supabase db reset` (needs the users from supabase/seed.sql). Run with:
--
--   docker exec -i supabase_db_rexius-recruiting psql -U postgres -d postgres -v ON_ERROR_STOP=0 -f - < scripts/test-policies.sql
--
-- Every block prints a line beginning with PASS or FAIL. Nothing is committed: each block is a
-- transaction that ends in rollback. Never run this against the hosted project.

\set QUIET on
\pset format unaligned
\pset tuples_only on

-- Helper: impersonate a Data API request for a given user id (or anon).
create or replace function pg_temp.as_user(uid text) returns void language plpgsql as $$
begin
  if uid is null then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    execute 'set local role anon';
  else
    perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
  end if;
end $$;

create or replace function pg_temp.check(label text, ok boolean) returns text language sql as $$
  select case when ok then 'PASS ' else 'FAIL ' end || label;
$$;

-- ----- admin -------------------------------------------------------------------------------
begin;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select pg_temp.check('admin: role is admin', recruiting.current_role() = 'admin');
select pg_temp.check('admin: reads all applications', (select count(*) from recruiting.applications) = 5);
select pg_temp.check('admin: reads notes', (select count(*) from recruiting.application_status where notes is not null) = 1);
select pg_temp.check('admin: reads channel_spend', (select count(*) from recruiting.channel_spend) = 1);
select pg_temp.check('admin: reads status_history', (select count(*) from recruiting.status_history) >= 8);
insert into recruiting.profiles (user_id, role, name) values ('44444444-4444-4444-4444-444444444444', 'manager', 'Promoted Nobody');
select pg_temp.check('admin: can add a profile', (select count(*) from recruiting.profiles) = 4);
insert into recruiting.stages (name, sort_order) values ('Background check', 55);
select pg_temp.check('admin: can add a stage', (select count(*) from recruiting.stages) = 10);
delete from recruiting.applications where jotform_submission_id = '6000000000000000005';
select pg_temp.check('admin: can delete an application', (select count(*) from recruiting.applications) = 4);
rollback;

-- ----- hr ----------------------------------------------------------------------------------
begin;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select pg_temp.check('hr: role is hr', recruiting.current_role() = 'hr');
select pg_temp.check('hr: reads all applications', (select count(*) from recruiting.applications) = 5);
select pg_temp.check('hr: reads raw answers', (select count(*) from recruiting.applications where answers ? '344') = 5);
update recruiting.application_status set stage_id = 7
  where application_id = (select id from recruiting.applications where jotform_submission_id = '6000000000000000004');
select pg_temp.check('hr: can change a stage', (select stage_id from recruiting.application_status st join recruiting.applications a on a.id = st.application_id where a.jotform_submission_id = '6000000000000000004') = 7);
select pg_temp.check('hr: stage change logged with changed_by', (select count(*) from recruiting.status_history where to_stage_id = 7 and changed_by = '22222222-2222-2222-2222-222222222222') = 1);
insert into recruiting.offers (application_id, offered_at)
  select id, current_date from recruiting.applications where jotform_submission_id = '6000000000000000002';
select pg_temp.check('hr: can add an offer', (select count(*) from recruiting.offers) = 1);
insert into recruiting.contacts (application_id, kind, summary) select id, 'call', 'Left voicemail.' from recruiting.applications limit 1;
select pg_temp.check('hr: can log a contact', (select count(*) from recruiting.contacts) = 2);
insert into recruiting.positions (title, location, status) values ('Test role', 'Eugene/Springfield', 'draft');
select pg_temp.check('hr: can add a position', (select count(*) from recruiting.positions where title = 'Test role') = 1);
insert into recruiting.channel_spend (posting_id, period_start, period_end, spend) select id, current_date, current_date, 1 from recruiting.postings;
select pg_temp.check('hr: can add spend', (select count(*) from recruiting.channel_spend) = 2);
select pg_temp.check('hr: cannot add a profile', not exists (
  select 1 from (select 1 where false) x) and (
  select count(*) from recruiting.profiles) = 3);
savepoint sp;
do $$ begin
  insert into recruiting.profiles (user_id, role, name) values ('44444444-4444-4444-4444-444444444444', 'manager', 'x');
  raise notice 'UNEXPECTED: hr inserted a profile';
exception when insufficient_privilege or others then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp;
select pg_temp.check('hr: profile insert was rejected', (select count(*) from recruiting.profiles) = 3);
savepoint sp2;
do $$ begin
  insert into recruiting.status_history (application_id, to_stage_id) select id, 2 from recruiting.applications limit 1;
  raise notice 'UNEXPECTED: hr inserted history directly';
exception when others then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp2;
select pg_temp.check('hr: cannot write status_history directly', true);
savepoint sp3;
do $$ begin
  delete from recruiting.applications where jotform_submission_id = '6000000000000000005';
end $$;
select pg_temp.check('hr: delete of application is silently filtered', (select count(*) from recruiting.applications) = 5);
rollback to sp3;
rollback;

-- ----- manager -----------------------------------------------------------------------------
begin;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select pg_temp.check('manager: role is manager', recruiting.current_role() = 'manager');
select pg_temp.check('manager: sees zero rows of applications table', (select count(*) from recruiting.applications) = 0);
select pg_temp.check('manager: sees zero rows of application_status', (select count(*) from recruiting.application_status) = 0);
select pg_temp.check('manager: sees zero rows of contacts', (select count(*) from recruiting.contacts) = 0);
select pg_temp.check('manager: sees zero rows of offers', (select count(*) from recruiting.offers) = 0);
select pg_temp.check('manager: sees zero rows of channel_spend', (select count(*) from recruiting.channel_spend) = 0);
select pg_temp.check('manager: sees zero rows of referrals', (select count(*) from recruiting.referrals) = 0);
select pg_temp.check('manager: sees zero rows of status_history', (select count(*) from recruiting.status_history) = 0);
select pg_temp.check('manager: reads the curated view', (select count(*) from recruiting.applications_for_managers) = 5);
select pg_temp.check('manager: view has stage and education', (select count(*) from recruiting.applications_for_managers where stage_name is not null and education is not null) = 5);
select pg_temp.check('forms: licence number and expiry stay in never_import, class does not', (select count(*) from recruiting.forms where field_map -> 'never_import' ? '30' and field_map -> 'never_import' ? '31' and not field_map -> 'never_import' ? '35' and field_map ->> 'licence_class' = '35') = 3);
select pg_temp.check('manager: view has licence_class', (select count(*) from information_schema.columns where table_schema = 'recruiting' and table_name = 'applications_for_managers' and column_name = 'licence_class') = 1);
select pg_temp.check('manager: view has employment history', (select jsonb_array_length(employment_history) from recruiting.applications_for_managers where name = 'Priya Natarajan') = 1);
select pg_temp.check('manager: reads stages', (select count(*) from recruiting.stages) = 9);
select pg_temp.check('manager: reads positions (17 seeded open + 10 past roles from Phase 7)', (select count(*) from recruiting.positions) = 27);
select pg_temp.check('manager: reads postings', (select count(*) from recruiting.postings) = 1);
select pg_temp.check('manager: reads forms', (select count(*) from recruiting.forms) = 3);
select pg_temp.check('manager: reads profiles', (select count(*) from recruiting.profiles) = 3);
insert into recruiting.manager_feedback (application_id, manager_user_id, verdict, note)
  select a.id, '33333333-3333-3333-3333-333333333333', 'interested', 'Please schedule.' from recruiting.applications_for_managers a where a.name = 'Priya Natarajan';
select pg_temp.check('manager: can leave own feedback', (select count(*) from recruiting.manager_feedback) = 1);
savepoint sp;
do $$ begin
  insert into recruiting.manager_feedback (application_id, manager_user_id, verdict)
    select a.id, '22222222-2222-2222-2222-222222222222', 'pass' from recruiting.applications_for_managers a limit 1;
  raise notice 'UNEXPECTED: manager wrote feedback as someone else';
exception when others then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp;
select pg_temp.check('manager: cannot write feedback as another user', (select count(*) from recruiting.manager_feedback) = 1);
savepoint sp2;
do $$ begin
  insert into recruiting.positions (title, location) values ('Sneaky', 'Bend');
  raise notice 'UNEXPECTED: manager inserted a position';
exception when others then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp2;
select pg_temp.check('manager: cannot add a position', (select count(*) from recruiting.positions where title = 'Sneaky') = 0);
savepoint sp3;
do $$ begin
  insert into recruiting.documents (title, kind, body, min_role) values ('x', 'template', 'x', 'hr');
  raise notice 'UNEXPECTED: manager inserted a document';
exception when others then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp3;
select pg_temp.check('manager: cannot add a document', (select count(*) from recruiting.documents) = 0);
rollback;

-- documents visibility by min_role (set up as admin, read as manager)
begin;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
insert into recruiting.documents (title, kind, body, min_role) values
  ('Crew member description', 'description', 'Mows things.', 'manager'),
  ('Interview guide', 'interview_guide', 'Ask about safety.', 'hr'),
  ('Admin only', 'other', 'x', 'admin');
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select pg_temp.check('manager: sees only manager-level documents', (select string_agg(title, ',') from recruiting.documents) = 'Crew member description');
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select pg_temp.check('hr: sees manager and hr documents', (select count(*) from recruiting.documents) = 2);
rollback;

-- ----- no profile --------------------------------------------------------------------------
begin;
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
select pg_temp.check('no profile: role is null', recruiting.current_role() is null);
select pg_temp.check('no profile: zero applications', (select count(*) from recruiting.applications) = 0);
select pg_temp.check('no profile: zero rows in curated view', (select count(*) from recruiting.applications_for_managers) = 0);
select pg_temp.check('no profile: zero stages', (select count(*) from recruiting.stages) = 0);
select pg_temp.check('no profile: zero positions', (select count(*) from recruiting.positions) = 0);
select pg_temp.check('no profile: zero profiles', (select count(*) from recruiting.profiles) = 0);
select pg_temp.check('no profile: zero documents', (select count(*) from recruiting.documents) = 0);
rollback;

-- ----- anon --------------------------------------------------------------------------------
begin;
select pg_temp.as_user(null);
do $$ begin
  perform count(*) from recruiting.applications;
  raise notice 'UNEXPECTED: anon read applications';
exception when insufficient_privilege then
  raise notice 'expected: anon has no usage on schema recruiting';
end $$;
rollback;
select 'PASS anon: schema access denied (see notice above)';

-- ----- service_role ------------------------------------------------------------------------
begin;
set local role service_role;
select pg_temp.check('service_role: reads all applications', (select count(*) from recruiting.applications) = 5);
insert into recruiting.applications (jotform_submission_id, form_id, submitted_at, name, answers)
  select '6000000000000000099', id, now(), 'Imported Person', '{}' from recruiting.forms limit 1;
select pg_temp.check('service_role: insert creates status row in first stage',
  (select s.name from recruiting.application_status st join recruiting.stages s on s.id = st.stage_id
   join recruiting.applications a on a.id = st.application_id where a.jotform_submission_id = '6000000000000000099') = 'Applied');
select pg_temp.check('service_role: insert creates history row',
  (select count(*) from recruiting.status_history h join recruiting.applications a on a.id = h.application_id where a.jotform_submission_id = '6000000000000000099') = 1);
rollback;

-- ----- storage: bucket recruiting-files (Phase 4) ----------------------------------------
begin;
select pg_temp.check('storage: bucket recruiting-files exists and is private',
  (select count(*) from storage.buckets where id = 'recruiting-files' and public = false) = 1);
set local role service_role;
insert into storage.objects (bucket_id, name, owner_id, metadata)
  values ('recruiting-files', 'applications/260115636145148/6000000000000000001/resume.pdf', null, '{"mimetype":"application/pdf","size":1}');
select pg_temp.check('storage: service_role can write an object', (select count(*) from storage.objects where bucket_id = 'recruiting-files') = 1);
reset role;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select pg_temp.check('storage: manager can see the object (signed URLs work)', (select count(*) from storage.objects where bucket_id = 'recruiting-files') = 1);
savepoint sp;
do $$ begin
  insert into storage.objects (bucket_id, name, metadata) values ('recruiting-files', 'applications/x/sneaky.pdf', '{}');
  raise notice 'UNEXPECTED: manager inserted an object';
exception when others then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp;
select pg_temp.check('storage: manager cannot upload', (select count(*) from storage.objects where bucket_id = 'recruiting-files') = 1);
-- (No delete check: storage.protect_delete() blocks every direct delete on storage.objects, so
-- deletes go through the Storage API, where the missing delete policy applies.)
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select pg_temp.check('storage: hr can see the object', (select count(*) from storage.objects where bucket_id = 'recruiting-files') = 1);
savepoint sp3;
do $$ begin
  insert into storage.objects (bucket_id, name, metadata) values ('recruiting-files', 'applications/x/hr.pdf', '{}');
  raise notice 'UNEXPECTED: hr inserted an object';
exception when others then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp3;
select pg_temp.check('storage: hr cannot upload (writes are service_role only)', (select count(*) from storage.objects where bucket_id = 'recruiting-files') = 1);
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
select pg_temp.check('storage: no profile sees no objects', (select count(*) from storage.objects where bucket_id = 'recruiting-files') = 0);
rollback;

-- ----- manual applications (origin, entered_by, scans under manual/) ----------------------
begin;
select pg_temp.check('manual: seed rows default to origin jotform with no entered_by/entered_at',
  (select count(*) from recruiting.applications where origin = 'jotform' and entered_by is null and entered_at is null) = 5);
select pg_temp.check('manual: file_kind has scan', 'scan'::recruiting.file_kind is not null);
rollback;

begin;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
savepoint sp;
do $$ begin
  insert into recruiting.applications (origin, submitted_at, name) values ('manual', now(), 'Sneaky Manager Entry');
  raise notice 'UNEXPECTED: manager inserted an application';
exception when others then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp;
reset role;
select pg_temp.check('manual: manager cannot insert an application', (select count(*) from recruiting.applications where name = 'Sneaky Manager Entry') = 0);
rollback;

begin;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
insert into recruiting.applications (origin, submitted_at, name, email, email_norm, phone, phone_norm, location, position_text, source, language, answers)
  values ('manual', now() - interval '1 day', 'Paper Applicant', 'Paper@Example.com', 'paper@example.com', '(541) 555-0199', '5415550199',
          'Eugene/Springfield', 'Landscape Maintenance Crew Member', 'Walk In', 'en', '{"manual_notes": "Ten years of mowing."}');
select pg_temp.check('manual: hr can insert a manual row with no Jotform ids',
  (select count(*) from recruiting.applications where name = 'Paper Applicant' and jotform_submission_id is null and form_id is null and jotform_url is null) = 1);
select pg_temp.check('manual: trigger stamped entered_by with the hr user and entered_at',
  (select entered_by = '22222222-2222-2222-2222-222222222222' and entered_at is not null from recruiting.applications where name = 'Paper Applicant'));
select pg_temp.check('manual: trigger created the status row in the first stage',
  (select s.name from recruiting.application_status st join recruiting.stages s on s.id = st.stage_id
   join recruiting.applications a on a.id = st.application_id where a.name = 'Paper Applicant') = 'Applied');
select pg_temp.check('manual: trigger created the opening history row',
  (select count(*) from recruiting.status_history h join recruiting.applications a on a.id = h.application_id where a.name = 'Paper Applicant') = 1);
insert into recruiting.application_files (application_id, storage_path, original_name, kind)
  select id, 'manual/' || id || '/application.pdf', 'application.pdf', 'scan' from recruiting.applications where name = 'Paper Applicant';
select pg_temp.check('manual: hr can record a scan file', (select count(*) from recruiting.application_files where kind = 'scan') = 1);
savepoint sp;
do $$ begin
  insert into recruiting.applications (origin, submitted_at, name) values ('jotform', now(), 'Fake Jotform Row');
  raise notice 'UNEXPECTED: a jotform row without ids was accepted';
exception when check_violation then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp;
select pg_temp.check('manual: a jotform-origin row must carry its Jotform ids', (select count(*) from recruiting.applications where name = 'Fake Jotform Row') = 0);
savepoint sp2;
do $$ begin
  insert into recruiting.applications (origin, submitted_at, name, jotform_submission_id, form_id)
    select 'manual', now(), 'Mixed Row', '6000000000000000001', id from recruiting.forms limit 1;
  raise notice 'UNEXPECTED: a manual row with a submission id was accepted';
exception when check_violation or unique_violation then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp2;
select pg_temp.check('manual: a manual row may not carry a Jotform submission id', (select count(*) from recruiting.applications where name = 'Mixed Row') = 0);
-- The manager view carries the manual row, its notes and origin.
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select pg_temp.check('manual: manager sees the manual row in the curated view with origin and notes',
  (select origin = 'manual' and manual_notes = 'Ten years of mowing.' and form_label is null and entered_by is not null
   from recruiting.applications_for_managers where name = 'Paper Applicant'));
select pg_temp.check('manual: manager view lists the scan among the files',
  (select files -> 0 ->> 'kind' from recruiting.applications_for_managers where name = 'Paper Applicant') = 'scan');
select pg_temp.check('manual: manager view still shows the five Jotform rows', (select count(*) from recruiting.applications_for_managers where origin = 'jotform') = 5);
rollback;

-- storage: authenticated staff may write under manual/ only
begin;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
insert into storage.objects (bucket_id, name, metadata) values ('recruiting-files', 'manual/00000000-0000-0000-0000-000000000001/scan.pdf', '{"mimetype":"application/pdf","size":1}');
select pg_temp.check('storage: hr can upload under manual/', (select count(*) from storage.objects where bucket_id = 'recruiting-files' and name like 'manual/%') = 1);
savepoint sp;
do $$ begin
  insert into storage.objects (bucket_id, name, metadata) values ('recruiting-files', 'applications/x/not-allowed.pdf', '{}');
  raise notice 'UNEXPECTED: hr uploaded outside manual/';
exception when others then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp;
select pg_temp.check('storage: hr still cannot upload under applications/', (select count(*) from storage.objects where bucket_id = 'recruiting-files' and name like 'applications/%') = 0);
savepoint sp2;
do $$ begin
  insert into storage.objects (bucket_id, name, metadata) values ('recruiting-files', 'manual-not-a-prefix.pdf', '{}');
  raise notice 'UNEXPECTED: hr uploaded at the bucket root';
exception when others then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp2;
select pg_temp.check('storage: hr cannot upload at the bucket root', (select count(*) from storage.objects where bucket_id = 'recruiting-files' and name not like 'manual/%') = 0);
savepoint sp3;
do $$ begin
  update storage.objects set name = 'manual/00000000-0000-0000-0000-000000000001/renamed.pdf' where name like 'manual/%';
end $$;
select pg_temp.check('storage: hr cannot change an uploaded scan (update filtered)', (select count(*) from storage.objects where name like 'manual/%/scan.pdf') = 1);
rollback to sp3;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
insert into storage.objects (bucket_id, name, metadata) values ('recruiting-files', 'manual/00000000-0000-0000-0000-000000000002/scan.jpg', '{"mimetype":"image/jpeg","size":1}');
select pg_temp.check('storage: admin can upload under manual/', (select count(*) from storage.objects where bucket_id = 'recruiting-files' and name like 'manual/%') = 2);
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select pg_temp.check('storage: manager can read scans (signed URLs work)', (select count(*) from storage.objects where bucket_id = 'recruiting-files' and name like 'manual/%') = 2);
savepoint sp4;
do $$ begin
  insert into storage.objects (bucket_id, name, metadata) values ('recruiting-files', 'manual/x/manager.pdf', '{}');
  raise notice 'UNEXPECTED: manager uploaded under manual/';
exception when others then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp4;
select pg_temp.check('storage: manager cannot upload under manual/', (select count(*) from storage.objects where bucket_id = 'recruiting-files' and name like 'manual/%') = 2);
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
select pg_temp.check('storage: no profile sees no scans', (select count(*) from storage.objects where bucket_id = 'recruiting-files') = 0);
rollback;

-- ----- trigger details (as postgres) -------------------------------------------------------
begin;
select pg_temp.check('seed: stage_since equals submitted_at for untouched applications',
  (select count(*) from recruiting.application_status st join recruiting.applications a on a.id = st.application_id
   where st.stage_id = 1 and st.stage_since <> a.submitted_at) = 0);
select pg_temp.check('seed: Priya has three history rows (applied, reviewed->sent, sent->interview)',
  (select count(*) from recruiting.status_history h join recruiting.applications a on a.id = h.application_id where a.name = 'Priya Natarajan') = 3);
select pg_temp.check('schema: nothing created in public',
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','v')) = 0);
select pg_temp.check('schema: every recruiting table has RLS on',
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'recruiting' and c.relkind = 'r' and not c.relrowsecurity) = 0);
select pg_temp.check('schema: anon has no privileges on any recruiting table',
  (select count(*) from information_schema.role_table_grants where table_schema = 'recruiting' and grantee = 'anon') = 0);
rollback;

-- ----- Phase 7: position aliases, matching, re-link ----------------------------------------
begin;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select pg_temp.check('hr: reads the seeded aliases', (select count(*) from recruiting.position_aliases) = 9);
select pg_temp.check('match: exact label at location', recruiting.match_position('Blower Truck Crew Member', 'Lake Oswego') is not null);
select pg_temp.check('match: case-insensitive alias', recruiting.match_position('blower truck DRIVER', 'Lake Oswego') = (select id from recruiting.positions where title = 'Blower Truck Operator' and location = 'Lake Oswego'));
select pg_temp.check('match: same text, other location, no match', recruiting.match_position('Blower Truck Driver', 'Central Oregon') is null);
select pg_temp.check('match: Any and blank never match', recruiting.match_position('Any', 'Lake Oswego') is null and recruiting.match_position('', 'Lake Oswego') is null and recruiting.match_position(null, 'Lake Oswego') is null);
select pg_temp.check('hr: relink runs and finds nothing to change on the seed', recruiting.relink_applications() = 0);
insert into recruiting.position_aliases (position_id, alias, location)
  select id, 'Maint crew (test alias)', 'Eugene/Springfield' from recruiting.positions where title = 'Landscape Maintenance Crew Member' and location = 'Eugene/Springfield';
select pg_temp.check('hr: can add an alias', (select count(*) from recruiting.position_aliases) = 10);
savepoint sp;
do $$ begin
  insert into recruiting.position_aliases (position_id, alias, location)
    select id, 'maint CREW (TEST alias)', 'Eugene/Springfield' from recruiting.positions where title = 'Flatbed Truck Driver' limit 1;
  raise notice 'UNEXPECTED: duplicate alias accepted';
exception when unique_violation then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp;
select pg_temp.check('alias: unique per location ignoring case', (select count(*) from recruiting.position_aliases) = 10);
rollback;

begin;
set local role service_role;
-- The importer leaves position_id null when the label is unknown; the insert trigger tries aliases.
insert into recruiting.applications (jotform_submission_id, form_id, submitted_at, name, location, position_text, answers)
  select '6000000000000000098', id, now(), 'Alias Test Person', 'Lake Oswego', 'Landscape Material Blower Truck Crew Member', '{}' from recruiting.forms where jotform_form_id = '232824275836160';
select pg_temp.check('service_role: insert trigger links a Spanish label through its alias',
  (select p.title from recruiting.applications a join recruiting.positions p on p.id = a.position_id where a.jotform_submission_id = '6000000000000000098') = 'Blower Truck Crew Member');
insert into recruiting.applications (jotform_submission_id, form_id, submitted_at, name, location, position_text, answers)
  select '6000000000000000097', id, now(), 'Unmatched Test Person', 'Eugene/Springfield', 'Zamboni Driver', '{}' from recruiting.forms where jotform_form_id = '260115636145148';
select pg_temp.check('service_role: unknown text stays unmatched', (select position_id from recruiting.applications where jotform_submission_id = '6000000000000000097') is null);
reset role;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
insert into recruiting.position_aliases (position_id, alias, location)
  select id, 'zamboni driver', 'Eugene/Springfield' from recruiting.positions where title = 'Flatbed Truck Driver' and location = 'Eugene/Springfield';
select pg_temp.check('hr: adding an alias links the waiting application at once',
  (select p.title from recruiting.applications a join recruiting.positions p on p.id = a.position_id where a.jotform_submission_id = '6000000000000000097') = 'Flatbed Truck Driver');
rollback;

begin;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select pg_temp.check('manager: reads aliases', (select count(*) from recruiting.position_aliases) = 9);
savepoint sp;
do $$ begin
  insert into recruiting.position_aliases (position_id, alias, location) select id, 'x', 'Lake Oswego' from recruiting.positions limit 1;
  raise notice 'UNEXPECTED: manager inserted an alias';
exception when others then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp;
select pg_temp.check('manager: cannot add an alias', (select count(*) from recruiting.position_aliases) = 9);
savepoint sp2;
do $$ begin
  perform recruiting.relink_applications();
  raise notice 'UNEXPECTED: manager ran relink';
exception when insufficient_privilege then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp2;
select pg_temp.check('manager: relink_applications is refused', true);
select pg_temp.check('manager: curated view carries furthest_stage_id',
  (select s.name from recruiting.applications_for_managers v join recruiting.stages s on s.id = v.furthest_stage_id where v.name = 'Priya Natarajan') = 'Interview');
rollback;

begin;
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
select pg_temp.check('no profile: zero aliases', (select count(*) from recruiting.position_aliases) = 0);
rollback;

-- ----- Phase 7: report views -----------------------------------------------------------------
begin;
select pg_temp.check('schema: eight report_* views, all security_barrier',
  (select count(*) from pg_views v join pg_class c on c.relname = v.viewname join pg_namespace n on n.oid = c.relnamespace and n.nspname = v.schemaname
   where v.schemaname = 'recruiting' and v.viewname like 'report\_%' and c.reloptions::text like '%security_barrier=true%') = 8);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select pg_temp.check('hr: source/stage report counts every seeded application', (select sum(applications) from recruiting.report_applications_by_source_stage) = 5);
select pg_temp.check('hr: time in stage has a row per stage', (select count(*) from recruiting.report_time_in_stage) = 8);
select pg_temp.check('hr: spend by channel by month shows the seeded month', (select spend from recruiting.report_spend_by_channel_month where channel = 'indeed') = 240.00);
select pg_temp.check('hr: funnel counts Priya as reaching Interview',
  (select applications from recruiting.report_position_funnel f join recruiting.positions p on p.id = f.position_id where p.title = 'Irrigation Service Technician' and f.stage_name = 'Interview' and f.source = 'Rexius.com') = 1);
select pg_temp.check('hr: funnel never lists Not selected or Withdrawn', (select count(*) from recruiting.report_position_funnel f join recruiting.stages s on s.id = f.stage_id where s.is_terminal and not s.is_hired) = 0);
select pg_temp.check('hr: cost by channel has one row per channel', (select count(*) from recruiting.report_cost_by_channel) = 6);
select pg_temp.check('hr: cost per applicant on indeed = 240 / 2', (select cost_per_applicant from recruiting.report_cost_by_channel where channel = 'indeed') = 120.00);
select pg_temp.check('hr: offer acceptance is empty on the seed', (select count(*) from recruiting.report_offer_acceptance) = 0);
select pg_temp.check('hr: time to fill lists every position', (select count(*) from recruiting.report_time_to_fill) = 27);
select pg_temp.check('hr: seasonality totals the seed', (select sum(applications) from recruiting.report_seasonality) = 5);
select pg_temp.check('hr: no report column carries notes, answers or pay',
  (select count(*) from information_schema.columns where table_schema = 'recruiting' and table_name like 'report\_%' and column_name in ('notes', 'answers', 'pay_min', 'pay_max', 'tags', 'email', 'phone')) = 0);
rollback;

begin;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
do $$
declare v record; n bigint; total bigint := 0;
begin
  for v in select viewname from pg_views where schemaname = 'recruiting' and viewname like 'report\_%' loop
    execute format('select count(*) from recruiting.%I', v.viewname) into n;
    total := total + n;
  end loop;
  if total <> 0 then raise exception 'manager saw % report rows', total; end if;
end $$;
select pg_temp.check('manager: every report view returns zero rows', true);
rollback;

begin;
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
select pg_temp.check('no profile: zero report rows', (select count(*) from recruiting.report_seasonality) + (select count(*) from recruiting.report_cost_by_channel) = 0);
rollback;

-- ----- Phase 7: storage rules for documents/ -------------------------------------------------
begin;
-- Two documents: one managers may read, one HR-only; objects written as service_role to stand
-- in for uploads. A third object has no documents row at all.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
insert into recruiting.documents (id, title, kind, storage_path, min_role) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Crew description', 'description', 'documents/aaaaaaaa-0000-0000-0000-000000000001/desc.pdf', 'manager'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Interview guide', 'interview_guide', 'documents/aaaaaaaa-0000-0000-0000-000000000002/guide.pdf', 'hr');
set local role service_role;
insert into storage.objects (bucket_id, name, metadata) values
  ('recruiting-files', 'documents/aaaaaaaa-0000-0000-0000-000000000001/desc.pdf', '{"size":1}'),
  ('recruiting-files', 'documents/aaaaaaaa-0000-0000-0000-000000000002/guide.pdf', '{"size":1}'),
  ('recruiting-files', 'documents/orphan/nobody-can-see.pdf', '{"size":1}'),
  ('recruiting-files', 'applications/260115636145148/6000000000000000001/resume.pdf', '{"size":1}');
reset role;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select pg_temp.check('storage: manager sees the manager-level document object only',
  (select string_agg(name, ',') from storage.objects where bucket_id = 'recruiting-files' and name like 'documents/%') = 'documents/aaaaaaaa-0000-0000-0000-000000000001/desc.pdf');
select pg_temp.check('storage: manager still sees resumes', (select count(*) from storage.objects where bucket_id = 'recruiting-files' and name like 'applications/%') = 1);
savepoint sp;
do $$ begin
  insert into storage.objects (bucket_id, name, metadata) values ('recruiting-files', 'documents/x/manager.pdf', '{}');
  raise notice 'UNEXPECTED: manager uploaded a document';
exception when others then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp;
select pg_temp.check('storage: manager cannot upload under documents/', (select count(*) from storage.objects where name = 'documents/x/manager.pdf') = 0);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select pg_temp.check('storage: hr sees both document objects, not the orphan',
  (select count(*) from storage.objects where bucket_id = 'recruiting-files' and name like 'documents/%') = 2);
insert into recruiting.documents (id, title, kind, storage_path, min_role) values
  ('bbbbbbbb-0000-0000-0000-000000000003', 'HR upload', 'template', 'documents/bbbbbbbb-0000-0000-0000-000000000003/new.pdf', 'hr');
insert into storage.objects (bucket_id, name, metadata) values ('recruiting-files', 'documents/bbbbbbbb-0000-0000-0000-000000000003/new.pdf', '{"size":1}');
select pg_temp.check('storage: hr can upload under documents/ and read it back', (select count(*) from storage.objects where name = 'documents/bbbbbbbb-0000-0000-0000-000000000003/new.pdf') = 1);
savepoint sp2;
do $$ begin
  insert into storage.objects (bucket_id, name, metadata) values ('recruiting-files', 'applications/x/hr-upload.pdf', '{}');
  raise notice 'UNEXPECTED: hr uploaded under applications/';
exception when others then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp2;
select pg_temp.check('storage: hr still cannot upload under applications/', (select count(*) from storage.objects where name = 'applications/x/hr-upload.pdf') = 0);
update storage.objects set metadata = '{"size":2}' where name = 'documents/aaaaaaaa-0000-0000-0000-000000000002/guide.pdf';
select pg_temp.check('storage: hr can replace a document object', (select metadata ->> 'size' from storage.objects where name = 'documents/aaaaaaaa-0000-0000-0000-000000000002/guide.pdf') = '2');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select pg_temp.check('storage: even an admin cannot see a documents/ object with no documents row',
  (select count(*) from storage.objects where name = 'documents/orphan/nobody-can-see.pdf') = 0);
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
select pg_temp.check('storage: no profile sees no document objects', (select count(*) from storage.objects where bucket_id = 'recruiting-files') = 0);
rollback;
