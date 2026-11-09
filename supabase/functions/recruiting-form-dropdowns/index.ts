// Rexius Recruiter: the live position dropdowns of the Jotform application forms, for the
// Positions page's drift check ("dropdown still lists a closed role", "open role not on the form").
//
// The tracker keeps each form's questions in recruiting.forms.questions, but that copy is written
// when a form is added (or by a migration) and nothing refreshes it. After HR edited a dropdown in
// Jotform the drift check kept comparing against the old list: on 2026-11-09 the English form's
// Eugene/Springfield dropdown had 6 roles in Jotform and 11 in the stored copy, and the Spanish
// 2026 form, which has its own dropdowns, was not checked at all. This function reads the
// dropdowns from Jotform when the page asks. It only reads: nothing is written to the database or
// to Jotform, and nothing about an applicant is involved.
//
// Request:  POST /functions/v1/recruiting-form-dropdowns   (no body)
//   `Authorization: Bearer <the user's Supabase JWT>`. Any tracker user (admin, hr or manager)
//   with a two-factor session, checked through recruiting.current_role() like every table
//   policy, because every user sees the drift check. The gateway's JWT check is off
//   (`verify_jwt = false`), as for the other tracker functions; the function checks itself.
// Response: JSON, always.
//   200 {checked_at, forms: [{jotform_form_id, label, language, dropdowns: {<location>: [option, ...]}}]}
//       One entry per active form whose field_map.position maps locations to question IDs (the
//       English and Spanish 2026 forms; the CAS form's position is free text and has none).
//       Options are trimmed with a trailing "/" stripped (CLAUDE.md section 4), and "Any" left out.
//   401 no or bad session, 403 no profile or no two-factor session, 405 not POST,
//   502 Jotform did not answer for a form (the error names it), 503 not configured.
//
// Environment (Edge Function secrets, never in code or config):
//   JOTFORM_API_KEY      required; the webhook's key (read access is enough)
//   JOTFORM_API_BASE     optional; default https://api.jotform.com (the local stub in
//                        scripts/webhook-test/stub-jotform.mjs serves the same route)
//   SUPABASE_URL, SUPABASE_ANON_KEY   injected by Supabase

import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const FUNCTION = "recruiting-form-dropdowns";
const JOTFORM_TIMEOUT_MS = 15_000;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

type Json = Record<string, unknown>;

function json(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}

function env(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v && v.trim() ? v.trim() : undefined;
}

interface FormRow {
  jotform_form_id: string;
  label: string;
  language: string;
  field_map: { position?: unknown } | null;
}

/** Location -> question ID, for forms whose position is a dropdown per location. */
function positionQuestions(form: FormRow): Record<string, string> | null {
  const p = form.field_map?.position;
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const out: Record<string, string> = {};
  for (const [loc, qid] of Object.entries(p as Record<string, unknown>)) {
    if ((typeof qid === "string" || typeof qid === "number") && /^\d+$/.test(String(qid))) out[loc] = String(qid);
  }
  return Object.keys(out).length ? out : null;
}

/** Jotform sends dropdown options as one "A|B|C" string. */
function cleanOptions(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split("|")) {
    const o = part.trim().replace(/\/\s*$/, "").trim();
    if (!o || o.toLowerCase() === "any" || seen.has(o.toLowerCase())) continue;
    seen.add(o.toLowerCase());
    out.push(o);
  }
  return out;
}

async function liveQuestions(base: string, apiKey: string, formId: string): Promise<Record<string, { options?: unknown }>> {
  let res: Response;
  try {
    res = await fetch(`${base}/form/${encodeURIComponent(formId)}/questions`, {
      headers: { APIKEY: apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(JOTFORM_TIMEOUT_MS),
    });
  } catch (err) {
    // The runtime's own message is long and technical; log it, and tell the page something short.
    console.error(`[${FUNCTION}] fetch ${formId}: ${err instanceof Error ? err.message : String(err)}`);
    throw new Error(err instanceof Error && err.name === "TimeoutError" ? "timed out" : "could not connect");
  }
  const text = await res.text();
  let body: { responseCode?: number; message?: string; content?: unknown };
  try { body = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}, not JSON`); }
  if (!res.ok || (body.responseCode && body.responseCode !== 200)) throw new Error(`HTTP ${res.status}: ${body.message ?? "no message"}`);
  if (!body.content || typeof body.content !== "object") throw new Error("no questions in the answer");
  return body.content as Record<string, { options?: unknown }>;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const supabaseUrl = env("SUPABASE_URL");
  const anonKey = env("SUPABASE_ANON_KEY");
  const apiKey = env("JOTFORM_API_KEY");
  const base = (env("JOTFORM_API_BASE") ?? "https://api.jotform.com").replace(/\/$/, "");
  if (!supabaseUrl || !anonKey) return json(503, { error: "function not configured (Supabase environment)" });
  if (!apiKey) return json(503, { error: "function not configured (JOTFORM_API_KEY)" });

  // 1. Who is calling: any tracker user with a two-factor session.
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json(401, { error: "sign in first" });
  const asUser = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
  const who = await asUser.auth.getUser(token);
  if (who.error || !who.data.user) return json(401, { error: "invalid session" });
  const role = await asUser.schema("recruiting").rpc("current_role");
  if (role.error) { console.error(`[${FUNCTION}] current_role: ${role.error.message}`); return json(500, { error: "could not check your role" }); }
  if (!role.data) return json(403, { error: "no tracker access (or no two-factor session)" });

  // 2. The forms, read as the user (the same rows the page reads).
  const forms = await asUser.schema("recruiting").from("forms")
    .select("jotform_form_id, label, language, field_map")
    .eq("is_active", true)
    .order("id");
  if (forms.error) { console.error(`[${FUNCTION}] forms: ${forms.error.message}`); return json(500, { error: "could not read the forms" }); }
  const withDropdowns = (forms.data as FormRow[]).map((f) => ({ form: f, questions: positionQuestions(f) })).filter((x) => x.questions);

  // 3. Their position dropdowns, live from Jotform.
  try {
    const out = await Promise.all(withDropdowns.map(async ({ form, questions }) => {
      let live: Record<string, { options?: unknown }>;
      try { live = await liveQuestions(base, apiKey, form.jotform_form_id); }
      catch (err) { throw new Error(`${form.label}: ${err instanceof Error ? err.message : String(err)}`); }
      const dropdowns: Record<string, string[]> = {};
      for (const [loc, qid] of Object.entries(questions!)) dropdowns[loc] = cleanOptions(live[qid]?.options);
      return { jotform_form_id: form.jotform_form_id, label: form.label, language: form.language, dropdowns };
    }));
    console.log(`[${FUNCTION}] ok: ${out.length} form(s)`);
    return json(200, { checked_at: new Date().toISOString(), forms: out });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${FUNCTION}] Jotform: ${msg}`);
    return json(502, { error: `Jotform did not answer for ${msg}` });
  }
});
