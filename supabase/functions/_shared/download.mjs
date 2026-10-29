// Shared by the Edge Function and the local backfill. Applicant answers must never choose
// where a request carrying the Jotform API key is sent.
import { isUploadUrl } from "./clean.mjs";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const DOWNLOAD_TIMEOUT_MS = 15_000;

export async function downloadJotformUpload(url, apiKey, {
  fetchImpl = fetch, maxBytes = MAX_FILE_BYTES, timeoutMs = DOWNLOAD_TIMEOUT_MS,
} = {}) {
  if (!isUploadUrl(url)) return { ok: false, reason: "unapproved Jotform upload URL" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let target = new URL(url);
    let queryFallback = false;
    let redirects = 0;
    for (;;) {
      // The only destination receiving credentials is the exact approved Jotform host.
      if (!isUploadUrl(target.href)) return { ok: false, reason: "unapproved redirect destination" };
      const requestUrl = new URL(target);
      if (queryFallback) requestUrl.searchParams.set("apiKey", apiKey);
      let res;
      try {
        res = await fetchImpl(requestUrl, {
          headers: queryFallback ? {} : { APIKEY: apiKey },
          redirect: "manual", signal: controller.signal,
        });
      } catch {
        return { ok: false, reason: "download request failed or timed out" };
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get("location");
        await res.body?.cancel();
        if (!location || redirects++ >= MAX_REDIRECTS) return { ok: false, reason: "unapproved or excessive redirect" };
        let next;
        try { next = new URL(location, requestUrl); }
        catch { return { ok: false, reason: "invalid redirect destination" }; }
        if (!isUploadUrl(next.href)) return { ok: false, reason: "unapproved redirect destination" };
        target = next;
        continue;
      }
      if ((res.status === 401 || res.status === 403) && !queryFallback) {
        await res.body?.cancel();
        queryFallback = true;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        return { ok: false, status: res.status, reason: `download HTTP ${res.status}` };
      }
      const contentType = (res.headers.get("content-type") || "").split(";")[0].trim() || null;
      if (contentType === "text/html") {
        await res.body?.cancel();
        return { ok: false, reason: "received HTML instead of a file" };
      }
      const declaredSize = Number(res.headers.get("content-length"));
      if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
        await res.body?.cancel();
        return { ok: false, reason: `file exceeds the ${maxBytes} byte limit` };
      }
      if (!res.body) return { ok: false, reason: "empty file" };
      const reader = res.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) return { ok: false, reason: `file exceeds the ${maxBytes} byte limit` };
          chunks.push(value);
        }
      } catch {
        return { ok: false, reason: "download stream failed or timed out" };
      } finally {
        reader.releaseLock();
        if (size > maxBytes) {
          try { await res.body.cancel(); } catch { /* Abort may already have closed it. */ }
        }
      }
      if (!size) return { ok: false, reason: "empty file" };
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return { ok: true, bytes, contentType };
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
