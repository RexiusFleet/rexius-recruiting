-- Local development seed. Loaded by `npx supabase db reset` (local Docker stack only); never
-- applied to the hosted project. Stages, forms and positions come from the migrations; this
-- file adds three app users (one per role) and a few made-up applications so the frontend can
-- be developed without touching real applicant data.
--
-- Sign in locally with any of these (password for all three: localdev-password):
--   admin@local.test    admin
--   hr@local.test       hr
--   manager@local.test  manager
--   nobody@local.test   (auth user with no profile; should see nothing)

-- ---------------------------------------------------------------------------------------------
-- Auth users. Inserting into auth.users directly is only acceptable on the local stack.
-- ---------------------------------------------------------------------------------------------

insert into auth.users
  (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
   raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
   confirmation_token, recovery_token, email_change, email_change_token_new)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated',
   'admin@local.test',   extensions.crypt('localdev-password', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated',
   'hr@local.test',      extensions.crypt('localdev-password', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333333', 'authenticated', 'authenticated',
   'manager@local.test', extensions.crypt('localdev-password', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '44444444-4444-4444-4444-444444444444', 'authenticated', 'authenticated',
   'nobody@local.test',  extensions.crypt('localdev-password', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');

insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select u.id, u.id, u.id::text,
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
       'email', now(), now(), now()
from auth.users u
where u.email like '%@local.test';

insert into recruiting.profiles (user_id, role, name) values
  ('11111111-1111-1111-1111-111111111111', 'admin',   'Local Admin'),
  ('22222222-2222-2222-2222-222222222222', 'hr',      'Local HR'),
  ('33333333-3333-3333-3333-333333333333', 'manager', 'Local Manager');

-- ---------------------------------------------------------------------------------------------
-- Sample applications. Names, contacts and employers are invented. The `answers` JSON uses the
-- English form's question IDs (see forms.field_map) so the manager view can read education,
-- skills and employment history from it.
-- ---------------------------------------------------------------------------------------------

with f as (select id from recruiting.forms where jotform_form_id = '260115636145148'),
     fes as (select id from recruiting.forms where jotform_form_id = '232824275836160')
insert into recruiting.applications
  (jotform_submission_id, form_id, submitted_at, name, first_name, last_name, email, email_norm,
   phone, phone_norm, city, state, location, position_text, position_id, source, referred_by,
   available_start, has_resume, language, answers, jotform_url)
values
  ('6000000000000000001', (select id from f), now() - interval '12 days', 'Jordan Rivera', 'Jordan', 'Rivera',
   'jordan.rivera@example.com', 'jordan.rivera@example.com', '(541) 555-0101', '5415550101',
   'Eugene', 'OR', 'Eugene/Springfield', 'Landscape Maintenance Crew Member',
   (select id from recruiting.positions where title = 'Landscape Maintenance Crew Member' and location = 'Eugene/Springfield'),
   'Indeed.com', null, current_date + 7, true, 'en',
   '{"344":"High School Diploma","372":"Three seasons of mowing and pruning.","272":"No","274":"No",
     "72":"Green Valley Lawn Care","280":"Springfield, OR","76":"Crew member","348":"03/2023","377":"09/2026","352":"Seasonal layoff"}',
   'https://www.jotform.com/inbox/260115636145148/6000000000000000001'),
  ('6000000000000000002', (select id from f), now() - interval '9 days', 'Priya Natarajan', 'Priya', 'Natarajan',
   'priya.n@example.com', 'priya.n@example.com', '541-555-0102', '5415550102',
   'Bend', 'OR', 'Central Oregon', 'Irrigation Service Technician',
   (select id from recruiting.positions where title = 'Irrigation Service Technician' and location = 'Central Oregon'),
   'Rexius.com', null, current_date + 14, true, 'en',
   '{"344":"Certification(s)","372":"Backflow tester certification, 4 years irrigation repair.","272":"No","274":"Yes",
     "72":"High Desert Irrigation","280":"Bend, OR","76":"Service technician","348":"05/2022","377":"","352":"Still employed; seeking stability"}',
   'https://www.jotform.com/inbox/260115636145148/6000000000000000002'),
  ('6000000000000000003', (select id from fes), now() - interval '6 days', 'Luis Hernández', 'Luis', 'Hernández',
   'luis.h@example.com', 'luis.h@example.com', '(503) 555-0103', '5035550103',
   'Lake Oswego', 'OR', 'Lake Oswego', 'Blower Truck Crew Member',
   (select id from recruiting.positions where title = 'Blower Truck Crew Member' and location = 'Lake Oswego'),
   'Referral', 'Marco Hernández', current_date + 3, false, 'es',
   '{"344":"GED","372":"Blower truck crew two seasons; Class B permit in progress.","272":"Yes","274":"Yes",
     "72":"Bark Blowers NW","280":"Tualatin, OR","76":"Crew","348":"04/2024","375":"10/2025","352":"Season ended"}',
   'https://www.jotform.com/inbox/232824275836160/6000000000000000003'),
  ('6000000000000000004', (select id from f), now() - interval '2 days', 'Sam Okafor', 'Sam', 'Okafor',
   'sam.okafor@example.com', 'sam.okafor@example.com', '541.555.0104', '5415550104',
   'Springfield', 'OR', 'Eugene/Springfield', 'Flatbed Truck Driver',
   (select id from recruiting.positions where title = 'Flatbed Truck Driver' and location = 'Eugene/Springfield'),
   'Craigslist.com', null, current_date + 10, true, 'en',
   '{"344":"High School Diploma","372":"CDL-A, flatbed and moffett experience.","272":"No","274":"No",
     "72":"Cascade Freight","280":"Eugene, OR","76":"Driver","348":"01/2020","377":"08/2026","352":"Company closed route"}',
   'https://www.jotform.com/inbox/260115636145148/6000000000000000004'),
  ('6000000000000000005', (select id from f), now() - interval '1 day', 'Jordan Rivera', 'Jordan', 'Rivera',
   'Jordan.Rivera@example.com', 'jordan.rivera@example.com', '5415550101', '5415550101',
   'Eugene', 'OR', 'Eugene/Springfield', 'Commercial Landscape Crew Member',
   (select id from recruiting.positions where title = 'Commercial Landscape Crew Member' and location = 'Eugene/Springfield'),
   'Indeed.com', null, current_date + 7, false, 'en',
   '{"344":"High School Diploma","372":"Also applied for maintenance crew.","272":"No","274":"Yes"}',
   'https://www.jotform.com/inbox/260115636145148/6000000000000000005');

-- Move a couple along the pipeline so the strip has something in it. The trigger writes the
-- history rows.
update recruiting.application_status set stage_id = 2, assigned_to = null
  where application_id = (select id from recruiting.applications where jotform_submission_id = '6000000000000000001');
update recruiting.application_status set stage_id = 3, assigned_to = 'Bend maintenance manager',
  notes = 'Strong fit; sent résumé to Bend.'
  where application_id = (select id from recruiting.applications where jotform_submission_id = '6000000000000000002');
update recruiting.application_status set stage_id = 4
  where application_id = (select id from recruiting.applications where jotform_submission_id = '6000000000000000002');

insert into recruiting.referrals (application_id, referrer_name)
select id, referred_by from recruiting.applications where referred_by is not null;

insert into recruiting.contacts (application_id, kind, direction, summary, by_name)
select id, 'email', 'outbound', 'Sent interview availability request.', 'Local HR'
from recruiting.applications where jotform_submission_id = '6000000000000000002';

insert into recruiting.postings (position_id, channel, url, posted_at)
select id, 'indeed', 'https://www.indeed.com/viewjob?jk=example', current_date - 30
from recruiting.positions where title = 'Landscape Maintenance Crew Member' and location = 'Eugene/Springfield';

insert into recruiting.channel_spend (posting_id, period_start, period_end, spend, views, applies)
select id, date_trunc('month', current_date)::date - interval '1 month', date_trunc('month', current_date)::date - 1, 240.00, 1850, 31
from recruiting.postings;

-- Phase 9a: one finished market check so the position page has something to show locally.
-- Figures and employers are invented.
update recruiting.positions set market_tracking = true, market_interval_days = 7
where title = 'Landscape Maintenance Crew Member' and location = 'Eugene/Springfield';

insert into recruiting.market_checks
  (position_id, ran_at, finished_at, trigger, summary, pay_ranges, postings, sources, comparison, below_market,
   input_tokens, output_tokens, searches, model)
select id, now() - interval '3 days', now() - interval '3 days' + interval '70 seconds', 'manual',
  'Three employers in the Eugene/Springfield area advertised landscape maintenance crew roles in the last month, at $18 to $23 an hour. Two mention seasonal work starting in spring. The figures are a sample from search results, not a count of every posting.',
  '[{"employer":"Example Lawn Co","title":"Landscape Crew Member","min":18,"max":21,"unit":"hour","url":"https://example.com/jobs/1"},
    {"employer":"Sample Grounds","title":"Grounds Maintenance","min":20,"max":23,"unit":"hour","url":"https://example.com/jobs/2"}]',
  '[{"employer":"Example Lawn Co","title":"Landscape Crew Member","pay_text":"$18–$21/hr","location":"Eugene, OR","posted":"2026-10-20","url":"https://example.com/jobs/1"},
    {"employer":"Sample Grounds","title":"Grounds Maintenance","pay_text":"$20–$23/hr","location":"Springfield, OR","posted":"2026-10-12","url":"https://example.com/jobs/2"},
    {"employer":"Demo Landscapes","title":"Maintenance Crew","pay_text":null,"location":"Eugene, OR","posted":null,"url":"https://example.com/jobs/3"}]',
  '[{"url":"https://example.com/jobs/1","title":"Landscape Crew Member - Example Lawn Co","age":"1 week ago"},
    {"url":"https://example.com/jobs/2","title":"Grounds Maintenance - Sample Grounds","age":null}]',
  '{"unit":"hour","position_min":17,"position_max":20,"market_low_median":19,"market_high_median":22,"ranges_compared":2}',
  false, 4120, 980, 4, 'claude-opus-5-5'
from recruiting.positions where title = 'Landscape Maintenance Crew Member' and location = 'Eugene/Springfield';

-- National check: one finished run for the same position (invented figures and employers).
insert into recruiting.national_checks
  (position_id, ran_at, finished_at, pass, summary, pay_samples, bls, cost_of_living, adjusted, comparison, below_market, sources,
   input_tokens, output_tokens, searches, model)
select id, now() - interval '2 days', now() - interval '2 days' + interval '3 minutes', 2,
  'Across the United States, landscape maintenance crew roles at larger employers advertise $17 to $26 an hour, with the Bureau of Labor Statistics median for landscaping and groundskeeping workers at $18.50. After scaling each figure to the Eugene/Springfield cost of living, the adjusted range is $18 to $24. This is a sample from search results, not a complete count.',
  '[{"employer":"Example National Grounds","title":"Landscape Crew Member","metro":"Denver, CO","state":"CO","min":21,"max":26,"unit":"hour","url":"https://example.com/n/1"},
    {"employer":"Sample Services Inc","title":"Grounds Maintenance Technician","metro":"Dallas, TX","state":"TX","min":17,"max":20,"unit":"hour","url":"https://example.com/n/2"},
    {"employer":"Demo Landscape Group","title":"Landscape Maintenance Crew","metro":"Phoenix, AZ","state":"AZ","min":18,"max":22,"unit":"hour","url":"https://example.com/n/3"}]',
  '{"occupation":"Landscaping and Groundskeeping Workers","soc_code":"37-3011","unit":"hour","national_median":18.5,"p25":15.9,"p75":22.1,"area_name":"Eugene-Springfield, OR","area_median":19.2,"year":"2025","source_url":"https://www.bls.gov/oes/current/oes373011.htm"}',
  '{"source_name":"Example cost-of-living index","source_url":"https://example.com/col","year":"2026","rexius_metro":"Eugene, OR","rexius_index":104,"metros":[{"metro":"Denver, CO","index":112},{"metro":"Dallas, TX","index":98},{"metro":"Phoenix, AZ","index":103}],"notes":"100 = US average."}',
  '[{"employer":"Example National Grounds","title":"Landscape Crew Member","metro":"Denver, CO","min":21,"max":26,"unit":"hour","index":112,"adjusted_min":19.5,"adjusted_max":24.14},
    {"employer":"Sample Services Inc","title":"Grounds Maintenance Technician","metro":"Dallas, TX","min":17,"max":20,"unit":"hour","index":98,"adjusted_min":18.04,"adjusted_max":21.22},
    {"employer":"Demo Landscape Group","title":"Landscape Maintenance Crew","metro":"Phoenix, AZ","min":18,"max":22,"unit":"hour","index":103,"adjusted_min":18.17,"adjusted_max":22.21}]',
  '{"unit":"hour","position_min":17,"position_max":20,"adjusted_low_median":18.17,"adjusted_high_median":22.21,"raw_low_median":18,"raw_high_median":22,"samples_compared":3,"bls_national_median_adjusted":19.64}',
  false,
  '[{"url":"https://example.com/n/1","title":"Landscape Crew Member - Example National Grounds","age":null},{"url":"https://www.bls.gov/oes/current/oes373011.htm","title":"Landscaping and Groundskeeping Workers","age":null}]',
  61000, 5200, 12, 'claude-opus-5-5'
from recruiting.positions where title = 'Landscape Maintenance Crew Member' and location = 'Eugene/Springfield';

-- Openings (20261111000100): the migration opened every open position on the day it ran, which
-- is after the applications above, so start them 45 days back. The maintenance crew also gets a
-- past spring season, and a range of $17–$20 that was then raised, so the position page shows
-- the history.
update recruiting.position_openings set opened_at = current_date - 45 where closed_at is null;

insert into recruiting.position_openings (position_id, opened_at, closed_at, note)
select id, current_date - 230, current_date - 120, 'Spring crews'
from recruiting.positions where title = 'Landscape Maintenance Crew Member' and location = 'Eugene/Springfield';

update recruiting.positions set pay_min = 17, pay_max = 20, pay_unit = 'hour'
where title = 'Landscape Maintenance Crew Member' and location = 'Eugene/Springfield';
update recruiting.positions set pay_min = 18, pay_max = 21
where title = 'Landscape Maintenance Crew Member' and location = 'Eugene/Springfield';
update recruiting.position_pay_history set note = 'Raised $1 to fill fall crews'
where id = (select max(id) from recruiting.position_pay_history);
