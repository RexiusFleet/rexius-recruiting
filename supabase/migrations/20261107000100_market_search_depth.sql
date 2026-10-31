-- Per-position search depth for the market check (2026-10-30, follow-up to Phase 9a).
--
-- Every run was capped at the same number of web searches (the function secret
-- MARKET_CHECK_MAX_SEARCHES, default 6). Common crew roles find plenty within that; rarer
-- titles ran out of searches with one or two postings found. positions.market_max_searches
-- lets staff raise the cap for one position (null = the standard limit). The function reads
-- it and caps at 20; the drawer offers Standard (6), Deeper (10) and Deepest (15).

alter table recruiting.positions
  add column market_max_searches integer
    check (market_max_searches is null or market_max_searches between 1 and 20);

comment on column recruiting.positions.market_max_searches is
  'Web searches one market check may use for this position. Null: the function''s standard limit (secret MARKET_CHECK_MAX_SEARCHES, default 6). Each search costs about a cent plus tokens.';
