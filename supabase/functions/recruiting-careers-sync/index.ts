// recruiting-careers-sync: keeps the tracker's positions in step with the job pages on
// https://rexius.com/blogs/careers (README "What the careers sync created").
//
// It reads the careers blog's Atom feed (every published job page with its title, body and
// dates) and one feed per location tag, compares them with recruiting.careers_pages, and then:
//   * closes a position whose last live page was taken down, opens one whose page was published;
//   * copies a changed "Pay:" line into the position's advertised range when it can be read;
//   * keeps one open rexius.com posting row per live page;
//   * records the run in recruiting.careers_sync_runs, with flags for what staff must decide.
// The rules are in ../_shared/careers.mjs (tested by `npm run careers:test`); this file fetches,
// calls planSync() and writes what it returns. Nothing about an applicant is read or sent, and
// the only addresses it can request are the careers feed and job pages under rexius.com.
//
// Safety: a feed that fails, is not a feed, is empty or lists under half the known pages changes
// nothing (the run is recorded with ok false). A page counts as gone only when it is missing
// from the feed AND its own address answers 404, 410 or a permanent redirect.
//
// Request:  POST, JSON body {} or {"dry_run": true} (plan only: nothing written, no run row).
//   Either header `x-market-check-secret` with MARKET_CHECK_SECRET (the daily pg_cron job,
//   recruiting.request_careers_sync()), or `Authorization: Bearer <a staff user's Supabase JWT>`
//   (admin or hr with a two-factor session: the "Check now" button on the Positions page).
//   The gateway's JWT check is off (`verify_jwt = false`); the function checks itself.
// Response: JSON, always.
//   200 {ok, dry_run, pages_listed, changes: [...], flags: [...], error?}
//   401 no or bad credentials, 403 not staff, 405 not POST, 503 not configured.
//
// Environment (Edge Function secrets):
//   MARKET_CHECK_SECRET                        shared with the other scheduled jobs
//   CAREERS_BASE                               optional; default https://rexius.com (a local stub
//                                              for tests: scripts/careers-sync/stub-site.mjs)
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY   injected by Supabase

import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import {
  CAREERS_FEED, CAREERS_ORIGIN, TAG_LOCATIONS, feedProblem, normalizeUrl, pageFromEntry, parseFeed, planSync, tagFeedUrl,
} from "../_shared/careers.mjs";

const FUNCTION = "recruiting-careers-sync";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_PAGE_CHECKS = 40;
const USER_AGENT = "RexiusRecruiter-careers-sync/1.0 (+https://rexius.com/blogs/careers)";
const PAGE_COLUMNS = ["url", "title", "tags", "location", "job_type", "pay_text", "pay_min", "pay_max", "pay_unit", "pay_problem", "pay_applied_text",
  "published_at", "site_updated_at", "first_seen_at", "last_seen_at", "gone_at", "position_id", "link_source", "ignored"] as const;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
type Json = Record<string, unknown>;

function json(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}
function env(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v && v.trim() ? v.trim() : undefined;
}
/** Compare two strings without leaking their length or where they differ through timing. */
function secretsMatch(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = new TextEncoder().encode(given), b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
function oregonDate(d: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return p.slice(0, 10);
}
const errText = (e: unknown) => (e instanceof Error ? (e.name === "TimeoutError" ? "timed out" : e.message) : String(e));

/** The site address to request for a canonical rexius.com URL (CAREERS_BASE swaps the origin in tests). */
function siteUrl(base: string, canonical: string): string {
  return base + canonical.slice(CAREERS_ORIGIN.length);
}
async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/atom+xml, application/xml;q=0.9" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return text;
}
/** Is one job page still there? "gone" only on a clear answer; anything else is "unknown". */
async function pageState(url: string): Promise<"up" | "gone" | "unknown"> {
  try {
    const res = await fetch(url, { method: "GET", redirect: "manual", headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    await res.body?.cancel();
    if (res.status === 200) return "up";
    if (res.status === 404 || res.status === 410 || res.status === 301 || res.status === 308) return "gone";
    return "unknown";
  } catch (err) {
    console.warn(`[${FUNCTION}] page check ${url}: ${errText(err)}`);
    return "unknown";
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const supabaseUrl = env("SUPABASE_URL"), serviceKey = env("SUPABASE_SERVICE_ROLE_KEY"), anonKey = env("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceKey || !anonKey) return json(503, { error: "function not configured (Supabase environment)" });
  const base = (env("CAREERS_BASE") ?? CAREERS_ORIGIN).replace(/\/$/, "");

  // 1. Who is calling: the scheduled job (shared secret) or a staff user (their session).
  let trigger: "schedule" | "manual", requestedBy: string | null = null;
  const given = req.headers.get("x-market-check-secret");
  if (given !== null) {
    const expected = env("MARKET_CHECK_SECRET");
    if (!expected) return json(503, { error: "function not configured (MARKET_CHECK_SECRET)" });
    if (!secretsMatch(given, expected)) { console.warn(`[${FUNCTION}] rejected: bad internal secret`); return json(401, { error: "bad secret" }); }
    trigger = "schedule";
  } else {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return json(401, { error: "sign in first" });
    const asUser = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
    const who = await asUser.auth.getUser(token);
    if (who.error || !who.data.user) return json(401, { error: "invalid session" });
    const role = await asUser.schema("recruiting").rpc("current_role");
    if (role.error) { console.error(`[${FUNCTION}] current_role: ${role.error.message}`); return json(500, { error: "could not check your role" }); }
    if (role.data !== "admin" && role.data !== "hr") return json(403, { error: "only HR and admins can check the careers page (two-factor session needed)" });
    trigger = "manual"; requestedBy = who.data.user.id;
  }

  let body: Json = {};
  try { body = await req.json(); } catch { /* an empty body is fine */ }
  const dryRun = body.dry_run === true;

  const client = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const db = client.schema("recruiting");
  const now = new Date();

  const record = async (run: Row): Promise<void> => {
    if (dryRun) return;
    const ins = await db.from("careers_sync_runs").insert({ trigger, requested_by: requestedBy, ...run });
    if (ins.error) console.error(`[${FUNCTION}] record run: ${ins.error.message}`);
  };
  const stop = async (error: string, pagesListed: number | null): Promise<Response> => {
    console.error(`[${FUNCTION}] nothing changed: ${error}`);
    await record({ ok: false, pages_listed: pagesListed, error });
    return json(200, { ok: false, dry_run: dryRun, pages_listed: pagesListed, changes: [], flags: [], error });
  };

  // 2. What the tracker holds.
  const [pagesQ, positionsQ, postingsQ] = await Promise.all([
    db.from("careers_pages").select("*"),
    db.from("positions").select("id, title, location, status, pay_min, pay_max, pay_unit, jotform_option_label"),
    db.from("postings").select("id, position_id, channel, url, posted_at, ended_at").eq("channel", "rexius_com"),
  ]);
  const failedQ = [pagesQ, positionsQ, postingsQ].find((q) => q.error);
  if (failedQ) { console.error(`[${FUNCTION}] read: ${failedQ.error!.message}`); return json(500, { error: "could not read the tracker's positions" }); }
  const dbPages = pagesQ.data as Row[];
  const knownLive = dbPages.filter((p) => !p.gone_at && !p.ignored && p.last_seen_at).length;

  // 3. What the site lists.
  let entries: ReturnType<typeof parseFeed>;
  try { entries = parseFeed(await getText(siteUrl(base, CAREERS_FEED))); }
  catch (err) { return await stop(`could not read the careers page feed (${errText(err)})`, null); }
  const problem = feedProblem(entries.length, knownLive);
  if (problem) return await stop(problem, entries.length);

  // Location tags: one feed per tag. If any fails, known pages keep their location and new
  // pages wait for the next run to be placed.
  const tagsByUrl = new Map<string, string[]>();
  let tagsOk = true;
  await Promise.all(Object.keys(TAG_LOCATIONS).map(async (tag) => {
    try {
      for (const e of parseFeed(await getText(siteUrl(base, tagFeedUrl(tag))))) tagsByUrl.set(e.url, [...(tagsByUrl.get(e.url) ?? []), tag]);
    } catch (err) { tagsOk = false; console.warn(`[${FUNCTION}] tag feed ${tag}: ${errText(err)}`); }
  }));
  const byUrl = new Map(dbPages.map((p) => [p.url, p]));
  const feedPages = entries.map((e) => {
    const page = pageFromEntry(e, tagsOk ? (tagsByUrl.get(e.url) ?? []).sort() : []);
    const old = byUrl.get(e.url);
    if (!tagsOk && old) { page.tags = old.tags ?? []; page.location = old.location ?? null; }
    return page;
  });

  // 4. Pages the tracker knew that the feed no longer lists: ask each one directly.
  const listed = new Set(feedPages.map((p) => p.url));
  const missing = dbPages.filter((p) => !p.gone_at && !listed.has(p.url) && normalizeUrl(p.url) === p.url).slice(0, MAX_PAGE_CHECKS);
  const gone: string[] = [], stillUp: string[] = [];
  await Promise.all(missing.map(async (p) => {
    const s = await pageState(siteUrl(base, p.url));
    if (s === "gone") gone.push(p.url); else if (s === "up") stillUp.push(p.url);
  }));

  // 5. Decide.
  const plan = planSync({ now: now.toISOString(), today: oregonDate(now), feedPages, gone, stillUp, dbPages, positions: positionsQ.data as Row[], postings: postingsQ.data as Row[] });
  if (!tagsOk) plan.flags.push({ kind: "tags_unavailable" });
  if (dryRun) {
    console.log(`[${FUNCTION}] dry run: ${plan.changes.length} change(s), ${plan.flags.length} flag(s)`);
    return json(200, { ok: true, dry_run: true, pages_listed: entries.length, changes: plan.changes, flags: plan.flags });
  }

  // 6. Write. Each step is safe to repeat: a failure is reported and the next run finishes it.
  const errors: string[] = [];
  if (plan.pages.length) {
    const rows = plan.pages.map((p: Row) => {
      const r: Row = {};
      for (const c of PAGE_COLUMNS) r[c] = p[c] ?? null;
      r.tags = p.tags ?? []; r.ignored = p.ignored === true; r.first_seen_at = p.first_seen_at ?? now.toISOString();
      return r;
    });
    const up = await db.from("careers_pages").upsert(rows, { onConflict: "url" });
    if (up.error) errors.push(`pages: ${up.error.message}`);
  }
  for (const u of plan.positionUpdates as Row[]) {
    const upd = await db.from("positions").update(u.set).eq("id", u.id);
    if (upd.error) { errors.push(`position ${u.id}: ${upd.error.message}`); continue; }
    if (u.pay_note) {
      // The pay-history row the positions trigger just wrote.
      const h = await db.from("position_pay_history").select("id").eq("position_id", u.id).is("note", null).order("changed_at", { ascending: false }).limit(1);
      if (!h.error && h.data?.length) await db.from("position_pay_history").update({ note: u.pay_note }).eq("id", h.data[0].id);
    }
    if (u.opening_note) {
      const o = await db.from("position_openings").select("id, note").eq("position_id", u.id).order("opened_at", { ascending: false }).limit(1);
      if (!o.error && o.data?.length && !o.data[0].note) await db.from("position_openings").update({ note: u.opening_note }).eq("id", o.data[0].id);
    }
  }
  if (plan.postingInserts.length) {
    const ins = await db.from("postings").insert(plan.postingInserts);
    if (ins.error) errors.push(`postings: ${ins.error.message}`);
  }
  for (const e of plan.postingEnds as Row[]) {
    const end = await db.from("postings").update({ ended_at: e.ended_at }).eq("id", e.id).is("ended_at", null);
    if (end.error) errors.push(`posting ${e.id}: ${end.error.message}`);
  }

  const ok = errors.length === 0;
  for (const e of errors) console.error(`[${FUNCTION}] ${e}`);
  console.log(`[${FUNCTION}] ${trigger}: ${entries.length} page(s) listed, ${plan.changes.length} change(s), ${plan.flags.length} flag(s), ${errors.length} error(s)`);
  await record({ ok, pages_listed: entries.length, changes: plan.changes, flags: plan.flags, error: ok ? null : errors.join("; ").slice(0, 1000) });
  return json(200, { ok, dry_run: false, pages_listed: entries.length, changes: plan.changes, flags: plan.flags, ...(ok ? {} : { error: "some changes could not be saved; the next check will retry them" }) });
});
