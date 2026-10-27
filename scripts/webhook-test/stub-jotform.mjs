#!/usr/bin/env node
// A stand-in for api.jotform.com so the webhook Edge Function can be tested on the local stack
// with no Jotform key and no real applicant data. Serves one made-up English-form submission
// built from reference/submission-shape.json (every value invented, including a driver licence,
// signature and initials that the import must drop) and one small PDF as its "resume".
//
//   node scripts/webhook-test/stub-jotform.mjs            # listens on 8787
//   PORT=9000 node scripts/webhook-test/stub-jotform.mjs
//
// Routes (any APIKEY is accepted, the way a dummy key would be):
//   GET /submission/<id>     -> { responseCode: 200, content: { id, form_id, created_at, status, answers } }
//                               <id> 6990000000000000001 is the sample; anything else is 404
//   GET /uploads/resume.pdf  -> a one-page PDF
// See README.md step 14 "Test it locally" for the full sequence.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const port = Number(process.env.PORT || 8787);
export const FORM_ID = "260115636145148";
export const SUBMISSION_ID = "6990000000000000001";

const shape = JSON.parse(readFileSync(join(repoRoot, "reference", "submission-shape.json"), "utf8"));
const questions = JSON.parse(readFileSync(join(repoRoot, "reference", "jotform-forms.json"), "utf8"))[FORM_ID].questions;

/** Invented answers, keyed by question ID; everything else in the shape gets a harmless string. */
function sampleAnswers(base) {
  const fill = {
    9: { first: "Test", middle: "", last: "Webhook" },
    21: ["Email"],
    22: "Test.Webhook@Example.com",
    72: "Example Nursery",
    238: `${base}/uploads/_signature_238.png`, // never imported
    261: { month: "11", day: "03", year: "2026", datetime: "2026-11-03 00:00:00" },
    263: { addr_line1: "1 Test St", addr_line2: "", city: "Eugene", state: "OR", postal: "97401" },
    264: { full: "(541) 555-0100" },
    266: "Cell",
    268: ["Indeed.com"],
    272: "No",
    274: "No",
    30: "DL-NEVER-IMPORT", // driver licence number: never imported
    31: { month: "01", day: "01", year: "2030" },
    324: "TW", // initials: never imported
    333: `${base}/uploads/_signature_333.png`,
    340: "Landscape Maintenance Crew Member",
    342: "Eugene/Springfield",
    344: "High School Diploma",
    348: "03/2023",
    352: "Seasonal end",
    369: `${base}/uploads/_signature_369.png`,
    372: "Mowing, edging, irrigation repair.",
    377: "10/2026",
    385: [],
    386: "Yes",
    387: [`${base}/uploads/resume.pdf`],
  };
  const answers = {};
  for (const qid of Object.keys(shape.submission_answers)) {
    const q = questions[qid] ?? {};
    const answer = qid in fill ? fill[qid] : "sample";
    answers[qid] = { name: q.name ?? `q${qid}`, text: q.text ?? "", type: q.type ?? "control_textbox", answer };
  }
  for (const [qid, answer] of Object.entries(fill)) {
    if (!answers[qid]) answers[qid] = { name: questions[qid]?.name ?? `q${qid}`, text: questions[qid]?.text ?? "", type: questions[qid]?.type ?? "control_textbox", answer };
  }
  return answers;
}

const PDF = Buffer.from(
  "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\nxref\n0 4\n0000000000 65535 f \n" +
  "0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n160\n%%EOF\n",
);

const server = createServer((req, res) => {
  const base = `http://${req.headers.host}`;
  const path = new URL(req.url, base).pathname;
  console.log(`${req.method} ${path}`);
  const send = (status, body, type = "application/json") => { res.writeHead(status, { "content-type": type }); res.end(body); };

  if (path === `/submission/${SUBMISSION_ID}`) {
    return send(200, JSON.stringify({
      responseCode: 200, message: "success",
      content: { id: SUBMISSION_ID, form_id: FORM_ID, created_at: "2026-10-27 09:15:00", status: "ACTIVE", answers: sampleAnswers(base) },
    }));
  }
  if (path.startsWith("/submission/")) {
    return send(404, JSON.stringify({ responseCode: 404, message: "Submission not found" }));
  }
  if (path === "/uploads/resume.pdf") return send(200, PDF, "application/pdf");
  if (path.startsWith("/uploads/_signature_")) return send(200, Buffer.alloc(0), "image/png");
  return send(404, JSON.stringify({ responseCode: 404, message: "Not Found" }));
});

server.listen(port, () => {
  console.log(`Jotform stub listening on http://127.0.0.1:${port} (from Docker: http://host.docker.internal:${port})`);
  console.log(`Sample: form ${FORM_ID}, submission ${SUBMISSION_ID}`);
});
