-- Logins the tracker made itself (2026-11-26).
--
-- auth.users is shared with the other app on this project. The Users page gives a tracker role to
-- anyone by email, including someone who already has a login for the other app, and until now it
-- would then set a temporary password on that login: the admin was handed a working password for
-- an account the tracker never owned, and the person's password for the other app changed without
-- their knowing.
--
-- profiles.login_made_by_tracker records which logins the Edge Function recruiting-users created
-- (Add user for an address with no login). Only for those does the function set a temporary
-- password, make a sign-in link, or delete a login nobody used. Everyone else keeps the password
-- they have and resets it where they got it.
--
-- The flag is set only by the function (service role) or in the SQL Editor: a before-trigger puts
-- it back whenever a signed-in user writes the row, so an admin session cannot switch it on
-- through the Data API.

alter table recruiting.profiles
  add column login_made_by_tracker boolean not null default false;

comment on column recruiting.profiles.login_made_by_tracker is
  'True when the Edge Function recruiting-users created this login. Only then does the Users page set a temporary password, make a sign-in link or delete the unused login; a login that existed before belongs to the other app as well. Set by the function or in the SQL Editor only.';

-- Existing rows: the function makes the login and the profile in one call, so a login created in
-- the ten minutes before its profile was made by the tracker. Anything older (a login from the
-- other app, or one invited from the dashboard and given a profile by script later) stays false,
-- which is the safe side; to correct one, run in the SQL Editor:
--   update recruiting.profiles set login_made_by_tracker = true where user_id = '<id>';
update recruiting.profiles p
set login_made_by_tracker = true
from auth.users u
where u.id = p.user_id
  and u.created_at >= p.created_at - interval '10 minutes';

create or replace function recruiting.keep_login_made_by_tracker()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- auth.uid() is null for the service role and the SQL Editor, which may set the flag.
  if auth.uid() is not null then
    if tg_op = 'INSERT' then
      new.login_made_by_tracker := false;
    else
      new.login_made_by_tracker := old.login_made_by_tracker;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function recruiting.keep_login_made_by_tracker() from public;

create trigger profiles_keep_login_made_by_tracker
  before insert or update on recruiting.profiles
  for each row execute function recruiting.keep_login_made_by_tracker();
