import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadJotformUpload } from "../../supabase/functions/_shared/download.mjs";

const file = "https://www.jotform.com/uploads/rexius/123/456/resume.pdf";
const key = "FAKE_TEST_KEY";

test("unapproved upload URL never initiates a request", async () => {
  let calls = 0;
  const result = await downloadJotformUpload("https://outside.invalid/uploads/resume.pdf", key, {
    fetchImpl: async () => { calls++; throw new Error("must not fetch"); },
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});

test("cross-origin redirect is stopped before sending the key", async () => {
  const calls = [];
  const result = await downloadJotformUpload(file, key, {
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), key: init.headers.APIKEY });
      return new Response(null, { status: 302, headers: { Location: "https://outside.invalid/uploads/resume.pdf" } });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, key);
  assert.ok(calls[0].url.startsWith("https://www.jotform.com/"));
});

test("an approved Jotform file downloads through a checked same-origin redirect", async () => {
  const calls = [];
  const result = await downloadJotformUpload(file, key, {
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), key: init.headers.APIKEY, redirect: init.redirect });
      if (calls.length === 1) return new Response(null, { status: 302, headers: { Location: "/uploads/rexius/123/456/actual.pdf" } });
      return new Response("synthetic file", { headers: { "content-type": "application/pdf" } });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(new TextDecoder().decode(result.bytes), "synthetic file");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.key === key && call.redirect === "manual"));
});

test("query fallback never follows a redirect to an outside origin", async () => {
  const calls = [];
  const result = await downloadJotformUpload(file, key, {
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), key: init.headers.APIKEY });
      if (calls.length === 1) return new Response(null, { status: 403 });
      return new Response(null, { status: 302, headers: { Location: "https://outside.invalid/uploads/resume.pdf" } });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes("apiKey=FAKE_TEST_KEY"));
  assert.ok(calls.every((call) => call.url.startsWith("https://www.jotform.com/")));
});

test("streaming stops when a response exceeds the configured limit", async () => {
  const result = await downloadJotformUpload(file, key, {
    maxBytes: 4,
    fetchImpl: async () => new Response("12345", { headers: { "content-type": "application/pdf" } }),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /exceeds/);
});

test("the signed files.jotform.com redirect is followed without any credentials", async () => {
  const calls = [];
  const signed = "https://files.jotform.com/jufs/rexius%2F123%2F456%2Fresume.pdf?md5=abc&expires=1";
  const result = await downloadJotformUpload(file, key, {
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), key: init.headers.APIKEY });
      if (calls.length === 1) return new Response(null, { status: 302, headers: { Location: signed } });
      return new Response("synthetic file", { headers: { "content-type": "application/pdf" } });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].key, key);
  assert.equal(calls[1].url, signed);
  assert.equal(calls[1].key, undefined);
  assert.ok(!calls[1].url.includes("apiKey"));
});

test("a redirect to files.jotform.com outside /jufs/ is refused", async () => {
  const calls = [];
  const result = await downloadJotformUpload(file, key, {
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), key: init.headers.APIKEY });
      return new Response(null, { status: 302, headers: { Location: "https://files.jotform.com/other/resume.pdf" } });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
});

test("a 403 from the signed host does not trigger the key-in-query fallback", async () => {
  const calls = [];
  const result = await downloadJotformUpload(file, key, {
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), key: init.headers.APIKEY });
      if (calls.length === 1) return new Response(null, { status: 302, headers: { Location: "https://files.jotform.com/jufs/x.pdf?md5=a&expires=1" } });
      return new Response(null, { status: 403 });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 2);
  assert.ok(!calls[1].url.includes("apiKey"));
});
