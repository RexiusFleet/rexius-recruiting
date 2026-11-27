// Rexius Recruiter: which page a market check link really opens.
//
// Claude writes each posting's address into its JSON answer as text, and three things went
// wrong with that: the address was a job board's search page (many jobs, the one named not
// among them by the time someone clicks), it was assembled or shortened by the model and led
// nowhere, or it was right. The function cannot open the pages (Indeed and LinkedIn refuse),
// but it does hold the exact addresses the web search returned, so it can tell the three apart:
//
//   "posting"     the address came back from the search and is the page of one job
//   "list"        the address came back from the search but is a search or list page
//   "unverified"  the address is not among the search results: the model wrote it itself
//
// Pure functions, no network, no database: shared by recruiting-market-check and
// recruiting-national-check, tested in scripts/market-check/links.test.mjs.

/** Query parameters that only track where a click came from; ignored when comparing addresses. */
const TRACKING = /^(utm_[a-z]+|gclid|fbclid|msclkid|ref|refid|src|source|from|trk|trackingid|campaign(id)?|mc_[a-z]+)$/i;

/** Query parameters that name one job, whatever else the address says. */
const JOB_ID = /^(jk|vjk|jid|lvk|jl|joblistingid|jobid|job_id|gh_jid|reqid|req_id|requisitionid|postingid|posting_id|currentjobid)$/i;

/** Query parameters of a search form. */
const SEARCH = /^(q|query|keywords?|search|searchterm|search_term|what|where|l|location|radius|sort|page|start)$/i;

/** Last path segments that are a careers or search page, not one job. */
const LIST_SEGMENTS = new Set([
  "jobs", "job", "careers", "career", "employment", "job-search", "jobsearch", "search", "search-jobs",
  "job-openings", "openings", "current-openings", "open-positions", "positions", "opportunities",
  "job-opportunities", "career-opportunities", "employment-opportunities", "vacancies", "join-our-team",
  "join-us", "work-with-us", "work-for-us", "now-hiring", "hiring", "careers-home", "all-jobs", "browse",
]);

function parse(url) {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch { return null; }
}

function bareHost(u) { return u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, ""); }

/** True when `host` is `domain` or a subdomain of it. */
function on(host, domain) { return host === domain || host.endsWith("." + domain); }

/**
 * One form of an address for comparing two spellings of the same page: no scheme, no www, no
 * fragment, no trailing slash, tracking parameters dropped, the rest of the query sorted.
 * The path keeps its case, because some sites' job IDs are case-sensitive. Null if not a URL.
 */
export function linkKey(url) {
  const u = parse(url);
  if (!u) return null;
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k))
    .sort((a, b) => (a[0] + "=" + a[1] < b[0] + "=" + b[1] ? -1 : 1))
    .map(([k, v]) => `${k.toLowerCase()}=${v}`);
  let path = u.pathname;
  try { path = decodeURIComponent(path); } catch { /* keep as written */ }
  path = path.replace(/\/+$/, "");
  return bareHost(u) + path + (params.length ? "?" + params.join("&") : "");
}

/**
 * "posting" when the address is the page of one job, "list" when it is a search, list or
 * careers home page. The big job boards have their own rules; anything else is judged by its
 * shape. Null if not a URL. A guess from the address alone: it never opens the page.
 */
export function linkKind(url) {
  const u = parse(url);
  if (!u) return null;
  const host = bareHost(u);
  const path = u.pathname.toLowerCase();
  const keys = [...u.searchParams.keys()];
  const hasJobId = keys.some((k) => JOB_ID.test(k) && (u.searchParams.get(k) ?? "").trim() !== "");
  const one = (yes) => (yes ? "posting" : "list");

  if (on(host, "indeed.com")) return one(hasJobId || /^\/(m\/)?(viewjob|rc\/clk|pagead\/clk|job\/)/.test(path));
  if (on(host, "linkedin.com")) return one(/^\/jobs\/view\//.test(path) || keys.some((k) => /^currentjobid$/i.test(k)));
  // ZipRecruiter: /Jobs/<keyword>/-in-<place> (capital J) is a search; /jobs/<employer>/<job> is one job.
  if (on(host, "ziprecruiter.com")) return one(hasJobId || /^\/(c|k|job|ojob)\//.test(path) || /^\/jobs\/[^/]+\/[^/]+/.test(u.pathname));
  if (on(host, "glassdoor.com")) return one(hasJobId || /^\/job-listing\//.test(path));
  if (on(host, "simplyhired.com")) return one(/^\/job\/[^/]+/.test(path));
  if (on(host, "snagajob.com")) return one(/^\/jobs\/\d+/.test(path));
  if (on(host, "craigslist.org")) return one(/\/\d{6,}\.html$/.test(path));
  if (on(host, "governmentjobs.com")) return one(/\/jobs\/\d+/.test(path));
  if (on(host, "monster.com")) return one(/^\/job-openings\//.test(path));
  if (on(host, "careerbuilder.com")) return one(/^\/job\/[^/]+/.test(path));
  if (on(host, "talent.com")) return one(/^\/view/.test(path) && keys.includes("id"));
  if (on(host, "jooble.org")) return one(/^\/(desc|jdp)\//.test(path));
  if (on(host, "salary.com") || on(host, "payscale.com") || on(host, "bls.gov")) return "list";

  // Everything else: employers' own sites and applicant tracking systems.
  if (hasJobId) return "posting";
  const segments = path.split("/").filter(Boolean);
  if (!segments.length) return "list";
  if (keys.some((k) => SEARCH.test(k))) return "list";
  const last = segments[segments.length - 1].replace(/\.(html?|php|aspx?)$/, "");
  if (LIST_SEGMENTS.has(last)) return "list";
  if (/(^|-)jobs$/.test(last) || /^jobs-in-/.test(last) || /-jobs-in-/.test(last) || /-jobs-srch/.test(last)) return "list";
  return "posting";
}

/**
 * Settles the link of each item ({url, url_kind?, ...}) against the addresses the search
 * returned. Returns new items with `url` replaced by the search's own spelling when it matches,
 * `link` set to "posting", "list" or "unverified" (null when there is no address), and the
 * model's `url_kind` removed. The model's own "list" is believed (it read the page; the address
 * of a small employer's careers page says nothing), its "posting" is not.
 *
 * `hitUrls`: every result URL from the web search tool. Empty means the search results could
 * not be read at all, so nothing can be called unverified; the address shape still applies.
 */
export function settleLinks(items, hitUrls) {
  const hits = new Map();
  for (const h of hitUrls ?? []) { const k = linkKey(h); if (k && !hits.has(k)) hits.set(k, h); }
  return (items ?? []).map((item) => {
    const { url_kind: said, ...rest } = item;
    if (!rest.url) return { ...rest, url: null, link: null };
    const key = linkKey(rest.url);
    if (!key) return { ...rest, url: null, link: null };
    const found = hits.get(key);
    if (!found && hits.size) return { ...rest, link: "unverified" };
    const url = found ?? rest.url;
    return { ...rest, url, link: said === "list" ? "list" : linkKind(url) };
  });
}

/**
 * For rows that repeat a posting (the pay table): take the posting's settled link when the
 * address is the same, so the two tables never disagree about one page.
 */
export function settleLike(items, hitUrls, settled) {
  const known = new Map();
  for (const s of settled ?? []) { const k = s.url && linkKey(s.url); if (k) known.set(k, s); }
  return settleLinks(items, hitUrls).map((item) => {
    const same = item.url ? known.get(linkKey(item.url)) : null;
    return same ? { ...item, url: same.url, link: same.link } : item;
  });
}

/** How many of the settled items have each kind of link; for the log line. */
export function linkCounts(items) {
  const c = { posting: 0, list: 0, unverified: 0, none: 0 };
  for (const i of items ?? []) c[i.link ?? "none"]++;
  return c;
}
