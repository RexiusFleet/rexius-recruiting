-- Manual applications, part 3 of 3: the curated manager view carries manual entries like any
-- other application. Two changes to the body and four appended columns:
--
--   * The join to recruiting.forms becomes a left join. A manual row has no form, and an inner
--     join would hide it from managers altogether. Columns read through the form's field_map
--     (education, relevant_skills, employment_history, ...) are simply null for manual rows.
--   * Appended: origin, entered_by, entered_at (so the drawer can say "Entered by X on date"),
--     and manual_notes, the free-text "notes and skills" the staff member typed from the paper
--     form, stored in answers under the key `manual_notes`. That key is the only part of
--     `answers` exposed here; the raw JSON itself stays staff-only as before.
--
-- `create or replace view` may only append columns, so the existing list is kept in order. It
-- includes `furthest_stage_id`, appended by the Phase 7 migration 20261029000200, which sorts
-- before this file: apply Phase 7's migrations first. (If this file runs on a database without
-- that column, the view simply gains it here; the expression depends only on status_history and
-- stages, which exist since Phase 3.)

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
  a.answers ->> 'manual_notes'      as manual_notes
from recruiting.applications a
left join recruiting.forms f on f.id = a.form_id
join recruiting.application_status st on st.application_id = a.id
join recruiting.stages s on s.id = st.stage_id
left join recruiting.positions p on p.id = a.position_id
where recruiting.current_role() is not null;

comment on view recruiting.applications_for_managers is
  'Curated applications for hiring managers: contact, position, availability, education, '
  'employment history, files (storage paths for signed URLs: resumes, portfolios and the scan '
  'of a manual entry), stage, assignee, the furthest stage reached (for funnels), origin and '
  'who entered a manual row. No notes, tags, raw answers, offers, referrals or contact log. '
  'Any user with a profile may read it; managers have nothing else.';

grant select on recruiting.applications_for_managers to authenticated, service_role;
