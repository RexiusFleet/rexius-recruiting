// Minimal Jotform REST client: paged submission listing and authenticated file download.
// Verified against api.jotform.com/docs (2026-10-25): the key goes in an `APIKEY` header (or
// `apiKey` query parameter); listing takes `limit` (max 1000), `offset`, `orderby`; responses are
// { responseCode, message, content, resultSet: { offset, limit, count }, "limit-left" }.
// Daily call quota depends on the Jotform plan; a full backfill is a handful of calls per form
// plus one download per file.

const DEFAULT_BASE = "https://api.jotform.com";
import { downloadJotformUpload } from "../../../supabase/functions/_shared/download.mjs";

async function fetchWithRetry(url, init, { tries = 5, label = url } = {}) {
  let delay = 1500;
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (attempt >= tries) throw new Error(`${label}: ${err.message}`);
      await sleep(delay); delay *= 2; continue;
    }
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt < tries) {
      await sleep(delay); delay *= 2; continue;
    }
    return res;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class JotformClient {
  constructor({ apiKey, base = DEFAULT_BASE }) {
    if (!apiKey) throw new Error("Jotform API key missing");
    this.apiKey = apiKey;
    this.base = base.replace(/\/$/, "");
  }

  async get(path, params = {}) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const res = await fetchWithRetry(url, { headers: { APIKEY: this.apiKey, Accept: "application/json" } }, { label: path });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { throw new Error(`${path}: HTTP ${res.status}, non-JSON body: ${text.slice(0, 200)}`); }
    if (!res.ok || (body.responseCode && body.responseCode !== 200)) {
      throw new Error(`${path}: HTTP ${res.status} responseCode ${body.responseCode}: ${body.message ?? text.slice(0, 200)}`);
    }
    return body;
  }

  async form(formId) {
    return (await this.get(`/form/${formId}`)).content;
  }

  async formQuestions(formId) {
    return (await this.get(`/form/${formId}/questions`)).content;
  }

  /**
   * Yields submissions (newest first, as Jotform returns them) until the form is exhausted or `limit` have been yielded.
   * `onPage` is told about each page (for progress output).
   */
  async *submissions(formId, { limit = Infinity, pageSize = 1000, onPage } = {}) {
    let offset = 0;
    let yielded = 0;
    while (yielded < limit) {
      const want = Math.min(pageSize, limit - yielded);
      // Jotform lists newest first regardless of any direction parameter (checked 2026-10-25).
      // With offset paging that is the safe order: a submission arriving mid-run pushes the
      // pages down, so a page boundary can repeat an item (skipped as existing) but never skip
      // one.
      const body = await this.get(`/form/${formId}/submissions`, { limit: want, offset, orderby: "created_at" });
      const page = Array.isArray(body.content) ? body.content : [];
      onPage?.({ offset, count: page.length, total: body.resultSet?.count, limitLeft: body["limit-left"] });
      for (const s of page) {
        yield s;
        yielded++;
        if (yielded >= limit) break;
      }
      if (page.length < want) break;
      offset += page.length;
    }
  }

  /**
   * Download an upload URL. Jotform serves upload files to the owning account; the API key is
   * sent only to an approved Jotform upload URL, as a header first and then (if refused)
   * as a query parameter. Redirects are checked before any credentials are sent.
   * Returns { ok, status, buffer, contentType } and never throws for HTTP errors.
   */
  async download(url) {
    const result = await downloadJotformUpload(url, this.apiKey);
    return result.ok ? { ok: true, status: 200, buffer: Buffer.from(result.bytes), contentType: result.contentType } : result;
  }
}
