-- Position suggestions: a summary also lists other positions the application relates to.
--
-- When HR or an admin presses Summarize, the Edge Function recruiting-applicant-summary now also
-- shows Claude the other open and closed positions at the location the applicant applied to
-- (title, department, description text) and asks which of them the application addresses with
-- stated facts. The answer is up to three positions, each with the facts that meet a stated
-- requirement of that role and what the application does not say about it. It is a pointer for
-- HR to read, never a score, a ranking or a recommendation: the function, not Claude, sets the
-- order (open positions first, then by title), and docs/applicant-summary-rules.md has the rules.
--
-- This migration adds:
--   * careers_pages.body_text: the text of the job page on rexius.com, kept by the daily careers
--     sync. A position whose job description is an uploaded file (or missing) has no text Claude
--     can read; the posting's own text is the fallback, for the applied-for position as well.
--   * applicant_summaries.other_positions and catalog_size: the suggestions of a run, and how
--     many other positions Claude was shown (null on runs from before this change).
--   * position_suggestions: for a position's page, the applications whose newest finished
--     summary lists that position. Admin and hr only; managers never see suggestions.

-- ---------------------------------------------------------------------------------------------
-- careers_pages: keep the posting's text
-- ---------------------------------------------------------------------------------------------

alter table recruiting.careers_pages
  add column body_text text check (body_text is null or length(body_text) <= 20000);

comment on column recruiting.careers_pages.body_text is
  'The job page''s text as published on rexius.com (plain text, one line per block), written by '
  'the careers sync. The applicant summary uses it as the position''s description when no '
  'typed job description is linked. Null until the first sync after this column was added.';

-- ---------------------------------------------------------------------------------------------
-- applicant_summaries: the other positions of a run
-- ---------------------------------------------------------------------------------------------

alter table recruiting.applicant_summaries
  add column other_positions jsonb not null default '[]'::jsonb check (jsonb_typeof(other_positions) = 'array'),
  add column catalog_size integer check (catalog_size is null or catalog_size >= 0);

comment on column recruiting.applicant_summaries.other_positions is
  'Other positions the application relates to: [{position_id, title, location, status, '
  'had_description, matches[], not_stated[]}], at most three. title, location and status are as '
  'they were at the run. Ordered by the function (open first, then title), never by Claude: the '
  'order is not a ranking. No scores and no recommendation (docs/applicant-summary-rules.md).';
comment on column recruiting.applicant_summaries.catalog_size is
  'How many other positions Claude was shown in this run (open and closed, at the location '
  'applied to). Null: the run predates position suggestions. 0: there was nothing to compare.';

-- ---------------------------------------------------------------------------------------------
-- position_suggestions: who was pointed at a position, for the position's page
-- ---------------------------------------------------------------------------------------------
-- One row per position and application, from the application's newest finished summary only (a
-- newer run replaces what an older one said). An application already linked to the position is
-- left out. Runs with the owner's privileges like the other curated views, so the where clause
-- is the access check: admin and hr.

create view recruiting.position_suggestions
with (security_barrier = true)
as
select
  (o ->> 'position_id')::uuid as position_id,
  latest.application_id,
  latest.id                   as summary_id,
  latest.created_at           as suggested_at,
  o -> 'matches'              as matches,
  o -> 'not_stated'           as not_stated
from (
  select distinct on (sm.application_id) sm.id, sm.application_id, sm.created_at, sm.other_positions
  from recruiting.applicant_summaries sm
  where sm.finished_at is not null and sm.error is null
  order by sm.application_id, sm.created_at desc
) latest
join recruiting.applications a on a.id = latest.application_id
cross join lateral jsonb_array_elements(latest.other_positions) as op(o)
join recruiting.positions p on p.id = (o ->> 'position_id')::uuid
where recruiting.is_staff()
  and a.position_id is distinct from p.id;

comment on view recruiting.position_suggestions is
  'Applications whose newest finished summary lists a position among the other positions the '
  'application relates to; the position page shows them when a role opens again. Admin and hr '
  'only. A pointer for staff to read, not a ranking: there is no score and no order.';

grant select on recruiting.position_suggestions to authenticated, service_role;
