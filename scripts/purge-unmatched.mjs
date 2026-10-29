// Delete the applications whose position answer matches no position, and keep them out.
//
//   npm run purge:unmatched              dry run: lists what would go, changes nothing
//   npm run purge:unmatched -- --yes     deletes
//
// "Unmatched" is the Positions page's definition: position_id is null and position_text is
// neither blank nor "Any" (blank and "Any" applications stay; they cannot be linked and are
// not what the clean-up list shows). CAS applications are never unmatched: the CAS form has
// no position dropdown, so their position stays as typed (2026-10-29). For every such application the script
//   1. removes its files from the recruiting-files bucket through the Storage API (deleting
//      storage.objects rows by SQL would strand the bytes),
//   2. records its Jotform submission ID in recruiting.purged_submissions so the backfill and
//      the webhook never re-import it,
//   3. deletes the application; status, history, files, contacts, offers, referrals and
//      manager feedback cascade.
// Steps 2 and 3 run in one transaction over SUPABASE_DB_URL; step 1 runs first and is
// idempotent, so a failure part-way can simply be re-run. Jotform keeps every submission.
//
// Needs SUPABASE_DB_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env (README step 10).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(repoRoot, ".env");
if (existsSync(envFile) && typeof process.loadEnvFile === "function") process.loadEnvFile(envFile);

const yes = process.argv.includes("--yes");
const missing = ["SUPABASE_DB_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter((k) => !process.env[k]);
if (missing.length) { console.error(`Missing in .env: ${missing.join(", ")}`); process.exit(1); }

const BUCKET = "recruiting-files";
const WHERE = `a.position_id is null and nullif(trim(a.position_text), '') is not null and lower(trim(a.position_text)) <> 'any' and coalesce(a.location, '') <> 'CAS'`;
const REASON = "Position answer matched no position; removed in the Positions page clean-up";

const cfg = { connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: !!process.env.SUPABASE_DB_SSL_CA } };
if (process.env.SUPABASE_DB_SSL_CA) cfg.ssl.ca = readFileSync(process.env.SUPABASE_DB_SSL_CA, "utf8");
const pgc = new pg.Client(cfg);
await pgc.connect();
const storage = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }).storage.from(BUCKET);

try {
  const apps = (await pgc.query(`select a.id, a.jotform_submission_id, a.origin, a.location, a.position_text from recruiting.applications a where ${WHERE} order by a.location, a.position_text`)).rows;
  const files = (await pgc.query(`select f.storage_path from recruiting.application_files f join recruiting.applications a on a.id = f.application_id where ${WHERE}`)).rows.map((r) => r.storage_path);
  console.log(`${apps.length} unmatched application(s), ${files.length} file(s).`);
  const groups = new Map();
  for (const a of apps) { const k = `${a.location} · ${a.position_text}`; groups.set(k, (groups.get(k) || 0) + 1); }
  for (const [k, n] of [...groups].sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
  if (!apps.length) process.exit(0);
  if (!yes) { console.log("\nDry run. Re-run with --yes to delete."); process.exit(0); }

  // 1. Files, 100 at a time (Storage API limit per remove call is generous, but keep batches small).
  let removed = 0;
  for (let i = 0; i < files.length; i += 100) {
    const batch = files.slice(i, i + 100);
    const { data, error } = await storage.remove(batch);
    if (error) throw new Error(`storage remove: ${error.message}`);
    removed += data?.length ?? 0;
  }
  console.log(`Removed ${removed} of ${files.length} storage object(s) (missing ones count as done).`);

  // 2 + 3. Purge list and delete, atomically.
  await pgc.query("begin");
  const ids = apps.map((a) => a.id);
  const subs = apps.filter((a) => a.jotform_submission_id).map((a) => a.jotform_submission_id);
  const ins = await pgc.query(
    `insert into recruiting.purged_submissions (jotform_submission_id, reason) select unnest($1::text[]), $2 on conflict do nothing`,
    [subs, REASON]);
  const del = await pgc.query(`delete from recruiting.applications where id = any($1::uuid[])`, [ids]);
  await pgc.query("commit");
  console.log(`Recorded ${ins.rowCount} purged submission(s); deleted ${del.rowCount} application(s).`);
  const left = (await pgc.query(`select count(*)::int as n from recruiting.applications a where ${WHERE}`)).rows[0].n;
  console.log(`Unmatched applications remaining: ${left}.`);
} catch (e) {
  try { await pgc.query("rollback"); } catch {}
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await pgc.end();
}
