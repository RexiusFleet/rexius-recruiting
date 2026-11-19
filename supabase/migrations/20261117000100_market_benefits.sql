-- Competitive benefits in the market check (2026-11-18).
--
-- A market check already records what others pay. Postings also say what else they offer:
-- health insurance, retirement, paid time off, year-round work, paid training. From now on a
-- run notes the benefits each posting lists, in a fixed set of categories, and the Edge
-- Function counts them and compares them with what Rexius offers for the position.
--
--   * positions.benefits: the categories Rexius offers for this role, ticked by staff in the
--     Market check section (empty = not filled in yet, so nothing is compared);
--     positions.benefits_note: free text shown beside them (waiting period, seasonal rules).
--   * market_checks.benefits: what the run found and the comparison, computed in the function:
--     {postings_with_benefits, postings_total, categories: [{key, count, share}], common: [keys],
--      rexius: [keys] or null, gaps: [keys], also_offered: [keys]}.
--     "common" is a category listed by at least half of the postings that list any benefit
--     (and by at least two); "gaps" are common categories Rexius does not tick. A posting that
--     lists no benefits is not counted as offering none: search results often leave them out.
--
-- No new table and no policy change: both tables' existing policies cover the new columns
-- (staff write positions; market_checks is written by the function).

alter table recruiting.positions
  add column benefits text[] not null default '{}'
    check (benefits <@ array['health','dental','vision','retirement','retirement_match','pto','holidays',
                             'bonus','year_round','training','gear','life_disability']::text[]),
  add column benefits_note text check (benefits_note is null or length(benefits_note) <= 500);

comment on column recruiting.positions.benefits is
  'Benefit categories Rexius offers for this role, for the market check''s comparison: health, dental, vision, retirement, retirement_match, pto, holidays, bonus, year_round, training, gear, life_disability. Empty: not filled in, nothing is compared.';
comment on column recruiting.positions.benefits_note is
  'Free text about this role''s benefits (waiting period, seasonal rules). Shown to staff and managers; never an individual''s terms.';

alter table recruiting.market_checks
  add column benefits jsonb check (benefits is null or jsonb_typeof(benefits) = 'object');

comment on column recruiting.market_checks.benefits is
  'Benefits the run''s postings list, counted by category, and the comparison with positions.benefits at the time of the run: {postings_with_benefits, postings_total, categories: [{key, count, share}], common, rexius, gaps, also_offered}. Null on runs before 2026-11-18.';
