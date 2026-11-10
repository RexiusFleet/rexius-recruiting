-- Positions follow the rexius.com careers page (2026-11-10).
--
-- Until now the tracker's positions and the job pages on https://rexius.com/blogs/careers were
-- kept in step by hand: HR published or took down a page, then had to open or close the
-- position here and retype the pay range. A daily job now reads the careers page's feed
-- (Edge Function recruiting-careers-sync) and:
--
--   * closes a position when its last live job page is taken down, and opens it when a page is
--     published for it. Only on that change: a position staff opened or closed by hand is left
--     alone until the site changes again, and a position that never had a page is never touched.
--   * copies the page's "Pay:" line into the position's advertised range when the line changes
--     and can be read with confidence (position_pay_history gets the usual row, with a note
--     quoting the page).
--   * keeps one open rexius.com posting row per live page, and ends it when the page goes.
--   * flags what it will not decide: a new page it cannot tie to a position, a pay line it
--     cannot read, a page missing from the feed that still answers.
--
-- A page is "gone" only when it is missing from the feed and its own address answers 404 or 410,
-- and a feed that is empty or lists under half the known pages changes nothing. The rules live
-- in supabase/functions/_shared/careers.mjs, with tests (npm run careers:test).
--
-- Nothing here holds applicant data: these are the public job pages and the tracker's positions.
--
-- The pieces:
--   * careers_pages: one row per job page ever seen, tied to a position by position_id. Seeded
--     from the rexius.com posting rows, which already hold each page's address.
--   * careers_sync_runs: one row per run with what it changed and what it flagged.
--   * request_careers_sync(): pg_cron -> pg_net -> the function, with the URL and shared secret
--     the market-check jobs keep in the vault. Daily at 14:15 UTC (early morning in Oregon).
--   * service_role may now write the note on a pay-history row (the sync says where a range
--     came from).

-- ---------------------------------------------------------------------------------------------
-- careers_pages
-- ---------------------------------------------------------------------------------------------

create table recruiting.careers_pages (
  id               uuid primary key default gen_random_uuid(),
  url              text not null unique
                   check (url ~ '^https://rexius\.com/blogs/careers/[a-z0-9][a-z0-9-]*$'),
  title            text,
  tags             text[] not null default '{}',
  location         text,
  job_type         text,
  pay_text         text,
  pay_min          numeric(10, 2),
  pay_max          numeric(10, 2),
  pay_unit         text check (pay_unit is null or pay_unit in ('hour', 'year')),
  pay_problem      text,
  pay_applied_text text,
  published_at     timestamptz,
  site_updated_at  timestamptz,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz,
  gone_at          timestamptz,
  position_id      uuid references recruiting.positions (id) on delete set null,
  link_source      text check (link_source is null or link_source in ('posting', 'title', 'staff')),
  linked_by        uuid references auth.users (id) on delete set null,
  ignored          boolean not null default false
);

comment on table recruiting.careers_pages is
  'One row per job page on rexius.com/blogs/careers the sync has seen. position_id ties it to a '
  'position (set by the sync through a posting row or an exact title, or by staff); gone_at is '
  'set once the page left the feed and answered 404. Written by the recruiting-careers-sync Edge '
  'Function; staff change only position_id and ignored.';
comment on column recruiting.careers_pages.pay_text is 'The page''s "Pay:" line as written.';
comment on column recruiting.careers_pages.pay_problem is 'Why pay_text could not be read into a range; null when it was read or there is no pay line.';
comment on column recruiting.careers_pages.pay_applied_text is
  'The pay_text the sync last carried to the position (or found already matching). The range is '
  'applied again only when pay_text differs from this, so a range staff edit by hand stays until '
  'the page changes.';
comment on column recruiting.careers_pages.ignored is
  'True for a page that is not a job (the General Application page) or that staff dismissed: never linked, flagged or counted.';

create index careers_pages_position_idx on recruiting.careers_pages (position_id) where position_id is not null;

-- A link made or removed in the browser is staff's: record who, and let the next run carry the
-- page's pay line to the newly linked position.
create or replace function recruiting.careers_page_linked()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.position_id is distinct from old.position_id and auth.uid() is not null then
    new.link_source := case when new.position_id is null then null else 'staff' end;
    new.linked_by := case when new.position_id is null then null else auth.uid() end;
    new.pay_applied_text := null;
  end if;
  return new;
end;
$$;
revoke execute on function recruiting.careers_page_linked() from public;

create trigger careers_pages_linked
  before update of position_id on recruiting.careers_pages
  for each row execute function recruiting.careers_page_linked();

alter table recruiting.careers_pages enable row level security;

create policy "careers_pages: app users can read pages"
  on recruiting.careers_pages for select to authenticated
  using (recruiting.current_role() is not null);

create policy "careers_pages: staff can link and ignore pages"
  on recruiting.careers_pages for update to authenticated
  using (recruiting.is_staff())
  with check (recruiting.is_staff());

-- No insert or delete for app users, and only two columns to change.
grant select on recruiting.careers_pages to authenticated;
grant update (position_id, ignored) on recruiting.careers_pages to authenticated;
grant all on recruiting.careers_pages to service_role;

-- ---------------------------------------------------------------------------------------------
-- careers_sync_runs
-- ---------------------------------------------------------------------------------------------

create table recruiting.careers_sync_runs (
  id           bigint generated always as identity primary key,
  ran_at       timestamptz not null default now(),
  trigger      text not null check (trigger in ('schedule', 'manual')),
  requested_by uuid references auth.users (id) on delete set null,
  ok           boolean not null,
  pages_listed integer,
  changes      jsonb not null default '[]'::jsonb,
  flags        jsonb not null default '[]'::jsonb,
  error        text
);

comment on table recruiting.careers_sync_runs is
  'One row per run of the careers page sync: what it changed (changes), what staff should look '
  'at (flags), or why it changed nothing (ok false, error). Written only by the Edge Function.';

create index careers_sync_runs_ran_idx on recruiting.careers_sync_runs (ran_at desc);

alter table recruiting.careers_sync_runs enable row level security;

create policy "careers_sync_runs: app users can read runs"
  on recruiting.careers_sync_runs for select to authenticated
  using (recruiting.current_role() is not null);

grant select on recruiting.careers_sync_runs to authenticated;
grant all on recruiting.careers_sync_runs to service_role;

-- The sync notes where a range came from.
grant update (note) on recruiting.position_pay_history to service_role;

-- ---------------------------------------------------------------------------------------------
-- Existing pages: every rexius.com posting row already names its job page
-- ---------------------------------------------------------------------------------------------

insert into recruiting.careers_pages (url, position_id, link_source, gone_at)
select distinct on (u.url) u.url, po.position_id, 'posting', po.ended_at::timestamptz
from recruiting.postings po
cross join lateral (
  select 'https://rexius.com/blogs/careers/' || lower(substring(po.url from '(?i)^https?://(?:www\.)?rexius\.com/blogs/careers/([a-z0-9][a-z0-9-]*)/?(?:[?#].*)?$')) as url
) u
where po.channel = 'rexius_com' and u.url is not null and u.url <> 'https://rexius.com/blogs/careers/tagged'
order by u.url, (po.ended_at is null) desc, po.posted_at desc;

-- The General Application page is on the careers blog but is not a job.
insert into recruiting.careers_pages (url, title, ignored)
values ('https://rexius.com/blogs/careers/all-positions', 'General Application', true)
on conflict (url) do update set ignored = true, position_id = null, link_source = null;

-- ---------------------------------------------------------------------------------------------
-- The daily job
-- ---------------------------------------------------------------------------------------------

create or replace function recruiting.request_careers_sync()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_request_id bigint;
begin
  select replace(decrypted_secret, 'recruiting-market-check', 'recruiting-careers-sync') into v_url
    from vault.decrypted_secrets where name = 'recruiting_market_check_url' limit 1;
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'recruiting_market_check_secret' limit 1;
  if v_url is null or v_secret is null then
    raise warning 'recruiting.request_careers_sync: vault secrets recruiting_market_check_url / recruiting_market_check_secret are not set; careers page not checked';
    return null;
  end if;
  select net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('content-type', 'application/json', 'x-market-check-secret', v_secret),
    timeout_milliseconds := 15000
  ) into v_request_id;
  return v_request_id;
end;
$$;
comment on function recruiting.request_careers_sync() is
  'Asks the recruiting-careers-sync Edge Function to compare the rexius.com careers page with the positions (daily pg_cron job). Returns the pg_net request id, or null when the vault is not set up.';
revoke all on function recruiting.request_careers_sync() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'recruiting-careers-sync';
  perform cron.schedule('recruiting-careers-sync', '15 14 * * *', 'select recruiting.request_careers_sync()');
end $$;
