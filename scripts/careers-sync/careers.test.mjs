// Unit tests for the careers page sync rules (supabase/functions/_shared/careers.mjs).
// Run: npm run careers:test. Invented feed entries in the shape rexius.com serves; no network,
// no database.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  feedProblem, htmlToText, normalizeUrl, pageFromEntry, parseFeed, parseJob, parsePay, payLabel, planSync,
} from "../../supabase/functions/_shared/careers.mjs";

const U = (h) => `https://rexius.com/blogs/careers/${h}`;
const entry = (handle, title, body, published = "2026-02-20T07:06:45-08:00") => `
  <entry>
    <id>${U(handle)}</id>
    <published>${published}</published>
    <updated>2026-09-30T09:45:31-07:00</updated>
    <link rel="alternate" type="text/html" href="${U(handle)}"/>
    <title>${title}</title>
    <author><name>Someone</name></author>
    <content type="html"><![CDATA[${body}]]></content>
  </entry>`;
const feed = (...entries) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xml:lang="en-US" xmlns="http://www.w3.org/2005/Atom">
  <id>https://rexius.com/blogs/careers.atom</id>
  <link rel="alternate" type="text/html" href="https://rexius.com/blogs/careers"/>
  <title>Rexius - Careers</title>${entries.join("")}
</feed>`;
const BODY = `<p> </p><p class="cta"><span>Need Help Applying:</span> <a href="tel:5550100">Call</a></p>
<p><strong>Job Type: </strong>Full-time</p>
<p><strong>Pay:  </strong>$25.00 - $30.00/hour D.O.E.</p>
<p><strong>Description:</strong></p><ul><li>Lead a crew &amp; plan the day</li></ul>`;

test("normalizeUrl accepts only job pages under rexius.com/blogs/careers", () => {
  assert.equal(normalizeUrl("https://rexius.com/blogs/careers/Truck-Driver8/?utm=x#top"), U("truck-driver8"));
  assert.equal(normalizeUrl("http://www.rexius.com/blogs/careers/a1"), U("a1"));
  for (const bad of ["https://rexius.com/blogs/careers", "https://rexius.com/blogs/careers/tagged/eugene", "https://rexius.com/blogs/news/x",
    "https://evil.example/blogs/careers/x", "https://rexius.com.evil.example/blogs/careers/x", "https://rexius.com/blogs/careers/a/b",
    "https://rexius.com@evil.example/blogs/careers/x", "https://rexius.com/blogs/careers/../admin", "", null, 5]) {
    assert.equal(normalizeUrl(bad), null, String(bad));
  }
});

test("parseFeed reads entries and refuses anything that is not an Atom feed", () => {
  const pages = parseFeed(feed(entry("lead14", "Landscape Maintenance Crew Lead", BODY), entry("x&amp;y", "bad handle", BODY), entry("lead14", "duplicate", BODY)));
  assert.equal(pages.length, 1);
  assert.equal(pages[0].url, U("lead14"));
  assert.equal(pages[0].title, "Landscape Maintenance Crew Lead");
  assert.equal(pages[0].published_at, "2026-02-20T15:06:45.000Z");
  assert.throws(() => parseFeed("<html><body>Just a moment...</body></html>"), /not an Atom feed/);
  assert.throws(() => parseFeed(""), /not an Atom feed/);
  assert.deepEqual(parseFeed(feed()), []);
});

test("htmlToText and parseJob find the Job Type and Pay lines", () => {
  const text = htmlToText(BODY);
  assert.match(text, /^Need Help Applying: Call\nJob Type: Full-time\nPay: \$25\.00 - \$30\.00\/hour D\.O\.E\.\nDescription:\nLead a crew & plan the day$/);
  assert.deepEqual(parseJob(text), { job_type: "Full-time", pay_text: "$25.00 - $30.00/hour D.O.E." });
  // seen on the site: no line break between the two
  assert.deepEqual(parseJob("Job Type: Full-timePay: $22.00 - $25.00/hour D.O.E.\nDescription"), { job_type: "Full-time", pay_text: "$22.00 - $25.00/hour D.O.E." });
  assert.deepEqual(parseJob("Job Summary:\nInstall irrigation systems."), { job_type: null, pay_text: null });
  assert.equal(parseJob("Pay:\n$20/hr").pay_text, "$20/hr");
});

test("parsePay reads every pay line seen on the site", () => {
  const ok = (text, min, max, unit, assumed = false) => assert.deepEqual(parsePay(text), { pay_min: min, pay_max: max, pay_unit: unit, assumed_unit: assumed }, text);
  ok("$25.00 - $30.00/hour D.O.E.", 25, 30, "hour");
  ok("$16.00-$24.00/hr D.O.E.", 16, 24, "hour");
  ok("$24.00-$30.00/hour D.O.E", 24, 30, "hour");
  ok("$22-$29/hr DOE", 22, 29, "hour");
  ok("$27-$36/hr. DOE", 27, 36, "hour");
  ok("$35.00 -$40.00/hour D.O.E.", 35, 40, "hour");
  ok("$17.00 - $21.00/ hour D.O.E.", 17, 21, "hour");
  ok("$16-$20 D.O.E.", 16, 20, "hour", true);
  ok("$22.00+ per hour D.O.E.", 22, null, "hour");
  ok("Up to $82,000 annually. $1,200+ a week.", null, 82000, "year");
  ok("$20.00 - $30.00/hour", 20, 30, "hour");
});

test("parsePay reads other common shapes", () => {
  const ok = (text, min, max, unit, assumed = false) => assert.deepEqual(parsePay(text), { pay_min: min, pay_max: max, pay_unit: unit, assumed_unit: assumed }, text);
  ok("$21 to $26 per hour", 21, 26, "hour");
  ok("$22–29 an hour", 22, 29, "hour");
  ok("$20/hr", 20, 20, "hour");
  ok("Starting at $19.50 hourly", 19.5, null, "hour");
  ok("$60,000 - $75,000 per year", 60000, 75000, "year");
  ok("$60k-$70k salary", 60000, 70000, "year");
  ok("$60-70k annually", 60000, 70000, "year");
  ok("$65,000", 65000, 65000, "year", true);
});

test("parsePay refuses what it cannot read with confidence", () => {
  for (const text of ["DOE", "Competitive", "", "$1,200+ a week", "$500 per day", "$20/hr trainee, $25/hr licensed", "$22-$25/hour plus $500 bonus",
    "$30-$20/hour", "$2/hour", "$900", "$20 per hour or $45,000 per year", "$5,000 annually"]) {
    assert.ok(parsePay(text).problem, text);
  }
});

test("pageFromEntry maps one location tag and leaves several unset", () => {
  const [e] = parseFeed(feed(entry("lead14", "Landscape Maintenance Crew Lead", BODY)));
  const page = pageFromEntry(e, ["central-oregon"]);
  assert.equal(page.location, "Central Oregon");
  assert.deepEqual([page.pay_min, page.pay_max, page.pay_unit, page.pay_problem, page.job_type], [25, 30, "hour", null, "Full-time"]);
  assert.equal(pageFromEntry(e, ["eugene", "central-oregon", "lake-oswego"]).location, null);
  assert.equal(pageFromEntry(e, []).location, null);
  const [noPay] = parseFeed(feed(entry("irrig2", "Irrigation Installation Crew Member", "<p>Job Summary:</p><p>Install systems.</p>")));
  assert.deepEqual([pageFromEntry(noPay, ["eugene"]).pay_text, pageFromEntry(noPay, ["eugene"]).pay_problem], [null, null]);
});

test("feedProblem stops an empty or half-empty feed", () => {
  assert.match(feedProblem(0, 0), /no jobs/);
  assert.match(feedProblem(5, 12), /listed 5/);
  assert.equal(feedProblem(6, 12), null);
  assert.equal(feedProblem(1, 3), null);
  assert.equal(feedProblem(13, 17), null);
});

test("payLabel", () => {
  assert.equal(payLabel({ pay_min: "28.00", pay_max: "38.00", pay_unit: "hour" }), "$28–$38/hr");
  assert.equal(payLabel({ pay_min: 22, pay_max: null, pay_unit: "hour" }), "$22+/hr");
  assert.equal(payLabel({ pay_min: null, pay_max: 82000, pay_unit: "year" }), "up to $82,000/yr");
  assert.equal(payLabel({ pay_min: null, pay_max: null, pay_unit: null }), "no range");
});

// ---------------------------------------------------------------------------------------------
// planSync
// ---------------------------------------------------------------------------------------------

const NOW = "2026-11-10T14:15:00.000Z", TODAY = "2026-11-10";
const pos = (id, title, location, status, pay = [null, null, null]) => ({ id, title, location, status, pay_min: pay[0], pay_max: pay[1], pay_unit: pay[2], jotform_option_label: title });
const fpage = (handle, title, location, payText, published = "2026-02-20T15:06:45.000Z") => {
  const pay = payText ? parsePay(payText) : {};
  return { url: U(handle), title, tags: [], location, job_type: "Full-time", pay_text: payText, pay_min: pay.pay_min ?? null, pay_max: pay.pay_max ?? null,
    pay_unit: pay.pay_unit ?? null, pay_problem: pay.problem ?? null, published_at: published, site_updated_at: null };
};
const dbpage = (fp, extra = {}) => ({ ...fp, first_seen_at: "2026-11-01T14:15:00.000Z", last_seen_at: "2026-11-09T14:15:00.000Z", gone_at: null, position_id: null, link_source: null, ignored: false, pay_applied_text: fp.pay_text, ...extra });
const posting = (id, position_id, handle, ended_at = null) => ({ id, position_id, channel: "rexius_com", url: U(handle), posted_at: "2026-02-20", ended_at });
const plan = (o) => planSync({ now: NOW, today: TODAY, feedPages: [], dbPages: [], positions: [], postings: [], gone: [], stillUp: [], ...o });
const kinds = (list) => list.map((c) => c.kind).sort();

test("a steady state changes nothing", () => {
  const p = pos("p1", "Blower Truck Operator", "Lake Oswego", "open", ["35.00", "40.00", "hour"]);
  const fp = fpage("blower11", "Blower Truck Operator", "Lake Oswego", "$35.00 -$40.00/hour D.O.E.");
  const r = plan({ feedPages: [fp], dbPages: [dbpage(fp, { position_id: "p1", link_source: "posting" })], positions: [p], postings: [posting("po1", "p1", "blower11")] });
  assert.deepEqual([r.positionUpdates, r.postingInserts, r.postingEnds, r.changes, r.flags], [[], [], [], [], []]);
  assert.equal(r.pages.length, 1);
  assert.equal(r.pages[0].last_seen_at, NOW);
});

test("a changed pay line updates the position with a note; an unchanged one never fights a manual edit", () => {
  const p = pos("p1", "Blower Truck Operator", "Lake Oswego", "open", ["28.00", "38.00", "hour"]);
  const fp = fpage("blower11", "Blower Truck Operator", "Lake Oswego", "$35.00 -$40.00/hour D.O.E.");
  const old = dbpage(fp, { position_id: "p1", pay_applied_text: "$28.00 -$38.00/hour D.O.E." });
  const r = plan({ feedPages: [fp], dbPages: [old], positions: [p], postings: [posting("po1", "p1", "blower11")] });
  assert.deepEqual(r.positionUpdates, [{ id: "p1", set: { pay_min: 35, pay_max: 40, pay_unit: "hour" }, pay_note: 'From rexius.com: "$35.00 -$40.00/hour D.O.E."' }]);
  assert.deepEqual(r.changes.map((c) => [c.kind, c.from, c.to]), [["pay", "$28–$38/hr", "$35–$40/hr"]]);
  assert.equal(r.pages[0].pay_applied_text, "$35.00 -$40.00/hour D.O.E.");
  // the next day: same line on the site, staff changed the range in the tracker
  const edited = pos("p1", "Blower Truck Operator", "Lake Oswego", "open", ["36.00", "41.00", "hour"]);
  const next = plan({ feedPages: [fp], dbPages: [dbpage(fp, { position_id: "p1" })], positions: [edited], postings: [posting("po1", "p1", "blower11")] });
  assert.deepEqual([next.positionUpdates, next.changes], [[], []]);
});

test("a pay line with no unit is applied and the note says the unit was assumed", () => {
  const p = pos("p1", "Blower Truck Crew Member", "Lake Oswego", "open");
  const fp = fpage("crew5", "Blower Truck Crew Member", "Lake Oswego", "$16-$20 D.O.E.");
  const r = plan({ feedPages: [fp], dbPages: [dbpage(fp, { position_id: "p1", pay_applied_text: null })], positions: [p], postings: [posting("po1", "p1", "crew5")] });
  assert.match(r.positionUpdates[0].pay_note, /no unit on the page; read as per hour/);
});

test("an unreadable pay line is flagged and the position's range is left alone", () => {
  const p = pos("p1", "Flatbed Truck Driver", "Eugene/Springfield", "open", [null, "82000.00", "year"]);
  const fp = fpage("driver8", "Flatbed Truck Driver - Home Most Nights", "Eugene/Springfield", "$1,200+ a week");
  const r = plan({ feedPages: [fp], dbPages: [dbpage(fp, { position_id: "p1", pay_applied_text: "Up to $82,000 annually." })], positions: [p], postings: [posting("po1", "p1", "driver8")] });
  assert.deepEqual(r.positionUpdates, []);
  assert.deepEqual(r.flags.map((f) => [f.kind, f.problem]), [["pay_unreadable", "not per hour or per year"]]);
  assert.equal(r.pages[0].pay_applied_text, "Up to $82,000 annually.");
});

test("a page with no pay line never clears the position's range", () => {
  const p = pos("p1", "Irrigation Installation Crew Member", "Eugene/Springfield", "open", ["20.00", "24.00", "hour"]);
  const fp = fpage("irrig2", "Irrigation Installation Crew Member", "Eugene/Springfield", null);
  const r = plan({ feedPages: [fp], dbPages: [dbpage(fp, { position_id: "p1", pay_applied_text: "$20-$24/hr" })], positions: [p], postings: [posting("po1", "p1", "irrig2")] });
  assert.deepEqual([r.positionUpdates, r.flags], [[], []]);
});

test("two live pages for one position that disagree on pay are flagged, not applied", () => {
  const p = pos("p1", "Landscape Maintenance Crew Member", "Central Oregon", "open", ["20.00", "23.00", "hour"]);
  const a = fpage("crew14", "Landscape Maintenance Crew Member", "Central Oregon", "$21.00 - $24.00/hour");
  const b = fpage("crew15", "Landscape Maintenance Crew Member", "Central Oregon", "$20.00 - $23.00/hour");
  const r = plan({ feedPages: [a, b], dbPages: [dbpage(a, { position_id: "p1", pay_applied_text: "$20.00 - $23.00/hour" }), dbpage(b, { position_id: "p1" })], positions: [p],
    postings: [posting("po1", "p1", "crew14"), posting("po2", "p1", "crew15")] });
  assert.deepEqual(r.positionUpdates, []);
  assert.deepEqual(kinds(r.flags), ["pay_conflict"]);
});

test("a page confirmed gone closes its open position and ends the posting", () => {
  const p = pos("p1", "Digital Marketer", "Eugene/Springfield", "open", ["20.00", "30.00", "hour"]);
  const fp = fpage("digital-marketer", "Digital Marketer", "Eugene/Springfield", "$20.00 - $30.00/hour");
  const r = plan({ dbPages: [dbpage(fp, { position_id: "p1" })], positions: [p], postings: [posting("po1", "p1", "digital-marketer")], gone: [fp.url] });
  assert.deepEqual(r.positionUpdates, [{ id: "p1", set: { status: "closed" }, opening_note: "Closed by the rexius.com sync: the job page was taken down." }]);
  assert.deepEqual(r.postingEnds, [{ id: "po1", ended_at: TODAY }]);
  assert.deepEqual(kinds(r.changes), ["closed", "page_gone"]);
  assert.equal(r.pages[0].gone_at, NOW);
});

test("a page missing from the feed but not confirmed gone changes nothing and is flagged", () => {
  const p = pos("p1", "Digital Marketer", "Eugene/Springfield", "open");
  const fp = fpage("digital-marketer", "Digital Marketer", "Eugene/Springfield", null);
  for (const [extra, kind] of [[{ stillUp: [fp.url] }, "not_listed"], [{}, "unreachable"]]) {
    const r = plan({ dbPages: [dbpage(fp, { position_id: "p1" })], positions: [p], postings: [posting("po1", "p1", "digital-marketer")], ...extra });
    assert.deepEqual([r.positionUpdates, r.postingEnds, r.changes, r.pages], [[], [], [], []]);
    assert.deepEqual(kinds(r.flags), [kind]);
  }
});

test("a position with two pages closes only when the last one goes", () => {
  const p = pos("p1", "Landscape Maintenance Crew Member", "Central Oregon", "open");
  const a = fpage("crew14", "Landscape Maintenance Crew Member", "Central Oregon", null);
  const b = fpage("crew15", "Landscape Maintenance Crew Member", "Central Oregon", null);
  const db = [dbpage(a, { position_id: "p1" }), dbpage(b, { position_id: "p1" })];
  const postings = [posting("po1", "p1", "crew14"), posting("po2", "p1", "crew15")];
  const one = plan({ feedPages: [b], dbPages: db, positions: [p], postings, gone: [a.url] });
  assert.deepEqual(one.positionUpdates, []);
  assert.deepEqual(one.postingEnds, [{ id: "po1", ended_at: TODAY }]);
  const both = plan({ dbPages: db, positions: [p], postings, gone: [a.url, b.url] });
  assert.equal(both.positionUpdates[0].set.status, "closed");
});

test("a page that comes back reopens the position with a new posting row", () => {
  const p = pos("p1", "Digital Marketer", "Eugene/Springfield", "closed");
  const fp = fpage("digital-marketer", "Digital Marketer", "Eugene/Springfield", null);
  const r = plan({ feedPages: [fp], dbPages: [dbpage(fp, { position_id: "p1", gone_at: "2026-11-02T14:15:00.000Z" })], positions: [p], postings: [posting("po1", "p1", "digital-marketer", "2026-11-02")] });
  assert.deepEqual(r.positionUpdates, [{ id: "p1", set: { status: "open" }, opening_note: "Opened by the rexius.com sync: the job page was published." }]);
  assert.deepEqual(r.postingInserts, [{ position_id: "p1", channel: "rexius_com", url: fp.url, posted_at: TODAY, notes: "Added by the rexius.com careers sync" }]);
  assert.deepEqual(kinds(r.changes), ["opened", "page_back"]);
  assert.equal(r.pages[0].gone_at, null);
});

test("a position staff reopened by hand while its page is down is left alone", () => {
  const p = pos("p1", "Digital Marketer", "Eugene/Springfield", "open");
  const fp = fpage("digital-marketer", "Digital Marketer", "Eugene/Springfield", null);
  const r = plan({ dbPages: [dbpage(fp, { position_id: "p1", gone_at: "2026-11-02T14:15:00.000Z" })], positions: [p], postings: [posting("po1", "p1", "digital-marketer", "2026-11-02")] });
  assert.deepEqual([r.positionUpdates, r.postingInserts, r.postingEnds, r.changes, r.flags, r.pages], [[], [], [], [], [], []]);
});

test("a position staff closed by hand while its page is up is left alone", () => {
  const p = pos("p1", "Digital Marketer", "Eugene/Springfield", "closed");
  const fp = fpage("digital-marketer", "Digital Marketer", "Eugene/Springfield", null);
  const r = plan({ feedPages: [fp], dbPages: [dbpage(fp, { position_id: "p1" })], positions: [p], postings: [posting("po1", "p1", "digital-marketer")] });
  assert.deepEqual([r.positionUpdates, r.changes], [[], []]);
});

test("a new page links through a posting row with its URL and opens a closed position", () => {
  const p = pos("p1", "Heavy Diesel Truck Mechanic", "Eugene/Springfield", "closed", ["25.00", "35.00", "hour"]);
  const fp = fpage("truck-mechanic18", "Diesel Mechanic (Swing Shift)", "Eugene/Springfield", "$27.00 - $37.00/hour");
  const r = plan({ feedPages: [fp], positions: [p], postings: [posting("po1", "p1", "truck-mechanic18", "2026-10-30")] });
  assert.deepEqual([r.pages[0].position_id, r.pages[0].link_source], ["p1", "posting"]);
  assert.deepEqual(r.positionUpdates[0].set, { status: "open", pay_min: 27, pay_max: 37, pay_unit: "hour" });
  assert.equal(r.postingInserts.length, 1);
  assert.deepEqual(kinds(r.changes), ["opened", "page_new", "pay"]);
});

test("a new page links by exact title only when one position at its location has it", () => {
  const positions = [pos("p1", "Landscape Maintenance Crew Member", "Central Oregon", "open"), pos("p2", "Landscape Maintenance Crew Member", "Eugene/Springfield", "closed")];
  const eug = fpage("worker10", "Landscape Maintenance Crew Member", "Eugene/Springfield", null, "2026-11-09T18:00:00.000Z");
  const r = plan({ feedPages: [eug], positions });
  assert.deepEqual([r.pages[0].position_id, r.pages[0].link_source], ["p2", "title"]);
  assert.equal(r.positionUpdates[0].set.status, "open");
  assert.deepEqual(r.postingInserts[0].posted_at, "2026-11-09");
  // no location on the page, a different title, or two candidates: not linked, flagged
  for (const fp of [fpage("w11", "Landscape Maintenance Crew Member", null, null), fpage("w12", "Maintenance Crew", "Eugene/Springfield", null)]) {
    const u = plan({ feedPages: [fp], positions });
    assert.equal(u.pages[0].position_id, null);
    assert.deepEqual([kinds(u.flags), u.positionUpdates, u.postingInserts], [["unlinked"], [], []]);
  }
  const twins = [pos("p3", "Crew Member", "Lake Oswego", "open"), pos("p4", "Crew  member", "Lake Oswego", "closed")];
  assert.equal(plan({ feedPages: [fpage("w13", "Crew Member", "Lake Oswego", null)], positions: twins }).pages[0].position_id, null);
});

test("an ignored page is never linked, flagged or counted", () => {
  const fp = fpage("all-positions", "General Application", null, null);
  const r = plan({ feedPages: [fp], dbPages: [{ url: fp.url, ignored: true, gone_at: null, position_id: null, link_source: null, pay_applied_text: null, first_seen_at: NOW, last_seen_at: null }],
    positions: [pos("p1", "General Application", "Eugene/Springfield", "closed")] });
  assert.deepEqual([r.flags, r.positionUpdates, r.changes], [[], [], []]);
  assert.equal(r.pages[0].ignored, true);
  assert.equal(r.pages[0].title, "General Application");
});

test("a page staff linked in the tracker gets its posting row and pay on the next run, not a status change", () => {
  const p = pos("p1", "Flatbed Truck Driver", "Eugene/Springfield", "closed");
  const fp = fpage("driver8", "Flatbed Truck Driver - Home Most Nights", "Eugene/Springfield", "Up to $82,000 annually. $1,200+ a week.");
  const r = plan({ feedPages: [fp], dbPages: [dbpage(fp, { position_id: "p1", link_source: "staff", pay_applied_text: null })], positions: [p] });
  assert.deepEqual(r.positionUpdates, [{ id: "p1", set: { pay_min: null, pay_max: 82000, pay_unit: "year" }, pay_note: 'From rexius.com: "Up to $82,000 annually. $1,200+ a week."' }]);
  assert.equal(r.postingInserts.length, 1);
});

test("the first run after the migration: seeded pages that are long gone end quietly", () => {
  const open = pos("p1", "Blower Truck Operator", "Lake Oswego", "open", ["28.00", "38.00", "hour"]);
  const closed = pos("p2", "Digital Marketer", "Eugene/Springfield", "closed", ["20.00", "30.00", "hour"]);
  const seed = (handle, position_id) => ({ url: U(handle), title: null, location: null, gone_at: null, position_id, link_source: "posting", ignored: false, pay_text: null, pay_applied_text: null, first_seen_at: NOW, last_seen_at: null });
  const r = plan({
    feedPages: [fpage("blower11", "Blower Truck Operator", "Lake Oswego", "$35.00 -$40.00/hour D.O.E.")],
    dbPages: [seed("blower11", "p1"), seed("digital-marketer", "p2")], positions: [open, closed],
    postings: [posting("po1", "p1", "blower11"), posting("po2", "p2", "digital-marketer")], gone: [U("digital-marketer")],
  });
  assert.deepEqual(r.positionUpdates.map((u) => [u.id, u.set]), [["p1", { pay_min: 35, pay_max: 40, pay_unit: "hour" }]]);
  assert.deepEqual(r.postingEnds, [{ id: "po2", ended_at: TODAY }]);
  assert.deepEqual(kinds(r.changes), ["page_gone", "pay"]);
});
