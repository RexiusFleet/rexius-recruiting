-- Two-factor authentication for every tracker user.
--
-- Supabase Auth issues a JWT whose `aal` claim is `aal1` after a password sign-in and `aal2`
-- once the user has also entered a code from their authenticator app (TOTP). Every policy in
-- this schema, and the storage policies on bucket recruiting-files, go through
-- recruiting.current_role(), so requiring aal2 inside that one function makes the whole
-- database refuse a session that has not passed the second factor: it behaves exactly like a
-- login with no profile. The frontend enrols a factor on first sign-in and asks for the code
-- on every later one (web/app.js, "MFA").
--
-- The one exception is a user's own profiles row, readable at aal1, so the page can tell a
-- signed-in account without a role "No access" instead of making it enrol an authenticator
-- for nothing, and so an admin can be identified while the factor is set up. It is the
-- caller's own row only, so nothing about anyone else is visible before the second factor.
--
-- service_role requests carry no `sub`, so auth.uid() is null and current_role() is null for
-- them as before; the backfill and the webhook are unaffected.
--
-- Recovery: a user who loses their authenticator cannot sign in. An admin removes the factor
-- (Dashboard -> Authentication -> Users -> the user -> factors, or
-- `delete from auth.mfa_factors where user_id = '<uuid>'` in the SQL editor) and the user
-- enrols again at the next sign-in. README "Two-factor authentication".

create or replace function recruiting.current_role()
returns recruiting.user_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from recruiting.profiles p
  where p.user_id = auth.uid()
    and coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
$$;

comment on function recruiting.current_role() is
  'Role of the calling user from recruiting.profiles, or null if they have no profile or their '
  'session has not passed two-factor authentication (JWT aal claim is not aal2). '
  'Use in every recruiting.* RLS policy.';

create policy "profiles: users can read their own row before MFA"
  on recruiting.profiles
  for select
  to authenticated
  using (user_id = auth.uid());
