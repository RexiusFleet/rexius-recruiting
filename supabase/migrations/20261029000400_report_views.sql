-- Phase 7d: reporting views. One view per report on the Reports page, all named report_*,
-- all filtered with recruiting.is_staff() so a manager (or anyone without a profile) gets no
-- rows; CLAUDE.md section 7 gives managers no reporting access. Like applications_for_managers
-- they run with the owner's privileges and are marked security_barrier, so the `where` clause
-- is the access check.
--
-- Definitions shared by the views:
--   * "reached a stage": the application's status_history has a row for that stage or a later
--     one, counting only non-terminal stages plus Hired (so Not selected and Withdrawn never
--     count as progress). Someone interviewed and then not selected reached Interview.
--   * "hired": the current stage has is_hired. Fixing a mis-click un-hires them.
--   * channel of an application: recruiting.source_channel(source) maps the form's "how did you
--     hear about us" answers onto the posting channels (Indeed.com -> indeed, Rexius.com ->
--     rexius_com, Craigslist.com -> craigslist, Google -> google_ads, Referral -> referral,
--     everything else -> other), so hand-entered spend per channel can be divided by applicants
--     and hires from that channel.
--   * spend lands in the month of channel_spend.period_start.
-- Nothing here exposes notes, raw answers, wages or any other restricted column; the views
-- return counts, sums and dates only.

-- ---------------------------------------------------------------------------------------------
-- source_channel(): form answer -> posting channel
-- ---------------------------------------------------------------------------------------------

create or replace function recruiting.source_channel(p_source text)
returns recruiting.posting_channel
language sql
immutable
set search_path = ''
as $$
  select case
    when p_source is null then 'other'
    when lower(p_source) like 'indeed%'     then 'indeed'
    when lower(p_source) like 'rexius%'     then 'rexius_com'
    when lower(p_source) like 'craigslist%' then 'craigslist'
    when lower(p_source) like 'google%'     then 'google_ads'
    when lower(p_source) like 'refer%'      then 'referral'
    else 'other'
  end::recruiting.posting_channel;
$$;

comment on function recruiting.source_channel(text) is
  'Maps an application''s source answer to a posting channel for cost-per-applicant reporting. '
  'Unknown sources (Facebook, Walk In, Other, blank) are channel ''other''.';

revoke execute on function recruiting.source_channel(text) from public;
grant execute on function recruiting.source_channel(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- report_applications_by_source_stage
-- ---------------------------------------------------------------------------------------------

create view recruiting.report_applications_by_source_stage
with (security_barrier = true)
as
select
  coalesce(nullif(btrim(a.source), ''), '(blank)') as source,
  recruiting.source_channel(a.source)              as channel,
  s.id                                             as stage_id,
  s.name                                           as stage_name,
  s.sort_order,
  count(*)::integer                                as applications
from recruiting.applications a
join recruiting.application_status st on st.application_id = a.id
join recruiting.stages s on s.id = st.stage_id
where recruiting.is_staff()
group by 1, 2, 3, 4, 5;

comment on view recruiting.report_applications_by_source_stage is
  'Applications per source (as answered on the form) and current stage. Staff only.';

grant select on recruiting.report_applications_by_source_stage to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- report_time_in_stage
-- ---------------------------------------------------------------------------------------------

create view recruiting.report_time_in_stage
with (security_barrier = true)
as
with visits as (
  select
    h.application_id,
    h.to_stage_id as stage_id,
    h.changed_at  as entered_at,
    lead(h.changed_at) over (partition by h.application_id order by h.changed_at, h.id) as left_at
  from recruiting.status_history h
)
select
  s.id         as stage_id,
  s.name       as stage_name,
  s.sort_order,
  s.is_terminal,
  count(v.application_id) filter (where v.left_at is not null)::integer as completed_visits,
  round((avg(extract(epoch from (v.left_at - v.entered_at)) / 86400)
         filter (where v.left_at is not null))::numeric, 1)             as avg_days,
  round((percentile_cont(0.5) within group (order by extract(epoch from (v.left_at - v.entered_at)) / 86400)
         filter (where v.left_at is not null))::numeric, 1)             as median_days,
  count(v.application_id) filter (where v.left_at is null)::integer     as currently_in_stage,
  round((avg(extract(epoch from (now() - v.entered_at)) / 86400)
         filter (where v.left_at is null))::numeric, 1)                 as avg_days_so_far
from recruiting.stages s
left join visits v on v.stage_id = s.id
where recruiting.is_staff()
group by s.id, s.name, s.sort_order, s.is_terminal;

comment on view recruiting.report_time_in_stage is
  'Per stage: how many applications have left it and how long they stayed (average and median '
  'days), plus how many are in it now and for how long so far. From status_history. Staff only.';

grant select on recruiting.report_time_in_stage to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- report_spend_by_channel_month
-- ---------------------------------------------------------------------------------------------

create view recruiting.report_spend_by_channel_month
with (security_barrier = true)
as
select
  p.channel,
  date_trunc('month', cs.period_start)::date as month,
  count(distinct p.position_id)::integer     as positions,
  count(distinct cs.posting_id)::integer     as postings,
  sum(cs.spend)                              as spend,
  sum(cs.views)::integer                     as views,
  sum(cs.applies)::integer                   as applies
from recruiting.channel_spend cs
join recruiting.postings p on p.id = cs.posting_id
where recruiting.is_staff()
group by 1, 2;

comment on view recruiting.report_spend_by_channel_month is
  'Hand-entered spend, views and applies per channel per month (month of period_start). Staff only.';

grant select on recruiting.report_spend_by_channel_month to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- report_position_funnel: long format, one row per position x source x stage with the number of
-- applications that reached that stage. The page pivots it by position and by source.
-- ---------------------------------------------------------------------------------------------

create view recruiting.report_position_funnel
with (security_barrier = true)
as
with reached as (
  select
    h.application_id,
    max(s.sort_order)  as max_sort_order,
    bool_or(s.is_hired) as hired
  from recruiting.status_history h
  join recruiting.stages s on s.id = h.to_stage_id
  where not s.is_terminal or s.is_hired
  group by h.application_id
)
select
  a.position_id,
  p.title                                          as position_title,
  coalesce(p.location, a.location, '(blank)')      as location,
  p.status                                         as position_status,
  coalesce(nullif(btrim(a.source), ''), '(blank)') as source,
  recruiting.source_channel(a.source)              as channel,
  s.id                                             as stage_id,
  s.name                                           as stage_name,
  s.sort_order,
  count(*) filter (
    where (s.is_hired and r.hired)
       or (not s.is_terminal and r.max_sort_order >= s.sort_order)
  )::integer                                       as applications
from recruiting.applications a
left join recruiting.positions p on p.id = a.position_id
join reached r on r.application_id = a.id
cross join recruiting.stages s
where recruiting.is_staff()
  and (not s.is_terminal or s.is_hired)
group by 1, 2, 3, 4, 5, 6, 7, 8, 9;

comment on view recruiting.report_position_funnel is
  'How many applications per position and source reached each pipeline stage (Applied, '
  'Reviewed, Sent to manager, Interview, Offer, Hired; Not selected and Withdrawn are not '
  'progress). position_id is null for applications no position matched. Staff only.';

grant select on recruiting.report_position_funnel to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- report_cost_by_channel
-- ---------------------------------------------------------------------------------------------

create view recruiting.report_cost_by_channel
with (security_barrier = true)
as
with spend as (
  select p.channel, sum(cs.spend) as spend, sum(cs.views) as views, sum(cs.applies) as reported_applies,
         min(cs.period_start) as first_period, max(cs.period_end) as last_period
  from recruiting.channel_spend cs
  join recruiting.postings p on p.id = cs.posting_id
  group by p.channel
),
apps as (
  select recruiting.source_channel(a.source) as channel,
         count(*)::integer                       as applicants,
         count(*) filter (where s.is_hired)::integer as hires
  from recruiting.applications a
  join recruiting.application_status st on st.application_id = a.id
  join recruiting.stages s on s.id = st.stage_id
  group by 1
)
select
  c.channel,
  coalesce(sp.spend, 0)                                          as spend,
  sp.first_period,
  sp.last_period,
  sp.views,
  sp.reported_applies,
  coalesce(ap.applicants, 0)                                     as applicants,
  coalesce(ap.hires, 0)                                          as hires,
  case when coalesce(ap.applicants, 0) > 0 and sp.spend is not null
       then round(sp.spend / ap.applicants, 2) end                as cost_per_applicant,
  case when coalesce(ap.hires, 0) > 0 and sp.spend is not null
       then round(sp.spend / ap.hires, 2) end                     as cost_per_hire
from unnest(enum_range(null::recruiting.posting_channel)) as c(channel)
left join spend sp on sp.channel = c.channel
left join apps  ap on ap.channel = c.channel
where recruiting.is_staff();

comment on view recruiting.report_cost_by_channel is
  'Per channel: total hand-entered spend, applicants whose source maps to the channel, hires '
  'among them, and spend divided by each. Spend is only ever typed in, so a channel with no '
  'spend rows shows null costs. Staff only.';

grant select on recruiting.report_cost_by_channel to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- report_offer_acceptance
-- ---------------------------------------------------------------------------------------------

create view recruiting.report_offer_acceptance
with (security_barrier = true)
as
select
  o.position_id,
  p.title                                                   as position_title,
  p.location,
  count(*)::integer                                         as offers,
  count(*) filter (where o.outcome = 'accepted')::integer   as accepted,
  count(*) filter (where o.outcome = 'declined')::integer   as declined,
  count(*) filter (where o.outcome = 'withdrawn')::integer  as withdrawn,
  count(*) filter (where o.outcome = 'pending')::integer    as pending,
  round(100.0 * count(*) filter (where o.outcome = 'accepted')
        / nullif(count(*) filter (where o.outcome in ('accepted', 'declined')), 0), 1) as acceptance_pct,
  round(avg(o.responded_at - o.offered_at) filter (where o.responded_at is not null)::numeric, 1) as avg_days_to_respond,
  min(o.offered_at)                                         as first_offer,
  max(o.offered_at)                                         as last_offer
from recruiting.offers o
left join recruiting.positions p on p.id = o.position_id
where recruiting.is_staff()
group by 1, 2, 3;

comment on view recruiting.report_offer_acceptance is
  'Offers per position by outcome, acceptance rate (accepted over accepted plus declined) and '
  'average days to respond. No wages exist to report. Staff only.';

grant select on recruiting.report_offer_acceptance to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- report_time_to_fill
-- ---------------------------------------------------------------------------------------------

create view recruiting.report_time_to_fill
with (security_barrier = true)
as
with hires as (
  select a.position_id,
         min(h.changed_at)::date as first_hired_at,
         count(distinct h.application_id)::integer as hires
  from recruiting.status_history h
  join recruiting.stages s on s.id = h.to_stage_id and s.is_hired
  join recruiting.applications a on a.id = h.application_id
  where a.position_id is not null
  group by a.position_id
),
apps as (
  select position_id, count(*)::integer as applicants, min(submitted_at)::date as first_application
  from recruiting.applications
  where position_id is not null
  group by position_id
)
select
  p.id                                   as position_id,
  p.title,
  p.location,
  p.status,
  p.opened_at,
  p.closed_at,
  coalesce(ap.applicants, 0)             as applicants,
  coalesce(hi.hires, 0)                  as hires,
  hi.first_hired_at,
  case when p.opened_at is not null and hi.first_hired_at is not null
       then hi.first_hired_at - p.opened_at end                        as days_to_first_hire,
  case when p.opened_at is not null and p.closed_at is not null
       then p.closed_at - p.opened_at end                              as days_open,
  case when p.opened_at is not null and p.closed_at is null and p.status = 'open'
       then current_date - p.opened_at end                             as days_open_so_far,
  fb.name                                as filled_by
from recruiting.positions p
left join apps  ap on ap.position_id = p.id
left join hires hi on hi.position_id = p.id
left join recruiting.applications fb on fb.id = p.filled_by_application_id
where recruiting.is_staff();

comment on view recruiting.report_time_to_fill is
  'Per position: opened and closed dates, days open, days from opening to the first hire, '
  'applicants, hires and who filled it. Staff only.';

grant select on recruiting.report_time_to_fill to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- report_seasonality
-- ---------------------------------------------------------------------------------------------

create view recruiting.report_seasonality
with (security_barrier = true)
as
select
  date_trunc('month', a.submitted_at)::date as month,
  coalesce(a.location, '(blank)')           as location,
  count(*)::integer                         as applications,
  count(*) filter (where s.is_hired)::integer as hired
from recruiting.applications a
join recruiting.application_status st on st.application_id = a.id
join recruiting.stages s on s.id = st.stage_id
where recruiting.is_staff()
group by 1, 2;

comment on view recruiting.report_seasonality is
  'Applications (and hires among them) per month per location. Staff only.';

grant select on recruiting.report_seasonality to authenticated, service_role;
