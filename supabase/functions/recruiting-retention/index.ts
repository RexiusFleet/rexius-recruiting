// recruiting-retention: removes the files of applications whose contact details the six-month
// retention has already purged (CLAUDE.md section 5; README "What the contact-retention
// change created").
//
// Why a function and not SQL: deleting a row from storage.objects leaves the file bytes behind.
// Only the Storage API removes both, so the daily job (pg_cron -> recruiting.request_file_purge()
// -> pg_net -> this function) does the deletion here with the service role, then clears the
// application_files rows and stamps applications.files_purged_at.
//
// What is removed (2026-11-26): everything in the application's own folder in the bucket
// (applications/<form id>/<submission id>/ for a Jotform application, manual/<application id>/
// for a paper one), plus any path its application_files rows name. Working from the rows alone
// left behind a file whose row was never written (an upload that succeeded before the row insert
// failed) or whose row was deleted or repointed later. An application is stamped only once its
// folder lists empty.
//
// Request:  POST, JSON body {} (or {"limit": n}), header x-market-check-secret with the value of
//           MARKET_CHECK_SECRET (the same shared secret the market-check jobs use, so no new
//           secret is needed). There is no browser route: nothing in the tracker calls this.
// Response: 200 {applications, files_removed, failed: [..]}; 401 bad secret; 503 not configured.
//
// Environment (Edge Function secrets):
//   MARKET_CHECK_SECRET                                        shared with the market-check jobs
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY                     injected by Supabase

import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const FUNCTION = "recruiting-retention";
const BUCKET = "recruiting-files";
const DEFAULT_LIMIT = 200;

type Json = Record<string, unknown>;

function json(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const supabaseUrl = env("SUPABASE_URL"), serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json(503, { error: "function not configured (Supabase environment)" });
  const expected = env("MARKET_CHECK_SECRET");
  if (!expected) return json(503, { error: "function not configured (MARKET_CHECK_SECRET)" });
  if (!secretsMatch(req.headers.get("x-market-check-secret"), expected)) {
    console.warn(`[${FUNCTION}] rejected: bad internal secret`);
    return json(401, { error: "bad secret" });
  }

  let body: Json = {};
  try { body = await req.json(); } catch { /* an empty body is fine */ }
  const limit = typeof body.limit === "number" && body.limit > 0 && body.limit <= 1000 ? Math.floor(body.limit) : DEFAULT_LIMIT;

  const client = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const db = client.schema("recruiting");

  // Applications whose contact details are gone but whose files are not yet.
  const forms = await db.from("forms").select("id, jotform_form_id");
  if (forms.error) { console.error(`[${FUNCTION}] select forms: ${forms.error.message}`); return json(500, { error: "could not list forms" }); }
  const formIds = new Map((forms.data ?? []).map((f) => [f.id, String(f.jotform_form_id ?? "")]));

  const due = await db.from("applications")
    .select("id, origin, form_id, jotform_submission_id")
    .not("contact_purged_at", "is", null)
    .is("files_purged_at", null)
    .order("contact_purged_at")
    .limit(limit);
  if (due.error) { console.error(`[${FUNCTION}] select applications: ${due.error.message}`); return json(500, { error: "could not list applications" }); }

  let filesRemoved = 0, applications = 0;
  const failed: string[] = [];
  for (const app of due.data ?? []) {
    const files = await db.from("application_files").select("id, storage_path").eq("application_id", app.id);
    if (files.error) { failed.push(`${app.id}: list files: ${files.error.message}`); continue; }
    const rowPaths = (files.data ?? []).map((f) => f.storage_path).filter((p) => typeof p === "string" && p.length > 0);

    const folder = folderOf(app, formIds);
    if (!folder) { failed.push(`${app.id}: cannot tell which folder holds its files`); continue; }
    // The folder as Storage lists it, so a file no row knows about goes too.
    const listed = await filesIn(client.storage, folder);
    if (listed.error) { failed.push(`${app.id}: list ${folder}: ${listed.error}`); continue; }
    const paths = [...new Set([...rowPaths, ...listed.paths])];

    if (paths.length) {
      const rm = await client.storage.from(BUCKET).remove(paths);
      if (rm.error) { failed.push(`${app.id}: storage: ${rm.error.message}`); continue; }
      // A remove on a missing path is silent, so look again before stamping the application.
      const left = await filesIn(client.storage, folder);
      if (left.error) { failed.push(`${app.id}: list ${folder}: ${left.error}`); continue; }
      if (left.paths.length) { failed.push(`${app.id}: ${left.paths.length} object(s) still present after remove`); continue; }
      filesRemoved += paths.length;
    }

    const del = await db.from("application_files").delete().eq("application_id", app.id);
    if (del.error) { failed.push(`${app.id}: delete rows: ${del.error.message}`); continue; }
    const upd = await db.from("applications").update({ files_purged_at: new Date().toISOString(), has_resume: false }).eq("id", app.id);
    if (upd.error) { failed.push(`${app.id}: stamp: ${upd.error.message}`); continue; }
    applications++;
  }

  console.log(`[${FUNCTION}] ${applications} application(s), ${filesRemoved} file(s) removed, ${failed.length} failed`);
  for (const f of failed) console.error(`[${FUNCTION}] ${f}`);
  return json(200, { applications, files_removed: filesRemoved, failed });
});

/**
 * The one folder that holds an application's files, or null when its ids are not the plain form
 * expected. The check matters: an empty or odd id would name a parent folder, and everything
 * listed in the folder is deleted.
 */
function folderOf(app: { id: string; origin: string; form_id: string | null; jotform_submission_id: string | null }, formIds: Map<string, string>): string | null {
  if (app.origin === "manual") {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(app.id) ? `manual/${app.id}` : null;
  }
  const form = app.form_id ? formIds.get(app.form_id) ?? "" : "";
  const submission = app.jotform_submission_id ?? "";
  return /^\d{6,}$/.test(form) && /^\d{6,}$/.test(submission) ? `applications/${form}/${submission}` : null;
}

/** Every file directly in a folder (sub-folders, which Storage lists without an id, are left alone). */
async function filesIn(storage: ReturnType<typeof createClient>["storage"], folder: string): Promise<{ paths: string[]; error?: string }> {
  const paths: string[] = [];
  for (let offset = 0; ; offset += 100) {
    const ls = await storage.from(BUCKET).list(folder, { limit: 100, offset, sortBy: { column: "name", order: "asc" } });
    if (ls.error) return { paths, error: ls.error.message };
    for (const o of ls.data ?? []) if (o.id) paths.push(`${folder}/${o.name}`);
    if ((ls.data ?? []).length < 100) return { paths };
  }
}
