-- Phase 9b: applicant summaries and translation (CLAUDE.md section 8, "Phase 9 decisions").
--
-- HR or an admin presses Summarize in an application's drawer. The Edge Function
-- recruiting-applicant-summary sends Claude the position (title, location, department, the
-- linked job description's text) and an allowlist of the application's answers, never the name,
-- email, phones, referrer, source, supervisors' names or phones, or the eligibility, age, health
-- and drug-policy questions. Claude returns a factual summary against the position (no scores,
-- no ranking, no recommendation) and an English translation of every written answer that is not
-- in English. HR can also translate a message to or from Spanish for a reply; that text is not
-- stored, only the usage. docs/applicant-summary-rules.md says what a summary may and may not
-- contain.
--
-- This migration adds:
--   * forms.field_map keys `certifications` (66), `worked_before_details` (273),
--     `applied_before_details` (275) and `other_qualifications` (276), the four written
--     questions the summary reads that had no key yet. Same question IDs on all four forms; a
--     form without the question gets no key.
--   * applicant_summaries: one row per run, never overwritten. Inserted when the run starts
--     (finished_at and error both null = running) and filled in when it finishes; an error is
--     stored on the row. Written only by the Edge Function (service_role), so a row is always
--     what Claude produced. Admin and hr read it; managers do not.
--   * message_translations: usage of the reply translator (direction, lengths, tokens, cost). The
--     message text itself is not stored. Admin and hr read it.
--   * applications_for_managers appends `translation`: the English translation of the answers a
--     manager can already see (skills, licence class, employment history, paper-form notes, the
--     position as written), from the latest finished summary. Nothing else from a summary reaches
--     managers.

-- ---------------------------------------------------------------------------------------------
-- forms: keys for the written questions the summary reads
-- ---------------------------------------------------------------------------------------------

update recruiting.forms
set field_map = field_map
  || case when questions ? '66'  then jsonb_build_object('certifications', '66') else '{}'::jsonb end
  || case when questions ? '273' then jsonb_build_object('worked_before_details', '273') else '{}'::jsonb end
  || case when questions ? '275' then jsonb_build_object('applied_before_details', '275') else '{}'::jsonb end
  || case when questions ? '276' then jsonb_build_object('other_qualifications', '276') else '{}'::jsonb end
where questions ?| array['66', '273', '275', '276'];

-- ---------------------------------------------------------------------------------------------
-- applicant_summaries: one row per run
-- ---------------------------------------------------------------------------------------------

create table recruiting.applicant_summaries (
  id                 uuid primary key default gen_random_uuid(),
  application_id     uuid not null references recruiting.applications (id) on delete cascade,
  position_id        uuid references recruiting.positions (id) on delete set null,
  requested_by       uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  finished_at        timestamptz,
  answer_language    text check (answer_language is null or answer_language in ('en', 'es', 'mixed', 'other')),
  summary            jsonb,
  translations       jsonb not null default '[]'::jsonb,
  had_description    boolean not null default false,
  model              text,
  input_tokens       integer check (input_tokens is null or input_tokens >= 0),
  output_tokens      integer check (output_tokens is null or output_tokens >= 0),
  cache_read_tokens  integer check (cache_read_tokens is null or cache_read_tokens >= 0),
  cache_write_tokens integer check (cache_write_tokens is null or cache_write_tokens >= 0),
  cost_usd           numeric(10, 4) check (cost_usd is null or cost_usd >= 0),
  error              text,
  check (summary is null or jsonb_typeof(summary) = 'object'),
  check (jsonb_typeof(translations) = 'array')
);

comment on table recruiting.applicant_summaries is
  'One row per applicant-summary run (Edge Function recruiting-applicant-summary). finished_at and '
  'error both null: still running. Written only by the function; admin and hr read. A summary '
  'states facts from the application against the position; it never scores, ranks or recommends '
  '(docs/applicant-summary-rules.md).';
comment on column recruiting.applicant_summaries.position_id is
  'The position the summary was written against (the application''s matched position at the time; null for CAS free text).';
comment on column recruiting.applicant_summaries.answer_language is
  'Language of the applicant''s own written answers as Claude read them: en, es, mixed or other. Only for how HR replies.';
comment on column recruiting.applicant_summaries.summary is
  '{overview, experience[], licences[], availability, location, not_stated[], check_in_application[]}.';
comment on column recruiting.applicant_summaries.translations is
  'English translation of written answers that were not in English: [{key, label, original, english, manager}]. '
  'original is copied from the application by the function, not written by Claude; manager = a manager can see that answer.';
comment on column recruiting.applicant_summaries.had_description is
  'True when the position had a linked job description whose text was sent with the application.';
comment on column recruiting.applicant_summaries.input_tokens is
  'All input tokens of the request, cached and uncached (usage.input_tokens + cache reads + cache writes).';
comment on column recruiting.applicant_summaries.cost_usd is
  'List-price cost of the run, worked out by the function from the usage figures and the model''s published rates.';

create index applicant_summaries_application_idx on recruiting.applicant_summaries (application_id, created_at desc);

alter table recruiting.applicant_summaries enable row level security;

create policy "applicant_summaries: staff can read applicant summaries"
  on recruiting.applicant_summaries for select to authenticated
  using (recruiting.is_staff());

grant select on recruiting.applicant_summaries to authenticated;
grant all on recruiting.applicant_summaries to service_role;

-- ---------------------------------------------------------------------------------------------
-- message_translations: usage of the reply translator, never the text
-- ---------------------------------------------------------------------------------------------

create table recruiting.message_translations (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid references recruiting.applications (id) on delete set null,
  requested_by   uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  direction      text not null check (direction in ('en-es', 'es-en')),
  chars_in       integer not null check (chars_in >= 0),
  chars_out      integer check (chars_out is null or chars_out >= 0),
  model          text,
  input_tokens   integer check (input_tokens is null or input_tokens >= 0),
  output_tokens  integer check (output_tokens is null or output_tokens >= 0),
  cost_usd       numeric(10, 4) check (cost_usd is null or cost_usd >= 0),
  error          text
);

comment on table recruiting.message_translations is
  'One row per use of the reply translator in the drawer (Edge Function recruiting-applicant-summary). '
  'Holds usage only: the message and its translation are returned to the browser and never stored.';

create index message_translations_created_idx on recruiting.message_translations (created_at desc);

alter table recruiting.message_translations enable row level security;

create policy "message_translations: staff can read translation usage"
  on recruiting.message_translations for select to authenticated
  using (recruiting.is_staff());

grant select on recruiting.message_translations to authenticated;
grant all on recruiting.message_translations to service_role;

-- ---------------------------------------------------------------------------------------------
-- applications_for_managers: append `translation` (create or replace view may only append)
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
  ) as translation
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
  'six-month retention has removed email and phone, then the files. Any user with a profile may '
  'read it; managers have nothing else.';

grant select on recruiting.applications_for_managers to authenticated, service_role;
