-- Contact log: when the contact happened, and when it was logged (2026-11-19).
--
-- contacts.at used to be stamped with the moment someone clicked "Log contact", which is wrong
-- whenever the log is written after the fact (a Friday call logged on Monday, a voicemail from
-- overnight). The drawer now has a "When" field, filled in with the current time, so `at` is when
-- the contact happened. To keep a backdated entry honest, `logged_at` records when the row was
-- written; only the database sets it, and the drawer shows it when the two are more than a day
-- apart. Existing rows were logged as they happened, so they get logged_at = at.
--
-- One rule: a contact cannot be in the future (a few minutes of grace for a browser clock that
-- runs fast). Nothing else reads contacts, so no view or report changes.

alter table recruiting.contacts add column if not exists logged_at timestamptz;
update recruiting.contacts set logged_at = at where logged_at is null;
alter table recruiting.contacts alter column logged_at set default now();
alter table recruiting.contacts alter column logged_at set not null;

comment on column recruiting.contacts.at is
  'When the contact happened, as entered in the drawer (default: the moment it was logged). Never in the future.';
comment on column recruiting.contacts.logged_at is
  'When the row was written. Set by the database (trigger contacts_stamp), never by the browser.';

create or replace function recruiting.contacts_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.logged_at := now();
  else
    new.logged_at := old.logged_at;
  end if;
  if new.at > now() + interval '5 minutes' then
    raise exception 'A contact cannot be dated in the future.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function recruiting.contacts_stamp() is
  'Trigger: stamps contacts.logged_at on insert, keeps it on update, and refuses a contact dated in the future.';

revoke execute on function recruiting.contacts_stamp() from public;

drop trigger if exists contacts_stamp on recruiting.contacts;
create trigger contacts_stamp
  before insert or update on recruiting.contacts
  for each row execute function recruiting.contacts_stamp();
