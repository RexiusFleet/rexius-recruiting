-- CAS applications keep their position as typed (2026-10-29).
--
-- The CAS Employment Application form has a free-text position box and no location question,
-- and the few CAS roles are not tracked on the Positions page. The unmatched-position purge of
-- 2026-10-28 therefore deleted every CAS application (13 from 2026) along with the old
-- dropdown labels it was meant to remove, and listed them in purged_submissions so the
-- importers would keep them out. From now on a CAS application is never "unmatched": the
-- Positions page and scripts/purge-unmatched.mjs skip location CAS, position_text stays as the
-- applicant typed it and position_id stays null. This migration takes the 13 CAS submissions
-- off the purge list so `npm run backfill -- --form 232764918957171` brings them back.
-- The IDs are Jotform submission IDs, not applicant data.

delete from recruiting.purged_submissions
where jotform_submission_id in (
  '6665133302012651247', '6660942289193327007', '6630205715819909000', '6605565755319268512',
  '6599854112219562175', '6577426152124084841', '6563251933545932300', '6542481853774401853',
  '6541592839601490548', '6532897973311689603', '6532322124221560286', '6472574184219315785',
  '6440851073496539360')
  and reason = 'Position answer matched no position; removed in the Positions page clean-up';

comment on column recruiting.applications.position_text is
  'Position as answered on the form. Linked to positions through position_id where the text matches a position or alias; for location CAS it is kept as typed and never linked.';
