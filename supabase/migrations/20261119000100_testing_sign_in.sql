-- Testing window (2026-11-19): sign-in that an admin can hand out without email or an
-- authenticator app, until the tracker moves inside the Rexius company app and takes its users
-- and roles from there.
--
-- Two changes, both per person, both set only by an admin on the Users page:
--
--   1. profiles.mfa_required (default true). Since migration 20261102000100 every session had to
--      be aal2. Now an admin can switch the second factor off for one person; for them a password
--      session (aal1) is enough. Everyone else is exactly as before, and nobody is switched off
--      by this migration.
--
--   2. Temporary passwords. The admin makes the login with a password the Edge Function
--      recruiting-users generates and shows once; the admin passes it on. The profile is marked
--      must_change_password, and while that is set current_role() is null: the temporary
--      password signs in but opens nothing, and the only thing the page offers is choosing a new
--      password (the function's `change_password` action, which sets it with the service role
--      and clears the mark). A temporary password that is not replaced within seven days stops
--      working for that too (temp_password_expires_at, checked by the function).
--
-- Every policy, the storage policies and every Edge Function go through current_role(), so this
-- one function is again the only place the rule lives.
--
-- A user cannot change these columns for themselves: the update policy on profiles needs
-- current_role() = 'admin', which is null at aal1 for anyone still required to use two factors
-- and null for anyone with a temporary password.

alter table recruiting.profiles
  add column mfa_required boolean not null default true,
  add column must_change_password boolean not null default false,
  add column temp_password_expires_at timestamptz;

comment on column recruiting.profiles.mfa_required is
  'False = this person signs in with a password alone (testing window, 2026-11-19). Set by an admin on the Users page.';
comment on column recruiting.profiles.must_change_password is
  'True while the person still has the temporary password an admin gave them; current_role() is null until they choose their own.';
comment on column recruiting.profiles.temp_password_expires_at is
  'When the temporary password can no longer be exchanged for a new one (seven days after it was made).';

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
    and not p.must_change_password
    and (not p.mfa_required or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2');
$$;

comment on function recruiting.current_role() is
  'Role of the calling user from recruiting.profiles, or null if they have no profile, still '
  'have a temporary password, or are required to use two-factor sign-in and their session has '
  'not passed it (JWT aal claim is not aal2). Use in every recruiting.* RLS policy.';
