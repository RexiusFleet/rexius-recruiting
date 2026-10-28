-- Driver licence class becomes visible (2026-10-28, with the application-download change).
--
-- Many Rexius roles need a CDL, so question 35 ("Class or Type of License") on each of the three
-- forms is now imported, shown in the drawer and the PDF, and exposed to managers. The licence
-- number (30) and expiry (31) stay in never_import and are still dropped at import, together with
-- the signatures and initials (CLAUDE.md section 5). Because question 35 is a free-text box right
-- under the licence number, the importer (supabase/functions/_shared/clean.mjs) drops an answer
-- that looks like a number (five or more digits in a row) or runs long.
--
-- Two changes:
--   * forms.field_map on every form: "35" leaves never_import and a `licence_class` key points at
--     it. Rows imported before this migration have no answer 35; re-run the backfill with
--     --refresh to fill it (README "What the application-download change created").
--   * applications_for_managers appends `licence_class` (create or replace view may only append).

update recruiting.forms
set field_map = jsonb_set(
  field_map,
  '{never_import}',
  coalesce((
    select jsonb_agg(q) from jsonb_array_elements(field_map -> 'never_import') q
    where q <> to_jsonb('35'::text)
  ), '[]'::jsonb)
) || '{"licence_class": "35"}'::jsonb
where jotform_form_id in ('260115636145148', '232824275836160', '232764918957171');

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
  a.answers -> (f.field_map ->> 'licence_class')     as licence_class
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
  'funnels), origin and who entered a manual row. No notes, tags, raw answers, offers, referrals '
  'or contact log. Any user with a profile may read it; managers have nothing else.';

grant select on recruiting.applications_for_managers to authenticated, service_role;
