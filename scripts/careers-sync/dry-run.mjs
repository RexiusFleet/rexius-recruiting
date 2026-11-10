// What would the careers page sync change right now? Reads the live rexius.com careers feed and
// the tracker's positions, runs the same rules as the Edge Function, prints the plan, and writes
// nothing. Works before the migration is applied too: without recruiting.careers_pages it starts
// from the rows the migration would seed from the rexius.com posting rows.
//
//   npm run careers:dry-run
//
// Needs SUPABASE_DB_URL in .env (README step 10). Read-only.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  CAREERS_FEED, TAG_LOCATIONS, feedProblem, normalizeUrl, pageFromEntry, parseFeed, payLabel, planSync, tagFeedUrl,
} from "../../supabase/functions/_shared/careers.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const envFile = join(repoRoot, ".env");
if (existsSync(envFile) && typeof process.loadEnvFile === "function") process.loadEnvFile(envFile);
if (!process.env.SUPABASE_DB_URL) { console.error("Missing in .env: SUPABASE_DB_URL"); process.exit(1); }

const UA = "RexiusRecruiter-careers-sync/1.0 (+https://rexius.com/blogs/careers)";
const getText = async (url) => {
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
};

const cfg = { connectionString: process.env.SUPABASE_DB_URL };
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(cfg.connectionString)) {
  cfg.ssl = { rejectUnauthorized: !!process.env.SUPABASE_DB_SSL_CA };
  if (process.env.SUPABASE_DB_SSL_CA) cfg.ssl.ca = readFileSync(process.env.SUPABASE_DB_SSL_CA, "utf8");
}
const db = new pg.Client(cfg);
await db.connect();
try {
  await db.query("begin transaction read only");
  const positions = (await db.query("select id, title, location, status, pay_min, pay_max, pay_unit, jotform_option_label from recruiting.positions")).rows;
  const postings = (await db.query("select id, position_id, channel, url, to_char(posted_at, 'YYYY-MM-DD') as posted_at, to_char(ended_at, 'YYYY-MM-DD') as ended_at from recruiting.postings where channel = 'rexius_com'")).rows;
  const hasTable = (await db.query("select to_regclass('recruiting.careers_pages') as t")).rows[0].t;
  let dbPages;
  if (hasTable) {
    dbPages = (await db.query("select * from recruiting.careers_pages")).rows.map((r) => ({ ...r, gone_at: r.gone_at ? r.gone_at.toISOString() : null }));
  } else {
    console.log("recruiting.careers_pages does not exist yet: starting from what the migration would seed.\n");
    const byUrl = new Map();
    for (const po of [...postings].sort((a, b) => (a.ended_at ? 1 : 0) - (b.ended_at ? 1 : 0) || (a.posted_at < b.posted_at ? 1 : -1))) {
      const url = normalizeUrl(po.url);
      if (url && !byUrl.has(url)) byUrl.set(url, { url, position_id: po.position_id, link_source: "posting", gone_at: po.ended_at, ignored: false, pay_applied_text: null, last_seen_at: null });
    }
    byUrl.set("https://rexius.com/blogs/careers/all-positions", { url: "https://rexius.com/blogs/careers/all-positions", title: "General Application", ignored: true, position_id: null, gone_at: null, pay_applied_text: null, last_seen_at: null });
    dbPages = [...byUrl.values()];
  }

  const entries = parseFeed(await getText(CAREERS_FEED));
  const knownLive = dbPages.filter((p) => !p.gone_at && !p.ignored && p.last_seen_at).length;
  const problem = feedProblem(entries.length, knownLive);
  if (problem) { console.log(`The sync would change nothing: ${problem}.`); process.exit(0); }
  const tags = new Map();
  for (const tag of Object.keys(TAG_LOCATIONS)) for (const e of parseFeed(await getText(tagFeedUrl(tag)))) tags.set(e.url, [...(tags.get(e.url) ?? []), tag]);
  const feedPages = entries.map((e) => pageFromEntry(e, (tags.get(e.url) ?? []).sort()));

  const listed = new Set(feedPages.map((p) => p.url));
  const gone = [], stillUp = [];
  for (const p of dbPages.filter((p) => !p.gone_at && !listed.has(p.url))) {
    const res = await fetch(p.url, { redirect: "manual", headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000) }).catch(() => null);
    if (res && [404, 410, 301, 308].includes(res.status)) gone.push(p.url); else if (res && res.status === 200) stillUp.push(p.url);
  }

  const now = new Date();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now).slice(0, 10);
  const plan = planSync({ now: now.toISOString(), today, feedPages, gone, stillUp, dbPages, positions, postings });
  const pos = new Map(positions.map((p) => [p.id, p]));
  const name = (id) => (pos.get(id) ? `${pos.get(id).title} (${pos.get(id).location})` : "no position");

  console.log(`The careers page lists ${entries.length} page(s). Pages and the positions they are tied to:`);
  const after = new Map(dbPages.map((p) => [p.url, p])); for (const p of plan.pages) after.set(p.url, p);
  for (const p of feedPages) {
    const row = after.get(p.url);
    console.log(`  ${p.url.split("/").pop().padEnd(48)} ${row.ignored ? "(ignored: not a job)" : name(row.position_id)}${p.pay_text ? `  ·  "${p.pay_text}" = ${p.pay_problem ? "UNREADABLE: " + p.pay_problem : payLabel(p)}` : "  ·  no pay line"}`);
  }
  console.log(`\nChanges the sync would make (${plan.changes.filter((c) => !c.kind.startsWith("page_")).length}):`);
  for (const c of plan.changes) {
    if (c.kind === "pay") console.log(`  PAY     ${c.title} (${c.location}): ${c.from} -> ${c.to}   from "${c.pay_text}"`);
    else if (c.kind === "closed") console.log(`  CLOSE   ${c.title} (${c.location}): page taken down`);
    else if (c.kind === "opened") console.log(`  OPEN    ${c.title} (${c.location}): page published (was ${c.from})`);
  }
  console.log(`\nPage events: ${plan.changes.filter((c) => c.kind.startsWith("page_")).map((c) => `${c.kind.slice(5)} ${c.url.split("/").pop()}`).join(", ") || "none"}`);
  console.log(`Posting rows: ${plan.postingInserts.length} to add, ${plan.postingEnds.length} to end.`);
  console.log(`\nFlags for staff (${plan.flags.length}):`);
  for (const f of plan.flags) console.log(`  ${f.kind}: ${f.title ?? ""} ${f.url ?? ""} ${f.problem ?? ""} ${f.pay_text ? `"${f.pay_text}"` : ""}`.trimEnd());
} finally {
  await db.query("rollback").catch(() => {});
  await db.end();
}
