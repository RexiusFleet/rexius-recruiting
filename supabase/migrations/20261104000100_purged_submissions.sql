-- Purged submissions stay out (2026-10-28).
--
-- Staff can delete applications from the tracker (first use: the 55 applications whose
-- position answer matched no position, deleted from the Positions page clean-up). Jotform keeps
-- the submission, and both importers are idempotent only on "already in applications", so a
-- re-run of the backfill or a webhook redelivery would bring a deleted one straight back.
-- This table remembers every Jotform submission deleted on purpose; the backfill and the
-- webhook skip anything listed here.
--
-- Service-role only: RLS is on and no policy is created, so the browser can neither read
-- nor write it. The list holds submission IDs and a reason, never applicant data.

create table recruiting.purged_submissions (
  jotform_submission_id text primary key,
  reason                text,
  purged_at             timestamptz not null default now()
);

comment on table recruiting.purged_submissions is
  'Jotform submissions deleted from the tracker on purpose; the backfill and webhook skip them.';

alter table recruiting.purged_submissions enable row level security;
