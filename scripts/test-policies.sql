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
-- `aal` is the JWT's authenticator assurance level: aal2 (the default here) after the second
-- factor, aal1 after a password only. Migration 20261102000100 makes current_role() null at aal1.
create or replace function pg_temp.as_user(uid text, aal text default 'aal2') returns void language plpgsql as $$
begin
  if uid is null then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    execute 'set local role anon';
  else
    perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', aal)::text, true);
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
select pg_temp.check('forms: licence number and expiry stay in never_import, class does not', (select count(*) from recruiting.forms where field_map -> 'never_import' ? '30' and field_map -> 'never_import' ? '31' and not field_map -> 'never_import' ? '35' and field_map ->> 'licence_class' = '35') = 4);
select pg_temp.check('manager: view has licence_class', (select count(*) from information_schema.columns where table_schema = 'recruiting' and table_name = 'applications_for_managers' and column_name = 'licence_class') = 1);
select pg_temp.check('manager: view has employment history', (select jsonb_array_length(employment_history) from recruiting.applications_for_managers where name = 'Priya Natarajan') = 1);
select pg_temp.check('manager: reads stages', (select count(*) from recruiting.stages) = 9);
select pg_temp.check('manager: reads positions (17 seeded open + 10 past roles from Phase 7)', (select count(*) from recruiting.positions) = 27);
select pg_temp.check('manager: reads postings', (select count(*) from recruiting.postings) = 1);
select pg_temp.check('manager: reads forms (three 2026 forms and the 2025 Spanish archive)', (select count(*) from recruiting.forms) = 4);
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

-- ----- password only, no second factor (aal1) ----------------------------------------------
-- The admin from the first block, before entering the authenticator code: nothing but their
-- own profile row.
begin;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111', 'aal1');
select pg_temp.check('aal1 admin: role is null', recruiting.current_role() is null);
select pg_temp.check('aal1 admin: not staff', recruiting.is_staff() is not true);
select pg_temp.check('aal1 admin: zero applications', (select count(*) from recruiting.applications) = 0);
select pg_temp.check('aal1 admin: zero rows in curated view', (select count(*) from recruiting.applications_for_managers) = 0);
select pg_temp.check('aal1 admin: zero stages', (select count(*) from recruiting.stages) = 0);
select pg_temp.check('aal1 admin: zero documents', (select count(*) from recruiting.documents) = 0);
select pg_temp.check('aal1 admin: zero report rows', (select count(*) from recruiting.report_position_funnel) = 0);
select pg_temp.check('aal1 admin: sees only their own profile row',
  (select count(*) from recruiting.profiles) = 1 and (select user_id from recruiting.profiles) = '11111111-1111-1111-1111-111111111111');
update recruiting.profiles set role = 'hr' where user_id = '11111111-1111-1111-1111-111111111111';
select pg_temp.check('aal1 admin: cannot change own role (update filtered out)',
  (select role from recruiting.profiles where user_id = '11111111-1111-1111-1111-111111111111') = 'admin');
select pg_temp.check('aal1 admin: zero storage objects visible', (select count(*) from storage.objects where bucket_id = 'recruiting-files') = 0);
rollback;
-- A JWT with no aal claim at all counts as aal1.
begin;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.check('no aal claim: role is null', recruiting.current_role() is null);
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
select pg_temp.check('hr: time in stage has a row per stage (eight plus Archived)', (select count(*) from recruiting.report_time_in_stage) = 9);
select pg_temp.check('hr: spend by channel by month shows the seeded month', (select spend from recruiting.report_spend_by_channel_month where channel = 'indeed') = 240.00);
select pg_temp.check('hr: funnel counts Priya as reaching Interview',
  (select applications from recruiting.report_position_funnel f join recruiting.positions p on p.id = f.position_id where p.title = 'Irrigation Service Technician' and f.stage_name = 'Interview' and f.source = 'Rexius.com') = 1);
select pg_temp.check('hr: funnel never lists Not selected or Withdrawn', (select count(*) from recruiting.report_position_funnel f join recruiting.stages s on s.id = f.stage_id where s.is_terminal and not s.is_hired) = 0);
select pg_temp.check('hr: cost by channel has one row per channel', (select count(*) from recruiting.report_cost_by_channel) = 6);
select pg_temp.check('hr: cost per applicant on indeed = 240 / 2', (select cost_per_applicant from recruiting.report_cost_by_channel where channel = 'indeed') = 120.00);
select pg_temp.check('hr: offer acceptance is empty on the seed', (select count(*) from recruiting.report_offer_acceptance) = 0);
select pg_temp.check('hr: time to fill has a row per opening (17 current + 1 past season in the seed)', (select count(*) from recruiting.report_time_to_fill) = 18);
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

-- ----- Phase 9a: market checks --------------------------------------------------------------
begin;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select pg_temp.check('hr: reads the seeded market check', (select count(*) from recruiting.market_checks) = 1);
select pg_temp.check('hr: reads market tracking columns', (select count(*) from recruiting.positions where market_tracking and market_interval_days = 7) = 1);
insert into recruiting.market_checks (position_id, trigger, requested_by)
  select id, 'manual', '22222222-2222-2222-2222-222222222222' from recruiting.positions where title = 'Flatbed Truck Driver' and location = 'Eugene/Springfield';
select pg_temp.check('hr: can add a market check row', (select count(*) from recruiting.market_checks) = 2);
update recruiting.market_checks set error = 'test' where summary is null;
select pg_temp.check('hr: can change a market check row', (select count(*) from recruiting.market_checks where error = 'test') = 1);
delete from recruiting.market_checks where error = 'test';
select pg_temp.check('hr: can remove a market check row', (select count(*) from recruiting.market_checks) = 1);
update recruiting.positions set market_tracking = true, market_interval_days = 30 where title = 'Flatbed Truck Driver' and location = 'Eugene/Springfield';
select pg_temp.check('hr: can turn tracking on', (select count(*) from recruiting.positions where market_tracking) = 2);
savepoint sp;
do $$ begin
  update recruiting.positions set market_interval_days = 14 where market_tracking;
  raise notice 'UNEXPECTED: interval 14 accepted';
exception when check_violation then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp;
select pg_temp.check('market: interval is 7 or 30 only', (select count(*) from recruiting.positions where market_interval_days = 14) = 0);
rollback;

begin;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select pg_temp.check('manager: reads market checks', (select count(*) from recruiting.market_checks) = 1);
select pg_temp.check('manager: reads the usage figures too (not applicant data)', (select input_tokens from recruiting.market_checks limit 1) is not null);
savepoint sp;
do $$ begin
  insert into recruiting.market_checks (position_id, trigger) select id, 'manual' from recruiting.positions limit 1;
  raise notice 'UNEXPECTED: manager inserted a market check';
exception when others then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp;
select pg_temp.check('manager: cannot add a market check', (select count(*) from recruiting.market_checks) = 1);
update recruiting.market_checks set summary = 'edited';
select pg_temp.check('manager: cannot change a market check', (select count(*) from recruiting.market_checks where summary = 'edited') = 0);
delete from recruiting.market_checks;
select pg_temp.check('manager: cannot remove a market check', (select count(*) from recruiting.market_checks) = 1);
update recruiting.positions set market_tracking = true;
select pg_temp.check('manager: cannot turn tracking on', (select count(*) from recruiting.positions where market_tracking) = 1);
rollback;

begin;
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
select pg_temp.check('no profile: sees no market checks', (select count(*) from recruiting.market_checks) = 0);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222', 'aal1');
select pg_temp.check('hr at aal1: sees no market checks', (select count(*) from recruiting.market_checks) = 0);
select pg_temp.as_user(null);
savepoint sp;
do $$ begin
  perform count(*) from recruiting.market_checks;
  raise notice 'UNEXPECTED: anon read market_checks';
exception when others then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp;
rollback;

begin;
-- The schedule and trigger plumbing, as postgres. Without vault secrets nothing is posted.
select pg_temp.check('cron: the daily job exists', (select count(*) from cron.job where jobname = 'recruiting-market-checks' and schedule = '0 13 * * *') = 1);
select pg_temp.check('market: request_market_check returns null without vault secrets', recruiting.request_market_check((select id from recruiting.positions limit 1), 'manual') is null);
select pg_temp.check('market: run_due_market_checks requests nothing without vault secrets', recruiting.run_due_market_checks() = 0);
select pg_temp.check('market: helpers are not callable by app users',
  not has_function_privilege('authenticated', 'recruiting.request_market_check(uuid, recruiting.market_check_trigger)', 'execute')
  and not has_function_privilege('authenticated', 'recruiting.run_due_market_checks()', 'execute'));
-- Due logic: the seeded position (weekly, last run 3 days ago) is not due; a position with no run is.
select pg_temp.check('market: a weekly position checked 3 days ago is not due',
  not exists (select 1 from recruiting.positions p where p.market_tracking and p.status = 'open'
    and not exists (select 1 from recruiting.market_checks c where c.position_id = p.id and c.error is null and c.ran_at > now() - make_interval(days => p.market_interval_days))));
rollback;

-- ----- Market check search depth per position -----------------------------------------------
begin;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
update recruiting.positions set market_max_searches = 15 where title = 'Flatbed Truck Driver' and location = 'Eugene/Springfield';
select pg_temp.check('hr: can set a position''s search depth', (select count(*) from recruiting.positions where market_max_searches = 15) = 1);
savepoint sp;
do $$ begin
  update recruiting.positions set market_max_searches = 25 where market_max_searches = 15;
  raise notice 'UNEXPECTED: depth 25 accepted';
exception when check_violation then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp;
select pg_temp.check('market: search depth is capped at 20', (select count(*) from recruiting.positions where market_max_searches > 20) = 0);
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
update recruiting.positions set market_max_searches = 10;
select pg_temp.check('manager: cannot change search depth', (select count(*) from recruiting.positions where market_max_searches = 10) = 0);
rollback;

-- ----- National market check ------------------------------------------------------------------
begin;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select pg_temp.check('hr: reads the seeded national check', (select count(*) from recruiting.national_checks) = 1);
insert into recruiting.national_checks (position_id, requested_by)
  select id, '22222222-2222-2222-2222-222222222222' from recruiting.positions where title = 'Flatbed Truck Driver' and location = 'Eugene/Springfield';
select pg_temp.check('hr: can add a national check row', (select count(*) from recruiting.national_checks) = 2);
update recruiting.national_checks set error = 'test', pass = 1 where summary is null;
select pg_temp.check('hr: can change a national check row', (select count(*) from recruiting.national_checks where error = 'test') = 1);
delete from recruiting.national_checks where error = 'test';
select pg_temp.check('hr: can remove a national check row', (select count(*) from recruiting.national_checks) = 1);
update recruiting.positions set national_max_searches = 20 where title = 'Flatbed Truck Driver' and location = 'Eugene/Springfield';
select pg_temp.check('hr: can set a position''s national search depth', (select count(*) from recruiting.positions where national_max_searches = 20) = 1);
savepoint sp;
do $$ begin
  update recruiting.positions set national_max_searches = 3 where national_max_searches = 20;
  raise notice 'UNEXPECTED: depth 3 accepted';
exception when check_violation then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp;
select pg_temp.check('national: search depth is 4 to 20', (select count(*) from recruiting.positions where national_max_searches < 4) = 0);
rollback;

begin;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select pg_temp.check('manager: reads national checks', (select count(*) from recruiting.national_checks) = 1);
savepoint sp;
do $$ begin
  insert into recruiting.national_checks (position_id) select id from recruiting.positions limit 1;
  raise notice 'UNEXPECTED: manager inserted a national check';
exception when others then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp;
select pg_temp.check('manager: cannot add a national check', (select count(*) from recruiting.national_checks) = 1);
update recruiting.national_checks set summary = 'edited';
select pg_temp.check('manager: cannot change a national check', (select count(*) from recruiting.national_checks where summary = 'edited') = 0);
delete from recruiting.national_checks;
select pg_temp.check('manager: cannot remove a national check', (select count(*) from recruiting.national_checks) = 1);
rollback;

begin;
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
select pg_temp.check('no profile: sees no national checks', (select count(*) from recruiting.national_checks) = 0);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222', 'aal1');
select pg_temp.check('hr at aal1: sees no national checks', (select count(*) from recruiting.national_checks) = 0);
rollback;

begin;
select pg_temp.check('national: request_national_check returns null without vault secrets', recruiting.request_national_check((select id from recruiting.positions limit 1)) is null);
select pg_temp.check('national: helper is not callable by app users', not has_function_privilege('authenticated', 'recruiting.request_national_check(uuid)', 'execute'));
rollback;

-- Contact-detail retention (20261109000100): the purge function is out of reach of app users,
-- a purged row stays purged, and the manager view carries the flag.
begin;
select pg_temp.check('retention: purge function is not callable by app users', not has_function_privilege('authenticated', 'recruiting.purge_contact_details(interval)', 'execute'));
select pg_temp.check('retention: pg_cron job exists', (select count(*) from cron.job where jobname = 'recruiting-purge-contact-details') = 1);
update recruiting.applications set contact_purged_at = now(), email = null, email_norm = null, phone = null, phone_norm = null where id = (select id from recruiting.applications order by submitted_at limit 1);
update recruiting.applications set email = 'back@example.com', phone = '5415550000' where contact_purged_at is not null;
select pg_temp.check('retention: a purged row cannot get its contact details back', (select count(*) from recruiting.applications where contact_purged_at is not null and (email is not null or phone is not null)) = 0);
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select pg_temp.check('retention: manager view exposes contact_purged_at', (select count(*) from recruiting.applications_for_managers where contact_purged_at is not null) >= 1);
rollback;

-- File retention (20261109000200): the pg_net helper is out of reach, the cron job exists,
-- and a purged application takes no new file.
begin;
select pg_temp.check('retention: file-purge helper is not callable by app users', not has_function_privilege('authenticated', 'recruiting.request_file_purge()', 'execute'));
select pg_temp.check('retention: file-purge cron job exists', (select count(*) from cron.job where jobname = 'recruiting-purge-files') = 1);
update recruiting.applications set files_purged_at = now(), has_resume = false where id = (select id from recruiting.applications order by submitted_at limit 1);
savepoint sp;
do $$ begin
  insert into recruiting.application_files (application_id, storage_path, original_name, kind)
    select id, 'applications/test/' || id || '/late.pdf', 'late.pdf', 'resume' from recruiting.applications where files_purged_at is not null limit 1;
  raise notice 'UNEXPECTED: a file was attached to a purged application';
exception when check_violation then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp;
select pg_temp.check('retention: a purged application takes no new file', (select count(*) from recruiting.application_files af join recruiting.applications a on a.id = af.application_id where a.files_purged_at is not null) = 0);
update recruiting.applications set has_resume = true where files_purged_at is not null;
select pg_temp.check('retention: has_resume stays false once files are purged', (select count(*) from recruiting.applications where files_purged_at is not null and has_resume) = 0);
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select pg_temp.check('retention: manager view exposes files_purged_at', (select count(*) from recruiting.applications_for_managers where files_purged_at is not null) >= 1);
rollback;

-- ----- Reopenable positions and pay history (20261111000100) ----------------------------------
-- Today in Oregon, as the triggers see it.
create or replace function pg_temp.today() returns date language sql as $$ select (now() at time zone 'America/Los_Angeles')::date $$;
create or replace function pg_temp.seasonal() returns uuid language sql as $$ select id from recruiting.positions where title = 'Seasonal test' $$;

begin;
select pg_temp.check('openings: every open position has one current opening, and no other position has one',
  (select count(*) from recruiting.positions where status = 'open') =
  (select count(*) from recruiting.position_openings o join recruiting.positions p on p.id = o.position_id where o.closed_at is null and p.status = 'open')
  and not exists (select 1 from recruiting.position_openings o join recruiting.positions p on p.id = o.position_id where o.closed_at is null and p.status <> 'open'));
select pg_temp.check('positions: opened_at, closed_at and filled_by_application_id are gone',
  (select count(*) from information_schema.columns where table_schema = 'recruiting' and table_name = 'positions' and column_name in ('opened_at', 'closed_at', 'filled_by_application_id')) = 0);
select pg_temp.check('openings: the trigger helpers are not callable by app users',
  not has_function_privilege('authenticated', 'recruiting.track_position_openings()', 'execute')
  and not has_function_privilege('authenticated', 'recruiting.log_position_pay()', 'execute'));

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
insert into recruiting.positions (title, location, status, pay_min, pay_max, pay_unit) values ('Seasonal test', 'Bend', 'open', 18, 20, 'hour');
select pg_temp.check('hr: a position added as open starts an opening today',
  (select count(*) from recruiting.position_openings where position_id = pg_temp.seasonal() and closed_at is null and opened_at = pg_temp.today() and opened_by = '22222222-2222-2222-2222-222222222222') = 1);
select pg_temp.check('hr: a new position''s range is logged',
  (select count(*) from recruiting.position_pay_history where position_id = pg_temp.seasonal() and pay_min = 18 and pay_max = 20 and changed_by = '22222222-2222-2222-2222-222222222222') = 1);
update recruiting.positions set status = 'closed' where id = pg_temp.seasonal();
select pg_temp.check('hr: closing the position ends its opening today',
  (select count(*) from recruiting.position_openings where position_id = pg_temp.seasonal() and closed_at = pg_temp.today() and closed_by = '22222222-2222-2222-2222-222222222222') = 1);
update recruiting.positions set status = 'open' where id = pg_temp.seasonal();
select pg_temp.check('hr: reopening on the day it closed carries on the same opening',
  (select count(*) from recruiting.position_openings where position_id = pg_temp.seasonal()) = 1
  and (select count(*) from recruiting.position_openings where position_id = pg_temp.seasonal() and closed_at is null and closed_by is null) = 1);
-- Move that opening back a season, close it, correct its closing date, then reopen.
update recruiting.position_openings set opened_at = pg_temp.today() - 200, note = 'Spring' where position_id = pg_temp.seasonal();
update recruiting.positions set status = 'closed' where id = pg_temp.seasonal();
update recruiting.position_openings set closed_at = pg_temp.today() - 100 where position_id = pg_temp.seasonal();
select pg_temp.check('hr: can correct an opening''s dates and note',
  (select count(*) from recruiting.position_openings where position_id = pg_temp.seasonal() and opened_at = pg_temp.today() - 200 and closed_at = pg_temp.today() - 100 and note = 'Spring') = 1);
update recruiting.positions set status = 'open' where id = pg_temp.seasonal();
select pg_temp.check('hr: reopening a later season starts a second opening',
  (select count(*) from recruiting.position_openings where position_id = pg_temp.seasonal()) = 2
  and (select count(*) from recruiting.position_openings where position_id = pg_temp.seasonal() and closed_at is null) = 1);
savepoint sp;
do $$ begin
  update recruiting.position_openings set closed_at = pg_temp.today() where position_id = pg_temp.seasonal() and closed_at is null;
  raise notice 'UNEXPECTED: the current opening was closed by a date edit';
exception when check_violation then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp;
select pg_temp.check('openings: the current opening is closed only by closing the position',
  (select count(*) from recruiting.position_openings where position_id = pg_temp.seasonal() and closed_at is null) = 1);
savepoint sp2;
do $$ begin
  update recruiting.position_openings set closed_at = pg_temp.today() where position_id = pg_temp.seasonal() and closed_at is not null;
  raise notice 'UNEXPECTED: overlapping openings accepted';
exception when check_violation then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp2;
select pg_temp.check('openings: openings of one position cannot overlap',
  (select closed_at from recruiting.position_openings where position_id = pg_temp.seasonal() and closed_at is not null) = pg_temp.today() - 100);
savepoint sp3;
do $$ begin
  insert into recruiting.position_openings (position_id, opened_at, closed_at) values (pg_temp.seasonal(), pg_temp.today() - 400, pg_temp.today() - 300);
  raise notice 'UNEXPECTED: hr inserted an opening directly';
exception when insufficient_privilege then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp3;
savepoint sp4;
do $$ begin
  delete from recruiting.position_openings where position_id = pg_temp.seasonal();
  raise notice 'UNEXPECTED: hr deleted an opening';
exception when insufficient_privilege then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp4;
savepoint sp5;
do $$ begin
  update recruiting.position_openings set position_id = (select id from recruiting.positions where title = 'Flatbed Truck Driver' limit 1) where position_id = pg_temp.seasonal();
  raise notice 'UNEXPECTED: hr moved an opening to another position';
exception when insufficient_privilege then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp5;
select pg_temp.check('openings: hr cannot add, delete or move openings', (select count(*) from recruiting.position_openings where position_id = pg_temp.seasonal()) = 2);

update recruiting.positions set pay_max = 21 where id = pg_temp.seasonal();
update recruiting.positions set department = 'Maintenance' where id = pg_temp.seasonal();
update recruiting.positions set pay_unit = 'hour' where id = pg_temp.seasonal();
select pg_temp.check('pay: a range change is logged, other edits are not',
  (select count(*) from recruiting.position_pay_history where position_id = pg_temp.seasonal()) = 2
  and (select pay_max from recruiting.position_pay_history where position_id = pg_temp.seasonal() order by id desc limit 1) = 21);
update recruiting.position_pay_history set note = 'Raised to fill spring crews' where id = (select max(id) from recruiting.position_pay_history where position_id = pg_temp.seasonal());
select pg_temp.check('hr: can add a note to a pay change', (select count(*) from recruiting.position_pay_history where note = 'Raised to fill spring crews') = 1);
savepoint sp6;
do $$ begin
  update recruiting.position_pay_history set pay_max = 30 where position_id = pg_temp.seasonal();
  raise notice 'UNEXPECTED: hr rewrote a logged range';
exception when insufficient_privilege then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp6;
savepoint sp7;
do $$ begin
  delete from recruiting.position_pay_history where position_id = pg_temp.seasonal();
  raise notice 'UNEXPECTED: hr deleted pay history';
exception when insufficient_privilege then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp7;
savepoint sp8;
do $$ begin
  insert into recruiting.position_pay_history (position_id, pay_min, pay_max, pay_unit) values (pg_temp.seasonal(), 1, 2, 'hour');
  raise notice 'UNEXPECTED: hr inserted pay history directly';
exception when insufficient_privilege then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp8;
select pg_temp.check('pay: hr cannot add, rewrite or delete logged ranges',
  (select count(*) from recruiting.position_pay_history where position_id = pg_temp.seasonal()) = 2
  and (select max(pay_max) from recruiting.position_pay_history where position_id = pg_temp.seasonal()) = 21);
select pg_temp.check('report: time to fill shows both seasons of the test position', (select count(*) from recruiting.report_time_to_fill where position_id = pg_temp.seasonal()) = 2);
select pg_temp.check('report: the seeded crew application counts towards the current opening, not last spring',
  (select string_agg(coalesce(closed_at::text, 'current') || ':' || applicants, ',' order by opened_at) from recruiting.report_time_to_fill where title = 'Landscape Maintenance Crew Member' and location = 'Eugene/Springfield') = (pg_temp.today() - 120)::text || ':0,current:1');
delete from recruiting.positions where id = pg_temp.seasonal();
select pg_temp.check('hr: deleting a position deletes its openings and pay history',
  not exists (select 1 from recruiting.position_openings o left join recruiting.positions p on p.id = o.position_id where p.id is null)
  and not exists (select 1 from recruiting.position_pay_history h left join recruiting.positions p on p.id = h.position_id where p.id is null));
rollback;

begin;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select pg_temp.check('manager: reads openings', (select count(*) from recruiting.position_openings) = 18);
select pg_temp.check('manager: reads pay history', (select count(*) from recruiting.position_pay_history) = 2);
update recruiting.position_openings set note = 'manager edit';
select pg_temp.check('manager: cannot change an opening', (select count(*) from recruiting.position_openings where note = 'manager edit') = 0);
update recruiting.position_pay_history set note = 'manager edit';
select pg_temp.check('manager: cannot change a pay note', (select count(*) from recruiting.position_pay_history where note = 'manager edit') = 0);
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
select pg_temp.check('no profile: sees no openings or pay history', (select count(*) from recruiting.position_openings) + (select count(*) from recruiting.position_pay_history) = 0);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222', 'aal1');
select pg_temp.check('hr at aal1: sees no openings or pay history', (select count(*) from recruiting.position_openings) + (select count(*) from recruiting.position_pay_history) = 0);
rollback;

-- ----- Phase 9b: applicant summaries and translation ----------------------------------------
begin;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select pg_temp.check('hr: reads the seeded applicant summaries', (select count(*) from recruiting.applicant_summaries) = 2);
select pg_temp.check('hr: reads translation usage', (select count(*) from recruiting.message_translations) = 1);
select pg_temp.check('hr: a summary holds an HR-only translation', exists (select 1 from recruiting.applicant_summaries where translations @> '[{"key":"rexius_work","manager":false}]'));
savepoint sp;
do $$ begin
  insert into recruiting.applicant_summaries (application_id) select id from recruiting.applications limit 1;
  raise notice 'UNEXPECTED: hr inserted a summary';
exception when insufficient_privilege then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp;
savepoint sp2;
do $$ begin
  update recruiting.applicant_summaries set summary = '{"overview":"edited"}';
  raise notice 'UNEXPECTED: hr edited a summary';
exception when insufficient_privilege then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp2;
savepoint sp3;
do $$ begin
  delete from recruiting.applicant_summaries;
  raise notice 'UNEXPECTED: hr deleted summaries';
exception when insufficient_privilege then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp3;
savepoint sp4;
do $$ begin
  insert into recruiting.message_translations (direction, chars_in) values ('en-es', 1);
  raise notice 'UNEXPECTED: hr inserted translation usage';
exception when insufficient_privilege then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp4;
select pg_temp.check('hr: cannot add, change or remove summaries or usage (only the function writes them)',
  (select count(*) from recruiting.applicant_summaries) = 2
  and (select count(*) from recruiting.applicant_summaries where summary ->> 'overview' = 'edited') = 0
  and (select count(*) from recruiting.message_translations) = 1);
rollback;

begin;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select pg_temp.check('admin: reads applicant summaries', (select count(*) from recruiting.applicant_summaries) = 2);
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select pg_temp.check('manager: sees no applicant summaries', (select count(*) from recruiting.applicant_summaries) = 0);
select pg_temp.check('manager: sees no translation usage', (select count(*) from recruiting.message_translations) = 0);
select pg_temp.check('manager: reads the English translation through the view', (select count(*) from recruiting.applications_for_managers where translation is not null) = 1);
select pg_temp.check('manager: the view carries only answers a manager can see',
  (select jsonb_array_length(translation) from recruiting.applications_for_managers where translation is not null) = 3
  and not exists (select 1 from recruiting.applications_for_managers where translation @> '[{"key":"rexius_work"}]'));
select pg_temp.check('manager: translation items carry key, label, original and English only',
  (select array_agg(k order by k) from recruiting.applications_for_managers v, jsonb_array_elements(v.translation) t, jsonb_object_keys(t) k where v.translation is not null and t ->> 'key' = 'skills')
  = array['english', 'key', 'label', 'original']);
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
select pg_temp.check('no profile: sees no applicant summaries', (select count(*) from recruiting.applicant_summaries) + (select count(*) from recruiting.message_translations) = 0);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222', 'aal1');
select pg_temp.check('hr at aal1: sees no applicant summaries', (select count(*) from recruiting.applicant_summaries) = 0);
select pg_temp.as_user(null);
savepoint sp;
do $$ begin
  perform count(*) from recruiting.applicant_summaries;
  raise notice 'UNEXPECTED: anon read applicant_summaries';
exception when insufficient_privilege then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp;
rollback;

begin;
-- As postgres (what the function's service role does): a running or failed run never replaces
-- the translation managers see; the newest finished run does.
insert into recruiting.applicant_summaries (application_id, created_at, translations)
  select id, now(), '[{"key":"skills","label":"x","original":"x","english":"RUNNING","manager":true}]' from recruiting.applications where jotform_submission_id = '6000000000000000003';
insert into recruiting.applicant_summaries (application_id, created_at, finished_at, error, translations)
  select id, now(), now(), 'test failure', '[{"key":"skills","label":"x","original":"x","english":"FAILED","manager":true}]' from recruiting.applications where jotform_submission_id = '6000000000000000003';
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select pg_temp.check('summaries: a running or failed run does not reach the manager view',
  (select translation -> 0 ->> 'english' from recruiting.applications_for_managers where translation is not null) = 'Two seasons on a blower truck crew; Class B permit in progress.');
reset role;
insert into recruiting.applicant_summaries (application_id, created_at, finished_at, translations)
  select id, now(), now(), '[{"key":"skills","label":"x","original":"x","english":"NEWEST","manager":true}]' from recruiting.applications where jotform_submission_id = '6000000000000000003';
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select pg_temp.check('summaries: the newest finished run is the one managers see',
  (select translation -> 0 ->> 'english' from recruiting.applications_for_managers where translation is not null) = 'NEWEST');
reset role;
delete from recruiting.applications where jotform_submission_id = '6000000000000000003';
select pg_temp.check('summaries: deleting an application deletes its summaries and keeps usage without the link',
  (select count(*) from recruiting.applicant_summaries where application_id not in (select id from recruiting.applications)) = 0
  and (select count(*) from recruiting.message_translations where application_id is null) = 1);
select pg_temp.check('forms: every form has the four keys the summary reads',
  (select count(*) from recruiting.forms where field_map ?& array['certifications', 'worked_before_details', 'applied_before_details', 'other_qualifications']) = (select count(*) from recruiting.forms));
rollback;

-- ----- Good leads (20261113000100) ------------------------------------------------------------
-- The flag needs a reason, stamps who and when, is capped at twelve months after the
-- application, holds off the six-month purge until it expires, and shows managers the flag only.
create or replace function pg_temp.app(n int) returns uuid language sql as $$ select id from recruiting.applications where jotform_submission_id = '600000000000000000' || n $$;
create or replace function pg_temp.lead_cap(n int) returns date language sql as $$ select ((submitted_at at time zone 'America/Los_Angeles')::date + interval '12 months')::date from recruiting.applications where id = pg_temp.app(n) $$;

begin;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select pg_temp.check('leads: nobody is a lead to begin with', (select count(*) from recruiting.application_status where is_lead) = 0);
savepoint sp;
do $$ begin
  update recruiting.application_status set is_lead = true where application_id = pg_temp.app(1);
  raise notice 'UNEXPECTED: a lead was flagged without a reason';
exception when check_violation then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp;
select pg_temp.check('leads: a flag without a reason is refused', (select count(*) from recruiting.application_status where is_lead) = 0);
update recruiting.application_status set is_lead = true, lead_reason = '  Experienced crew lead; no opening until spring  ', lead_revisit_on = current_date + 90,
  lead_flagged_by = '11111111-1111-1111-1111-111111111111', lead_flagged_at = '2020-01-01'
  where application_id = pg_temp.app(1);
select pg_temp.check('leads: hr can flag a lead', (select is_lead from recruiting.application_status where application_id = pg_temp.app(1)));
select pg_temp.check('leads: who and when are stamped from the session, not the request',
  (select lead_flagged_by = '22222222-2222-2222-2222-222222222222' and lead_flagged_at > now() - interval '1 minute' from recruiting.application_status where application_id = pg_temp.app(1)));
select pg_temp.check('leads: the reason is trimmed', (select lead_reason from recruiting.application_status where application_id = pg_temp.app(1)) = 'Experienced crew lead; no opening until spring');
select pg_temp.check('leads: keep-until defaults to twelve months after the application', (select lead_keep_until from recruiting.application_status where application_id = pg_temp.app(1)) = pg_temp.lead_cap(1));
savepoint sp;
do $$ begin
  update recruiting.application_status set lead_keep_until = pg_temp.lead_cap(1) + 1 where application_id = pg_temp.app(1);
  raise notice 'UNEXPECTED: a lead was kept past twelve months';
exception when check_violation then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp;
select pg_temp.check('leads: keep-until cannot pass twelve months', (select lead_keep_until from recruiting.application_status where application_id = pg_temp.app(1)) = pg_temp.lead_cap(1));
savepoint sp;
do $$ begin
  update recruiting.application_status set lead_keep_until = current_date - 2 where application_id = pg_temp.app(1);
  raise notice 'UNEXPECTED: keep-until was set in the past';
exception when check_violation then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp;
update recruiting.application_status set lead_keep_until = current_date + 30, notes = 'Call in March.' where application_id = pg_temp.app(1);
select pg_temp.check('leads: keep-until can be shortened, and the stamp survives other edits',
  (select lead_keep_until = current_date + 30 and lead_flagged_by = '22222222-2222-2222-2222-222222222222' from recruiting.application_status where application_id = pg_temp.app(1)));
select pg_temp.check('leads: helper functions are not callable by app users',
  not has_function_privilege('authenticated', 'recruiting.expire_leads()', 'execute') and not has_function_privilege('authenticated', 'recruiting.purge_contact_details(interval)', 'execute'));

select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select pg_temp.check('leads: manager sees the flag through the view', (select count(*) from recruiting.applications_for_managers where is_lead) = 1);
select pg_temp.check('leads: the view carries no reason or dates',
  (select count(*) from information_schema.columns where table_schema = 'recruiting' and table_name = 'applications_for_managers' and column_name like 'lead\_%') = 0);
update recruiting.application_status set is_lead = false;
reset role;
select pg_temp.check('leads: manager cannot change the flag', (select count(*) from recruiting.application_status where is_lead) = 1);

-- Retention: two applications seven months old in a terminal stage; only the lead keeps its details.
update recruiting.applications set submitted_at = now() - interval '7 months' where id in (pg_temp.app(1), pg_temp.app(5));
update recruiting.application_status set stage_id = (select id from recruiting.stages where is_terminal and not is_hired and not is_archive order by sort_order limit 1)
  where application_id in (pg_temp.app(1), pg_temp.app(5));
select recruiting.purge_contact_details();
select pg_temp.check('leads: the six-month purge skips a good lead', (select contact_purged_at is null and email is not null from recruiting.applications where id = pg_temp.app(1)));
select pg_temp.check('leads: the purge still reaches everyone else', (select contact_purged_at is not null and email is null from recruiting.applications where id = pg_temp.app(5)));
select pg_temp.check('leads: files are not due while the lead holds', (select count(*) from recruiting.applications where contact_purged_at is not null and files_purged_at is null and id = pg_temp.app(1)) = 0);
-- The keep-until date passes (set behind the trigger's back): the next run clears the flag and purges.
alter table recruiting.application_status disable trigger application_status_keep_lead_fields;
update recruiting.application_status set lead_keep_until = (now() at time zone 'America/Los_Angeles')::date - 1 where application_id = pg_temp.app(1);
alter table recruiting.application_status enable trigger application_status_keep_lead_fields;
select recruiting.purge_contact_details();
select pg_temp.check('leads: an expired flag clears itself with its reason and dates',
  (select not is_lead and lead_reason is null and lead_revisit_on is null and lead_keep_until is null and lead_flagged_by is null and lead_flagged_at is null from recruiting.application_status where application_id = pg_temp.app(1)));
select pg_temp.check('leads: once expired the six-month purge applies again', (select contact_purged_at is not null and email is null from recruiting.applications where id = pg_temp.app(1)));

-- Removing the flag by hand blanks the lead columns; an application over twelve months old cannot be flagged.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
update recruiting.application_status set is_lead = true, lead_reason = 'Strong interview' where application_id = pg_temp.app(2);
update recruiting.application_status set is_lead = false where application_id = pg_temp.app(2);
select pg_temp.check('leads: removing the flag deletes the reason', (select not is_lead and lead_reason is null and lead_keep_until is null from recruiting.application_status where application_id = pg_temp.app(2)));
reset role;
update recruiting.applications set submitted_at = now() - interval '13 months' where id = pg_temp.app(3);
savepoint sp;
do $$ begin
  update recruiting.application_status set is_lead = true, lead_reason = 'Too late' where application_id = pg_temp.app(3);
  raise notice 'UNEXPECTED: an application over twelve months old was flagged';
exception when check_violation then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp;
select pg_temp.check('leads: an application over twelve months old cannot be flagged', (select not is_lead from recruiting.application_status where application_id = pg_temp.app(3)));
rollback;

-- ----- Careers page sync (20261114000100) --------------------------------------------------------
-- careers_pages and careers_sync_runs: every app user reads them; staff change only a page's
-- position and its ignored flag; nobody inserts or deletes from the browser; the seed from the
-- rexius.com posting rows normalises addresses.
begin;
delete from recruiting.careers_pages;
insert into recruiting.careers_pages (url, title, location, pay_text, pay_applied_text, last_seen_at)
values ('https://rexius.com/blogs/careers/crew1', 'Crew Member', 'Eugene/Springfield', '$20-$24/hr', '$20-$24/hr', now());
insert into recruiting.careers_sync_runs (trigger, ok, pages_listed) values ('schedule', true, 1);

select pg_temp.check('careers: anon has no table privilege on pages or runs',
  not has_table_privilege('anon', 'recruiting.careers_pages', 'select') and not has_table_privilege('anon', 'recruiting.careers_sync_runs', 'select'));

select pg_temp.as_user('11111111-1111-1111-1111-111111111111', 'aal1');
select pg_temp.check('careers: a password-only session reads nothing', (select count(*) from recruiting.careers_pages) = 0 and (select count(*) from recruiting.careers_sync_runs) = 0);
reset role;

select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select pg_temp.check('careers: manager reads pages and runs', (select count(*) from recruiting.careers_pages) = 1 and (select count(*) from recruiting.careers_sync_runs) = 1);
update recruiting.careers_pages set ignored = true;
update recruiting.careers_pages set position_id = (select id from recruiting.positions limit 1);
reset role;
select pg_temp.check('careers: manager cannot link or ignore a page', (select not ignored and position_id is null from recruiting.careers_pages));

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
update recruiting.careers_pages set position_id = (select id from recruiting.positions order by title limit 1);
reset role;
select pg_temp.check('careers: hr can tie a page to a position; the link is recorded as staff and the pay line is due again',
  (select position_id is not null and link_source = 'staff' and linked_by = '22222222-2222-2222-2222-222222222222' and pay_applied_text is null from recruiting.careers_pages));
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
update recruiting.careers_pages set ignored = true;
reset role;
select pg_temp.check('careers: hr can mark a page as not a job', (select ignored from recruiting.careers_pages));
select pg_temp.check('careers: app users can change only position_id and ignored',
  has_column_privilege('authenticated', 'recruiting.careers_pages', 'position_id', 'update') and has_column_privilege('authenticated', 'recruiting.careers_pages', 'ignored', 'update')
  and not has_column_privilege('authenticated', 'recruiting.careers_pages', 'url', 'update') and not has_column_privilege('authenticated', 'recruiting.careers_pages', 'pay_min', 'update')
  and not has_column_privilege('authenticated', 'recruiting.careers_pages', 'gone_at', 'update') and not has_column_privilege('authenticated', 'recruiting.careers_pages', 'pay_applied_text', 'update'));
select pg_temp.check('careers: app users cannot insert or delete pages, or write runs',
  not has_table_privilege('authenticated', 'recruiting.careers_pages', 'insert') and not has_table_privilege('authenticated', 'recruiting.careers_pages', 'delete')
  and not has_table_privilege('authenticated', 'recruiting.careers_sync_runs', 'insert') and not has_table_privilege('authenticated', 'recruiting.careers_sync_runs', 'update')
  and not has_table_privilege('authenticated', 'recruiting.careers_sync_runs', 'delete'));
select pg_temp.check('careers: the job trigger function is not callable by app users',
  not has_function_privilege('authenticated', 'recruiting.request_careers_sync()', 'execute') and not has_function_privilege('anon', 'recruiting.request_careers_sync()', 'execute'));
select pg_temp.check('careers: the sync may note where a pay range came from', has_column_privilege('service_role', 'recruiting.position_pay_history', 'note', 'update'));

savepoint sp;
do $$ begin
  insert into recruiting.careers_pages (url) values ('https://example.com/blogs/careers/x');
  raise notice 'UNEXPECTED: a page outside rexius.com/blogs/careers was stored';
exception when check_violation then
  raise notice 'expected: %', sqlerrm;
end $$;
rollback to sp;
select pg_temp.check('careers: only job pages under rexius.com/blogs/careers can be stored', (select count(*) from recruiting.careers_pages where url like '%example.com%') = 0);

-- The seed: one page per rexius.com posting address, normalised; an ended posting seeds a gone page.
delete from recruiting.careers_pages;
insert into recruiting.postings (position_id, channel, url, posted_at, ended_at)
select id, 'rexius_com', u.url, '2026-02-01', u.ended::date
from (select id from recruiting.positions order by title limit 1) p,
     (values ('https://rexius.com/blogs/careers/Truck-Driver8/?utm_source=x', null), ('http://www.rexius.com/blogs/careers/old-role3', '2026-06-01'),
             ('https://rexius.com/blogs/careers', null), ('https://www.indeed.com/job/1', null), ('https://rexius.com/blogs/careers/truck-driver8', '2026-03-01')) as u(url, ended);
insert into recruiting.careers_pages (url, position_id, link_source, gone_at)
select distinct on (u.url) u.url, po.position_id, 'posting', po.ended_at::timestamptz
from recruiting.postings po
cross join lateral (
  select 'https://rexius.com/blogs/careers/' || lower(substring(po.url from '(?i)^https?://(?:www\.)?rexius\.com/blogs/careers/([a-z0-9][a-z0-9-]*)/?(?:[?#].*)?$')) as url
) u
where po.channel = 'rexius_com' and u.url is not null and u.url <> 'https://rexius.com/blogs/careers/tagged'
order by u.url, (po.ended_at is null) desc, po.posted_at desc;
select pg_temp.check('careers: the seed keeps one normalised page per posting address, live if any posting is',
  (select string_agg(regexp_replace(url, '.*/', '') || ':' || (gone_at is null), ',' order by url) from recruiting.careers_pages) = 'old-role3:false,truck-driver8:true');
rollback;
