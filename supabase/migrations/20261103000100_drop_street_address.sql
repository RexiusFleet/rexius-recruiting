-- Street addresses leave the tracker (2026-10-28).
--
-- Question 263 ("Address") on each of the three forms carries the applicant's street address,
-- apartment line and postal code as well as city and state. Nothing in the tracker needs the
-- street address, so it joins the never-import list (CLAUDE.md section 5): the webhook and the
-- backfill keep reading question 263 to fill `applications.city` and `applications.state`, but
-- the answer itself is no longer stored in `answers`. Anyone who needs the full address opens
-- the submission in Jotform via `jotform_url`.
--
-- Two changes:
--   * forms.field_map on every form: "263" joins never_import. The `address` key stays so the
--     importer still knows where city and state come from.
--   * applications.answers on every row imported so far: key 263 is removed. Jotform keeps the
--     original submission, so nothing is lost.

update recruiting.forms
set field_map = jsonb_set(
  field_map,
  '{never_import}',
  coalesce(field_map -> 'never_import', '[]'::jsonb) || '["263"]'::jsonb
)
where jotform_form_id in ('260115636145148', '232824275836160', '232764918957171')
  and not (coalesce(field_map -> 'never_import', '[]'::jsonb) ? '263');

update recruiting.applications
set answers = answers - '263'
where answers ? '263';
