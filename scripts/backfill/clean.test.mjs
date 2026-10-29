// Unit tests for the cleanup rules (CLAUDE.md sections 4 and 5). Run: npm run backfill:test
// Uses the real field maps and question lists from reference/jotform-forms.json and the seed
// migration, with invented answers. No network, no database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  beforeFirstSlash, buildApplication, cleanOption, fileNameFromUrl, isSignatureUrl, isUploadUrl, jotformDateToIso,
  normalizeEmail, normalizeLocation, normalizePhone, parseSubtitle, storageSafeName,
  stripTrailingSlash, zonedPartsToDate,
} from "./lib/clean.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const reference = JSON.parse(readFileSync(join(repoRoot, "reference", "jotform-forms.json"), "utf8"));
const seedSql = readFileSync(join(repoRoot, "supabase", "migrations", "20261026000400_seed_stages_forms_positions.sql"), "utf8");

// The field maps exactly as the seed migration stores them in recruiting.forms.field_map.
const fieldMaps = [...seedSql.matchAll(/\$json\$(\{"address".*?\})\$json\$/gs)].map((m) => JSON.parse(m[1]));
assert.equal(fieldMaps.length, 3, "expected three field maps in the seed migration");

// Migration 20261101000100 moves question 35 (licence class) out of never_import into a
// `licence_class` key on every form; the fixtures get the same change so the tests see the
// field maps as the database holds them after that migration.
for (const fm of fieldMaps) {
  fm.never_import = (fm.never_import ?? []).filter((q) => String(q) !== "35");
  fm.licence_class = "35";
}
// Migration 20261103000100 adds question 263 (street address) to never_import on every form;
// city and state are still read from it into their own columns.
for (const fm of fieldMaps) fm.never_import.push("263");
const forms = {
  en: { id: 1, jotform_form_id: "260115636145148", language: "en", default_location: null, questions: reference["260115636145148"].questions, field_map: fieldMaps[0] },
  es: { id: 2, jotform_form_id: "232824275836160", language: "es", default_location: null, questions: reference["232824275836160"].questions, field_map: fieldMaps[1] },
  cas: { id: 3, jotform_form_id: "232764918957171", language: "en", default_location: "CAS", questions: reference["232764918957171"].questions, field_map: fieldMaps[2] },
};
const positions = [
  { id: "p-eug-maint", title: "Landscape Maintenance Crew Member", location: "Eugene/Springfield", jotform_option_label: "Landscape Maintenance Crew Member" },
  { id: "p-co-maint", title: "Landscape Maintenance Crew Member", location: "Central Oregon", jotform_option_label: "Landscape Maintenance Crew Member" },
  { id: "p-lo-blower", title: "Blower Truck Crew Member", location: "Lake Oswego", jotform_option_label: "Blower Truck Crew Member" },
];

const a = (answers) => Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, { answer: v }]));

test("string cleanup rules", () => {
  assert.equal(beforeFirstSlash("Yes/Si"), "Yes");
  assert.equal(beforeFirstSlash("Indeed.com/"), "Indeed.com");
  assert.equal(beforeFirstSlash("Email/ Correo electrónico"), "Email");
  assert.equal(stripTrailingSlash("Blower Truck Driver/"), "Blower Truck Driver");
  assert.equal(stripTrailingSlash("Retail Yard Associate / Delivery Driver"), "Retail Yard Associate / Delivery Driver");
  assert.equal(cleanOption("Retail Yard Associate / Delivery Driver/", { language: "es", isPosition: true }), "Retail Yard Associate / Delivery Driver");
  assert.equal(cleanOption("High School Diploma/ Diploma de secundaria", { language: "es" }), "High School Diploma");
  assert.equal(cleanOption("Any/", { language: "en" }), "Any");
  assert.equal(normalizeLocation("Eugene-Springfield"), "Eugene/Springfield");
  assert.equal(normalizeLocation("Central Oregon/"), "Central Oregon");
  assert.equal(normalizeEmail("  Jordan.Rivera@Example.COM "), "jordan.rivera@example.com");
  assert.equal(normalizeEmail("not an email"), null);
  assert.equal(normalizePhone("(541) 555-0101"), "5415550101");
  assert.equal(normalizePhone("+1 541 555 0101"), "5415550101");
  assert.equal(normalizePhone("555-0101"), null);
});

test("dates without Date.parse", () => {
  assert.equal(jotformDateToIso({ month: "3", day: "9", year: "2026" }), "2026-03-09");
  assert.equal(jotformDateToIso({ month: "2", day: "30", year: "2026" }), null);
  assert.equal(jotformDateToIso("11/05/2026"), "2026-11-05");
  assert.equal(jotformDateToIso(""), null);
  assert.deepEqual(parseSubtitle("Oct 23, 2026 12:56 AM"), { y: 2026, m: 10, d: 23, h: 0, mi: 56, s: 0 });
  assert.deepEqual(parseSubtitle("Jul 4, 2025 1:05 PM"), { y: 2025, m: 7, d: 4, h: 13, mi: 5, s: 0 });
  assert.equal(parseSubtitle("2026-10-23"), null);
  // PDT (UTC-7) in October, PST (UTC-8) in January.
  assert.equal(zonedPartsToDate({ y: 2026, m: 10, d: 23, h: 0, mi: 56, s: 0 }, "America/Los_Angeles").toISOString(), "2026-10-23T07:56:00.000Z");
  assert.equal(zonedPartsToDate({ y: 2026, m: 1, d: 15, h: 9, mi: 0, s: 0 }, "America/Los_Angeles").toISOString(), "2026-01-15T17:00:00.000Z");
});

test("upload and signature URL detection", () => {
  assert.ok(isUploadUrl("https://www.jotform.com/uploads/rexius/260115636145148/6000000000000000001/6000000000000000001_resume.pdf"));
  assert.ok(isUploadUrl("https://www.jotform.com/uploads/rexius/260115636145148/6000000000000000001/Resume march 2026.docx"));
  assert.ok(isUploadUrl("https://www.jotform.com/uploads/rexius/260115636145148/6000000000000000001/x.png?nc=1"));
  assert.ok(!isUploadUrl("https://rexius.com/blogs/careers"));
  assert.ok(!isUploadUrl("https://example.invalid/uploads/x.pdf"));
  assert.ok(!isUploadUrl("http://www.jotform.com/uploads/x.pdf"));
  assert.ok(!isUploadUrl("https://www.jotform.com.evil.invalid/uploads/x.pdf"));
  assert.ok(!isUploadUrl("https://www.jotform.com:444/uploads/x.pdf"));
  assert.ok(!isUploadUrl("https://user@www.jotform.com/uploads/x.pdf"));
  assert.equal(fileNameFromUrl("https://www.jotform.com/uploads/rexius/260115636145148/6000000000000000001/Resume march 2026.docx"), "Resume march 2026.docx");
  assert.ok(isSignatureUrl("https://www.jotform.com/uploads/rexius/260115636145148/6000000000000000001/6000000000000000001_signature_369.png"));
  assert.equal(storageSafeName("Résumé (final) v2.pdf", 0), "Resume_final_v2.pdf");
  assert.equal(storageSafeName("resume.pdf", 1), "1_resume.pdf");
});

test("English submission: fields, position link, files, never-import", () => {
  const sub = {
    id: "6000000000000000001", form_id: "260115636145148", created_at: "2026-10-23 00:56:12", status: "ACTIVE",
    answers: {
      ...a({
        9: { first: "Jordan", middle: "", last: "Rivera" },
        22: "Jordan.Rivera@Example.com",
        264: { full: "(541) 555-0101" },
        263: { addr_line1: "1 Main St", city: "Eugene", state: "OR", postal: "97401" },
        21: ["Email"],
        342: "Eugene/Springfield",
        340: "Landscape Maintenance Crew Member",
        268: ["Indeed.com", "Rexius.com"],
        384: "Saw the truck",
        261: { month: "11", day: "2", year: "2026" },
        344: "High School Diploma",
        272: "No", 274: "Yes",
        72: "Green Valley", 280: "Springfield, OR", 76: "Crew", 348: "03/2023", 377: "09/2026", 352: "Seasonal layoff",
        387: ["https://www.jotform.com/uploads/rexius/260115636145148/6000000000000000001/6000000000000000001_resume.pdf"],
        393: ["https://www.jotform.com/uploads/rexius/260115636145148/6000000000000000001/6000000000000000001_portfolio.pdf"],
        30: "A1234567", 31: { month: "1", day: "1", year: "2030" }, 35: "C",
        324: "JR", 326: "JR", 328: "JR", 330: "JR", 332: "JR",
        369: "https://www.jotform.com/uploads/rexius/260115636145148/6000000000000000001/6000000000000000001_signature_369.png",
        333: "https://www.jotform.com/uploads/rexius/260115636145148/6000000000000000001/6000000000000000001_signature_333.png",
        238: "https://www.jotform.com/uploads/rexius/260115636145148/6000000000000000001/6000000000000000001_signature_238.png",
      }),
      // REST payloads also carry type/text per answer.
      "217": { type: "control_text", text: "PLEASE READ", answer: undefined },
    },
  };
  const { row, files, warnings } = buildApplication(sub, forms.en, positions);
  assert.deepEqual(warnings, []);
  assert.equal(row.name, "Jordan Rivera");
  assert.equal(row.first_name, "Jordan");
  assert.equal(row.last_name, "Rivera");
  assert.equal(row.email, "Jordan.Rivera@Example.com");
  assert.equal(row.email_norm, "jordan.rivera@example.com");
  assert.equal(row.phone, "(541) 555-0101");
  assert.equal(row.phone_norm, "5415550101");
  assert.equal(row.city, "Eugene");
  assert.equal(row.state, "OR");
  assert.equal(row.location, "Eugene/Springfield");
  assert.equal(row.position_text, "Landscape Maintenance Crew Member");
  assert.equal(row.position_id, "p-eug-maint");
  assert.equal(row.source, "Indeed.com");
  assert.equal(row.source_detail, "Saw the truck | also: Rexius.com");
  assert.equal(row.available_start, "2026-11-02");
  assert.equal(row.submitted_at, "2026-10-23T07:56:12.000Z");
  assert.equal(row.has_resume, true);
  assert.equal(row.language, "en");
  assert.equal(row.jotform_url, "https://www.jotform.com/inbox/260115636145148/6000000000000000001");
  // Never-import questions are gone from answers; nothing signature-like survives anywhere.
  for (const qid of ["30", "31", "238", "333", "369", "324", "325", "326", "327", "328", "329", "330", "331", "332"]) {
    assert.ok(!(qid in row.answers), `answer ${qid} must not be stored`);
  }
  assert.ok(!JSON.stringify(row).includes("_signature_"));
  assert.ok(!JSON.stringify(row).includes("A1234567"));
  assert.equal(row.answers["35"], "C", "licence class is kept");
  assert.ok(!("263" in row.answers), "street address is never stored");
  assert.equal(row.city, "Eugene"); assert.equal(row.state, "OR");
  assert.equal(row.answers["344"], "High School Diploma");
  assert.equal(row.answers["261"], "2026-11-02");
  assert.equal(row.answers["264"], "(541) 555-0101");
  assert.ok(!("217" in row.answers));
  // Files: resume and portfolio, no signatures.
  assert.equal(files.length, 2);
  assert.deepEqual(files.map((f) => f.kind).sort(), ["portfolio", "resume"]);
  assert.equal(files.find((f) => f.kind === "resume").storage_name, "6000000000000000001_resume.pdf");
});

test("only mapped upload questions create files", () => {
  const sub = {
    id: "6000000000000000002", created_at: "2026-10-23 00:56:12",
    answers: a({
      9: { first: "Test", last: "Applicant" },
      384: "https://www.jotform.com/uploads/rexius/260115636145148/6000000000000000002/not-a-file.pdf",
      9999: "https://www.jotform.com/uploads/rexius/260115636145148/6000000000000000002/unknown.pdf",
      387: ["https://www.jotform.com/uploads/rexius/260115636145148/6000000000000000002/resume.pdf"],
    }),
  };
  const { files } = buildApplication(sub, forms.en, positions);
  assert.deepEqual(files.map((f) => f.qid), ["387"]);
});

test("Spanish submission: bilingual values, location alias, position keeps inner slash", () => {
  const sub = {
    id: "6000000000000000003", created_at: "2026-01-15 09:00:00", status: "ACTIVE",
    answers: a({
      9: { first: "Luis", last: "Hernández" },
      22: "luis.h@example.com",
      264: { full: "(503) 555-0103" },
      21: ["Email/ Correo electrónico"],
      342: "Eugene-Springfield/",
      340: "Retail Yard Associate / Delivery Driver/",
      268: ["Indeed.com/"],
      355: "Marco Hernández",
      344: "High School Diploma/ Diploma de secundaria",
      272: "Yes/Si", 274: "No",
      266: "Cell/ Cellular",
      348: "04/2024", 375: "10/2025",
    }),
  };
  const { row, files } = buildApplication(sub, forms.es, positions);
  assert.equal(row.language, "es");
  assert.equal(row.location, "Eugene/Springfield");
  assert.equal(row.position_text, "Retail Yard Associate / Delivery Driver");
  assert.equal(row.position_id, null);
  assert.equal(row.source, "Indeed.com");
  assert.equal(row.referred_by, "Marco Hernández");
  assert.equal(row.answers["344"], "High School Diploma");
  assert.equal(row.answers["272"], "Yes");
  assert.equal(row.answers["266"], "Cell");
  assert.deepEqual(row.answers["21"], ["Email"]);
  assert.equal(row.answers["348"], "04/2024", "free-text dates keep their slash");
  assert.equal(row.submitted_at, "2026-01-15T17:00:00.000Z");
  assert.equal(row.has_resume, false);
  assert.equal(files.length, 0);
});

test("CAS submission: free-text position, location CAS, resume on 381", () => {
  const sub = {
    id: "6000000000000000007", created_at: "2026-05-01 14:30:00",
    answers: a({
      9: { first: "Pat", last: "Lee" },
      375: "Yard associate/",
      376: ["Referral"],
      377: "Chris",
      381: "https://www.jotform.com/uploads/rexius/232764918957171/6000000000000000007/6000000000000000007_cv.docx",
    }),
  };
  const { row, files } = buildApplication(sub, forms.cas, positions);
  assert.equal(row.location, "CAS");
  assert.equal(row.position_text, "Yard associate");
  assert.equal(row.source, "Referral");
  assert.equal(row.referred_by, "Chris");
  assert.equal(row.has_resume, true);
  assert.equal(files.length, 1);
  assert.equal(files[0].kind, "resume");
});

test("inbox shape (submission_answers + subtitle) and inferred location", () => {
  const sub = {
    id: "6000000000000000009", title: "Sam Okafor", subtitle: "Jul 4, 2025 1:05 PM",
    submission_answers: {
      ...a({ 9: { first: "Sam", last: "Okafor" }, 341: "Landscape Maintenance Crew Member" }),
      created_at: { answer: "2025-07-04 13:05:00" },
    },
  };
  const { row, warnings } = buildApplication(sub, forms.en, positions);
  assert.equal(row.submitted_at, "2025-07-04T20:05:00.000Z");
  assert.equal(row.location, "Central Oregon", "location inferred from the dropdown that was answered");
  assert.equal(row.position_id, "p-co-maint");
  assert.ok(!("created_at" in row.answers));
  assert.deepEqual(warnings, []);
});

test("checkbox with an Other box comes back as an object", () => {
  const mk = (src) => buildApplication({ id: "5", created_at: "2026-03-01 08:00:00", answers: a({ 9: { first: "A", last: "B" }, 268: src }) }, forms.en, positions);
  let { row } = mk({ 0: "Indeed.com", 1: "Rexius.com", other: "Ben S." });
  assert.equal(row.source, "Indeed.com");
  assert.equal(row.source_detail, "Ben S. | also: Rexius.com");
  assert.deepEqual(row.answers["268"], ["Indeed.com", "Rexius.com", "Other: Ben S."]);
  ({ row } = mk({ other: "Employee" }));
  assert.equal(row.source, "Other");
  assert.equal(row.source_detail, "Employee");
  ({ row } = mk({ 0: "Other", other: "Internal word of mouth." }));
  assert.equal(row.source, "Other");
  assert.equal(row.source_detail, "Internal word of mouth.");
});

test("a signature question is never a file, even with a malformed URL", () => {
  const sub = {
    id: "6570344866913315378", created_at: "2026-02-01 10:00:00",
    answers: {
      "9": { answer: { first: "A", last: "B" } },
      "238": { type: "control_signature", answer: "https://www.jotform.com/uploads/n:image/png;base64,iVBORw0KGgo?nc=1" },
    },
  };
  const { row, files } = buildApplication(sub, forms.es, positions);
  assert.equal(files.length, 0);
  assert.ok(!("238" in row.answers));
});

test("missing name and unparseable time are reported, not thrown", () => {
  const { row, warnings } = buildApplication({ id: "1", created_at: "yesterday", answers: {} }, forms.en, positions);
  assert.equal(row.name, "(no name)");
  assert.equal(row.submitted_at, null);
  assert.equal(warnings.length, 2);
});

test("licence class: kept when it is a class, dropped when it looks like a licence number", () => {
  const make = (v) => ({
    id: "6000000000000000009", form_id: "260115636145148", created_at: "2026-10-23 00:56:12", status: "ACTIVE",
    answers: a({ 9: { first: "Sam", last: "Lee" }, 22: "sam@example.com", 342: "Eugene/Springfield", 30: "B9876543", 35: v }),
  });
  for (const v of ["C", "Class A CDL", "A", "CDL class B with tanker endorsement", "no"]) {
    const { row, warnings } = buildApplication(make(v), forms.en, positions);
    assert.equal(row.answers["35"], v);
    assert.deepEqual(warnings, []);
    assert.ok(!("30" in row.answers));
  }
  for (const v of ["B9876543", "1234567", "C 98765432", "x".repeat(61)]) {
    const { row, warnings } = buildApplication(make(v), forms.en, positions);
    assert.ok(!("35" in row.answers), `"${v}" must be dropped`);
    assert.equal(warnings.length, 1);
    assert.ok(!JSON.stringify(row).includes("9876543"));
  }
});
