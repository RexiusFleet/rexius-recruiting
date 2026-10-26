-- Phase 6: let the curated manager view carry the applicant's files so the frontend can request
-- short-lived signed URLs for managers. Managers have no select on recruiting.application_files
-- (staff only), so without this column they would know an applicant has a resume (has_resume)
-- but not where it is in the bucket.
--
-- `create or replace view` may only append columns, so `files` goes last. Only the storage path,
-- original file name and kind are exposed; the Jotform URL of the file stays out (managers do not
-- have Jotform logins and the Storage copy is the one they should open).

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
        'employer', a.answers -> (e ->> 'name'),
        'location', a.answers -> (e ->> 'location'),
        'title',    a.answers -> (e ->> 'title'),
        'start',    a.answers -> (e ->> 'start'),
        'end',      a.answers -> (e ->> 'end'),
        'reason',   a.answers -> (e ->> 'reason')
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

comment on view recruiting.applications_for_managers is
  'Curated applications for hiring managers: contact, position, availability, education, '
  'employment history, resume files (storage paths for signed URLs), stage and assignee. No '
  'notes, tags, raw answers, offers, referrals or contact log. Any user with a profile may read '
  'it; managers have nothing else.';

grant select on recruiting.applications_for_managers to authenticated, service_role;
