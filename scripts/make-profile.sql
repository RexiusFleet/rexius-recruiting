-- Give an existing auth user a role in the recruiting app (Phase 8: inviting HR and managers).
--
-- The auth user must already exist: Dashboard -> Authentication -> Users -> Invite user (sends
-- the email) or Add user. Run this in Dashboard -> SQL Editor after changing the three values on
-- the first `select` line. the third value is one of admin, hr, manager. Re-running for the same email
-- updates the role and name; it never creates a second row. scripts/make-admin.sql is the same
-- with the role fixed to admin.

with target as (
  select 'person@rexius.com'::text as email, 'Their Name'::text as name, 'manager'::recruiting.user_role as new_role
)
insert into recruiting.profiles (user_id, role, name)
select u.id, t.new_role, t.name
from target t
join auth.users u on lower(u.email) = lower(t.email)
on conflict (user_id) do update
  set role = excluded.role,
      name = excluded.name
returning user_id, role, name, created_at;

-- Zero rows returned: no auth user has that email. Invite or add the user first, then re-run.
