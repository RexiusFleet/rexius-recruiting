-- National market check with a cost-of-living adjustment (2026-10-30, follow-up to Phase 9a).
--
-- For specialised roles the local check finds little. One national run asks Claude, with web
-- search, what the same role pays across the United States (public postings and the Bureau of
-- Labor Statistics' published occupational wages) and what each place costs to live in compared
-- with the Rexius location, then scales every figure to the Rexius location and compares the
-- adjusted median with the position's advertised range. The arithmetic is done in the Edge
-- Function recruiting-national-check, not by the model. On demand only (Check now); no
-- schedule, since a run costs a few dollars.
--
-- The run has two passes saved separately (postings and BLS, then cost of living and the
-- adjustment), so a run cut off in the second pass still keeps the first: `pass` says how far
-- it got. Access as for market_checks: admin and hr read and write, managers read.

alter table recruiting.positions
  add column national_max_searches integer
    check (national_max_searches is null or national_max_searches between 4 and 20);

comment on column recruiting.positions.national_max_searches is
  'Web searches one national check may use for this position (both passes together). Null: the function''s standard limit (secret NATIONAL_CHECK_MAX_SEARCHES, default 15).';

create table recruiting.national_checks (
  id              uuid primary key default gen_random_uuid(),
  position_id     uuid not null references recruiting.positions (id) on delete cascade,
  ran_at          timestamptz not null default now(),
  requested_by    uuid references auth.users (id) on delete set null,
  pass            smallint not null default 0 check (pass between 0 and 2),
  summary         text,
  pay_samples     jsonb not null default '[]'::jsonb,
  bls             jsonb,
  cost_of_living  jsonb,
  adjusted        jsonb not null default '[]'::jsonb,
  comparison      jsonb,
  below_market    boolean,
  sources         jsonb not null default '[]'::jsonb,
  input_tokens    integer check (input_tokens is null or input_tokens >= 0),
  output_tokens   integer check (output_tokens is null or output_tokens >= 0),
  searches        integer check (searches is null or searches >= 0),
  model           text,
  error           text,
  finished_at     timestamptz,
  check (jsonb_typeof(pay_samples) = 'array'),
  check (jsonb_typeof(adjusted) = 'array'),
  check (jsonb_typeof(sources) = 'array')
);

comment on table recruiting.national_checks is
  'One row per national market check for a position (Edge Function recruiting-national-check). '
  'pass 0: running the first pass; 1: postings and BLS saved, cost of living running; 2: done. '
  'summary and error both null with pass < 2: still running. A sample, never a complete count.';
comment on column recruiting.national_checks.pay_samples is
  'National postings found: [{employer, title, metro, state, min, max, unit, url}]. What others advertise; never a Rexius wage.';
comment on column recruiting.national_checks.bls is
  'Bureau of Labor Statistics figures for the matching occupation: {occupation, soc_code, unit, national_median, p25, p75, area_name, area_median, year, source_url}, or null when none was found.';
comment on column recruiting.national_checks.cost_of_living is
  'Cost-of-living index per metro from one published source (100 = US average): {source_name, source_url, year, rexius_metro, rexius_index, metros: [{metro, index}], notes}.';
comment on column recruiting.national_checks.adjusted is
  'Each sample scaled to the Rexius location: [{employer, title, metro, min, max, unit, index, adjusted_min, adjusted_max}], in the position''s pay unit.';
comment on column recruiting.national_checks.comparison is
  '{unit, position_min, position_max, adjusted_low_median, adjusted_high_median, raw_low_median, raw_high_median, samples_compared, bls_national_median_adjusted}.';
comment on column recruiting.national_checks.below_market is
  'True when the top of the position''s advertised range is below the median low end of the adjusted national samples. Null when nothing could be compared.';

create index national_checks_position_idx on recruiting.national_checks (position_id, ran_at desc);

alter table recruiting.national_checks enable row level security;

create policy "national_checks: app users can read national checks"
  on recruiting.national_checks for select to authenticated
  using (recruiting.current_role() is not null);

create policy "national_checks: staff can add national checks"
  on recruiting.national_checks for insert to authenticated
  with check (recruiting.is_staff());

create policy "national_checks: staff can change national checks"
  on recruiting.national_checks for update to authenticated
  using (recruiting.is_staff())
  with check (recruiting.is_staff());

create policy "national_checks: staff can remove national checks"
  on recruiting.national_checks for delete to authenticated
  using (recruiting.is_staff());

grant select, insert, update, delete on recruiting.national_checks to authenticated;
grant all on recruiting.national_checks to service_role;
