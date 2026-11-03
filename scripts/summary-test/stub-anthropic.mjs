#!/usr/bin/env node
// A stand-in for api.anthropic.com so the applicant-summary Edge Function can be tested on the
// local stack end to end (row written, drawer rendering, the manager view's translation) with no
// API key, no cost and no real applicant data leaving the machine. It never calls Anthropic.
//
//   node scripts/summary-test/stub-anthropic.mjs                  # listens on 8788
//   STUB_MODE=refusal node scripts/summary-test/stub-anthropic.mjs
//
// Point the function at it with APPLICANT_SUMMARY_API_BASE=http://host.docker.internal:8788 in
// supabase/functions/.env (the Edge Runtime runs in Docker). README "What Phase 9b created" has
// the full sequence.
//
// POST /v1/messages (with or without ?beta=true) answers in the shape the real API uses:
//   * a summary request (the JSON schema has "overview"): a made-up summary marked "(stub)",
//     and a "(stub)" translation for every keyed written answer that looks Spanish;
//   * a translate request (the schema has "translation"): the message marked "(stub)".
// STUB_MODE: ok (default), refusal (stop_reason refusal), badjson (text that is not JSON),
// slow (answers after 20 seconds), auth (401, as for a wrong key), ratelimit (429, as when the
// workspace's spend cap is reached).
// STUB_DUMP=<folder>: also write each request body there as request-<n>.json, to read exactly
// what the function sends Claude (system prompt, schema, the application text).

import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.env.PORT || 8788);
const mode = process.env.STUB_MODE || "ok";
const dump = process.env.STUB_DUMP || "";
if (dump) mkdirSync(dump, { recursive: true });
let n = 0;

const SPANISH = /[áéíóúñ¿¡]|\b(de|del|la|las|el|los|en|y|con|para|una|por|que|años?|temporada|trabajo|cuadrilla|camión|soplador|ayudante|terminó)\b/i;

function userText(body) {
  const m = (body.messages || []).find((x) => x.role === "user");
  if (!m) return "";
  return typeof m.content === "string" ? m.content : (m.content || []).map((b) => b.text || "").join("\n");
}

function summaryResult(prompt) {
  const translations = [];
  const keyed = /\[([a-z0-9_.]+)\][^:\n]*:\s*([^;\n]*)/g;
  let m;
  while ((m = keyed.exec(prompt)) !== null) {
    const [, key, text] = m;
    if (SPANISH.test(text)) translations.push({ key, english: `(stub translation) ${text.trim()}` });
  }
  const title = (/^Title: (.*)$/m.exec(prompt) || [])[1] || "the position";
  return {
    answer_language: translations.length ? "es" : "en",
    overview: `(stub) Applies for ${title}. This text comes from scripts/summary-test/stub-anthropic.mjs, not from Claude.`,
    experience: ["(stub) One line per related job or skill would appear here."],
    licences: [],
    availability: "(stub) Start date as given in the application.",
    location: "(stub) Where the applicant lives and the location applied to.",
    not_stated: ["(stub) Does not say whether …"],
    check_in_application: [],
    translations,
  };
}

function reply(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json", "request-id": `req_stub_${n}` });
  res.end(JSON.stringify(obj));
}

createServer((req, res) => {
  if (req.method !== "POST" || !/\/v1\/messages(\?|$)/.test(req.url || "")) return reply(res, 404, { type: "error", error: { type: "not_found_error", message: "stub: POST /v1/messages only" } });
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    n++;
    let body;
    try { body = JSON.parse(raw); } catch { return reply(res, 400, { type: "error", error: { type: "invalid_request_error", message: "stub: body is not JSON" } }); }
    if (dump) writeFileSync(join(dump, `request-${n}.json`), JSON.stringify(body, null, 2));
    if (mode === "auth") return reply(res, 401, { type: "error", error: { type: "authentication_error", message: "stub: invalid x-api-key" } });
    if (mode === "ratelimit") return reply(res, 429, { type: "error", error: { type: "rate_limit_error", message: "stub: rate limit" } });
    const props = body.output_config?.format?.schema?.properties || {};
    const prompt = userText(body);
    const isTranslate = "translation" in props;
    let content, stop_reason = "end_turn", stop_details = null;
    if (mode === "refusal") {
      content = []; stop_reason = "refusal"; stop_details = { type: "refusal", category: "cyber", explanation: null };
    } else if (mode === "badjson") {
      content = [{ type: "text", text: "Here is the summary you asked for." }];
    } else if (isTranslate) {
      const msg = (/<message>\n?([\s\S]*?)\n?<\/message>/.exec(prompt) || [])[1] || "";
      const into = /into Spanish/.test(prompt) ? "ES" : "EN";
      content = [{ type: "text", text: JSON.stringify({ translation: `(stub ${into}) ${msg}` }) }];
    } else {
      content = [{ type: "text", text: JSON.stringify(summaryResult(prompt)) }];
    }
    const message = {
      id: `msg_stub_${n}`, type: "message", role: "assistant", model: body.model || "claude-opus-5-5",
      content, stop_reason, stop_sequence: null, stop_details,
      usage: { input_tokens: Math.ceil(prompt.length / 4) + 1800, output_tokens: isTranslate ? 120 : 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
    console.log(`${new Date().toISOString()} ${isTranslate ? "translate" : "summary"} request #${n} (${mode}), ${prompt.length} prompt chars`);
    setTimeout(() => reply(res, 200, message), mode === "slow" ? 20000 : 1500);
  });
}).listen(port, () => console.log(`stub Anthropic API on :${port} (mode ${mode})`));
