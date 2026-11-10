// Rexius Recruiter: reading the rexius.com careers page and deciding what the tracker should
// change because of it. Shared by the Edge Function recruiting-careers-sync and the local dry run
// (scripts/careers-sync/dry-run.mjs); pure functions only, no network and no database, so the
// rules can be tested with `npm run careers:test`.
//
// The careers page is a Shopify blog: one article per job. Its Atom feed
// (https://rexius.com/blogs/careers.atom) lists every published job with its title, body and
// dates in one request, and one feed per location tag says where each job is. A job page that is
// unpublished or deleted leaves the feed and answers 404.
//
// The rules (README "What the careers sync created"):
//   * A page is tied to a position by its URL (recruiting.careers_pages.position_id), never by
//     title alone: titles on the site differ from the tracker's ("Flatbed Truck Driver - Home
//     Most Nights"). A new page links itself only through an existing rexius.com posting row with
//     that URL, or when exactly one position at its location has exactly its title.
//   * Status follows events, not state: a position closes when its last live page goes away and
//     opens when a page appears for it. A position staff reopened by hand is left alone until the
//     site changes again, and a position that never had a page is never touched.
//   * Pay follows the page's "Pay:" line when that line changes (or is seen for the first time)
//     and can be read with confidence. Anything else is flagged for staff, never guessed.
//   * A page counts as gone only when it is missing from the feed AND its own URL answers
//     404 or 410. A failed or half-empty fetch changes nothing.

export const CAREERS_ORIGIN = "https://rexius.com";
export const CAREERS_PATH = "/blogs/careers";
export const CAREERS_FEED = CAREERS_ORIGIN + CAREERS_PATH + ".atom";
/** Location tag on the site -> location name in the tracker. */
export const TAG_LOCATIONS = {
  "eugene": "Eugene/Springfield",
  "central-oregon": "Central Oregon",
  "lake-oswego": "Lake Oswego",
};
export function tagFeedUrl(tag) { return `${CAREERS_ORIGIN}${CAREERS_PATH}/tagged/${tag}.atom`; }

// ---------------------------------------------------------------------------------------------
// Reading the feed
// ---------------------------------------------------------------------------------------------

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", trade: "™", reg: "®" };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** Article HTML -> plain text, one line per block element. */
export function htmlToText(html) {
  const t = String(html)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|li|div|h[1-6]|tr|ul|ol|table)>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return decodeEntities(t).replace(/ /g, " ")
    .split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n");
}

/**
 * The address of one job page, or null for anything else. Everything the sync stores or fetches
 * goes through here, so the function can only ever request pages under rexius.com/blogs/careers.
 */
export function normalizeUrl(u) {
  if (typeof u !== "string") return null;
  const m = /^https?:\/\/(?:www\.)?rexius\.com\/blogs\/careers\/([a-z0-9][a-z0-9-]{0,150})\/?(?:[?#].*)?$/i.exec(u.trim());
  if (!m) return null;
  const handle = m[1].toLowerCase();
  if (handle === "tagged") return null;
  return `${CAREERS_ORIGIN}${CAREERS_PATH}/${handle}`;
}

function tagText(entry, name) {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(entry);
  if (!m) return null;
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(m[1]);
  return cdata ? cdata[1] : decodeEntities(m[1]);
}
function isoOrNull(s) {
  if (!s) return null;
  const d = new Date(s.trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Atom XML -> [{url, title, published_at, site_updated_at, html}]. Throws when it is not a feed. */
export function parseFeed(xml) {
  if (typeof xml !== "string" || !/<feed\b[^>]*xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/i.test(xml)) throw new Error("not an Atom feed");
  const out = [], seen = new Set();
  const re = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const e = m[1];
    const href = /<link\b[^>]*\brel="alternate"[^>]*\bhref="([^"]+)"/i.exec(e) || /<link\b[^>]*\bhref="([^"]+)"[^>]*\brel="alternate"/i.exec(e);
    const url = normalizeUrl(decodeEntities(href ? href[1] : (tagText(e, "id") || "")));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      title: (tagText(e, "title") || "").replace(/\s+/g, " ").trim().slice(0, 200),
      published_at: isoOrNull(tagText(e, "published")),
      site_updated_at: isoOrNull(tagText(e, "updated")),
      html: tagText(e, "content") || "",
    });
  }
  return out;
}

/** The "Job Type:" and "Pay:" lines of a job page's text. */
export function parseJob(text) {
  const jt = /Job Type\s*:\s*([^\n]*?)\s*(?=Pay(?:\s+R(?:ange|ate))?\s*:|\n|$)/.exec(text);
  const pay = /(?:Pay(?:\s+R(?:ange|ate))?|Compensation|Wages?|Salary)\s*:\s*([^\n]+)/.exec(text);
  return {
    job_type: jt && jt[1] ? jt[1].slice(0, 120) : null,
    pay_text: pay ? pay[1].replace(/\s+/g, " ").trim().slice(0, 200) || null : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Reading a pay line
// ---------------------------------------------------------------------------------------------

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(\s?k\b)?`;
function toNumber(whole, cents, k) {
  let n = Number(whole.replace(/,/g, "")) + (cents ? Number("0." + cents) : 0);
  if (k) n *= 1000;
  return Math.round(n * 100) / 100;
}

/**
 * "$22.00 - $25.00/hour D.O.E." -> {pay_min: 22, pay_max: 25, pay_unit: "hour"}.
 * Returns {problem} instead when the line cannot be read with confidence; the caller flags it.
 * Only the first sentence with a dollar amount counts ("Up to $82,000 annually. $1,200+ a week.").
 */
export function parsePay(payText) {
  const t = String(payText || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
  const seg = t.split(/[.;]\s+(?=[A-Z$])/).find((s) => /\$\s?\d/.test(s));
  if (!seg) return { problem: "no dollar amount" };

  const amounts = seg.match(new RegExp(String.raw`\$\s?` + NUM, "gi")) || [];
  const range = new RegExp(String.raw`\$\s?${NUM}\s*(?:-|–|—|to)\s*\$?\s?${NUM}`, "i").exec(seg);
  let min = null, max = null;
  if (range) {
    if (amounts.length > 2) return { problem: "more than one range or amount" };
    // "$60-70k" and "$60k-$70k" both mean thousands on each side.
    const k = (range[3] || range[6]) ? "k" : null;
    const small = (w) => Number(w.replace(/,/g, "")) < 1000;
    min = toNumber(range[1], range[2], k && small(range[1]) ? k : null);
    max = toNumber(range[4], range[5], k && small(range[4]) ? k : null);
  } else {
    if (amounts.length !== 1) return { problem: "more than one amount" };
    const one = new RegExp(String.raw`\$\s?${NUM}(\s?\+)?`, "i").exec(seg);
    const v = toNumber(one[1], one[2], one[3]);
    if (/\bup to\b|\bmax(?:imum)?\b|\bno more than\b/i.test(seg)) max = v;
    else if (one[4] || /\b(?:and up|or more|min(?:imum)?|starting|starts|from|at least)\b/i.test(seg)) min = v;
    else { min = v; max = v; }
  }

  const hourly = /(?:\/|\bper\b|\ban?\b)\s*(?:hour|hr)\b|\bhourly\b/i.test(seg);
  const yearly = /(?:\/|\bper\b|\ba\b)\s*(?:year|yr)\b|\bannual(?:ly)?\b|\byearly\b|\bsalar(?:y|ied)\b/i.test(seg);
  const other = /(?:\/|\bper\b|\ba\b)\s*(?:week|month|day|shift|load|mile)\b|\b(?:weekly|monthly|daily)\b/i.test(seg);
  const values = [min, max].filter((v) => v != null);
  let unit, assumed = false;
  if (hourly && yearly) return { problem: "both hourly and yearly" };
  if (hourly) unit = "hour";
  else if (yearly) unit = "year";
  else if (other) return { problem: "not per hour or per year" };
  else if (values.every((v) => v <= 200)) { unit = "hour"; assumed = true; }
  else if (values.every((v) => v >= 15000)) { unit = "year"; assumed = true; }
  else return { problem: "no unit and the amount fits neither hourly nor yearly" };

  if (min != null && max != null && min > max) return { problem: "range is upside down" };
  const [lo, hi] = unit === "hour" ? [5, 200] : [10000, 500000];
  if (values.some((v) => v < lo || v > hi)) return { problem: `amount outside ${lo} to ${hi} per ${unit}` };
  return { pay_min: min, pay_max: max, pay_unit: unit, assumed_unit: assumed };
}

/** A parsed feed entry plus its location tags -> the fields kept in recruiting.careers_pages. */
export function pageFromEntry(entry, tags) {
  const job = parseJob(htmlToText(entry.html));
  const known = (tags || []).filter((t) => TAG_LOCATIONS[t]);
  const pay = job.pay_text ? parsePay(job.pay_text) : {};
  return {
    url: entry.url,
    title: entry.title,
    tags: tags || [],
    location: known.length === 1 ? TAG_LOCATIONS[known[0]] : null,
    job_type: job.job_type,
    pay_text: job.pay_text,
    pay_min: pay.pay_min ?? null,
    pay_max: pay.pay_max ?? null,
    pay_unit: pay.pay_unit ?? null,
    pay_problem: pay.problem ?? null,
    published_at: entry.published_at,
    site_updated_at: entry.site_updated_at,
  };
}

// ---------------------------------------------------------------------------------------------
// Deciding what to change
// ---------------------------------------------------------------------------------------------

/**
 * Null when the feed looks like the real careers page, or the reason to change nothing: the feed
 * is empty, or lists fewer than half the jobs the tracker last saw (a redesign, a block page or a
 * bulk mistake on the site; staff look before the tracker closes half the positions).
 */
export function feedProblem(feedCount, knownLiveCount) {
  if (!feedCount) return "the careers page listed no jobs";
  if (knownLiveCount >= 4 && feedCount * 2 < knownLiveCount) return `the careers page listed ${feedCount} job(s) where the tracker last saw ${knownLiveCount}`;
  return null;
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const num = (v) => (v == null || v === "" ? null : Number(v));
const samePay = (a, b) => num(a.pay_min) === num(b.pay_min) && num(a.pay_max) === num(b.pay_max) && (a.pay_unit || null) === (b.pay_unit || null);
export function payLabel(p) {
  const f = (n) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const lo = num(p.pay_min), hi = num(p.pay_max);
  if (lo == null && hi == null) return "no range";
  const unit = p.pay_unit === "year" ? "/yr" : "/hr";
  if (lo != null && hi != null) return (lo === hi ? f(lo) : f(lo) + "–" + f(hi)) + unit;
  return (lo != null ? f(lo) + "+" : "up to " + f(hi)) + unit;
}

/**
 * @param input.now       ISO timestamp of the run
 * @param input.today     Oregon date of the run, YYYY-MM-DD
 * @param input.feedPages pages from the feed (pageFromEntry)
 * @param input.gone      URLs missing from the feed whose own address answered 404 or 410
 * @param input.stillUp   URLs missing from the feed whose own address still answered 200
 * @param input.dbPages   rows of recruiting.careers_pages
 * @param input.positions rows of recruiting.positions (id, title, location, status, pay_*, jotform_option_label)
 * @param input.postings  rows of recruiting.postings with channel rexius_com
 * @returns {pages, positionUpdates, postingInserts, postingEnds, changes, flags}
 *   pages: every row to upsert by url; changes: what the run did, for the log;
 *   flags: what staff should look at.
 */
export function planSync(input) {
  const { now, today, feedPages, dbPages, positions, postings } = input;
  const gone = new Set(input.gone || []), stillUp = new Set(input.stillUp || []);
  const posById = new Map(positions.map((p) => [p.id, p]));
  const sitePostings = postings.map((po) => ({ ...po, nurl: normalizeUrl(po.url) })).filter((po) => po.nurl);
  const changes = [], flags = [], touched = new Set();

  // Which positions had a live page before this run.
  const isLive = (pg) => !pg.gone_at && !pg.ignored;
  const liveBefore = new Set(dbPages.filter((pg) => isLive(pg) && pg.position_id).map((pg) => pg.position_id));

  const pages = new Map(dbPages.map((pg) => [pg.url, { ...pg }]));
  const autoLink = (pg) => {
    const viaPosting = sitePostings.filter((po) => po.nurl === pg.url && posById.has(po.position_id));
    const ids = [...new Set(viaPosting.map((po) => po.position_id))];
    if (ids.length === 1) return { position_id: ids[0], link_source: "posting" };
    if (ids.length > 1 || !pg.location) return null;
    const t = norm(pg.title);
    const byTitle = positions.filter((p) => p.location === pg.location && (norm(p.title) === t || norm(p.jotform_option_label) === t));
    return byTitle.length === 1 ? { position_id: byTitle[0].id, link_source: "title" } : null;
  };

  // 1. Pages the feed lists.
  const inFeed = new Set();
  for (const fp of feedPages) {
    inFeed.add(fp.url);
    const old = pages.get(fp.url);
    const pg = old
      ? { ...old, ...fp, last_seen_at: now, gone_at: null }
      : { ...fp, first_seen_at: now, last_seen_at: now, gone_at: null, position_id: null, link_source: null, ignored: false, pay_applied_text: null };
    if (pg.position_id && !posById.has(pg.position_id)) { pg.position_id = null; pg.link_source = null; }
    if (!pg.position_id && !pg.ignored) {
      const link = autoLink(pg);
      if (link) Object.assign(pg, link);
    }
    if (!old) changes.push({ kind: "page_new", url: pg.url, title: pg.title, location: pg.location, position_id: pg.position_id });
    else if (old.gone_at) changes.push({ kind: "page_back", url: pg.url, title: pg.title, location: pg.location, position_id: pg.position_id });
    pages.set(pg.url, pg); touched.add(pg.url);
  }

  // 2. Pages the tracker knew that the feed no longer lists.
  for (const pg of pages.values()) {
    if (inFeed.has(pg.url) || pg.gone_at) continue;
    if (gone.has(pg.url)) {
      pg.gone_at = now; touched.add(pg.url);
      changes.push({ kind: "page_gone", url: pg.url, title: pg.title, location: pg.location, position_id: pg.position_id });
    } else if (!pg.ignored) {
      flags.push({ kind: stillUp.has(pg.url) ? "not_listed" : "unreachable", url: pg.url, title: pg.title, position_id: pg.position_id });
    }
  }

  // 3. Status: only on a change of "has a live page".
  const linked = new Map();
  for (const pg of pages.values()) if (pg.position_id && !pg.ignored) (linked.get(pg.position_id) || linked.set(pg.position_id, []).get(pg.position_id)).push(pg);
  const updates = new Map();
  const upd = (id) => updates.get(id) || updates.set(id, { id, set: {} }).get(id);
  for (const [pid, list] of linked) {
    const pos = posById.get(pid); if (!pos) continue;
    const before = liveBefore.has(pid), after = list.some((pg) => !pg.gone_at);
    if (before && !after && pos.status === "open") {
      upd(pid).set.status = "closed"; upd(pid).opening_note = "Closed by the rexius.com sync: the job page was taken down.";
      changes.push({ kind: "closed", position_id: pid, title: pos.title, location: pos.location, url: list[0].url });
    } else if (!before && after && pos.status !== "open") {
      upd(pid).set.status = "open"; upd(pid).opening_note = "Opened by the rexius.com sync: the job page was published.";
      changes.push({ kind: "opened", position_id: pid, title: pos.title, location: pos.location, from: pos.status, url: list.find((pg) => !pg.gone_at).url });
    }
  }

  // 4. Pay: when a live page's pay line is new to the tracker and readable.
  for (const [pid, list] of linked) {
    const pos = posById.get(pid); if (!pos) continue;
    const live = list.filter((pg) => !pg.gone_at && pg.pay_text);
    const fresh = live.filter((pg) => pg.pay_text !== pg.pay_applied_text);
    if (!fresh.length) continue;
    const unreadable = fresh.filter((pg) => pg.pay_problem);
    for (const pg of unreadable) flags.push({ kind: "pay_unreadable", url: pg.url, title: pg.title, position_id: pid, pay_text: pg.pay_text, problem: pg.pay_problem });
    const readable = live.filter((pg) => !pg.pay_problem);
    if (!readable.length || !fresh.some((pg) => !pg.pay_problem)) continue;
    if (readable.some((pg) => !samePay(pg, readable[0]))) {
      flags.push({ kind: "pay_conflict", position_id: pid, title: pos.title, pages: readable.map((pg) => ({ url: pg.url, pay_text: pg.pay_text })) });
      continue;
    }
    const src = fresh.find((pg) => !pg.pay_problem);
    if (!samePay(src, pos)) {
      Object.assign(upd(pid).set, { pay_min: src.pay_min, pay_max: src.pay_max, pay_unit: src.pay_unit });
      upd(pid).pay_note = `From rexius.com: "${src.pay_text}"` + (src.pay_unit && parsePay(src.pay_text).assumed_unit ? ` (no unit on the page; read as per ${src.pay_unit})` : "");
      changes.push({ kind: "pay", position_id: pid, title: pos.title, location: pos.location, from: payLabel(pos), to: payLabel(src), pay_text: src.pay_text, url: src.url });
    }
    for (const pg of readable) if (pg.pay_text !== pg.pay_applied_text) { pg.pay_applied_text = pg.pay_text; touched.add(pg.url); }
  }

  // 5. Posting rows follow the pages: one open rexius.com row per live linked page.
  const postingInserts = [], postingEnds = [];
  for (const pg of pages.values()) {
    const rows = sitePostings.filter((po) => po.nurl === pg.url);
    if (pg.gone_at) {
      if (pg.gone_at === now) for (const po of rows) if (!po.ended_at) postingEnds.push({ id: po.id, ended_at: po.posted_at > today ? po.posted_at : today });
      continue;
    }
    if (!pg.position_id || pg.ignored) continue;
    const mine = rows.filter((po) => po.position_id === pg.position_id);
    if (mine.some((po) => !po.ended_at)) continue;
    const firstDay = pg.published_at ? pg.published_at.slice(0, 10) : today;
    postingInserts.push({
      position_id: pg.position_id, channel: "rexius_com", url: pg.url,
      posted_at: mine.length || firstDay > today ? today : firstDay,
      notes: "Added by the rexius.com careers sync",
    });
  }

  // 6. Live pages nobody has tied to a position.
  for (const pg of pages.values()) {
    if (pg.gone_at || pg.ignored || pg.position_id) continue;
    flags.push({ kind: "unlinked", url: pg.url, title: pg.title, location: pg.location, pay_text: pg.pay_text });
  }

  return {
    pages: [...pages.values()].filter((pg) => touched.has(pg.url)),
    positionUpdates: [...updates.values()].filter((u) => Object.keys(u.set).length),
    postingInserts, postingEnds, changes, flags,
  };
}
