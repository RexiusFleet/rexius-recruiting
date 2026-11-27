-- Review follow-ups (2026-11-27): the third batch from the project review.
--
--   1. keep_lead_fields: two edge cases in the good-lead trigger.
--   2. postings.url: a web address or nothing.
--   3. Three trigger functions lose the default execute grant.

-- ---------------------------------------------------------------------------------------------
-- 1. keep_lead_fields
-- ---------------------------------------------------------------------------------------------
-- (a) The twelve-month cap was checked on every update of a flagged row, also when the keep-until
--     date had not been touched. If the application's submitted time later moved earlier (the
--     Eastern-time correction did this), the stored date was past the cap, and every stage change
--     or note on that application failed with the twelve-month message. An untouched date is now
--     brought back to the cap instead; a date someone sets past the cap is still refused.
-- (b) lead_flagged_by was always put back to its old value. When the user who set the flag is
--     deleted, the foreign key sets the column to null, and the trigger undid that, leaving a
--     reference to a user who no longer exists. The old value is now kept only against a signed-in
--     user's edit; auth.uid() is null for the foreign-key action run by the auth service.

create or replace function recruiting.keep_lead_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_submitted timestamptz;
  v_today date := (now() at time zone 'America/Los_Angeles')::date;
  v_cap date;
  v_new_flag boolean;
  v_date_set boolean;
begin
  if not new.is_lead then
    new.lead_reason := null; new.lead_revisit_on := null; new.lead_keep_until := null;
    new.lead_flagged_by := null; new.lead_flagged_at := null;
    return new;
  end if;

  new.lead_reason := nullif(btrim(new.lead_reason), '');
  if new.lead_reason is null then
    raise exception 'a good lead needs a reason' using errcode = 'check_violation';
  end if;

  select a.submitted_at into v_submitted from recruiting.applications a where a.id = new.application_id;
  v_cap := ((v_submitted at time zone 'America/Los_Angeles')::date + interval '12 months')::date;
  v_new_flag := tg_op = 'INSERT' or not old.is_lead;

  if v_new_flag then
    if v_cap < v_today then
      raise exception 'this application is more than twelve months old; it cannot be kept as a good lead'
        using errcode = 'check_violation';
    end if;
    new.lead_flagged_at := now();
    new.lead_flagged_by := auth.uid();
    new.lead_keep_until := coalesce(new.lead_keep_until, v_cap);
  else
    new.lead_flagged_at := old.lead_flagged_at;
    if auth.uid() is not null then
      new.lead_flagged_by := old.lead_flagged_by;
    end if;
    new.lead_keep_until := coalesce(new.lead_keep_until, old.lead_keep_until, v_cap);
  end if;

  v_date_set := v_new_flag or new.lead_keep_until is distinct from old.lead_keep_until;
  if new.lead_keep_until > v_cap then
    if v_date_set then
      raise exception 'a good lead is kept for at most twelve months after the application (until %)', v_cap
        using errcode = 'check_violation';
    end if;
    new.lead_keep_until := v_cap;
  end if;
  if v_date_set and new.lead_keep_until < v_today then
    raise exception 'the keep-until date cannot be in the past' using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 2. postings.url
-- ---------------------------------------------------------------------------------------------
-- The tracker shows a posting's address as a link, to managers too. Only http and https
-- addresses are links now (web/app.js safeHref); this keeps anything else out of the column in
-- the first place. NOT VALID: rows already there are left as they are and checked only when
-- they are next changed.

alter table recruiting.postings
  add constraint postings_url_is_web check (url is null or url ~* '^https?://[^[:space:]]+$') not valid;

-- ---------------------------------------------------------------------------------------------
-- 3. Three trigger functions still had the default execute grant to everyone
-- ---------------------------------------------------------------------------------------------
-- Harmless as they stood (a trigger function cannot be called directly, and anon has no usage on
-- the schema), but every other function in the schema is revoked from public, and the policy
-- tests now check that none is executable without signing in.
revoke all on function recruiting.keep_contact_purged() from public;
revoke all on function recruiting.keep_lead_fields() from public;
revoke all on function recruiting.refuse_file_after_purge() from public;
