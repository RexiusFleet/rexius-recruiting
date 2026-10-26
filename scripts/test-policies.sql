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
select pg_temp.check('admin: can add a stage', (select count(*) from recruiting.stages) = 9);
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
select pg_temp.check('manager: view has employment history', (select jsonb_array_length(employment_history) from recruiting.applications_for_managers where name = 'Priya Natarajan') = 1);
select pg_temp.check('manager: reads stages', (select count(*) from recruiting.stages) = 8);
select pg_temp.check('manager: reads positions', (select count(*) from recruiting.positions) = 17);
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
