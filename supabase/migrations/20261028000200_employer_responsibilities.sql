-- Phase 6: the English form asks "Please describe your role and responsibilities" for each
-- employer (questions 380, 381, 382). The seeded employer blocks in forms.field_map did not
-- include them, so the employment history in the drawer and in the manager view lost the most
-- useful part of each job. Add a `responsibilities` key to each employer block on the English
-- form (the Spanish and CAS forms have no such question) and emit it from the view.
--
-- The view is re-created with the same column list; `responsibilities` is a new key inside the
-- existing `employment_history` jsonb, so no column is added or moved.

update recruiting.forms
set field_map = jsonb_set(
  field_map,
  '{employers}',
  (
    select jsonb_agg(
      case ord
        when 1 then e || '{"responsibilities": "380"}'::jsonb
        when 2 then e || '{"responsibilities": "381"}'::jsonb
        when 3 then e || '{"responsibilities": "382"}'::jsonb
        else e
      end
      order by ord
    )
    from jsonb_array_elements(field_map -> 'employers') with ordinality as emp(e, ord)
  )
)
where jotform_form_id = '260115636145148'
  and jsonb_array_length(coalesce(field_map -> 'employers', '[]'::jsonb)) = 3;

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
  ) as files
from recruiting.applications a
join recruiting.forms f on f.id = a.form_id
join recruiting.application_status st on st.application_id = a.id
join recruiting.stages s on s.id = st.stage_id
left join recruiting.positions p on p.id = a.position_id
where recruiting.current_role() is not null;

grant select on recruiting.applications_for_managers to authenticated, service_role;
