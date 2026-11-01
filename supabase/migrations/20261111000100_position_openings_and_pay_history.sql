-- Reopenable positions and pay history.
--
-- Until now a position row was one opening: a role hired for again got a new row, so time to fill
-- stayed per opening. Seasonal and crew roles open and close several times a year, and a new row
-- each time split their applicants, aliases, postings, market checks and pay across rows. From
-- this migration a position is the role, kept for good, and:
--
--   * position_openings: one row per period the position was open. A trigger on positions writes
--     it when status changes, so HR keeps switching Open and Closed as before. Reopening on the
--     day it closed carries on the same opening. Staff can correct an opening's dates and note;
--     nothing else about an opening can be changed from the browser.
--   * position_pay_history: one row per change of the advertised range (pay_min, pay_max,
--     pay_unit), written by a trigger. The figures cannot be changed or deleted from the browser;
--     staff can add or edit the note saying why. Each position with a range gets a first row
--     dated now: earlier changes were never recorded.
--   * positions.opened_at, closed_at and filled_by_application_id are dropped. The openings carry
--     the dates, and hires come from the pipeline (a crew role hires several people a season).
--   * report_time_to_fill is rebuilt with one row per opening.
--
-- Access (CLAUDE.md section 7): both tables are readable by every app user, like positions
-- (managers already saw the dates and the advertised range); admin and hr change dates and notes
-- only. The range is what Rexius advertises for the role, never an individual's wage (section 5).
--
-- Dates are Oregon dates: an opening that starts at 11 pm Pacific starts that day, not the next.

-- ---------------------------------------------------------------------------------------------
-- position_openings
-- ---------------------------------------------------------------------------------------------

create table recruiting.position_openings (
  id          uuid primary key default gen_random_uuid(),
  position_id uuid not null references recruiting.positions (id) on delete cascade,
  opened_at   date not null,
  closed_at   date,
  opened_by   uuid references auth.users (id) on delete set null,
  closed_by   uuid references auth.users (id) on delete set null,
  note        text,
  created_at  timestamptz not null default now(),
  check (closed_at is null or closed_at >= opened_at)
);

comment on table recruiting.position_openings is
  'One row per period a position was open. Written by the positions status trigger; closed_at '
  'null is the current opening of an open position (at most one). Applications count towards the '
  'opening they were submitted in, up to the day the position next opened.';
comment on column recruiting.position_openings.note is
  'Free text from HR, for example "Spring crews" or "Reopened for the Bend contract".';

create unique index position_openings_one_current on recruiting.position_openings (position_id)
  where closed_at is null;
create index position_openings_position_idx on recruiting.position_openings (position_id, opened_at desc);

-- Openings of one position never overlap, a closed position has no current opening, and the
-- current opening of an open position is closed by closing the position, not by a date edit.
create or replace function recruiting.check_position_opening()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status recruiting.position_status;
begin
  select p.status into v_status from recruiting.positions p where p.id = new.position_id;
  if new.closed_at is null and v_status is distinct from 'open' then
    raise exception 'Only an open position has a current opening. Set the position to Open instead.'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and old.closed_at is null and new.closed_at is not null and v_status = 'open' then
    raise exception 'To close the current opening, set the position to Closed.'
      using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from recruiting.position_openings o
    where o.position_id = new.position_id
      and o.id <> new.id
      and daterange(o.opened_at, o.closed_at, '[]') && daterange(new.opened_at, new.closed_at, '[]'))
  then
    raise exception 'Openings of one position cannot overlap (% to %).', new.opened_at, coalesce(new.closed_at::text, 'now')
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function recruiting.check_position_opening() from public;

create trigger position_openings_check
  before insert or update on recruiting.position_openings
  for each row execute function recruiting.check_position_opening();

alter table recruiting.position_openings enable row level security;

create policy "position_openings: app users can read openings"
  on recruiting.position_openings for select to authenticated
  using (recruiting.current_role() is not null);

create policy "position_openings: staff can correct openings"
  on recruiting.position_openings for update to authenticated
  using (recruiting.is_staff())
  with check (recruiting.is_staff());

-- No insert or delete for app users: openings start and end with the position's status. Only the
-- dates and the note can be corrected.
grant select on recruiting.position_openings to authenticated;
grant update (opened_at, closed_at, note) on recruiting.position_openings to authenticated;
grant all on recruiting.position_openings to service_role;

-- ---------------------------------------------------------------------------------------------
-- position_pay_history
-- ---------------------------------------------------------------------------------------------

create table recruiting.position_pay_history (
  id          bigint generated always as identity primary key,
  position_id uuid not null references recruiting.positions (id) on delete cascade,
  pay_min     numeric(10, 2),
  pay_max     numeric(10, 2),
  pay_unit    text,
  note        text,
  changed_by  uuid references auth.users (id) on delete set null,
  changed_at  timestamptz not null default now()
);

comment on table recruiting.position_pay_history is
  'Append-only log of the advertised pay range per position: one row each time pay_min, pay_max '
  'or pay_unit changes (all null: the range was removed). Written by trigger; only the note can be '
  'edited. The advertised range for the role, never an individual''s wage.';
comment on column recruiting.position_pay_history.note is
  'Why the range changed, from HR. Editable afterwards; the figures are not.';

create index position_pay_history_position_idx on recruiting.position_pay_history (position_id, changed_at desc);

alter table recruiting.position_pay_history enable row level security;

create policy "position_pay_history: app users can read pay history"
  on recruiting.position_pay_history for select to authenticated
  using (recruiting.current_role() is not null);

create policy "position_pay_history: staff can add notes"
  on recruiting.position_pay_history for update to authenticated
  using (recruiting.is_staff())
  with check (recruiting.is_staff());

grant select on recruiting.position_pay_history to authenticated;
grant update (note) on recruiting.position_pay_history to authenticated;
grant select on recruiting.position_pay_history to service_role;

-- ---------------------------------------------------------------------------------------------
-- Triggers on positions
-- ---------------------------------------------------------------------------------------------

-- Status changes start and end openings. A position that reopens on the day its last opening
-- closed carries on that opening (a mistaken close), so no zero-length gap is recorded.
create or replace function recruiting.track_position_openings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'America/Los_Angeles')::date;
  v_last recruiting.position_openings%rowtype;
begin
  if new.status = 'open' and (tg_op = 'INSERT' or old.status <> 'open') then
    select * into v_last from recruiting.position_openings
      where position_id = new.id order by opened_at desc limit 1;
    if found and v_last.closed_at >= v_today then
      update recruiting.position_openings set closed_at = null, closed_by = null where id = v_last.id;
    else
      insert into recruiting.position_openings (position_id, opened_at, opened_by)
      values (new.id, v_today, auth.uid());
    end if;
  elsif tg_op = 'UPDATE' and old.status = 'open' and new.status <> 'open' then
    update recruiting.position_openings
      set closed_at = greatest(opened_at, v_today), closed_by = auth.uid()
      where position_id = new.id and closed_at is null;
  end if;
  return new;
end;
$$;

comment on function recruiting.track_position_openings() is
  'After insert or status change on positions: open a position_openings row when the position '
  'becomes open, close the current one when it stops being open.';

revoke execute on function recruiting.track_position_openings() from public;

create trigger positions_track_openings
  after insert or update of status on recruiting.positions
  for each row execute function recruiting.track_position_openings();

create or replace function recruiting.log_position_pay()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and (new.pay_min is not null or new.pay_max is not null))
     or (tg_op = 'UPDATE' and (new.pay_min is distinct from old.pay_min
                               or new.pay_max is distinct from old.pay_max
                               or new.pay_unit is distinct from old.pay_unit))
  then
    insert into recruiting.position_pay_history (position_id, pay_min, pay_max, pay_unit, changed_by)
    values (new.id, new.pay_min, new.pay_max, new.pay_unit, auth.uid());
  end if;
  return new;
end;
$$;

comment on function recruiting.log_position_pay() is
  'After insert or pay change on positions: append the new advertised range to position_pay_history.';

revoke execute on function recruiting.log_position_pay() from public;

create trigger positions_log_pay
  after insert or update of pay_min, pay_max, pay_unit on recruiting.positions
  for each row execute function recruiting.log_position_pay();

-- ---------------------------------------------------------------------------------------------
-- Existing positions
-- ---------------------------------------------------------------------------------------------

-- An open position's first opening starts on its Opened date, or else on the earlier of the day
-- it was added and the day its first linked application arrived (it was on the form by then).
-- A closed position with a Closed date gets one past opening ending then; a closed position with
-- no dates was never opened in the tracker and gets none.
insert into recruiting.position_openings (position_id, opened_at, closed_at)
select
  p.id,
  coalesce(p.opened_at, least((p.created_at at time zone 'America/Los_Angeles')::date, fa.first_app)),
  null
from recruiting.positions p
left join (
  select position_id, min((submitted_at at time zone 'America/Los_Angeles')::date) as first_app
  from recruiting.applications where position_id is not null group by position_id
) fa on fa.position_id = p.id
where p.status = 'open';

insert into recruiting.position_openings (position_id, opened_at, closed_at)
select
  p.id,
  least(coalesce(p.opened_at, (p.created_at at time zone 'America/Los_Angeles')::date), p.closed_at),
  p.closed_at
from recruiting.positions p
where p.status <> 'open' and p.closed_at is not null;

insert into recruiting.position_pay_history (position_id, pay_min, pay_max, pay_unit, note)
select p.id, p.pay_min, p.pay_max, p.pay_unit, 'Range when pay history started; earlier changes were not recorded.'
from recruiting.positions p
where p.pay_min is not null or p.pay_max is not null;

-- ---------------------------------------------------------------------------------------------
-- report_time_to_fill: one row per opening
-- ---------------------------------------------------------------------------------------------

drop view recruiting.report_time_to_fill;

alter table recruiting.positions
  drop column opened_at,
  drop column closed_at,
  drop column filled_by_application_id;

comment on table recruiting.positions is
  'Roles Rexius hires for, kept for good. A role that opens and closes with the seasons stays one '
  'row; each open period is a position_openings row and each change of the advertised range a '
  'position_pay_history row.';

create view recruiting.report_time_to_fill
with (security_barrier = true)
as
with o as (
  select po.*,
         lead(po.opened_at) over (partition by po.position_id order by po.opened_at) as next_opened_at
  from recruiting.position_openings po
),
apps as (
  select o.id as opening_id, a.id as application_id
  from o
  join recruiting.applications a on a.position_id = o.position_id
  where (a.submitted_at at time zone 'America/Los_Angeles')::date >= o.opened_at
    and (o.next_opened_at is null or (a.submitted_at at time zone 'America/Los_Angeles')::date < o.next_opened_at)
),
hires as (
  select ap.opening_id,
         count(distinct h.application_id)::integer as hires,
         min((h.changed_at at time zone 'America/Los_Angeles')::date) as first_hired_at
  from apps ap
  join recruiting.status_history h on h.application_id = ap.application_id
  join recruiting.stages s on s.id = h.to_stage_id and s.is_hired
  group by ap.opening_id
),
counts as (
  select opening_id, count(*)::integer as applicants from apps group by opening_id
)
select
  o.id                                   as opening_id,
  p.id                                   as position_id,
  p.title,
  p.location,
  p.status,
  o.opened_at,
  o.closed_at,
  o.note,
  coalesce(c.applicants, 0)              as applicants,
  coalesce(hi.hires, 0)                  as hires,
  hi.first_hired_at,
  hi.first_hired_at - o.opened_at        as days_to_first_hire,
  o.closed_at - o.opened_at              as days_open,
  case when o.closed_at is null
       then (now() at time zone 'America/Los_Angeles')::date - o.opened_at end as days_open_so_far
from o
join recruiting.positions p on p.id = o.position_id
left join counts c  on c.opening_id = o.id
left join hires  hi on hi.opening_id = o.id
where recruiting.is_staff();

comment on view recruiting.report_time_to_fill is
  'One row per opening: opened and closed dates, days open, applicants who applied from the day it '
  'opened until the position next opened, how many of them reached Hired (whenever that was) and '
  'days from opening to the first such hire. Staff only.';

grant select on recruiting.report_time_to_fill to authenticated, service_role;
