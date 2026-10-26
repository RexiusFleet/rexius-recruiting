-- Phase 7c: Storage rules for the document library. Uploaded job descriptions, interview guides
-- and templates live in the same private bucket as resumes, under the `documents/` prefix
-- (object key documents/<document id>/<file name>), with their metadata in recruiting.documents.
--
-- Rules:
--   * Reading: an object under documents/ is readable only when a recruiting.documents row points
--     at it AND the caller may read that row. The documents table's own policy applies min_role
--     (manager < hr < admin), so the `exists` below is evaluated under the caller's rights: a
--     manager gets a signed URL for a manager-level description and nothing for an hr-level
--     interview guide. Objects outside documents/ (the resumes) keep the Phase 4 rule: any user
--     with a profile.
--   * Writing: admin and hr may upload, overwrite and delete under documents/ only. The resume
--     prefix stays service_role-only (backfill and webhook), as in Phase 4.
--
-- The Phase 4 select policy is dropped and re-created with the extra condition rather than
-- adding a restrictive policy on storage.objects, which the inventory app's buckets share.

drop policy if exists "recruiting-files: app users can read files" on storage.objects;

create policy "recruiting-files: app users can read files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'recruiting-files'
    and recruiting.current_role() is not null
    and (
      name not like 'documents/%'
      or exists (
        select 1 from recruiting.documents d where d.storage_path = objects.name
      )
    )
  );

create policy "recruiting-files: staff can upload documents"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'recruiting-files'
    and name like 'documents/%'
    and recruiting.is_staff()
  );

create policy "recruiting-files: staff can replace documents"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'recruiting-files'
    and name like 'documents/%'
    and recruiting.is_staff()
  )
  with check (
    bucket_id = 'recruiting-files'
    and name like 'documents/%'
    and recruiting.is_staff()
  );

create policy "recruiting-files: staff can remove documents"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'recruiting-files'
    and name like 'documents/%'
    and recruiting.is_staff()
  );
