/* Market check report: one run of the per-position market check (Phase 9a), or of the national
 * check, as a PDF to send to a hiring manager, or as plain text to paste into an email. Built
 * here in the browser from the row the page already holds, with the shared kit in pdf-kit.js
 * (jsPDF, Public Sans, the Rexius wordmark), the same way application-pdf.js builds the
 * application PDF. Nothing is fetched and nothing is written to Supabase; the file exists only
 * as the download in the user's browser.
 *
 * The report says what the run found and how it compares with Rexius' advertised range. It
 * carries the same caveat as the page: a sample from web search results, not a complete count.
 * Pay figures are what other employers advertise; no Rexius wage is in it. Page titles that the
 * search returned are stripped of any HTML before they are printed.
 */
(function () {
  "use strict";

  function K() { var k = window.RR && RR.pdfKit; if (!k) throw new Error("The PDF module did not load. Reload the page and try again."); return k; }

  // ---------- Shared wording (PDF and text) ----------
  function money(n) { if (n == null) return "—"; var v = Number(n), whole = Math.abs(v - Math.round(v)) < 0.005; return "$" + v.toLocaleString(undefined, { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }); }
  function unitSuffix(u) { return u === "year" ? "/yr" : "/hr"; }
  function rangeText(lo, hi, unit) {
    if (lo == null && hi == null) return "—";
    return (lo != null && hi != null && Number(lo) !== Number(hi) ? money(lo) + "–" + money(hi) : money(lo != null ? lo : hi)) + unitSuffix(unit);
  }
  function fmtDateTime(d) { return d.toLocaleString(undefined, { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); }
  function fmtDay(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ""); if (!m) return s || ""; return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
  function today() { return new Date().toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }); }
  function clean(s) { return window.RR && RR.pdfKit ? RR.pdfKit.stripHtml(s) : String(s == null ? "" : s); }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  var TRIGGER = { manual: "run by hand", schedule: "scheduled run", opened: "run when the position opened" };

  // Verdict wording shared by both reports. `what` names the market side of the comparison.
  function verdict(below, what) {
    if (below === true) return { chip: "Below market", tone: "warn", text: "The top of Rexius' range is below the median low end " + what + "." };
    if (below === false) return { chip: "At or above market", tone: "good", text: "The top of Rexius' range is at or above the median low end " + what + "." };
    return { chip: "Nothing to compare", tone: "neutral", text: "Rexius has no advertised range to compare, or no pay figures were found." };
  }

  // Everything the local report says, in one structure both renderers walk.
  function model(position, check, preparedBy) {
    var cmp = check.comparison || null;
    var ranges = check.pay_ranges || [], postings = check.postings || [], sources = check.sources || [];
    var ran = new Date(check.ran_at);
    // Rexius' range as it was when the run compared it (the comparison keeps a copy), else today's.
    var rMin = cmp && cmp.position_min != null ? cmp.position_min : position.pay_min;
    var rMax = cmp && cmp.position_max != null ? cmp.position_max : position.pay_max;
    var rUnit = cmp && cmp.unit ? cmp.unit : (position.pay_unit || "hour");
    var hasMarket = cmp && cmp.market_low_median != null;
    var v = verdict(hasMarket ? check.below_market : null, "others advertise");
    var figures = [];
    figures.push(["Rexius advertises", rMin != null || rMax != null ? rangeText(rMin, rMax, rUnit) : "no range set"]);
    if (hasMarket) figures.push(["Others advertise", rangeText(cmp.market_low_median, cmp.market_high_median, cmp.unit) + " (medians of " + plural(cmp.ranges_compared, "range", "ranges") + " found)"]);
    figures.push(["Against the market", v.chip + ": " + v.text]);
    figures.push(["Postings found", postings.length + (ranges.length ? ", " + ranges.length + " with pay shown" : "")]);
    return {
      title: position.title + " · " + position.location,
      subtitle: "Run " + fmtDateTime(ran) + " · " + (TRIGGER[check.trigger] || check.trigger),
      rexius: rMin != null || rMax != null ? rangeText(rMin, rMax, rUnit) : "No range set",
      market: hasMarket ? rangeText(cmp.market_low_median, cmp.market_high_median, cmp.unit) : null,
      marketSub: hasMarket ? "Medians of " + plural(cmp.ranges_compared, "pay range", "pay ranges") + " found" : "No pay figures found",
      verdict: v,
      figures: figures,
      summary: check.summary || "",
      ranges: ranges, postings: postings, sources: sources,
      caveat: "This is a sample drawn from web search results on " + fmtDateTime(ran) + ", not a complete count of openings. Pay figures are what other employers advertised on the pages found; none is a Rexius wage. Generated by Rexius Recruiter with Claude (" + (check.model || "Claude") + ", " + (check.searches != null ? plural(check.searches, "web search", "web searches") : "web search") + ").",
      byline: (preparedBy ? "Prepared by " + preparedBy + " · " : "") + "Rexius Recruiter · " + today(),
      ran: ran
    };
  }

  // ---------- Plain text ----------
  function text(position, check, preparedBy) {
    var m = model(position, check, preparedBy);
    var out = [m.title, "Market check · " + m.subtitle, ""];
    m.figures.forEach(function (f) { out.push(f[0] + ": " + f[1]); });
    out.push("", m.summary, "");
    if (m.ranges.length) {
      out.push("Pay others advertise");
      m.ranges.forEach(function (r) { out.push("- " + (r.employer || "Unknown") + (r.title ? ", " + clean(r.title) : "") + ": " + rangeText(r.min, r.max, r.unit) + (r.url ? " (" + r.url + ")" : "")); });
      out.push("");
    }
    if (m.postings.length) {
      out.push("Who else is hiring");
      m.postings.forEach(function (p) {
        var bits = [p.pay_text, p.location, p.posted ? "posted " + fmtDay(p.posted) : null].filter(Boolean);
        out.push("- " + (p.employer || "Unknown") + (p.title ? ", " + clean(p.title) : "") + (bits.length ? " (" + bits.join(", ") + ")" : "") + (p.url ? " " + p.url : ""));
      });
      out.push("");
    }
    if (m.sources.length) { out.push("Sources"); m.sources.forEach(function (s) { out.push("- " + (clean(s.title) ? clean(s.title) + " " : "") + s.url); }); out.push(""); }
    out.push(m.caveat, m.byline);
    return out.join("\n");
  }

  // ---------- PDF ----------
  function linkCell(textValue, url, style) { return { text: textValue, link: url || null, style: style }; }

  async function build(position, check, preparedBy) {
    var kit = K();
    var m = model(position, check, preparedBy);
    var doc = await kit.create({ kind: "Market check", title: m.title, subtitle: m.subtitle, date: today(), byline: m.byline, docTitle: m.title + " - market check" });
    var w = doc.w;
    w.tiles([
      { label: "Rexius advertises", value: m.rexius },
      { label: "Others advertise", value: m.market || "—", sub: m.marketSub },
      { label: "Against the market", chip: m.verdict.chip, tone: m.verdict.tone, sub: m.verdict.text },
      { label: "Postings found", value: String(m.postings.length), sub: m.ranges.length ? plural(m.ranges.length, "shows pay", "show pay") : "none shows pay" }
    ]);
    w.heading("What the search found");
    w.paragraph(m.summary || "The run returned no summary.", { size: 10.5, leading: 1.45 });
    if (m.ranges.length) {
      w.heading("Pay others advertise", 50);
      w.table([{ label: "Employer", width: 30 }, { label: "Title as posted", width: 52 }, { label: "Pay", width: 18, align: "right" }],
        m.ranges.map(function (r) { return [linkCell(r.employer || "Unknown", r.url, "semibold"), clean(r.title), rangeText(r.min, r.max, r.unit)]; }));
    }
    if (m.postings.length) {
      w.heading("Who else is hiring", 50);
      w.table([{ label: "Employer", width: 25 }, { label: "Title as posted", width: 32 }, { label: "Location", width: 16 }, { label: "Pay shown", width: 17 }, { label: "Posted", width: 15, align: "right" }],
        m.postings.map(function (p) { return [linkCell(p.employer || "Unknown", p.url, "semibold"), clean(p.title), p.location || "", p.pay_text || "—", p.posted ? fmtDay(p.posted) : "—"]; }), { size: 9 });
    }
    if (m.sources.length) {
      w.heading("Sources", 40);
      w.paragraph("Pages the web search returned, in the order found. Employer names in the tables above link to the posting.", { size: 8.5, color: kit.C.mute, after: 8 });
      w.sources(m.sources);
    }
    w.note(m.caveat);
    w.footers();
    return doc.pdf;
  }

  function fileName(position, check) {
    var kit = K();
    var day = String(check.ran_at || "").slice(0, 10) || "undated";
    return [kit.slug(position.title), kit.slug(position.location), "market-check", day].filter(Boolean).join("-") + ".pdf";
  }
  async function download(position, check, preparedBy) {
    var pdf = await build(position, check, preparedBy);
    pdf.save(fileName(position, check));
  }
  async function copy(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(t); return true; }
    var ta = document.createElement("textarea"); ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
    var ok = false; try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    ta.remove(); return ok;
  }
  async function copyText(position, check, preparedBy) { return copy(text(position, check, preparedBy)); }

  // ---------- National check (cost-of-living adjusted) ----------
  function nationalModel(position, check, preparedBy) {
    var cmp = check.comparison || null, col = check.cost_of_living || null, bls = check.bls || null;
    var ran = new Date(check.ran_at);
    var rMin = cmp && cmp.position_min != null ? cmp.position_min : position.pay_min;
    var rMax = cmp && cmp.position_max != null ? cmp.position_max : position.pay_max;
    var unit = cmp && cmp.unit ? cmp.unit : (position.pay_unit || "hour");
    var hasAdj = cmp && cmp.adjusted_low_median != null;
    var v = verdict(hasAdj ? check.below_market : null, "of the adjusted postings");
    var figures = [["Rexius advertises", rMin != null || rMax != null ? rangeText(rMin, rMax, unit) : "no range set"]];
    if (hasAdj) {
      figures.push(["Adjusted to " + position.location, rangeText(cmp.adjusted_low_median, cmp.adjusted_high_median, unit) + " (medians of " + plural(cmp.samples_compared, "posting", "postings") + ", scaled by cost of living)"]);
      if (cmp.raw_low_median != null) figures.push(["As advertised elsewhere", rangeText(cmp.raw_low_median, cmp.raw_high_median, unit)]);
    }
    figures.push(["Against the adjusted market", v.chip + ": " + v.text]);
    var method = [];
    if (bls) {
      method.push(["BLS occupation", bls.occupation + (bls.soc_code ? " (SOC " + bls.soc_code + ")" : "") + (bls.year ? ", " + bls.year + " wage data" : "")]);
      var figs = [];
      if (bls.national_median != null) figs.push("national median " + money(bls.national_median) + unitSuffix(bls.unit));
      if (bls.p25 != null || bls.p75 != null) figs.push("25th–75th percentile " + rangeText(bls.p25, bls.p75, bls.unit));
      if (bls.area_median != null) figs.push((bls.area_name || "area") + " median " + money(bls.area_median) + unitSuffix(bls.unit));
      if (cmp && cmp.bls_national_median_adjusted != null) figs.push("national median adjusted to " + position.location + " " + money(cmp.bls_national_median_adjusted) + unitSuffix(unit));
      if (figs.length) method.push(["BLS figures", figs.join("; ")]);
    }
    if (col) {
      method.push(["Cost-of-living index", col.source_name + (col.year ? ", " + col.year : "") + ". " + (col.rexius_metro || position.location) + " is " + (col.rexius_index == null ? "—" : col.rexius_index) + " against 100 for the US average; each posting's pay is multiplied by that index over its own metro's."]);
      if (col.notes) method.push(["Notes", col.notes]);
    }
    return {
      title: position.title + " · " + position.location,
      subtitle: "Run " + fmtDateTime(ran) + (check.pass < 2 ? " · first pass only" : ""),
      rexius: rMin != null || rMax != null ? rangeText(rMin, rMax, unit) : "No range set",
      adjusted: hasAdj ? rangeText(cmp.adjusted_low_median, cmp.adjusted_high_median, unit) : null,
      adjustedSub: hasAdj ? "Medians of " + plural(cmp.samples_compared, "posting", "postings") + ", scaled by cost of living" : "No comparable postings could be adjusted",
      raw: hasAdj && cmp.raw_low_median != null ? rangeText(cmp.raw_low_median, cmp.raw_high_median, unit) : null,
      verdict: v,
      figures: figures, method: method, summary: check.summary || "",
      rows: check.adjusted || [], samples: check.pay_samples || [], sources: check.sources || [], bls: bls, col: col,
      caveat: "A sample drawn from web search results on " + fmtDateTime(ran) + ", not a complete count. Pay figures are what other employers advertised or what the Bureau of Labor Statistics publishes; none is a Rexius wage. The cost-of-living adjustment multiplies each figure by the Rexius metro's index over the posting metro's index" + (col ? " (" + col.source_name + ")" : "") + " and is approximate. Generated by Rexius Recruiter with Claude (" + (check.model || "Claude") + ", " + (check.searches != null ? plural(check.searches, "web search", "web searches") : "web search") + ").",
      byline: (preparedBy ? "Prepared by " + preparedBy + " · " : "") + "Rexius Recruiter · " + today()
    };
  }
  function urlFor(m, r) { var s = m.samples.filter(function (x) { return x.employer === r.employer && x.metro === r.metro; })[0]; return s && s.url ? s.url : null; }
  function nationalText(position, check, preparedBy) {
    var m = nationalModel(position, check, preparedBy);
    var out = [m.title, "National market check · " + m.subtitle, ""];
    m.figures.forEach(function (f) { out.push(f[0] + ": " + f[1]); });
    m.method.forEach(function (f) { out.push(f[0] + ": " + f[1]); });
    out.push("", m.summary, "");
    if (m.rows.length) {
      out.push("Postings across the country, scaled to " + position.location);
      m.rows.forEach(function (r) { out.push("- " + (r.employer || "Unknown") + (r.title ? ", " + clean(r.title) : "") + " (" + r.metro + (r.index != null ? ", index " + r.index : "") + "): " + rangeText(r.min, r.max, r.unit) + " as posted" + (r.adjusted_min != null ? ", " + rangeText(r.adjusted_min, r.adjusted_max, r.unit) + " adjusted" : "") + (urlFor(m, r) ? " " + urlFor(m, r) : "")); });
      out.push("");
    } else if (m.samples.length) {
      out.push("Postings across the country");
      m.samples.forEach(function (s) { out.push("- " + (s.employer || "Unknown") + (s.title ? ", " + clean(s.title) : "") + " (" + s.metro + "): " + rangeText(s.min, s.max, s.unit) + (s.url ? " " + s.url : "")); });
      out.push("");
    }
    if (m.sources.length) { out.push("Sources"); m.sources.forEach(function (s) { out.push("- " + (clean(s.title) ? clean(s.title) + " " : "") + s.url); }); out.push(""); }
    out.push(m.caveat, m.byline);
    return out.join("\n");
  }
  async function buildNational(position, check, preparedBy) {
    var kit = K();
    var m = nationalModel(position, check, preparedBy);
    var doc = await kit.create({ kind: "National market check", title: m.title, subtitle: m.subtitle, date: today(), byline: m.byline, docTitle: m.title + " - national market check" });
    var w = doc.w;
    var tiles = [{ label: "Rexius advertises", value: m.rexius }, { label: "Adjusted to " + position.location, value: m.adjusted || "—", sub: m.adjustedSub }];
    if (m.raw) tiles.push({ label: "As advertised elsewhere", value: m.raw, sub: "Before the cost-of-living adjustment" });
    tiles.push({ label: "Against the adjusted market", chip: m.verdict.chip, tone: m.verdict.tone, sub: m.verdict.text });
    w.tiles(tiles);
    w.heading("What the search found");
    w.paragraph(m.summary || "The run returned no summary.", { size: 10.5, leading: 1.45 });
    if (m.rows.length) {
      w.heading("Postings across the country, scaled to " + position.location, 50);
      w.table([{ label: "Employer", width: 28 }, { label: "Metro", width: 22 }, { label: "Index", width: 9, align: "right" }, { label: "As posted", width: 20, align: "right" }, { label: "Adjusted", width: 21, align: "right" }],
        m.rows.map(function (r) { return [linkCell(r.employer || "Unknown", urlFor(m, r), "semibold"), r.metro || "", r.index == null ? "—" : String(r.index), rangeText(r.min, r.max, r.unit), r.adjusted_min == null ? "—" : { text: rangeText(r.adjusted_min, r.adjusted_max, r.unit), style: "semibold" }]; }));
    } else if (m.samples.length) {
      w.heading("Postings across the country", 50);
      w.table([{ label: "Employer", width: 30 }, { label: "Title as posted", width: 34 }, { label: "Metro", width: 20 }, { label: "Pay", width: 16, align: "right" }],
        m.samples.map(function (s) { return [linkCell(s.employer || "Unknown", s.url, "semibold"), clean(s.title), s.metro || "", rangeText(s.min, s.max, s.unit)]; }));
    }
    if (m.method.length) {
      w.heading("Method", 40);
      m.method.forEach(function (f) { w.kv(f[0], f[1]); });
    }
    if (m.sources.length) {
      w.heading("Sources", 40);
      w.paragraph("Pages the web search returned, in the order found. Employer names in the table above link to the posting.", { size: 8.5, color: kit.C.mute, after: 8 });
      w.sources(m.sources);
    }
    w.note(m.caveat);
    w.footers();
    return doc.pdf;
  }
  function nationalFileName(position, check) { return fileName(position, check).replace("-market-check-", "-national-check-"); }
  async function downloadNational(position, check, preparedBy) { var pdf = await buildNational(position, check, preparedBy); pdf.save(nationalFileName(position, check)); }
  async function copyNationalText(position, check, preparedBy) { return copy(nationalText(position, check, preparedBy)); }

  window.RR = window.RR || {};
  window.RR.marketReport = { build: build, download: download, copyText: copyText, text: text, fileName: fileName,
    buildNational: buildNational, downloadNational: downloadNational, copyNationalText: copyNationalText, nationalText: nationalText, nationalFileName: nationalFileName };
})();
