-- Users page (2026-11-10): admins invite, change and remove tracker users from the app instead of
-- the Supabase dashboard and the SQL Editor. The page works through the Edge Function
-- recruiting-users (service role, admin-only), and profiles keeps its Phase 2 policies.
--
-- One rule belongs in the database rather than in the page or the function, so it holds for the
-- SQL Editor, the dashboard's "Delete user" (which cascades to profiles) and any later code too:
-- the tracker always keeps at least one admin. Without one, nobody could invite or restore anyone
-- and the only way back would be SQL by an organization member.

create or replace function recruiting.keep_one_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role <> 'admin' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' and new.role = 'admin' then
    return new;
  end if;
  -- Two admins demoting each other at the same moment must not both succeed.
  perform pg_advisory_xact_lock(hashtext('recruiting.profiles.last_admin'));
  if not exists (
    select 1 from recruiting.profiles p
    where p.role = 'admin' and p.user_id <> old.user_id
  ) then
    raise exception 'The tracker must keep at least one admin. Make someone else an admin first.'
      using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

comment on function recruiting.keep_one_admin() is
  'Trigger: refuses to delete or demote the last admin profile (Users page, 2026-11-10).';

revoke execute on function recruiting.keep_one_admin() from public;

drop trigger if exists profiles_keep_one_admin on recruiting.profiles;
create trigger profiles_keep_one_admin
  before update of role or delete on recruiting.profiles
  for each row execute function recruiting.keep_one_admin();
