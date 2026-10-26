-- Phase 3c: offers, referrals, manager feedback, the document library, and the curated view
-- managers read applications through.
--
-- Access rules (CLAUDE.md sections 5 and 7):
--   * offers: admin and hr only. No wage columns exist and none may be added (section 5).
--   * referrals: admin and hr only (bonus tracking).
--   * manager_feedback: managers write and read their own rows; admin and hr read everything.
--   * documents: metadata readable where min_role allows; admin and hr write. The file bodies
--     live in Storage; bucket policies arrive with the library UI in Phase 7.
--   * applications_for_managers: the only way a manager sees applications. It omits `answers`,
--     notes, tags, offers and anything else section 5 restricts.

-- ---------------------------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------------------------

create type recruiting.offer_outcome as enum ('pending', 'accepted', 'declined', 'withdrawn');
create type recruiting.feedback_verdict as enum ('interested', 'pass', 'undecided');
create type recruiting.document_kind as enum ('description', 'interview_guide', 'template', 'other');

-- ---------------------------------------------------------------------------------------------
-- offers: offer history, no wages
-- ---------------------------------------------------------------------------------------------

create table recruiting.offers (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references recruiting.applications (id) on delete cascade,
  position_id    uuid references recruiting.positions (id) on delete set null,
  offered_at     date not null default current_date,
  outcome        recruiting.offer_outcome not null default 'pending',
  responded_at   date,
  notes          text,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  check (responded_at is null or responded_at >= offered_at),
  check (outcome = 'pending' or responded_at is not null)
);

comment on table recruiting.offers is
  'Offers made and their outcome, for acceptance-rate and time-to-fill reporting. Deliberately '
  'has no pay column: offered or agreed wages are never stored (CLAUDE.md section 5).';

create index offers_application_idx on recruiting.offers (application_id);
create index offers_position_idx on recruiting.offers (position_id);
create index offers_offered_at_idx on recruiting.offers (offered_at);

alter table recruiting.offers enable row level security;

create policy "offers: staff can read offers"
  on recruiting.offers for select to authenticated
  using (recruiting.is_staff());

create policy "offers: staff can add offers"
  on recruiting.offers for insert to authenticated
  with check (recruiting.is_staff());

create policy "offers: staff can change offers"
  on recruiting.offers for update to authenticated
  using (recruiting.is_staff())
  with check (recruiting.is_staff());

create policy "offers: staff can remove offers"
  on recruiting.offers for delete to authenticated
  using (recruiting.is_staff());

grant select, insert, update, delete on recruiting.offers to authenticated;
grant all on recruiting.offers to service_role;

-- ---------------------------------------------------------------------------------------------
-- referrals: referral bonus tracking
-- ---------------------------------------------------------------------------------------------

create table recruiting.referrals (
  id                uuid primary key default gen_random_uuid(),
  application_id    uuid not null unique references recruiting.applications (id) on delete cascade,
  referrer_name     text not null check (length(btrim(referrer_name)) > 0),
  referrer_employee text,
  hired             boolean not null default false,
  bonus_paid_at     date,
  notes             text,
  created_at        timestamptz not null default now(),
  check (bonus_paid_at is null or hired)
);

comment on table recruiting.referrals is
  'One row per referred applicant: who referred them (as written on the form and, once matched, '
  'the employee), whether the hire happened, and when the referral bonus was paid.';

create index referrals_referrer_idx on recruiting.referrals (lower(referrer_name));

alter table recruiting.referrals enable row level security;

create policy "referrals: staff can read referrals"
  on recruiting.referrals for select to authenticated
  using (recruiting.is_staff());

create policy "referrals: staff can add referrals"
  on recruiting.referrals for insert to authenticated
  with check (recruiting.is_staff());

create policy "referrals: staff can change referrals"
  on recruiting.referrals for update to authenticated
  using (recruiting.is_staff())
  with check (recruiting.is_staff());

create policy "referrals: staff can remove referrals"
  on recruiting.referrals for delete to authenticated
  using (recruiting.is_staff());

grant select, insert, update, delete on recruiting.referrals to authenticated;
grant all on recruiting.referrals to service_role;

-- ---------------------------------------------------------------------------------------------
-- manager_feedback: a manager's response to a hand-off
-- ---------------------------------------------------------------------------------------------

create table recruiting.manager_feedback (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null references recruiting.applications (id) on delete cascade,
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  verdict         recruiting.feedback_verdict not null,
  note            text,
  at              timestamptz not null default now()
);

comment on table recruiting.manager_feedback is
  'What a hiring manager said about an application sent to them. Managers write their own rows '
  'and see only their own; HR and admin see all. The table exists now; the UI can wait.';

create index manager_feedback_application_idx on recruiting.manager_feedback (application_id, at desc);
create index manager_feedback_manager_idx on recruiting.manager_feedback (manager_user_id);

alter table recruiting.manager_feedback enable row level security;

create policy "manager_feedback: staff can read all feedback"
  on recruiting.manager_feedback for select to authenticated
  using (recruiting.is_staff());

create policy "manager_feedback: managers can read their own feedback"
  on recruiting.manager_feedback for select to authenticated
  using (recruiting.current_role() = 'manager' and manager_user_id = auth.uid());

create policy "manager_feedback: managers can add their own feedback"
  on recruiting.manager_feedback for insert to authenticated
  with check (recruiting.current_role() = 'manager' and manager_user_id = auth.uid());

create policy "manager_feedback: managers can change their own feedback"
  on recruiting.manager_feedback for update to authenticated
  using (recruiting.current_role() = 'manager' and manager_user_id = auth.uid())
  with check (recruiting.current_role() = 'manager' and manager_user_id = auth.uid());

create policy "manager_feedback: staff can remove feedback"
  on recruiting.manager_feedback for delete to authenticated
  using (recruiting.is_staff());

grant select, insert, update, delete on recruiting.manager_feedback to authenticated;
grant all on recruiting.manager_feedback to service_role;

-- ---------------------------------------------------------------------------------------------
-- documents: descriptions, interview guides, templates (metadata; bodies in Storage)
-- ---------------------------------------------------------------------------------------------

create table recruiting.documents (
  id           uuid primary key default gen_random_uuid(),
  title        text not null check (length(btrim(title)) > 0),
  kind         recruiting.document_kind not null default 'other',
  position_id  uuid references recruiting.positions (id) on delete set null,
  storage_path text,
  body         text,
  version      integer not null default 1 check (version >= 1),
  min_role     recruiting.user_role not null default 'hr',
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (storage_path is not null or body is not null)
);

comment on table recruiting.documents is
  'Job descriptions, interview guides and message templates. Either an uploaded file '
  '(storage_path in bucket recruiting-files) or inline text (body, for templates). min_role is '
  'the least-privileged role that may read it: manager < hr < admin.';

create index documents_kind_idx on recruiting.documents (kind);
create index documents_position_idx on recruiting.documents (position_id);

create trigger documents_set_updated_at
  before update on recruiting.documents
  for each row execute function recruiting.set_updated_at();

-- Role rank so "min_role allows" can be compared. manager=1, hr=2, admin=3.
create or replace function recruiting.role_rank(r recruiting.user_role)
returns smallint
language sql
immutable
set search_path = ''
as $$
  select case r when 'manager' then 1 when 'hr' then 2 when 'admin' then 3 end::smallint;
$$;

comment on function recruiting.role_rank(recruiting.user_role) is
  'manager -> 1, hr -> 2, admin -> 3. Used to compare a user''s role with documents.min_role.';

revoke execute on function recruiting.role_rank(recruiting.user_role) from public;
grant execute on function recruiting.role_rank(recruiting.user_role) to authenticated, service_role;

alter table recruiting.documents enable row level security;

create policy "documents: app users can read documents their role allows"
  on recruiting.documents for select to authenticated
  using (
    recruiting.current_role() is not null
    and recruiting.role_rank(recruiting.current_role()) >= recruiting.role_rank(min_role)
  );

create policy "documents: staff can add documents"
  on recruiting.documents for insert to authenticated
  with check (recruiting.is_staff());

create policy "documents: staff can change documents"
  on recruiting.documents for update to authenticated
  using (recruiting.is_staff())
  with check (recruiting.is_staff());

create policy "documents: staff can remove documents"
  on recruiting.documents for delete to authenticated
  using (recruiting.is_staff());

grant select, insert, update, delete on recruiting.documents to authenticated;
grant all on recruiting.documents to service_role;

-- positions.description_doc_id had to wait for documents to exist.
alter table recruiting.positions
  add column description_doc_id uuid references recruiting.documents (id) on delete set null;

comment on column recruiting.positions.description_doc_id is
  'The current job description for this position in the document library.';

-- ---------------------------------------------------------------------------------------------
-- applications_for_managers: the curated read model for managers (and a convenient list view
-- for everyone). Omits `answers`, notes, tags, offers, referrals and the contact log.
--
-- The view runs with the privileges of its owner (not security_invoker), which is how managers
-- can read rows from tables they have no policy on. The where clause is therefore the access
-- check: any signed-in user with a profile. Managers see all locations for now (CLAUDE.md
-- section 2); a location filter against profiles.location is a one-line change here later.
-- ---------------------------------------------------------------------------------------------

create view recruiting.applications_for_managers
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
        'employer', a.answers -> (e ->> 'name'),
        'location', a.answers -> (e ->> 'location'),
        'title',    a.answers -> (e ->> 'title'),
        'start',    a.answers -> (e ->> 'start'),
        'end',      a.answers -> (e ->> 'end'),
        'reason',   a.answers -> (e ->> 'reason')
      ) order by ord
    )
    from jsonb_array_elements(coalesce(f.field_map -> 'employers', '[]'::jsonb)) with ordinality as emp(e, ord)
    where a.answers ? (e ->> 'name')
  ) as employment_history
from recruiting.applications a
join recruiting.forms f on f.id = a.form_id
join recruiting.application_status st on st.application_id = a.id
join recruiting.stages s on s.id = st.stage_id
left join recruiting.positions p on p.id = a.position_id
where recruiting.current_role() is not null;

comment on view recruiting.applications_for_managers is
  'Curated applications for hiring managers: contact, position, availability, education, '
  'employment history, resume flag, stage and assignee. No notes, tags, raw answers, offers, '
  'referrals or contact log. Any user with a profile may read it; managers have nothing else.';

grant select on recruiting.applications_for_managers to authenticated, service_role;
