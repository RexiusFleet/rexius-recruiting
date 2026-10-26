-- Give an existing auth user the admin role in the recruiting app.
--
-- Use when there is no admin yet (first user) or when the app's own user management is not
-- reachable. The auth user must already exist: Dashboard -> Authentication -> Users -> Add user
-- (tick "Auto Confirm User"), or an invite.
--
-- Run in Dashboard -> SQL Editor, replacing the two values in the first line, or from the repo
-- root with the same connection as the migration runner:
--
--   npm run db:make-admin -- you@rexius.com "Your Name"
--
-- Re-running for a user who already has a profile changes their role to admin and updates the
-- name; it never creates a second row.

with target as (
  select 'you@rexius.com'::text as email, 'Your Name'::text as name
)
insert into recruiting.profiles (user_id, role, name)
select u.id, 'admin', t.name
from target t
join auth.users u on lower(u.email) = lower(t.email)
on conflict (user_id) do update
  set role = excluded.role,
      name = excluded.name
returning user_id, role, name, created_at;

-- If this returns zero rows, no auth user has that email. Create the user first.
