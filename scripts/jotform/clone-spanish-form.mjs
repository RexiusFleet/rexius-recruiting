#!/usr/bin/env node
// Create the Spanish 2026 application form as a clone of the English 2026 form.
//
// Why a clone and not an edit of the 2025 Spanish form: Jotform deletes a question's answers from
// every past submission when the question is removed, and the 2025 form holds the archive for
// everything the tracker has purged (CLAUDE.md section 5). The English form is the source of
// truth for wording and structure, so the Spanish form is built from it: same question IDs,
// same conditions, same options, with a Spanish half added to every label from
// spanish-2026.translations.mjs. Because IDs match, the tracker reuses the English field map.
//
// What the clone keeps (checked on a throwaway clone 2026-10-31, Jotform help article 42):
// questions, conditions, thank-you page and redirect, the webhook endpoint, email notifications
// with their content. The script then sets the title, the Spanish thank-you page on rexius.com,
// rewrites conditions whose option values changed, and re-adds the webhook if it is missing.
//
// Usage (reads JOTFORM_API_KEY from the shell or the gitignored .env; never prints it):
//   node scripts/jotform/clone-spanish-form.mjs --dry-run     plan only, no writes
//   node scripts/jotform/clone-spanish-form.mjs --test        clone, apply, verify, delete
//   node scripts/jotform/clone-spanish-form.mjs               the real run: creates the form,
//                                                             writes the forms-row migration and
//                                                             the reference entry
//   --source <formID>   English form to clone (default 260115636145148)
//   --keep              with --test, leave the test clone in place (delete it in Jotform later)
//
// The run is not idempotent: each real run creates another form. Run it once, then do the
// manual steps it prints (README "What the Spanish 2026 form created").

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FORM, QUESTIONS, SKIP_TYPES } from "./spanish-2026.translations.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const envFile = join(repoRoot, ".env");
if (existsSync(envFile) && typeof process.loadEnvFile === "function") process.loadEnvFile(envFile);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const DRY = flag("--dry-run"), TEST = flag("--test"), KEEP = flag("--keep");
const SOURCE = opt("--source", "260115636145148");
const BASE = (process.env.JOTFORM_API_BASE || "https://api.jotform.com").replace(/\/$/, "");
const KEY = process.env.JOTFORM_API_KEY;
if (!KEY) { console.error("JOTFORM_API_KEY is not set (shell or .env at the repo root)."); process.exit(1); }

const redact = (s) => String(s).replace(/secret=[^&"\\\s]+/g, "secret=<redacted>");
const fail = (msg) => { console.error("Error: " + msg); process.exit(1); };

async function api(method, path, { form, json } = {}) {
  const init = { method, headers: { APIKEY: KEY, Accept: "application/json" } };
  if (json) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(json); }
  else if (form) { const f = new URLSearchParams(); for (const [k, v] of Object.entries(form)) f.set(k, String(v)); init.body = f; }
  let res, text;
  for (let attempt = 1; ; attempt++) {
    res = await fetch(BASE + path, init);
    text = await res.text();
    if (res.status !== 429 && res.status < 500) break;
    if (attempt >= 4) break;
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  let body; try { body = JSON.parse(text); } catch { throw new Error(`${method} ${path}: HTTP ${res.status}, non-JSON body`); }
  if (!res.ok || (body.responseCode && body.responseCode !== 200)) {
    const err = new Error(`${method} ${path}: HTTP ${res.status} responseCode ${body.responseCode}: ${redact(body.message ?? "")}`);
    err.status = res.status; err.message_raw = body.message; throw err;
  }
  return body.content;
}

// ---------------------------------------------------------------------------------------------
// Compose the per-question updates from the English form and the translation table
// ---------------------------------------------------------------------------------------------

const HTML_TYPES = new Set(["control_text"]);
const SIMPLE_STRINGS = ["subLabel", "hint", "emptyText", "otherText", "nextButtonText", "buttonText", "clearText"];
const bilingual = (en, es) => `${String(en).trim()}/ ${es}`;

function compose(sourceQuestions) {
  const updates = [];          // [{ qid, fields: { "question[text]": ..., ... } }]
  const valueMaps = {};        // qid -> { oldOption: newOption } for conditions
  const untranslated = [], notes = [];
  const ordered = Object.values(sourceQuestions).sort((a, b) => Number(a.order) - Number(b.order));
  for (const q of ordered) {
    const qid = String(q.qid);
    if (SKIP_TYPES.has(q.type)) continue;
    const tr = QUESTIONS[qid];
    if (!tr) { untranslated.push(`${qid} ${q.type} "${String(q.text).slice(0, 60)}"`); continue; }
    const fields = {};
    if (tr.text) {
      if (!q.text) notes.push(`${qid}: source has no text; Spanish text skipped`);
      else fields["question[text]"] = HTML_TYPES.has(q.type) ? `${q.text}\n${tr.text}` : bilingual(q.text, tr.text);
    }
    if (tr.options || tr.values) {
      if (typeof q.options !== "string") notes.push(`${qid}: translation has options but the source question has none`);
      else {
        const map = {};
        const out = q.options.split("|").map((o) => {
          const nv = tr.values?.[o] ?? (tr.options?.[o] ? bilingual(o, tr.options[o]) : o);
          if (nv !== o) map[o] = nv;
          return nv;
        });
        for (const key of Object.keys({ ...(tr.options ?? {}), ...(tr.values ?? {}) })) {
          if (!q.options.split("|").includes(key)) notes.push(`${qid}: option "${key}" is not on the English form (ignored)`);
        }
        fields["question[options]"] = out.join("|");
        if (Object.keys(map).length) valueMaps[qid] = map;
      }
    }
    if (tr.sublabels) {
      if (!q.sublabels || typeof q.sublabels !== "object") notes.push(`${qid}: translation has sublabels but the source has none`);
      else {
        // Jotform replaces the whole sublabels object with what is posted, so every existing key
        // goes back, translated or not.
        for (const [k, en] of Object.entries(q.sublabels)) {
          fields[`question[sublabels][${k}]`] = tr.sublabels[k] && en ? bilingual(en, tr.sublabels[k]) : en;
        }
        for (const k of Object.keys(tr.sublabels)) if (!(k in q.sublabels)) notes.push(`${qid}: sublabel "${k}" not on the source (ignored)`);
      }
    }
    for (const k of SIMPLE_STRINGS) {
      if (!tr[k]) continue;
      if (!q[k]) { notes.push(`${qid}: ${k} is empty on the source; set to Spanish only`); fields[`question[${k}]`] = tr[k]; }
      else fields[`question[${k}]`] = bilingual(q[k], tr[k]);
    }
    if (Object.keys(fields).length) updates.push({ qid, type: q.type, fields });
  }
  for (const qid of Object.keys(QUESTIONS)) if (!sourceQuestions[qid]) notes.push(`translation for ${qid} has no question on the English form (ignored)`);
  return { updates, valueMaps, untranslated, notes };
}

function rewriteConditions(conditions, valueMaps) {
  let changed = 0;
  const out = conditions.map((c) => {
    let terms; try { terms = JSON.parse(c.terms); } catch { return c; }
    let touched = false;
    for (const t of terms) {
      const map = valueMaps[String(t.field)];
      if (map && typeof t.value === "string" && map[t.value] !== undefined) { t.value = map[t.value]; touched = true; }
    }
    if (!touched) return c;
    changed++;
    return { ...c, terms: JSON.stringify(terms) };
  });
  return { conditions: out, changed };
}

// ---------------------------------------------------------------------------------------------

const srcQuestions = await api("GET", `/form/${SOURCE}/questions`);
const srcProps = await api("GET", `/form/${SOURCE}/properties`);
const srcWebhooks = Object.values((await api("GET", `/form/${SOURCE}/webhooks`)) ?? {});
console.log(`Source: ${srcProps.title} (${SOURCE}), ${Object.keys(srcQuestions).length} questions, ${(srcProps.conditions ?? []).length} conditions, ${srcWebhooks.length} webhook(s), ${(srcProps.emails ?? []).length} email(s)`);

const plan = compose(srcQuestions);
const condPlan = rewriteConditions(srcProps.conditions ?? [], plan.valueMaps);
console.log(`Plan: ${plan.updates.length} questions to update, ${Object.keys(plan.valueMaps).length} option lists change values, ${condPlan.changed} conditions to rewrite`);
for (const n of plan.notes) console.log("  note: " + n);
if (plan.untranslated.length) {
  console.log(`  ${plan.untranslated.length} question(s) without a translation:`);
  for (const u of plan.untranslated) console.log("    " + u);
}
if (DRY) {
  for (const u of plan.updates.slice(0, 6)) console.log(`  ${u.qid} ${u.type}: ${JSON.stringify(u.fields).slice(0, 220)}`);
  console.log("Dry run: nothing written.");
  process.exit(0);
}
if (plan.untranslated.length) fail("every visible question needs a translation (or its type in SKIP_TYPES) before the form is created");
if (!srcWebhooks.length) fail("the English form has no webhook; add it first (README step 14) so the clone can carry it over");

// ---------------------------------------------------------------------------------------------
// Create and shape the form
// ---------------------------------------------------------------------------------------------

const title = TEST ? `ZZ TEST ${FORM.title} (delete me)` : FORM.title;
const clone = await api("POST", `/form/${SOURCE}/clone`);
const id = String(clone.id);
console.log(`Cloned -> ${id} "${clone.title}"`);
let ok = false;
try {
  let n = 0;
  for (const u of plan.updates) { await api("POST", `/form/${id}/question/${u.qid}`, { form: u.fields }); n++; }
  console.log(`Updated ${n} questions`);

  const props = { title, pagetitle: TEST ? title : FORM.pagetitle, thankurl: FORM.thankurl, activeRedirect: "thankurl" };
  if (condPlan.changed) props.conditions = condPlan.conditions;
  const cloneProps = await api("GET", `/form/${id}/properties`);
  const emails = (cloneProps.emails ?? []).map((e) => (e.pdfId === SOURCE ? { ...e, pdfId: id } : e));
  if (emails.some((e, i) => e !== cloneProps.emails[i])) props.emails = emails;
  await api("PUT", `/form/${id}/properties`, { json: { properties: props } });
  console.log(`Set title, thank-you page${condPlan.changed ? `, ${condPlan.changed} rewritten conditions` : ""}${props.emails ? ", email PDF ids" : ""}`);

  let hooks = Object.values((await api("GET", `/form/${id}/webhooks`)) ?? {});
  for (const url of srcWebhooks) {
    if (hooks.includes(url)) continue;
    try { await api("POST", `/form/${id}/webhooks`, { form: { webhookURL: url } }); }
    catch (e) { if (e.status !== 400) throw e; } // 400 = already registered
  }
  hooks = Object.values((await api("GET", `/form/${id}/webhooks`)) ?? {});

  // Verify against the source
  const newQ = await api("GET", `/form/${id}/questions`);
  const newP = await api("GET", `/form/${id}/properties`);
  const problems = [];
  const srcIds = Object.keys(srcQuestions).sort(), newIds = Object.keys(newQ).sort();
  if (srcIds.join() !== newIds.join()) problems.push(`question IDs differ: source ${srcIds.length}, clone ${newIds.length}`);
  for (const qid of srcIds) {
    const a = srcQuestions[qid], b = newQ[qid];
    if (!b) continue;
    if (a.type !== b.type) problems.push(`${qid}: type ${a.type} -> ${b.type}`);
    if (String(a.order) !== String(b.order)) problems.push(`${qid}: order ${a.order} -> ${b.order}`);
    if (String(a.required ?? "") !== String(b.required ?? "")) problems.push(`${qid}: required ${a.required} -> ${b.required}`);
    const tr = QUESTIONS[qid];
    if (tr?.text && a.text && !String(b.text).startsWith(String(a.text).trim())) problems.push(`${qid}: text does not start with the English text`);
    if (tr?.text && a.text && !String(b.text).includes(tr.text.slice(0, 20))) problems.push(`${qid}: Spanish text missing`);
    if (a.sublabels && b.sublabels && Object.keys(a.sublabels).sort().join() !== Object.keys(b.sublabels).sort().join()) problems.push(`${qid}: sublabel keys changed`);
    if (typeof a.options === "string" && a.options.split("|").length !== String(b.options ?? "").split("|").length) problems.push(`${qid}: option count changed`);
  }
  if ((newP.conditions ?? []).length !== (srcProps.conditions ?? []).length) problems.push(`conditions: ${srcProps.conditions?.length} -> ${newP.conditions?.length}`);
  for (const url of srcWebhooks) if (!hooks.includes(url)) problems.push("webhook missing on the new form");
  if (newP.thankurl !== FORM.thankurl || newP.activeRedirect !== "thankurl") problems.push(`thank-you redirect is ${newP.activeRedirect} ${newP.thankurl}`);
  if ((newP.emails ?? []).length !== (srcProps.emails ?? []).length) problems.push(`emails: ${srcProps.emails?.length} -> ${newP.emails?.length}`);
  for (const e of newP.emails ?? []) if (!e.body || e.body.length < 200) problems.push(`email "${e.name}" has no body (Jotform reset it); recreate it in the builder`);

  console.log("\nNew form");
  console.log(`  title:        ${newP.title}`);
  console.log(`  url:          https://form.jotform.com/${id}`);
  console.log(`  thank-you:    ${newP.activeRedirect} -> ${newP.thankurl}`);
  console.log(`  conditions:   ${(newP.conditions ?? []).length}`);
  console.log(`  webhooks:     ${hooks.map(redact).join(", ") || "none"}`);
  for (const e of newP.emails ?? []) console.log(`  email:        ${e.type} "${e.name}" to ${e.to}; subject "${e.subject}"; sends on submit: ${e.sendOnSubmit === "1" ? "yes" : "no"}`);
  if (problems.length) { console.log(`\n${problems.length} problem(s):`); for (const p of problems) console.log("  - " + p); }
  else console.log("\nVerification passed: same questions, types, order and conditions as the English form; every label carries its Spanish half.");
  ok = problems.length === 0;

  if (!TEST) {
    writeMigration(id, newQ, newP.title);
    writeReference(id, newQ, newP.title);
    console.log(`
Next (README "What the Spanish 2026 form created"):
  1. Open https://www.jotform.com/build/${id} and read it through once; have a Spanish speaker check the agreement text.
  2. Apply the migration: npm run db:migrate  (adds the forms row so the webhook accepts submissions).
  3. Submit one test application, confirm it appears in the tracker, then delete the test in Jotform and the tracker.
  4. Point the careers page's Spanish link at https://form.jotform.com/${id}.
  5. Disable the 2025 Spanish form in Jotform and run: update recruiting.forms set is_active = false where jotform_form_id = '232824275836160';`);
  }
} finally {
  if (TEST && !KEEP) { await api("DELETE", `/form/${id}`); console.log(`Deleted test clone ${id}`); }
  else if (TEST) console.log(`Kept test clone ${id}; delete it in Jotform when done.`);
}
process.exit(ok ? 0 : 2);

// ---------------------------------------------------------------------------------------------

function questionsForDb(newQ) {
  const out = {};
  for (const [qid, q] of Object.entries(newQ)) {
    const row = { name: q.name, order: q.order, text: q.text, type: q.type };
    if (typeof q.options === "string" && q.options) row.options = Object.fromEntries(q.options.split("|").map((o) => [o, o]));
    out[qid] = row;
  }
  return out;
}

function writeMigration(id, newQ, formTitle) {
  const stamp = "20261110000100";
  const path = join(repoRoot, "supabase", "migrations", `${stamp}_spanish_form_2026.sql`);
  const questions = JSON.stringify(questionsForDb(newQ));
  if (questions.includes("$json$")) fail("question text contains the quoting tag $json$");
  const sql = `-- Spanish 2026 application form (${formTitle}, Jotform ${id}), created on 2026-10-31 by
-- scripts/jotform/clone-spanish-form.mjs as a clone of the English 2026 form. Same question IDs,
-- so the field map is copied from the English row; language 'es' applies the Spanish option rule
-- ("Yes/ Sí" -> "Yes") in clean.mjs. The 2025 Spanish form stays active until the careers page
-- links here; README "What the Spanish 2026 form created" has the switch-over steps.

insert into recruiting.forms (jotform_form_id, label, language, default_location, questions, field_map)
select
  '${id}',
  '${formTitle.replace(/'/g, "''")} (Spanish)',
  'es',
  null,
  $json$${questions}$json$::jsonb,
  en.field_map
from recruiting.forms en
where en.jotform_form_id = '${SOURCE}'
on conflict (jotform_form_id) do nothing;
`;
  writeFileSync(path, sql);
  console.log(`Wrote ${path.replace(repoRoot + "/", "")}`);
}

function writeReference(id, newQ, formTitle) {
  const path = join(repoRoot, "reference", "jotform-forms.json");
  const ref = JSON.parse(readFileSync(path, "utf8"));
  ref[id] = { title: formTitle, submission_count_2026_10_31: 0, questions: questionsForDb(newQ) };
  writeFileSync(path, JSON.stringify(ref, null, 2) + "\n");
  console.log(`Added ${id} to reference/jotform-forms.json`);
}
