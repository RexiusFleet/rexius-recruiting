// Rexius Recruiter: Jotform webhook (CLAUDE.md Phase 5).
//
// Jotform calls this function once per new submission on each of the three employment
// application forms (Settings -> Integrations -> Webhooks). The POST body is multipart/form-data
// with `formID`, `submissionID`, `rawRequest` (the answers as a JSON string keyed
// `q<ID>_<name>`), plus `formTitle`, `ip` and a few more parts (shape confirmed against
// Jotform's help pages and third-party write-ups, 2026-10-27; Jotform publishes no formal
// schema). Only `formID` and `submissionID` are used: the function fetches the submission
// from Jotform's REST API (`GET /submission/{id}`, same object shape as the backfill's
// `GET /form/{id}/submissions`) rather than trusting the posted body.
//
// Request:  POST /functions/v1/recruiting-jotform-webhook?secret=<JOTFORM_WEBHOOK_SECRET>
//           (the secret may also come in an `x-webhook-secret` header, for curl tests)
// Response: JSON, always. 200 {status: "inserted" | "exists" | "skipped", ...},
//           400 bad payload / unknown form, 401 bad or missing secret, 405 not POST,
//           502 Jotform API failure, 503 secrets not configured, 500 anything else.
//
// What it does, in order:
//   1. constant-time check of the shared secret (the gateway's JWT check is off; Jotform cannot
//      send a Supabase JWT);
//   2. reads formID and submissionID; rejects a formID that is not an active row in
//      recruiting.forms (logged);
//   3. returns {status: "exists"} if recruiting.applications already has the submission, so a
//      retried or duplicated webhook never creates a second row;
//   4. fetches the submission from Jotform with JOTFORM_API_KEY; checks it belongs to formID;
//      skips submissions in Jotform's trash;
//   5. builds the row with the SAME rules as the backfill (../_shared/clean.mjs: field map,
//      never-import list for driver licence 30/31/35, signatures 238/333/369 and initials
//      324-332, Spanish value cleanup, email/phone normalisation) and inserts it. The insert
//      trigger creates application_status in the first stage and the first status_history row,
//      and matches the position; this function never writes those tables;
//   6. responds, then copies resumes/portfolios into the private bucket `recruiting-files`
//      in the background (EdgeRuntime.waitUntil) and records them in application_files, so
//      Jotform's 5-second webhook timeout is not spent on downloads. A file that fails to copy
//      is logged; `npm run backfill -- --refresh` re-copies it later.
//
// Environment (Edge Function secrets, never in code or config):
//   JOTFORM_WEBHOOK_SECRET   required; the value Jotform sends as ?secret=
//   JOTFORM_API_KEY          required; read-only Jotform key
//   JOTFORM_API_BASE         optional; default https://api.jotform.com (EU: https://eu-api.jotform.com)
//   JOTFORM_TIMEZONE         optional; default America/Los_Angeles (zone of Jotform's created_at)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   injected by Supabase
//
// Logs carry form and submission IDs only, never answers, names or secrets.

import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { buildApplication } from "../_shared/clean.mjs";
import { downloadJotformUpload } from "../_shared/download.mjs";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const BUCKET = "recruiting-files";
const FUNCTION = "recruiting-jotform-webhook";

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
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** formID and submissionID from multipart, urlencoded or JSON bodies. */
async function readIds(req: Request): Promise<{ formId?: string; submissionId?: string; error?: string }> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  let formId: unknown, submissionId: unknown;
  try {
    if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) {
      const fd = await req.formData();
      formId = fd.get("formID");
      submissionId = fd.get("submissionID") ?? fd.get("submission_id");
    } else if (ct.includes("application/json")) {
      const body = await req.json();
      formId = body?.formID ?? body?.form_id;
      submissionId = body?.submissionID ?? body?.submission_id;
    } else {
      return { error: `unsupported content type "${ct || "(none)"}"` };
    }
  } catch (err) {
    return { error: `unreadable body: ${(err as Error).message}` };
  }
  const digits = (v: unknown) => (typeof v === "string" && /^\d{1,32}$/.test(v.trim()) ? v.trim() : undefined);
  const f = digits(formId), s = digits(submissionId);
  if (!f || !s) return { error: "formID and submissionID must be present and numeric" };
  return { formId: f, submissionId: s };
}

// ---------------------------------------------------------------------------------------------
// Jotform REST (same conventions as scripts/backfill/lib/jotform.mjs: APIKEY header, JSON
// envelope { responseCode, message, content })
// ---------------------------------------------------------------------------------------------

async function fetchWithRetry(url: string | URL, init: RequestInit, tries = 3): Promise<Response> {
  let delay = 800;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (attempt >= tries) throw err;
      await new Promise((r) => setTimeout(r, delay)); delay *= 2; continue;
    }
    if (res.ok || attempt >= tries || !(res.status === 429 || res.status >= 500)) return res;
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, delay)); delay *= 2;
  }
}

async function jotformSubmission(base: string, apiKey: string, submissionId: string): Promise<Json> {
  const res = await fetchWithRetry(`${base}/submission/${submissionId}`, {
    headers: { APIKEY: apiKey, Accept: "application/json" },
  });
  const text = await res.text();
  let body: Json;
  try { body = JSON.parse(text); } catch { throw new Error(`Jotform HTTP ${res.status}, non-JSON body`); }
  const code = Number(body.responseCode ?? res.status);
  if (!res.ok || code !== 200) throw new Error(`Jotform HTTP ${res.status} responseCode ${code}: ${String(body.message ?? "").slice(0, 200)}`);
  if (!body.content || typeof body.content !== "object") throw new Error("Jotform response has no content");
  return body.content as Json;
}

function guessContentType(name: string): string {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return ({
    pdf: "application/pdf", doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    rtf: "application/rtf", txt: "text/plain", odt: "application/vnd.oasis.opendocument.text",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", heic: "image/heic", gif: "image/gif", webp: "image/webp",
    pages: "application/vnd.apple.pages", zip: "application/zip",
  } as Record<string, string>)[ext] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------------------------

type FileToCopy = { qid: string; url: string; kind: string; original_name: string; storage_name: string };

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const log = (msg: string) => console.log(`[${FUNCTION}] ${msg}`);
  const warn = (msg: string) => console.warn(`[${FUNCTION}] ${msg}`);

  const secret = env("JOTFORM_WEBHOOK_SECRET");
  const apiKey = env("JOTFORM_API_KEY");
  const supabaseUrl = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret || !apiKey || !supabaseUrl || !serviceKey) {
    const missing = [["JOTFORM_WEBHOOK_SECRET", secret], ["JOTFORM_API_KEY", apiKey], ["SUPABASE_URL", supabaseUrl], ["SUPABASE_SERVICE_ROLE_KEY", serviceKey]]
      .filter(([, v]) => !v).map(([k]) => k);
    warn(`not configured: missing ${missing.join(", ")}`);
    return json(503, { error: "function not configured", missing });
  }

  // 1. Shared secret, before anything else is read.
  const given = url.searchParams.get("secret") ?? req.headers.get("x-webhook-secret");
  if (!secretsMatch(given, secret)) {
    warn(`rejected: bad or missing secret (method ${req.method})`);
    return json(401, { error: "unauthorised" });
  }
  if (req.method === "GET" || req.method === "HEAD") return json(200, { ok: true, function: FUNCTION });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  // 2. Which form, which submission.
  const ids = await readIds(req);
  if (ids.error) { warn(`rejected: ${ids.error}`); return json(400, { error: ids.error }); }
  const { formId, submissionId } = ids as { formId: string; submissionId: string };
  const tag = `form ${formId} submission ${submissionId}`;

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: "recruiting" },
  });
  const db = supabase.schema("recruiting");

  try {
    const forms = await db.from("forms")
      .select("id, jotform_form_id, label, language, default_location, questions, field_map, is_active")
      .eq("jotform_form_id", formId).limit(1);
    if (forms.error) throw new Error(`select forms: ${forms.error.message}`);
    const form = forms.data?.[0];
    if (!form || !form.is_active) {
      warn(`rejected: ${tag}: ${form ? "form is inactive" : "unknown form ID (no row in recruiting.forms)"}`);
      return json(400, { error: "unknown form", formID: formId });
    }

    // 3. Idempotency: already imported (backfill or an earlier delivery of this webhook).
    const existing = await db.from("applications").select("id").eq("jotform_submission_id", submissionId).limit(1);
    if (existing.error) throw new Error(`select applications: ${existing.error.message}`);
    if (existing.data?.length) {
      log(`${tag}: already imported as application ${existing.data[0].id}`);
      return json(200, { status: "exists", application_id: existing.data[0].id });
    }

    // 4. The real submission, from Jotform, not from the posted body.
    const base = (env("JOTFORM_API_BASE") ?? "https://api.jotform.com").replace(/\/$/, "");
    let submission: Json;
    try {
      submission = await jotformSubmission(base, apiKey, submissionId);
    } catch (err) {
      warn(`${tag}: ${(err as Error).message}`);
      return json(502, { error: "could not fetch the submission from Jotform" });
    }
    if (submission.form_id != null && String(submission.form_id) !== formId) {
      warn(`rejected: ${tag}: Jotform says the submission belongs to form ${submission.form_id}`);
      return json(400, { error: "submission does not belong to formID" });
    }
    if (String(submission.status ?? "").toUpperCase() === "DELETED") {
      log(`${tag}: in Jotform's trash, skipped`);
      return json(200, { status: "skipped", reason: "deleted in Jotform" });
    }

    // 5. Clean and insert.
    const positions = await db.from("positions").select("id, title, location, jotform_option_label");
    if (positions.error) throw new Error(`select positions: ${positions.error.message}`);
    const timeZone = env("JOTFORM_TIMEZONE") ?? "America/Los_Angeles";
    const { row, files, warnings } = buildApplication({ ...submission, id: submissionId }, form, positions.data ?? [], { timeZone });
    for (const w of warnings) warn(`${tag}: ${w}`);
    if (!row.submitted_at) {
      warn(`${tag}: no parseable submission time, not imported`);
      return json(502, { error: "submission has no parseable created_at" });
    }

    const inserted = await db.from("applications").insert(row).select("id").single();
    if (inserted.error) {
      if (inserted.error.code === "23505") {
        // Two deliveries raced past the check above; the other one won.
        const again = await db.from("applications").select("id").eq("jotform_submission_id", submissionId).limit(1);
        log(`${tag}: inserted concurrently as application ${again.data?.[0]?.id ?? "?"}`);
        return json(200, { status: "exists", application_id: again.data?.[0]?.id ?? null });
      }
      throw new Error(`insert applications: ${inserted.error.message}`);
    }
    const applicationId = inserted.data.id as string;
    log(`${tag}: inserted application ${applicationId} (${files.length} file(s) to copy, position ${row.position_id ? "matched" : "unmatched"})`);

    // 6. Files, after the response has gone back to Jotform.
    if (files.length) {
      const copy = copyFiles(supabase, apiKey, formId, submissionId, applicationId, files as FileToCopy[], log, warn);
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(copy);
      else await copy;
    }
    return json(200, { status: "inserted", application_id: applicationId, files: files.length });
  } catch (err) {
    console.error(`[${FUNCTION}] ${tag}: ${(err as Error).message}`);
    return json(500, { error: "import failed; see function logs" });
  }
});

async function copyFiles(
  supabase: ReturnType<typeof createClient>, apiKey: string, formId: string, submissionId: string,
  applicationId: string, files: FileToCopy[], log: (m: string) => void, warn: (m: string) => void,
): Promise<void> {
  const db = supabase.schema("recruiting");
  let copied = 0;
  for (const f of files) {
    const storagePath = `applications/${formId}/${submissionId}/${f.storage_name}`;
    try {
      const dl = await downloadJotformUpload(f.url, apiKey);
      if (!dl.ok) { warn(`form ${formId} submission ${submissionId}: file ${f.storage_name}: ${dl.reason}`); continue; }
      const contentType = dl.contentType && dl.contentType !== "application/octet-stream" ? dl.contentType : guessContentType(f.original_name);
      const up = await supabase.storage.from(BUCKET).upload(storagePath, dl.bytes, { contentType, upsert: true });
      if (up.error) { warn(`form ${formId} submission ${submissionId}: file ${f.storage_name}: upload: ${up.error.message}`); continue; }
      const meta = await db.from("application_files").upsert({
        application_id: applicationId, storage_path: storagePath, original_name: f.original_name,
        kind: f.kind, content_type: contentType, size_bytes: dl.bytes.length, jotform_url: f.url,
      }, { onConflict: "storage_path" });
      if (meta.error) { warn(`form ${formId} submission ${submissionId}: file ${f.storage_name}: application_files: ${meta.error.message}`); continue; }
      copied++;
    } catch (err) {
      warn(`form ${formId} submission ${submissionId}: file ${f.storage_name}: ${(err as Error).message}`);
    }
  }
  log(`form ${formId} submission ${submissionId}: ${copied} of ${files.length} file(s) copied to ${BUCKET}`);
}
