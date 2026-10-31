#!/usr/bin/env node
// One-time import of existing Jotform submissions into recruiting.applications, with resumes
// and portfolios copied into the Storage bucket recruiting-files (CLAUDE.md phase 4).
//
// Usage (from the repo root, Node 22+, after `npm install`):
//   npm run backfill -- --dry-run                 clean everything, write nothing, print counts
//   npm run backfill -- --form 232764918957171 --limit 25
//   npm run backfill                              all three forms, every submission
//   npm run backfill -- --refresh                 re-clean and update rows already imported
//
// Options:
//   --dry-run        no writes to the database or Storage (files are not downloaded either)
//   --form <id>      only this Jotform form (repeatable); default: every active row in forms
//   --limit <n>      at most n submissions per form (newest first, as Jotform lists them)
//   --refresh        update applications that already exist and re-copy their files
//   --skip-files     import rows but do not download or upload files
//   --sample         print one cleaned row per form (answers truncated) and stop; implies --dry-run
//   --since <date>   import only submissions made on or after this date (YYYY-MM-DD, in the
//                    Jotform account's time zone); default 2026-10-01. Older submissions are
//                    counted as "old" and never written. The tracker's records start on
//                    2026-10-01 (decision of 2026-10-30; Jotform keeps the originals).
//
// Environment (shell, or a gitignored .env at the repo root; never committed, never pasted
// into chat):
//   JOTFORM_API_KEY             Jotform -> account settings -> API
//   SUPABASE_URL                project URL (local: http://127.0.0.1:54321)
//   SUPABASE_SERVICE_ROLE_KEY   service-role key (local: `npx supabase status`; hosted:
//                               Project Settings -> API Keys). Bypasses RLS; server-side only.
//   JOTFORM_API_BASE            optional, default https://api.jotform.com (EU: https://eu-api.jotform.com)
//   JOTFORM_TIMEZONE            optional, default America/Los_Angeles: the Jotform account's
//                               time zone, in which `created_at` is expressed
//
// Idempotent on jotform_submission_id: a submission already in applications is skipped (or
// updated with --refresh). Inserting an application fires the trigger that creates its
// application_status and first status_history rows, so this script never writes those.
// Driver licence, signature and initials questions (forms.field_map.never_import) are dropped
// before `answers` is written; signature images are never downloaded.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { buildApplication } from "./lib/clean.mjs";
import { JotformClient } from "./lib/jotform.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUCKET = "recruiting-files";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
// Submissions before this date are never imported (decision of 2026-10-30, "What the October
// cutoff did" in the README; it was 2026-01-01 from 2026-10-28). Override per run with --since.
const DEFAULT_SINCE = "2026-10-01";

// ---------------------------------------------------------------------------------------------
// Arguments and environment
// ---------------------------------------------------------------------------------------------

const args = process.argv.slice(2);
const opts = { dryRun: false, forms: [], limit: Infinity, refresh: false, skipFiles: false, sample: false, since: DEFAULT_SINCE };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => {
    const v = args[++i];
    if (v === undefined) fail(`${a} needs a value`);
    return v;
  };
  if (a === "--dry-run") opts.dryRun = true;
  else if (a === "--refresh") opts.refresh = true;
  else if (a === "--skip-files") opts.skipFiles = true;
  else if (a === "--sample") { opts.sample = true; opts.dryRun = true; }
  else if (a === "--form") opts.forms.push(next());
  else if (a === "--limit") {
    opts.limit = Number(next());
    if (!Number.isInteger(opts.limit) || opts.limit < 1) fail("--limit needs a positive integer");
  } else if (a === "--since") {
    opts.since = next();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.since) || Number.isNaN(Date.parse(opts.since))) fail("--since needs a date as YYYY-MM-DD");
  } else if (a === "--help" || a === "-h") { printUsage(); process.exit(0); }
  else fail(`Unknown option ${a}`);
}

function printUsage() {
  console.log("Usage: npm run backfill -- [--dry-run] [--form <id>]... [--limit <n>] [--refresh] [--skip-files] [--sample] [--since <YYYY-MM-DD>]");
}

function fail(msg) {
  console.error(msg);
  printUsage();
  process.exit(2);
}

const envFile = join(repoRoot, ".env");
if (existsSync(envFile) && typeof process.loadEnvFile === "function") {
  // Values already in the shell win; .env only fills gaps.
  process.loadEnvFile(envFile);
}

const env = {
  jotformKey: process.env.JOTFORM_API_KEY,
  jotformBase: process.env.JOTFORM_API_BASE || "https://api.jotform.com",
  timeZone: process.env.JOTFORM_TIMEZONE || "America/Los_Angeles",
  supabaseUrl: process.env.SUPABASE_URL,
  serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
};
const missing = [];
if (!env.jotformKey) missing.push("JOTFORM_API_KEY");
if (!env.supabaseUrl) missing.push("SUPABASE_URL");
if (!env.serviceKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
if (missing.length) {
  console.error(`Missing ${missing.join(", ")}. Set them in your shell or in the gitignored .env at the repo root (see scripts/backfill/README.md).`);
  process.exit(2);
}
try { new Intl.DateTimeFormat("en-US", { timeZone: env.timeZone }); } catch { fail(`JOTFORM_TIMEZONE "${env.timeZone}" is not a valid IANA time zone`); }

const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(env.supabaseUrl);

// ---------------------------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------------------------

const jotform = new JotformClient({ apiKey: env.jotformKey, base: env.jotformBase });
const supabase = createClient(env.supabaseUrl, env.serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "recruiting" },
});
const db = supabase.schema("recruiting");

function unwrap({ data, error }, what) {
  if (error) {
    const hint = /schema must be one of|not found in the schema cache|relation .* does not exist/i.test(error.message ?? "")
      ? "\nIs schema `recruiting` exposed in the Data API (README step 5), and are the migrations applied?"
      : "";
    throw new Error(`${what}: ${error.message ?? JSON.stringify(error)}${hint}`);
  }
  return data;
}

async function selectAll(table, columns, order = "id") {
  // PostgREST caps a response at max_rows (1000 locally); page explicitly.
  const out = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const rows = unwrap(await db.from(table).select(columns).order(order).range(from, from + page - 1), `select ${table}`);
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

const totals = { forms: [], filesCopied: 0, filesSkipped: 0, filesFailed: 0, warnings: 0 };

async function main() {
  console.log(`Backfill ${opts.dryRun ? "(dry run) " : ""}-> ${env.supabaseUrl}${isLocal ? " (local stack)" : ""}`);
  console.log(`Importing submissions made on or after ${opts.since} (${env.timeZone}); older ones are skipped.`);
  if (!isLocal && !opts.dryRun) {
    console.log("Target is not the local stack. Writing real data to the hosted project.");
  }

  const forms = await selectAll("forms", "id, jotform_form_id, label, language, default_location, questions, field_map, is_active");
  const positions = await selectAll("positions", "id, title, location, jotform_option_label");
  const selected = forms.filter((f) => (opts.forms.length ? opts.forms.includes(f.jotform_form_id) : f.is_active));
  for (const id of opts.forms) {
    if (!forms.some((f) => f.jotform_form_id === id)) {
      throw new Error(`--form ${id}: no row in recruiting.forms has that jotform_form_id (known: ${forms.map((f) => f.jotform_form_id).join(", ")})`);
    }
  }
  if (!selected.length) throw new Error("No forms selected.");

  // Everything already imported, so re-runs skip instead of re-inserting.
  const existing = new Map();
  for (const a of await selectAll("applications", "id, jotform_submission_id", "jotform_submission_id")) {
    existing.set(a.jotform_submission_id, a.id);
  }
  const existingFiles = new Set((await selectAll("application_files", "storage_path", "storage_path")).map((f) => f.storage_path));
  // Deleted on purpose (recruiting.purged_submissions); never re-imported.
  const purged = new Set((await selectAll("purged_submissions", "jotform_submission_id", "jotform_submission_id")).map((p) => p.jotform_submission_id));
  console.log(`Database has ${existing.size} application(s) and ${existingFiles.size} file(s) already; ${purged.size} purged submission(s) will be skipped.`);

  if (!opts.dryRun && !opts.skipFiles) await ensureBucket();

  for (const form of selected) {
    await importForm(form, positions, existing, existingFiles, purged);
  }

  printReport();
  if (!opts.dryRun) await duplicateReport();
}

// The cutoff is a calendar date in the Jotform account's zone; compare on the local date of the
// submission there, so "2026-10-01" keeps a 12:30 AM October 1 submission in Oregon.
const sinceDateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: env.timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
function isBeforeSince(submittedAtIso) {
  return sinceDateFmt.format(new Date(submittedAtIso)) < opts.since;
}

async function ensureBucket() {
  const { data, error } = await supabase.storage.getBucket(BUCKET);
  if (error || !data) {
    throw new Error(`Storage bucket "${BUCKET}" is missing (${error?.message ?? "not found"}). Apply migration 20261027000100_storage_bucket_recruiting_files.sql first.`);
  }
  if (data.public) throw new Error(`Storage bucket "${BUCKET}" is public; it must be private.`);
}

async function importForm(form, positions, existing, existingFiles, purged) {
  const c = {
    form: form.jotform_form_id, label: form.label,
    fetched: 0, inserted: 0, updated: 0, skippedExisting: 0, skippedDeleted: 0, skippedPurged: 0, skippedOld: 0, failed: 0,
    filesFound: 0, filesCopied: 0, filesSkipped: 0, filesFailed: 0,
    positionMatched: 0, withResume: 0, warnings: [],
  };
  totals.forms.push(c);
  console.log(`\n== ${form.label} (${form.jotform_form_id})`);

  let printedSample = false;
  for await (const sub of jotform.submissions(form.jotform_form_id, {
    limit: opts.limit,
    onPage: ({ offset, count, total, limitLeft }) =>
      console.log(`  page offset ${offset}: ${count} submission(s)${total != null ? ` of ${total}` : ""}${limitLeft != null ? `, ${limitLeft} API calls left today` : ""}`),
  })) {
    c.fetched++;
    if (sub.status && String(sub.status).toUpperCase() === "DELETED") { c.skippedDeleted++; continue; }
    if (purged.has(String(sub.id))) { c.skippedPurged++; continue; }

    const { row, files, warnings } = buildApplication(sub, form, positions, { timeZone: env.timeZone });
    for (const w of warnings) c.warnings.push(`${row.jotform_submission_id}: ${w}`);
    if (!row.submitted_at) { c.failed++; continue; }
    if (isBeforeSince(row.submitted_at)) { c.skippedOld++; continue; }
    if (row.position_id) c.positionMatched++;
    if (row.has_resume) c.withResume++;
    c.filesFound += files.length;

    if (opts.sample && !printedSample) {
      printedSample = true;
      const shown = { ...row, answers: Object.fromEntries(Object.entries(row.answers).slice(0, 12)) };
      console.log(JSON.stringify({ row: shown, files, warnings }, null, 2));
      break;
    }

    const alreadyId = existing.get(row.jotform_submission_id);
    if (alreadyId && !opts.refresh) { c.skippedExisting++; continue; }

    if (opts.dryRun) {
      if (alreadyId) c.updated++; else c.inserted++;
      continue;
    }

    let applicationId = alreadyId;
    try {
      if (alreadyId) {
        unwrap(await db.from("applications").update(row).eq("id", alreadyId), `update ${row.jotform_submission_id}`);
        c.updated++;
      } else {
        const inserted = unwrap(await db.from("applications").insert(row).select("id").single(), `insert ${row.jotform_submission_id}`);
        applicationId = inserted.id;
        existing.set(row.jotform_submission_id, applicationId);
        c.inserted++;
      }
    } catch (err) {
      c.failed++;
      c.warnings.push(`${row.jotform_submission_id}: ${err.message}`);
      continue;
    }

    if (opts.skipFiles) continue;
    for (const f of files) {
      const storagePath = `applications/${form.jotform_form_id}/${row.jotform_submission_id}/${f.storage_name}`;
      if (existingFiles.has(storagePath) && !opts.refresh) { c.filesSkipped++; continue; }
      const result = await copyFile(f, storagePath, applicationId);
      if (result.ok) { c.filesCopied++; existingFiles.add(storagePath); }
      else { c.filesFailed++; c.warnings.push(`${row.jotform_submission_id}: file ${f.original_name}: ${result.reason}`); }
    }
    if ((c.inserted + c.updated) % 100 === 0) {
      console.log(`  ... ${c.inserted + c.updated} written, ${c.filesCopied} file(s) copied`);
    }
  }

  totals.filesCopied += c.filesCopied;
  totals.filesSkipped += c.filesSkipped;
  totals.filesFailed += c.filesFailed;
  totals.warnings += c.warnings.length;
}

async function copyFile(f, storagePath, applicationId) {
  const dl = await jotform.download(f.url);
  if (!dl.ok) return { ok: false, reason: dl.reason ?? `download HTTP ${dl.status}` };
  if (dl.buffer.length > MAX_FILE_BYTES) return { ok: false, reason: `${dl.buffer.length} bytes exceeds the ${MAX_FILE_BYTES} byte limit` };
  if (dl.buffer.length === 0) return { ok: false, reason: "empty file" };

  const contentType = dl.contentType && dl.contentType !== "application/octet-stream" ? dl.contentType : guessContentType(f.original_name);
  const up = await supabase.storage.from(BUCKET).upload(storagePath, dl.buffer, { contentType, upsert: true });
  if (up.error) return { ok: false, reason: `upload: ${up.error.message}` };

  const meta = {
    application_id: applicationId,
    storage_path: storagePath,
    original_name: f.original_name,
    kind: f.kind,
    content_type: contentType,
    size_bytes: dl.buffer.length,
    jotform_url: f.url,
  };
  const { error } = await db.from("application_files").upsert(meta, { onConflict: "storage_path" });
  if (error) return { ok: false, reason: `application_files: ${error.message}` };
  return { ok: true };
}

function guessContentType(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return {
    pdf: "application/pdf", doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    rtf: "application/rtf", txt: "text/plain", odt: "application/vnd.oasis.opendocument.text",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", heic: "image/heic", gif: "image/gif", webp: "image/webp",
    pages: "application/vnd.apple.pages", zip: "application/zip",
  }[ext] ?? "application/octet-stream";
}

function printReport() {
  console.log("\n== Report");
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`  ${pad("form", 42)} ${pad("fetched", 8)} ${pad("inserted", 9)} ${pad("updated", 8)} ${pad("existing", 9)} ${pad("deleted", 8)} ${pad("purged", 7)} ${pad("old", 6)} ${pad("failed", 7)} ${pad("pos match", 10)} ${pad("w/ resume", 10)} ${pad("files", 6)} ${pad("copied", 7)} ${pad("f.skip", 7)} f.fail`);
  for (const c of totals.forms) {
    console.log(`  ${pad(c.label.slice(0, 41), 42)} ${pad(c.fetched, 8)} ${pad(c.inserted, 9)} ${pad(c.updated, 8)} ${pad(c.skippedExisting, 9)} ${pad(c.skippedDeleted, 8)} ${pad(c.skippedPurged, 7)} ${pad(c.skippedOld, 6)} ${pad(c.failed, 7)} ${pad(c.positionMatched, 10)} ${pad(c.withResume, 10)} ${pad(c.filesFound, 6)} ${pad(c.filesCopied, 7)} ${pad(c.filesSkipped, 7)} ${c.filesFailed}`);
  }
  const all = totals.forms.reduce((a, c) => ({
    fetched: a.fetched + c.fetched, inserted: a.inserted + c.inserted, updated: a.updated + c.updated,
    failed: a.failed + c.failed, skippedOld: a.skippedOld + c.skippedOld,
  }), { fetched: 0, inserted: 0, updated: 0, failed: 0, skippedOld: 0 });
  console.log(`  total: ${all.fetched} fetched, ${all.inserted} inserted, ${all.updated} updated, ${all.skippedOld} before ${opts.since} (skipped), ${all.failed} failed; files ${totals.filesCopied} copied, ${totals.filesSkipped} already present, ${totals.filesFailed} failed`);
  const warnings = totals.forms.flatMap((c) => c.warnings);
  if (warnings.length) {
    console.log(`\n== Warnings (${warnings.length})`);
    for (const w of warnings.slice(0, 50)) console.log(`  ${w}`);
    if (warnings.length > 50) console.log(`  ... ${warnings.length - 50} more`);
  }
  if (all.failed || totals.filesFailed) process.exitCode = 1;
}

async function duplicateReport() {
  const rows = await selectAll("applications", "id, email_norm, phone_norm", "submitted_at");
  const byEmail = new Map(), byPhone = new Map();
  for (const r of rows) {
    if (r.email_norm) byEmail.set(r.email_norm, (byEmail.get(r.email_norm) ?? 0) + 1);
    if (r.phone_norm) byPhone.set(r.phone_norm, (byPhone.get(r.phone_norm) ?? 0) + 1);
  }
  const dupEmails = [...byEmail.values()].filter((n) => n > 1);
  const dupPhones = [...byPhone.values()].filter((n) => n > 1);
  console.log("\n== Duplicates in the database (repeat applicants, across all forms)");
  console.log(`  ${dupEmails.length} email address(es) appear more than once, covering ${dupEmails.reduce((a, b) => a + b, 0)} application(s)`);
  console.log(`  ${dupPhones.length} phone number(s) appear more than once, covering ${dupPhones.reduce((a, b) => a + b, 0)} application(s)`);
  console.log(`  ${rows.length} application(s) in total`);
}

main().catch((err) => {
  console.error(`\n${err.message ?? err}`);
  process.exit(1);
});
