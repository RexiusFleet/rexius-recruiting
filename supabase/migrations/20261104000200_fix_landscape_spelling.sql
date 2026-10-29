-- "Commercial Landcape Project Lead" becomes "Commercial Landscape Project Lead" (2026-10-28).
--
-- The English form's Eugene/Springfield position dropdown carried the misspelling, and it was
-- copied into the positions seed, the stored question map, 11 applications and an alias. The
-- dropdown option itself was renamed in Jotform the same day. Everything here follows:
--   * positions: title and jotform_option_label.
--   * forms.questions: the option key and value under question 340, so the drift check compares
--     the corrected label.
--   * applications: position_text and the stored answer 340 on the 11 rows that chose it.
--   * position_aliases: the alias that mapped the correct spelling to the misspelled position
--     goes; one mapping the old misspelling takes its place, so a submission edited in Jotform
--     before the rename, or a redelivery, still links.

update recruiting.positions
set title = 'Commercial Landscape Project Lead',
    jotform_option_label = 'Commercial Landscape Project Lead'
where location = 'Eugene/Springfield'
  and (title = 'Commercial Landcape Project Lead' or jotform_option_label = 'Commercial Landcape Project Lead');

update recruiting.forms
set questions = jsonb_set(
  questions,
  '{340,options}',
  (questions -> '340' -> 'options') - 'Commercial Landcape Project Lead'
    || jsonb_build_object('Commercial Landscape Project Lead', 'Commercial Landscape Project Lead')
)
where jotform_form_id = '260115636145148'
  and questions -> '340' -> 'options' ? 'Commercial Landcape Project Lead';

update recruiting.applications
set position_text = 'Commercial Landscape Project Lead'
where position_text = 'Commercial Landcape Project Lead';

update recruiting.applications
set answers = jsonb_set(answers, '{340}', to_jsonb('Commercial Landscape Project Lead'::text))
where answers ->> '340' = 'Commercial Landcape Project Lead';

delete from recruiting.position_aliases
where location = 'Eugene/Springfield' and lower(alias) = lower('Commercial Landscape Project Lead');

insert into recruiting.position_aliases (position_id, alias, location, note)
select id, 'Commercial Landcape Project Lead', 'Eugene/Springfield', 'Misspelling the English form carried until 2026-10-28'
from recruiting.positions
where title = 'Commercial Landscape Project Lead' and location = 'Eugene/Springfield'
on conflict do nothing;
