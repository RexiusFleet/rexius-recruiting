-- Let the service role read the purge list (2026-10-29).
--
-- 20261104000100 created recruiting.purged_submissions with RLS on and no policies, but also no
-- grant, so the backfill and the webhook (which read it through the service-role key) got
-- "permission denied" instead of a list. The purge script itself connects to Postgres directly
-- as the owner, which is why the purge worked. Service role bypasses RLS once the grant exists;
-- authenticated and anon still have nothing, so the browser cannot read it.

grant all on recruiting.purged_submissions to service_role;
