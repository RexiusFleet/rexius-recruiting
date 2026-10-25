-- Phase 2: create the `recruiting` schema, the app's role type, the `profiles` table, the
-- `recruiting.current_role()` helper that every later RLS policy uses, and the policies on
-- `profiles` itself.
--
-- Conventions this migration establishes (see docs/database-conventions.md):
--   * Everything the app owns lives in schema `recruiting`. Nothing is created in `public`, which
--     belongs to the unrelated inventory app that shares this Supabase project.
--   * `anon` is granted nothing. The frontend ships the public anon/publishable key, but every
--     request must carry a signed-in user's JWT, so the Data API runs as `authenticated`.
--   * Row-level security is enabled in the same statement block that creates a table, and the
--     table is granted to `authenticated` (filtered by RLS) and `service_role` (used only by the
--     backfill script and the webhook, never by the browser).
--   * A user with no `profiles` row has no access to anything, whatever their JWT says.

create schema if not exists recruiting;

comment on schema recruiting is
  'Rexius Recruiter: applications, pipeline, positions, postings, documents, reports.';

-- Schema visibility for the Data API roles. `anon` is deliberately left out.
grant usage on schema recruiting to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------------------------

create type recruiting.user_role as enum ('admin', 'hr', 'manager');

comment on type recruiting.user_role is
  'admin: everything plus user management. hr: everything except user management. '
  'manager: read-only, curated columns, no notes or offers.';

-- ---------------------------------------------------------------------------------------------
-- profiles: one row per app user. No row = no access.
-- ---------------------------------------------------------------------------------------------

create table recruiting.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  role       recruiting.user_role not null,
  name       text not null check (length(btrim(name)) > 0),
  location   text,
  created_at timestamptz not null default now()
);

comment on table recruiting.profiles is
  'App users and their role. Rows are created by an admin after the auth user is invited. '
  'Shared auth.users with the inventory app; that app keeps its own profiles table.';
comment on column recruiting.profiles.location is
  'Reserved for a later per-location scope for managers. Null means all locations.';

alter table recruiting.profiles enable row level security;

-- ---------------------------------------------------------------------------------------------
-- current_role(): the role of the signed-in user, or null when they have no profile.
--
-- security definer so that the policies on `profiles` itself can call it without recursing
-- into their own RLS check; `set search_path = ''` so every object reference inside is
-- schema-qualified and cannot be hijacked. stable so the planner evaluates it once per query.
-- ---------------------------------------------------------------------------------------------

create or replace function recruiting.current_role()
returns recruiting.user_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from recruiting.profiles p
  where p.user_id = auth.uid();
$$;

comment on function recruiting.current_role() is
  'Role of the calling user from recruiting.profiles, or null if they have no profile. '
  'Use in every recruiting.* RLS policy.';

-- Functions are executable by everyone by default; restrict to the roles that need it.
revoke execute on function recruiting.current_role() from public;
grant execute on function recruiting.current_role() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Policies on profiles
-- ---------------------------------------------------------------------------------------------

-- Anyone with a profile can see who the other app users are (names and roles are needed to
-- show assignees and "changed by" in the tracker). Nobody without a profile sees anything.
create policy "profiles: app users can read all profiles"
  on recruiting.profiles
  for select
  to authenticated
  using (recruiting.current_role() is not null);

create policy "profiles: admins can add users"
  on recruiting.profiles
  for insert
  to authenticated
  with check (recruiting.current_role() = 'admin');

create policy "profiles: admins can change roles"
  on recruiting.profiles
  for update
  to authenticated
  using (recruiting.current_role() = 'admin')
  with check (recruiting.current_role() = 'admin');

create policy "profiles: admins can remove users"
  on recruiting.profiles
  for delete
  to authenticated
  using (recruiting.current_role() = 'admin');

-- Table privileges. RLS above decides which rows; these decide which verbs are possible at all.
grant select, insert, update, delete on recruiting.profiles to authenticated;
grant all on recruiting.profiles to service_role;
