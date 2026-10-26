-- Phase 7a: position aliases, the matching function the importer and the app share, a re-link
-- function for applications that have no position yet, and the past roles the data showed.
--
-- Why: applications link to a position only when position_text equals a positions row's
-- jotform_option_label for the same location. The Spanish form uses different labels
-- ("Landscape Material Blower Truck Crew Member" for the Lake Oswego blower truck crew), the CAS
-- form is free text, and the English dropdown has listed roles that have since closed, so only
-- about a third of the backfilled applications had a position. This migration:
--   * adds recruiting.position_aliases: "this text, at this location, means this position";
--   * adds recruiting.match_position(text, location): exact label, then title, then alias,
--     case-insensitive, preferring an open position and then the newest;
--   * adds recruiting.relink_applications(): sets position_id on applications that have none
--     (or on all, with p_all => true) using match_position; staff run it from the Positions page;
--   * links new applications on insert through a trigger, so the webhook (Phase 5) gets the
--     same matching without knowing about aliases;
--   * links applications the moment an alias is added, through a trigger on position_aliases;
--   * seeds closed positions for the roles that appeared many times in the data with no
--     positions row (they were on the dropdowns before docs/positions-seed.csv was written),
--     and aliases for the Spanish dropdown labels that clearly name an existing position.
--
-- Access rules (CLAUDE.md section 7): anyone with a profile can read aliases (the Positions page
-- shows them to managers read-only); admin and hr write them. Nothing here touches personal
-- information.

-- ---------------------------------------------------------------------------------------------
-- position_aliases
-- ---------------------------------------------------------------------------------------------

create table recruiting.position_aliases (
  id          uuid primary key default gen_random_uuid(),
  position_id uuid not null references recruiting.positions (id) on delete cascade,
  alias       text not null check (length(btrim(alias)) > 0),
  location    text not null check (length(btrim(location)) > 0),
  note        text,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

comment on table recruiting.position_aliases is
  'Other texts an applicant may have chosen or typed for a position at a location: Spanish '
  'dropdown labels, old dropdown labels, CAS free text. match_position() and the applications '
  'insert trigger use them; adding one re-links unmatched applications at once.';
comment on column recruiting.position_aliases.location is
  'The applications.location the alias applies to (Eugene/Springfield, Central Oregon, Lake '
  'Oswego, CAS). The same text can mean different positions at different locations.';

-- Unique per location, ignoring case and surrounding whitespace.
create unique index position_aliases_alias_location_key
  on recruiting.position_aliases (lower(btrim(alias)), location);
create index position_aliases_position_idx on recruiting.position_aliases (position_id);

alter table recruiting.position_aliases enable row level security;

create policy "position_aliases: app users can read aliases"
  on recruiting.position_aliases for select to authenticated
  using (recruiting.current_role() is not null);

create policy "position_aliases: staff can add aliases"
  on recruiting.position_aliases for insert to authenticated
  with check (recruiting.is_staff());

create policy "position_aliases: staff can change aliases"
  on recruiting.position_aliases for update to authenticated
  using (recruiting.is_staff())
  with check (recruiting.is_staff());

create policy "position_aliases: staff can remove aliases"
  on recruiting.position_aliases for delete to authenticated
  using (recruiting.is_staff());

grant select, insert, update, delete on recruiting.position_aliases to authenticated;
grant all on recruiting.position_aliases to service_role;

-- ---------------------------------------------------------------------------------------------
-- match_position(text, location): the one place matching rules live
-- ---------------------------------------------------------------------------------------------

create or replace function recruiting.match_position(p_text text, p_location text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  with want as (
    select lower(btrim(p_text)) as key, btrim(p_location) as loc
  )
  select x.id
  from (
    select p.id, 1 as rank, (p.status = 'open') as is_open, p.created_at
    from recruiting.positions p, want
    where p.location = want.loc
      and lower(btrim(coalesce(p.jotform_option_label, ''))) = want.key
    union all
    select p.id, 2, (p.status = 'open'), p.created_at
    from recruiting.positions p, want
    where p.location = want.loc
      and lower(btrim(p.title)) = want.key
    union all
    select p.id, 3, (p.status = 'open'), p.created_at
    from recruiting.position_aliases al
    join recruiting.positions p on p.id = al.position_id, want
    where al.location = want.loc
      and lower(btrim(al.alias)) = want.key
  ) x
  where length(coalesce((select key from want), '')) > 0
  order by x.rank, x.is_open desc, x.created_at desc
  limit 1;
$$;

comment on function recruiting.match_position(text, text) is
  'Position for an applicant''s position text at a location: exact dropdown label, then title, '
  'then alias, all case-insensitive; an open position beats a closed one, then the newest. Null '
  'when nothing matches. security definer so the insert trigger and the backfill agree even '
  'when the caller cannot read positions.';

revoke execute on function recruiting.match_position(text, text) from public;
grant execute on function recruiting.match_position(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- relink_applications(): staff action from the Positions page, or `select
-- recruiting.relink_applications();` in the SQL editor. Runs as the caller, so RLS decides which
-- rows it may change (staff: all; manager or no profile: none).
-- ---------------------------------------------------------------------------------------------

create or replace function recruiting.relink_applications(p_all boolean default false)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  n integer;
begin
  if recruiting.current_role() is not null and not recruiting.is_staff() then
    raise exception 'only admin and hr can re-link applications' using errcode = 'insufficient_privilege';
  end if;
  with cand as (
    select a.id, recruiting.match_position(a.position_text, a.location) as pid
    from recruiting.applications a
    where a.position_text is not null
      and a.location is not null
      and (p_all or a.position_id is null)
  )
  update recruiting.applications a
  set position_id = cand.pid
  from cand
  where cand.id = a.id
    and cand.pid is not null
    and cand.pid is distinct from a.position_id;
  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function recruiting.relink_applications(boolean) is
  'Set position_id on applications that have none (p_all => true: recompute every row) using '
  'match_position(). Returns how many rows changed. Never clears a position.';

revoke execute on function recruiting.relink_applications(boolean) from public;
grant execute on function recruiting.relink_applications(boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Triggers: match on application insert; re-link when an alias is added
-- ---------------------------------------------------------------------------------------------

create or replace function recruiting.link_application_position()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.position_id is null then
    new.position_id := recruiting.match_position(new.position_text, new.location);
  end if;
  return new;
end;
$$;

comment on function recruiting.link_application_position() is
  'Before insert on applications: when the importer left position_id null, try match_position().';

revoke execute on function recruiting.link_application_position() from public;

create trigger applications_link_position
  before insert on recruiting.applications
  for each row execute function recruiting.link_application_position();

create or replace function recruiting.apply_position_alias()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update recruiting.applications a
  set position_id = new.position_id
  where a.position_id is null
    and a.location = new.location
    and lower(btrim(a.position_text)) = lower(btrim(new.alias));
  return new;
end;
$$;

comment on function recruiting.apply_position_alias() is
  'After insert on position_aliases: link every unmatched application whose text and location '
  'the new alias covers. security definer so the update is not limited by the caller''s policies '
  '(only staff can insert an alias in the first place).';

revoke execute on function recruiting.apply_position_alias() from public;

create trigger position_aliases_apply
  after insert on recruiting.position_aliases
  for each row execute function recruiting.apply_position_alias();

-- ---------------------------------------------------------------------------------------------
-- Seed: past roles seen in the backfilled data (2026-10-26) with no positions row. Each text
-- appeared at least ten times as an identical dropdown value, so it was a real option on the form
-- at the time. They are closed, with unknown dates, so applicants-per-position and the funnel
-- include them; staff fill in dates, department and manager later. jotform_option_label keeps the
-- text the applicants saw, which is what match_position() checks first.
-- ---------------------------------------------------------------------------------------------

insert into recruiting.positions (title, location, status, jotform_option_label)
select v.title, v.location, 'closed', v.title
from (values
  ('Retail Yard Associate',                        'Eugene/Springfield'),
  ('Marketing and Content Creator',                'Eugene/Springfield'),
  ('Residential Landscape Construction Crew Member','Eugene/Springfield'),
  ('Landscape Construction Crew Member',           'Eugene/Springfield'),
  ('Accounting and Finance Manager',               'Eugene/Springfield'),
  ('Construction Project Coordinator',             'Eugene/Springfield'),
  ('Commercial Landscape Maintenance Supervisor',  'Eugene/Springfield'),
  ('CDL B Truck Driver',                           'Lake Oswego'),
  ('Operations and Sales Supervisor',              'Lake Oswego'),
  ('Office Administrator',                         'Central Oregon')
) as v(title, location)
where not exists (
  select 1 from recruiting.positions p where p.title = v.title and p.location = v.location
);

-- Aliases: Spanish-form dropdown labels (form 232824275836160) that name an existing position
-- under different words, plus one common misspelling. The Spanish Central Oregon labels equal
-- the English ones and need nothing. Labels whose meaning is not obvious ("Landscape
-- Residential Construction Project Lead", "Experienced Irrigation Lead") are left for staff to
-- decide on the Positions page.
insert into recruiting.position_aliases (position_id, alias, location, note)
select p.id, v.alias, v.location, v.note
from (values
  ('Landscape Maintenance Crew Member',   'Eugene/Springfield', 'Landscape Maintenance Crew',                     'Spanish form label'),
  ('Landscape Maintenance Crew Leader',   'Eugene/Springfield', 'Landscape Maintenance Lead',                     'Spanish form label'),
  ('Commercial Landcape Project Lead',    'Eugene/Springfield', 'Landscape Commercial Construction Project Lead', 'Spanish form label'),
  ('Commercial Landcape Project Lead',    'Eugene/Springfield', 'Commercial Landscape Project Lead',              'Spelling of the English label'),
  ('Landscape Construction Crew Member',  'Eugene/Springfield', 'Landscape Construction Crew',                    'Spanish form label'),
  ('Landscape Construction Crew Member',  'Eugene/Springfield', 'Skilled Landscape Construction Crew Member',     'Spanish form label'),
  ('Retail Yard Associate',               'Eugene/Springfield', 'Retail Yard Associate / Delivery Driver',        'Spanish form label'),
  ('Blower Truck Crew Member',            'Lake Oswego',        'Landscape Material Blower Truck Crew Member',    'Spanish form label'),
  ('Blower Truck Operator',               'Lake Oswego',        'Blower Truck Driver',                            'Spanish form label')
) as v(title, location, alias, note)
join recruiting.positions p on p.title = v.title and p.location = v.location
where not exists (
  select 1 from recruiting.position_aliases al
  where lower(btrim(al.alias)) = lower(btrim(v.alias)) and al.location = v.location
);

-- Link what the new positions and aliases cover. On the hosted project this runs before the
-- backfill and changes nothing; the insert trigger handles the rows as they arrive.
select recruiting.relink_applications();
