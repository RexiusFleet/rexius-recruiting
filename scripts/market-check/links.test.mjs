// Unit tests for the market check link rules (supabase/functions/_shared/market-links.mjs).
// Run: npm run market:test. Invented addresses in the shapes the job boards use; no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { linkCounts, linkKey, linkKind, settleLike, settleLinks } from "../../supabase/functions/_shared/market-links.mjs";

test("linkKind: job boards, one job against a list", () => {
  const posting = [
    "https://www.indeed.com/viewjob?jk=0123456789abcdef",
    "https://www.indeed.com/m/viewjob?jk=0123456789abcdef",
    "https://www.indeed.com/rc/clk?jk=0123456789abcdef&fccid=1",
    "https://www.indeed.com/cmp/Acme-Landscape/jobs?jk=0123456789abcdef",
    "https://www.linkedin.com/jobs/view/landscape-laborer-at-acme-4012345678",
    "https://www.ziprecruiter.com/c/Acme-Landscape/Job/Landscape-Laborer/-in-Eugene,OR?jid=abc123",
    "https://www.ziprecruiter.com/jobs/acme-landscape-1a2b3c/landscape-laborer-9f8e7d",
    "https://www.glassdoor.com/job-listing/landscape-laborer-acme-JV_IC1151584_KO0,17.htm?jl=1009876543",
    "https://www.simplyhired.com/job/AbCdEfGhIjK",
    "https://eugene.craigslist.org/lab/d/eugene-landscape-crew/7801234567.html",
    "https://www.governmentjobs.com/careers/eugene/jobs/4567890/parks-maintenance-worker",
    "https://boards.greenhouse.io/acme/jobs/5551234",
    "https://jobs.lever.co/acme/3f1c2d4e-aaaa-bbbb-cccc-1234567890ab",
    "https://acmelandscape.com/careers/landscape-crew-member",
    "https://acme.com/careers?gh_jid=5551234",
  ];
  const list = [
    "https://www.indeed.com/q-landscape-l-eugene,-or-jobs.html",
    "https://www.indeed.com/jobs?q=landscape+laborer&l=Eugene%2C+OR",
    "https://www.indeed.com/cmp/Acme-Landscape/jobs",
    "https://www.indeed.com/cmp/Acme-Landscape",
    "https://www.indeed.com/career/landscape-technician/salaries/Eugene--OR",
    "https://www.linkedin.com/jobs/landscape-jobs-eugene-or",
    "https://www.linkedin.com/jobs/search?keywords=landscape&location=Eugene",
    "https://www.ziprecruiter.com/Jobs/Landscaping/-in-Eugene,OR",
    "https://www.glassdoor.com/Job/eugene-landscaper-jobs-SRCH_IL.0,6_IC1151584_KO7,17.htm",
    "https://www.simplyhired.com/search?q=landscaper&l=eugene%2C+or",
    "https://eugene.craigslist.org/search/lab?query=landscape",
    "https://www.governmentjobs.com/careers/eugene",
    "https://acmelandscape.com/careers",
    "https://acmelandscape.com/careers/",
    "https://acmelandscape.com/",
    "https://acmelandscape.com/about/join-our-team.html",
    "https://example.com/oregon/landscaping-jobs",
    "https://example.com/jobs-in-eugene-or",
    "https://example.com/find?keywords=cdl+driver",
  ];
  for (const u of posting) assert.equal(linkKind(u), "posting", u);
  for (const u of list) assert.equal(linkKind(u), "list", u);
  assert.equal(linkKind("not a url"), null);
  assert.equal(linkKind("ftp://example.com/job/1"), null);
  assert.equal(linkKind(null), null);
});

test("linkKey: the same page spelled two ways compares equal", () => {
  assert.equal(linkKey("https://www.indeed.com/viewjob?jk=abc&utm_source=x#top"), linkKey("http://indeed.com/viewjob?jk=abc"));
  assert.equal(linkKey("https://acme.com/careers/crew/"), linkKey("https://acme.com/careers/crew"));
  assert.equal(linkKey("https://acme.com/job?b=2&a=1"), linkKey("https://acme.com/job?a=1&b=2"));
  assert.notEqual(linkKey("https://www.indeed.com/viewjob?jk=abc"), linkKey("https://www.indeed.com/viewjob?jk=abd"));
  assert.notEqual(linkKey("https://www.indeed.com/viewjob?jk=abc"), linkKey("https://www.indeed.com/viewjob"));
  assert.notEqual(linkKey("https://jobs.lever.co/acme/AbC"), linkKey("https://jobs.lever.co/acme/abc"));
  assert.equal(linkKey(""), null);
});

const HITS = [
  "https://www.indeed.com/q-landscape-l-eugene,-or-jobs.html",
  "https://www.indeed.com/viewjob?jk=aaa111",
  "https://acmelandscape.com/careers/landscape-crew-member",
  "https://smallnursery.com/careers",
];

test("settleLinks: an address from the search is kept and classed", () => {
  const out = settleLinks([
    { employer: "Acme", url: "https://acmelandscape.com/careers/landscape-crew-member/?utm_source=google", url_kind: null },
    { employer: "Indeed job", url: "http://indeed.com/viewjob?jk=aaa111" },
    { employer: "Board list", url: "https://www.indeed.com/q-landscape-l-eugene,-or-jobs.html" },
  ], HITS);
  assert.deepEqual(out.map((x) => x.link), ["posting", "posting", "list"]);
  // The search's own spelling replaces the model's.
  assert.equal(out[0].url, "https://acmelandscape.com/careers/landscape-crew-member");
  assert.equal(out[1].url, "https://www.indeed.com/viewjob?jk=aaa111");
  assert.ok(!("url_kind" in out[0]));
});

test("settleLinks: an address the search never returned is unverified, and kept", () => {
  const out = settleLinks([{ employer: "Made up", url: "https://www.indeed.com/viewjob?jk=zzz999", url_kind: "posting" }], HITS);
  assert.equal(out[0].link, "unverified");
  assert.equal(out[0].url, "https://www.indeed.com/viewjob?jk=zzz999");
});

test("settleLinks: the model's 'list' is believed, its 'posting' is not", () => {
  const out = settleLinks([
    { employer: "Small Nursery", url: "https://smallnursery.com/careers", url_kind: "posting" },
    { employer: "Acme", url: "https://acmelandscape.com/careers/landscape-crew-member", url_kind: "list" },
  ], HITS);
  assert.deepEqual(out.map((x) => x.link), ["list", "list"]);
});

test("settleLinks: no address, a bad address, and no search results to check against", () => {
  const out = settleLinks([{ employer: "A", url: null }, { employer: "B", url: "see indeed" }, { employer: "C" }], HITS);
  assert.deepEqual(out.map((x) => [x.url, x.link]), [[null, null], [null, null], [null, null]]);
  // With no results read at all, nothing can be called unverified; the address shape still applies.
  const blind = settleLinks([{ url: "https://www.indeed.com/viewjob?jk=zzz999" }, { url: "https://www.indeed.com/jobs?q=x" }], []);
  assert.deepEqual(blind.map((x) => x.link), ["posting", "list"]);
  assert.deepEqual(settleLinks(undefined, HITS), []);
});

test("settleLike: the pay table follows the posting with the same address", () => {
  const postings = settleLinks([{ employer: "Small Nursery", url: "https://smallnursery.com/careers/", url_kind: "list" }], HITS);
  const ranges = settleLike([
    { employer: "Small Nursery", min: 18, url: "https://www.smallnursery.com/careers" },
    { employer: "Acme", min: 20, url: "https://acmelandscape.com/careers/landscape-crew-member" },
  ], HITS, postings);
  assert.deepEqual(ranges.map((x) => x.link), ["list", "posting"]);
  assert.equal(ranges[0].url, "https://smallnursery.com/careers");
});

test("linkCounts", () => {
  assert.deepEqual(linkCounts([{ link: "posting" }, { link: "list" }, { link: "list" }, { link: "unverified" }, { link: null }, {}]),
    { posting: 1, list: 2, unverified: 1, none: 2 });
});
