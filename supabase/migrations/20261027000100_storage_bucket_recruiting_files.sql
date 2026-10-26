-- Phase 4: the private Storage bucket for resumes and portfolios, and the access rules on it.
--
-- Files copied from Jotform (CLAUDE.md sections 2 and 5) live in bucket `recruiting-files` as
-- private objects. The frontend never gets a public URL: a signed-in user with a profile asks
-- Storage for a short-lived signed URL, which Storage grants only if a `select` policy on
-- storage.objects lets that user see the object. Writes come from the backfill script and the
-- webhook only, both running as service_role, which bypasses RLS; no `authenticated` write
-- policy exists, so a browser session cannot upload, overwrite or delete anything here.
--
-- Object keys written by the importer: applications/<jotform form id>/<submission id>/<file>.
-- Metadata about each object (kind, original name, which application) is in
-- recruiting.application_files; this bucket holds only the bytes.
--
-- The storage schema belongs to Supabase (owner supabase_storage_admin). This file only adds a
-- bucket row and policies, which is the supported way to configure Storage from SQL; it never
-- alters storage tables. The policies call recruiting.current_role(), which already has
-- `execute` for authenticated.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recruiting-files', 'recruiting-files', false, 26214400, null)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit;

create policy "recruiting-files: app users can read files"
  on storage.objects for select to authenticated
  using (bucket_id = 'recruiting-files' and recruiting.current_role() is not null);

-- No insert, update or delete policies for authenticated on this bucket, on purpose. RLS on
-- storage.objects is already enabled by Supabase; with no matching policy those operations are
-- denied for browser sessions. service_role (backfill, webhook) is not subject to RLS.
