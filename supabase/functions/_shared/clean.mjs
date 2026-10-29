// Pure functions that turn one Jotform submission into a recruiting.applications row and a list
// of files to copy. No I/O here, so scripts/backfill/clean.test.mjs can exercise every rule in
// CLAUDE.md sections 4 and 5 without an API key.
//
// This is the canonical copy, shared by the backfill (scripts/backfill/lib/clean.mjs re-exports
// it) and the recruiting-jotform-webhook Edge Function. It lives under supabase/functions because
// `supabase functions deploy` only bundles files from that folder. Plain JavaScript, no Node or
// Deno APIs, so both runtimes load it unchanged.
//
// Two submission shapes are accepted:
//   * REST API (GET /form/{id}/submissions): { id, form_id, created_at, status, answers:
//     { "<qid>": { name, text, type, answer, prettyFormat } } }
//   * The shape captured in reference/submission-shape.json: { id, title, url, subtitle,
//     submission_answers: { "<qid>": { answer } } }
// Question types come from the submission when present, else from forms.questions.

const OPTION_TYPES = new Set(["control_dropdown", "control_radio", "control_checkbox"]);
const NO_ANSWER_TYPES = new Set([
  "control_text", "control_head", "control_button", "control_pagebreak", "control_divider",
  "control_signature", "control_image", "control_collapse", "control_captcha",
]);

const LOCATION_ALIASES = new Map([
  ["eugene-springfield", "Eugene/Springfield"],
  ["eugene/springfield", "Eugene/Springfield"],
  ["eugene / springfield", "Eugene/Springfield"],
  ["eugene springfield", "Eugene/Springfield"],
  ["central oregon", "Central Oregon"],
  ["bend", "Central Oregon"],
  ["lake oswego", "Lake Oswego"],
]);

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

export function isBlank(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.every(isBlank);
  if (typeof v === "object") return Object.values(v).every(isBlank);
  return false;
}

export function asArray(v) {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * A checkbox answer is an array of ticked options, or, when the question has an "Other" box
 * that was filled in, an object like { "0": "Indeed.com", "1": "Rexius.com", "other": "text" }.
 * Returns { values, other }.
 */
export function checkboxAnswer(v) {
  if (v === null || v === undefined) return { values: [], other: null };
  if (Array.isArray(v)) return { values: v.filter((x) => !isBlank(x)).map(String), other: null };
  if (typeof v === "object") {
    const values = Object.entries(v)
      .filter(([k, x]) => /^\d+$/.test(k) && !isBlank(x))
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, x]) => String(x));
    const other = isBlank(v.other) ? null : String(v.other).trim();
    return { values, other };
  }
  return { values: isBlank(v) ? [] : [String(v)], other: null };
}

/** "Yes/Si" -> "Yes", "Indeed.com/" -> "Indeed.com", "Email/ Correo electrónico" -> "Email". */
export function beforeFirstSlash(s) {
  const i = s.indexOf("/");
  return (i < 0 ? s : s.slice(0, i)).trim();
}

/** "Blower Truck Driver/" -> "Blower Truck Driver"; "Retail Yard Associate / Delivery Driver" unchanged. */
export function stripTrailingSlash(s) {
  return s.replace(/\s*\/\s*$/, "").trim();
}

/**
 * Cleanup for a dropdown/radio/checkbox value (CLAUDE.md section 4, "Value cleanup").
 * Spanish form: text before the first slash, except positions, which only lose a trailing slash.
 * English and CAS forms: only a trailing slash is stripped.
 */
export function cleanOption(value, { language = "en", isPosition = false } = {}) {
  if (typeof value !== "string") return value;
  const v = value.trim();
  if (language === "es" && !isPosition) return beforeFirstSlash(v);
  return stripTrailingSlash(v);
}

export function normalizeLocation(value) {
  if (isBlank(value)) return null;
  const v = stripTrailingSlash(String(value));
  return LOCATION_ALIASES.get(v.toLowerCase()) ?? v;
}

// normalizeEmail, normalizePhone and storageSafeName are mirrored in web/app.js for manual
// entries (the frontend loads no modules); change both together.
export function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return v.includes("@") ? v : null;
}

/** Digits only, last 10 (drops a leading country code). Fewer than 10 digits is not comparable. */
export function normalizePhone(value) {
  if (isBlank(value)) return null;
  const digits = String(value).replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

export function phoneText(answer) {
  if (isBlank(answer)) return null;
  if (typeof answer === "string") return answer.trim();
  if (typeof answer === "object") {
    if (!isBlank(answer.full)) return String(answer.full).trim();
    const parts = [answer.area, answer.phone].filter((x) => !isBlank(x));
    return parts.length ? parts.join("-") : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Dates and times. Never Date.parse (CLAUDE.md section 4).
// ---------------------------------------------------------------------------------------------

/** Jotform date answer {month, day, year} -> "YYYY-MM-DD", or null when absent or nonsense. */
export function jotformDateToIso(answer) {
  if (isBlank(answer)) return null;
  let y, m, d;
  if (typeof answer === "object") {
    y = Number(answer.year); m = Number(answer.month); d = Number(answer.day);
  } else if (typeof answer === "string") {
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(answer.trim());
    const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(answer.trim());
    if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3]; }
    else if (us) { m = +us[1]; d = +us[2]; y = +us[3]; }
    else return null;
  } else {
    return null;
  }
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "Oct 23, 2026 12:56 AM" -> {y, m, d, h, mi, s}, or null. */
export function parseSubtitle(s) {
  if (typeof s !== "string") return null;
  const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}) (AM|PM)$/.exec(s.trim());
  if (!m || !MONTHS[m[1]]) return null;
  let h = Number(m[4]) % 12;
  if (m[6] === "PM") h += 12;
  return { y: +m[3], m: MONTHS[m[1]], d: +m[2], h, mi: +m[5], s: 0 };
}

/** REST "2026-10-23 00:56:12" -> {y, m, d, h, mi, s}, or null. */
export function parseCreatedAt(s) {
  if (typeof s !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s.trim());
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: m[6] ? +m[6] : 0 };
}

function tzOffsetMs(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - utcMs;
}

/** Wall-clock parts in `timeZone` -> Date (UTC instant). Handles DST by iterating the offset once. */
export function zonedPartsToDate(parts, timeZone) {
  const guess = Date.UTC(parts.y, parts.m - 1, parts.d, parts.h, parts.mi, parts.s ?? 0);
  const off1 = tzOffsetMs(guess, timeZone);
  let utc = guess - off1;
  const off2 = tzOffsetMs(utc, timeZone);
  if (off2 !== off1) utc = guess - off2;
  return new Date(utc);
}

/**
 * Submitted time for a submission. Jotform's REST `created_at` is wall-clock time in the
 * account's time zone (Rexius: America/Los_Angeles); the inbox `subtitle` is the same clock.
 */
export function submittedAt(submission, timeZone) {
  const parts = parseCreatedAt(submission.created_at) ?? parseSubtitle(submission.subtitle);
  return parts ? zonedPartsToDate(parts, timeZone) : null;
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

// Jotform returns upload URLs with the original file name unencoded, spaces included, and
// sometimes a `?nc=1` suffix; fetch() and new URL() percent-encode the spaces when downloading.
const UPLOAD_URL = /^https?:\/\/[^\s"'<>]+\/uploads\/[^"'<>]+$/i;

export function isUploadUrl(v) {
  return typeof v === "string" && UPLOAD_URL.test(v.trim());
}

/** Signature images are never imported, whatever question they came from. */
export function isSignatureUrl(v) {
  return typeof v === "string" && /_signature_/i.test(v);
}

export function fileNameFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const last = path.split("/").filter(Boolean).pop() ?? "file";
    return decodeURIComponent(last);
  } catch {
    return url.split("/").pop() || "file";
  }
}

/** Object key inside the bucket. Safe characters only; the original name stays in the table. */
export function storageSafeName(name, index) {
  const cleaned = name.normalize("NFKD").replace(/[^\x20-\x7E]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^[_.]+/, "").slice(0, 120);
  const base = cleaned || "file";
  return index > 0 ? `${index}_${base}` : base;
}

// ---------------------------------------------------------------------------------------------
// Submission -> row
// ---------------------------------------------------------------------------------------------

function rawAnswers(submission) {
  return submission.answers ?? submission.submission_answers ?? {};
}

function questionType(qid, raw, form) {
  return raw?.type ?? form.questions?.[qid]?.type ?? null;
}

function cleanAnswerValue(qid, value, type, { language, positionQids }) {
  if (isBlank(value)) return undefined;
  if (typeof value === "string" && isSignatureUrl(value)) return undefined;
  if (OPTION_TYPES.has(type)) {
    const opts = { language, isPosition: positionQids.has(qid) };
    if (type === "control_checkbox" && typeof value === "object" && !Array.isArray(value)) {
      const { values, other } = checkboxAnswer(value);
      const arr = values.map((v) => cleanOption(v, opts)).filter((v) => !isBlank(v));
      if (other) arr.push(`Other: ${other}`);
      return arr.length ? arr : undefined;
    }
    if (Array.isArray(value)) {
      const arr = value.map((v) => cleanOption(v, opts)).filter((v) => !isBlank(v));
      return arr.length ? arr : undefined;
    }
    return cleanOption(value, opts) || undefined;
  }
  if (type === "control_datetime") return jotformDateToIso(value) ?? undefined;
  if (type === "control_phone") return phoneText(value) ?? undefined;
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    const arr = value.filter((v) => !isBlank(v) && !isSignatureUrl(v));
    return arr.length ? arr : undefined;
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (!isBlank(v) && !isSignatureUrl(v)) out[k] = typeof v === "string" ? v.trim() : v;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value;
}

/**
 * Build the applications row, the files to copy, and warnings for one submission.
 *
 * @param submission  Jotform submission (either shape above)
 * @param form        row of recruiting.forms: { id, jotform_form_id, language, default_location,
 *                    questions, field_map }
 * @param positions   array of { id, title, location, jotform_option_label }
 * @param options     { timeZone }
 */
export function buildApplication(submission, form, positions, { timeZone = "America/Los_Angeles" } = {}) {
  const warnings = [];
  const fm = form.field_map ?? {};
  const language = form.language === "es" ? "es" : "en";
  const raw = rawAnswers(submission);
  const neverImport = new Set((fm.never_import ?? []).map(String));
  const positionQids = new Set(
    typeof fm.position === "object" && fm.position ? Object.values(fm.position).map(String)
      : fm.position ? [String(fm.position)] : [],
  );
  const get = (qid) => (qid == null ? undefined : raw[String(qid)]?.answer);

  // Cleaned answers: every question except never-import ones and non-answers.
  const answers = {};
  for (const [qid, item] of Object.entries(raw)) {
    if (!/^\d+$/.test(qid)) continue; // the inbox shape carries a "created_at" pseudo-answer
    if (neverImport.has(qid)) continue;
    const type = questionType(qid, item, form);
    if (NO_ANSWER_TYPES.has(type)) continue;
    const v = cleanAnswerValue(qid, item?.answer, type, { language, positionQids });
    if (v !== undefined) answers[qid] = v;
  }
  // Licence class ("Class or Type of License", question 35 on every form) is kept because many
  // roles need a CDL. It is a free-text box right under the licence number, so an answer that
  // looks like a number (five or more digits in a row) or runs long is dropped rather than stored;
  // the number and expiry themselves stay in never_import (CLAUDE.md section 5).
  const licenceQid = fm.licence_class == null ? null : String(fm.licence_class);
  if (licenceQid && licenceQid in answers) {
    const v = answers[licenceQid];
    if (typeof v !== "string" || /\d{5,}/.test(v) || v.trim().length > 60) {
      delete answers[licenceQid];
      warnings.push(`licence class answer dropped (looked like a licence number)`);
    }
  }

  // Name
  const nameAns = get(fm.name);
  let first = null, last = null, name = null;
  if (nameAns && typeof nameAns === "object") {
    first = isBlank(nameAns.first) ? null : String(nameAns.first).trim();
    last = isBlank(nameAns.last) ? null : String(nameAns.last).trim();
    const middle = isBlank(nameAns.middle) ? null : String(nameAns.middle).trim();
    name = [first, middle, last].filter(Boolean).join(" ");
  } else if (typeof nameAns === "string" && !isBlank(nameAns)) {
    name = nameAns.trim();
    const parts = name.split(/\s+/);
    first = parts[0]; last = parts.length > 1 ? parts[parts.length - 1] : null;
  }
  if (!name && typeof submission.title === "string" && !isBlank(submission.title)) name = submission.title.trim();
  if (!name) { name = "(no name)"; warnings.push("no name on submission"); }

  // Contact
  const email = isBlank(get(fm.email)) ? null : String(get(fm.email)).trim();
  const phone = phoneText(get(fm.phone)) ?? phoneText(get(fm.phone_alt));
  // The address question (263) is in never_import since 2026-10-28, so the street address,
  // apartment line and postal code never reach `answers`; only city and state are kept, in
  // their own columns, read straight from the raw answer here.
  const addr = get(fm.address);
  const city = addr && typeof addr === "object" && !isBlank(addr.city) ? String(addr.city).trim() : null;
  const state = addr && typeof addr === "object" && !isBlank(addr.state) ? String(addr.state).trim() : null;

  // Location and position
  let location = fm.location ? normalizeLocation(cleanOption(String(get(fm.location) ?? ""), { language })) : null;
  let positionText = null;
  if (typeof fm.position === "object" && fm.position) {
    // One dropdown per location. Prefer the one for the chosen location; otherwise whichever
    // was answered, and infer the location from it.
    const answered = Object.entries(fm.position)
      .map(([loc, qid]) => [normalizeLocation(loc), cleanOption(String(get(qid) ?? ""), { language, isPosition: true })])
      .filter(([, v]) => !isBlank(v));
    const forLocation = answered.find(([loc]) => loc === location);
    if (forLocation) positionText = forLocation[1];
    else if (answered.length) {
      positionText = answered[0][1];
      if (!location) location = answered[0][0];
      else warnings.push(`position answered for ${answered[0][0]} but location is ${location}`);
    }
  } else if (fm.position) {
    const v = get(fm.position);
    positionText = isBlank(v) ? null : stripTrailingSlash(String(v));
  }
  if (!location && form.default_location) location = form.default_location;

  let positionId = null;
  if (positionText && location) {
    const want = positionText.toLowerCase();
    const hit = positions.find((p) =>
      p.jotform_option_label && p.location === location && p.jotform_option_label.toLowerCase() === want);
    positionId = hit?.id ?? null;
  }

  // Source
  const sourceAns = checkboxAnswer(get(fm.source));
  const sources = sourceAns.values.map((v) => cleanOption(v, { language })).filter((v) => !isBlank(v));
  const source = sources[0] ?? (sourceAns.other ? "Other" : null);
  const detailParts = [];
  if (sourceAns.other) detailParts.push(sourceAns.other);
  const other = fm.source_other ? get(fm.source_other) : null;
  if (!isBlank(other) && String(other).trim() !== sourceAns.other) detailParts.push(String(other).trim());
  if (sources.length > 1) detailParts.push(`also: ${sources.slice(1).join(", ")}`);
  const sourceDetail = detailParts.length ? detailParts.join(" | ") : null;
  const referredBy = isBlank(get(fm.referred_by)) ? null : String(get(fm.referred_by)).trim();

  // Dates
  const submitted = submittedAt(submission, timeZone);
  if (!submitted) warnings.push(`unparseable submission time: ${submission.created_at ?? submission.subtitle}`);
  const availableStart = jotformDateToIso(get(fm.available_start));

  // Files: any upload URL anywhere in the answers that is not a signature image.
  const kindByQid = new Map();
  if (fm.resume) kindByQid.set(String(fm.resume), "resume");
  if (fm.portfolio_file) kindByQid.set(String(fm.portfolio_file), "portfolio");
  const files = [];
  const seen = new Set();
  for (const [qid, item] of Object.entries(raw)) {
    if (!/^\d+$/.test(qid)) continue;
    // Never-import questions and signature fields are not even looked at: one real submission
    // had a signature stored as a malformed upload URL without `_signature_` in it.
    if (neverImport.has(qid) || questionType(qid, item, form) === "control_signature") continue;
    const values = [];
    const walk = (v) => {
      if (typeof v === "string") values.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(item?.answer);
    for (const v of values) {
      const url = v.trim();
      if (!isUploadUrl(url) || isSignatureUrl(url) || seen.has(url)) continue;
      seen.add(url);
      files.push({ qid, url, kind: kindByQid.get(qid) ?? "other", original_name: fileNameFromUrl(url) });
    }
  }
  files.forEach((f, i) => {
    const dupes = files.filter((g, j) => j < i && g.original_name === f.original_name).length;
    f.storage_name = storageSafeName(f.original_name, dupes);
  });

  const submissionId = String(submission.id);
  const row = {
    jotform_submission_id: submissionId,
    form_id: form.id,
    submitted_at: submitted ? submitted.toISOString() : null,
    name,
    first_name: first,
    last_name: last,
    email,
    email_norm: normalizeEmail(email),
    phone,
    phone_norm: normalizePhone(phone),
    city,
    state,
    location,
    position_text: positionText,
    position_id: positionId,
    source,
    source_detail: sourceDetail,
    referred_by: referredBy,
    available_start: availableStart,
    has_resume: files.some((f) => f.kind === "resume"),
    language,
    answers,
    jotform_url: `https://www.jotform.com/inbox/${form.jotform_form_id}/${submissionId}`,
  };

  return { row, files, warnings };
}
