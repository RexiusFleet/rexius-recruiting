/* PDF kit: the one place that defines how a Rexius Recruiter PDF looks. application-pdf.js and
 * market-report.js build their documents with it, so the application hand-off, the market check
 * and the national check read as a set: same page frame, type, colours and page-break rules.
 *
 * Everything is drawn with jsPDF (pinned in index.html) in the browser; nothing is fetched from
 * Jotform and nothing is written to Supabase. Two kinds of asset are loaded from web/assets when
 * the first PDF is built and then kept for the session:
 *   - the Rexius wordmark (rexius-logo.png) for the first-page header;
 *   - Public Sans (fonts/PublicSans-*.ttf, SIL Open Font License, see fonts/OFL.txt), the
 *     tracker's own typeface, embedded so the PDF matches the screen. If a font fails to load
 *     the document falls back to Helvetica and still builds.
 *
 * Layout model: a Writer keeps a cursor `y` (the baseline of the next line) and page-breaks
 * when `need(h)` finds too little room. Headings keep with their first lines, table headers
 * repeat on a new page and never sit alone at the foot of one, and the first lines of a
 * paragraph stay together (no orphaned single line).
 *
 * Also exported: safeText (strip characters the font cannot show), stripHtml (page titles
 * scraped from the web sometimes carry tags or comments), domainOf (host of a URL for a
 * compact source list).
 */
(function () {
  "use strict";

  var PAGE = { w: 612, h: 792 };                      // US Letter, points
  var M = { top: 56, right: 54, bottom: 64, left: 54 };
  var C = {
    ink: [23, 32, 25], mute: [95, 107, 99], faint: [141, 151, 143],
    line: [217, 223, 216], lineStrong: [185, 195, 186],
    accent: [47, 107, 63], accentSoft: [226, 238, 228], panel: [245, 247, 243],
    link: [36, 84, 140],
    warnBg: [251, 238, 221], warnInk: [122, 75, 18],
    goodBg: [226, 238, 228], goodInk: [31, 80, 45]
  };
  var FAMILY = "PublicSans";
  var FONTS = [
    { file: "PublicSans-Regular.ttf", style: "normal" },
    { file: "PublicSans-SemiBold.ttf", style: "semibold" },
    { file: "PublicSans-Bold.ttf", style: "bold" },
    { file: "PublicSans-Italic.ttf", style: "italic" }
  ];
  var assets = null;                                  // promise of { logo, fonts: [{style, b64}] }

  // ---------- text helpers ----------
  function safeText(s) {
    // Public Sans covers Latin, including the accented letters in Spanish answers; emoji and
    // other scripts would come out as boxes, so they become "?". The same filter keeps the
    // Helvetica fallback (WinAnsi only) safe.
    return String(s == null ? "" : s).replace(/\r\n?/g, "\n").replace(/[^\n\x20-\x7E\xA0-ɏ–—‘’“”•…]/g, "?");
  }
  function stripHtml(s) {
    return String(s == null ? "" : s).replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]*>/g, " ")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ").trim();
  }
  function domainOf(url) {
    var m = /^[a-z][a-z0-9+.-]*:\/\/([^\/?#]+)/i.exec(String(url || ""));
    return m ? m[1].replace(/^www\./i, "").toLowerCase() : "";
  }
  function truncate(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s; }

  // ---------- assets ----------
  function toBase64(buf) {
    var bytes = new Uint8Array(buf), bin = "", chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(bin);
  }
  function fetchBase64(path) {
    return fetch(path).then(function (r) { if (!r.ok) throw new Error(path + " " + r.status); return r.arrayBuffer(); }).then(toBase64).catch(function () { return null; });
  }
  function loadAssets() {
    if (assets) return assets;
    assets = Promise.all([fetchBase64("assets/rexius-logo.png")].concat(FONTS.map(function (f) { return fetchBase64("assets/fonts/" + f.file); })))
      .then(function (r) {
        var fonts = [];
        FONTS.forEach(function (f, i) { if (r[i + 1]) fonts.push({ file: f.file, style: f.style, b64: r[i + 1] }); });
        // All four or none: mixing Public Sans with Helvetica for one missing weight looks worse than either alone.
        return { logo: r[0], fonts: fonts.length === FONTS.length ? fonts : [] };
      });
    return assets;
  }

  // ---------- writer ----------
  // opts: { kind: "Employment application" (eyebrow and continuation label), title, subtitle,
  //         date (string shown top right), byline (footer left), docTitle (PDF metadata) }
  function Writer(pdf, loaded, opts) {
    this.pdf = pdf; this.opts = opts || {}; this.logo = loaded.logo;
    this.family = "helvetica";
    if (loaded.fonts.length) {
      for (var i = 0; i < loaded.fonts.length; i++) { pdf.addFileToVFS(loaded.fonts[i].file, loaded.fonts[i].b64); pdf.addFont(loaded.fonts[i].file, FAMILY, loaded.fonts[i].style); }
      this.family = FAMILY;
    }
    this.width = PAGE.w - M.left - M.right;
    this.y = M.top;
    this.pageNo = 1;
    this.tableCtx = null;                             // the table whose header to repeat after a break
  }
  Writer.prototype.font = function (style, size, color) {
    var st = style || "normal";
    if (this.family === "helvetica" && st === "semibold") st = "bold";
    this.pdf.setFont(this.family, st).setFontSize(size);
    var c = color || C.ink; this.pdf.setTextColor(c[0], c[1], c[2]);
    return this;
  };
  Writer.prototype.bottom = function () { return PAGE.h - M.bottom; };
  Writer.prototype.room = function () { return this.bottom() - this.y; };
  // Make room for `h` points; starts a new page (with its continuation header) when there is not.
  Writer.prototype.need = function (h) {
    if (this.y + h <= this.bottom()) return false;
    this.breakPage();
    return true;
  };
  Writer.prototype.breakPage = function () {
    this.pdf.addPage(); this.pageNo++; this.y = M.top;
    this.font("normal", 8.5, C.mute);
    var label = safeText(this.opts.title || "");
    this.pdf.text(truncate(label, 90), M.left, this.y);
    this.font("normal", 8.5, C.faint);
    this.pdf.text(safeText((this.opts.kind || "document") + " · continued"), PAGE.w - M.right, this.y, { align: "right" });
    this.y += 6; this.rule(C.line, 0.6); this.y += 18;
    if (this.tableCtx) this.tableHeader(this.tableCtx);
  };
  Writer.prototype.rule = function (color, w) {
    var c = color || C.line; this.pdf.setDrawColor(c[0], c[1], c[2]).setLineWidth(w || 0.6);
    this.pdf.line(M.left, this.y, PAGE.w - M.right, this.y);
  };
  Writer.prototype.space = function (h) { this.y += h; };

  // First-page header: wordmark, document kind and date on the right, green rule, title, subtitle.
  Writer.prototype.header = function () {
    var o = this.opts, top = M.top - 10;
    if (this.logo) { try { this.pdf.addImage(this.logo, "PNG", M.left, top, 128, 25); } catch (e) { this.logo = null; } }
    if (!this.logo) { this.font("bold", 18, C.accent); this.pdf.text("REXIUS", M.left, top + 20); }
    this.font("semibold", 8, C.accent);
    this.pdf.text(safeText(o.kind || "").toUpperCase(), PAGE.w - M.right, top + 10, { align: "right", charSpace: 0.8 });
    if (o.date) { this.font("normal", 8.5, C.mute); this.pdf.text(safeText(o.date), PAGE.w - M.right, top + 22, { align: "right" }); }
    this.y = top + 36; this.rule(C.accent, 1.4);
    this.y += 30;
    this.font("bold", 20, C.ink);
    var lines = this.pdf.splitTextToSize(safeText(o.title || ""), this.width);
    for (var i = 0; i < lines.length; i++) { this.pdf.text(lines[i], M.left, this.y); this.y += 23; }
    if (o.subtitle) {
      this.y -= 6;
      this.font("normal", 10.5, C.mute);
      var sub = this.pdf.splitTextToSize(safeText(o.subtitle), this.width);
      for (var j = 0; j < sub.length; j++) { this.pdf.text(sub[j], M.left, this.y); this.y += 14; }
      this.y += 4;
    } else this.y += 2;
  };
  Writer.prototype.footers = function () {
    var n = this.pdf.getNumberOfPages();
    for (var p = 1; p <= n; p++) {
      this.pdf.setPage(p);
      var y = PAGE.h - M.bottom + 22;
      this.pdf.setDrawColor(C.line[0], C.line[1], C.line[2]).setLineWidth(0.6);
      this.pdf.line(M.left, y - 12, PAGE.w - M.right, y - 12);
      this.font("normal", 8, C.mute);
      if (this.opts.byline) this.pdf.text(this.pdf.splitTextToSize(safeText(this.opts.byline), this.width - 80)[0], M.left, y);
      this.pdf.text("Page " + p + " of " + n, PAGE.w - M.right, y, { align: "right" });
    }
    this.pdf.setPage(n);
  };

  // Section heading; keeps with the next ~2 lines so it never ends a page.
  Writer.prototype.heading = function (title, keepWith) {
    this.need(34 + (keepWith || 24));
    this.y += 8;
    this.font("semibold", 9, C.accent);
    this.pdf.text(safeText(title).toUpperCase(), M.left, this.y, { charSpace: 0.7 });
    this.y += 6; this.rule(C.lineStrong, 0.6); this.y += 15;
  };
  // Wrapped text; the first two lines stay together. Returns the height used.
  Writer.prototype.paragraph = function (text, o) {
    o = o || {};
    var size = o.size || 10, lh = size * (o.leading || 1.38), x = o.x || M.left, width = o.width || (this.width - (x - M.left));
    this.font(o.style, size, o.color);
    var lines = this.pdf.splitTextToSize(safeText(text), width);
    for (var i = 0; i < lines.length; i++) {
      this.need(i === 0 ? Math.min(lines.length, 2) * lh : lh);
      this.font(o.style, size, o.color);
      if (o.link) this.pdf.textWithLink(lines[i], x, this.y, { url: o.link }); else this.pdf.text(lines[i], x, this.y);
      this.y += lh;
    }
    this.y += o.after == null ? 4 : o.after;
    return lines.length * lh;
  };
  // Label on the left, value on the right; both wrap; the row keeps its first lines together.
  Writer.prototype.kv = function (label, value, o) {
    if (value == null || String(value).trim() === "") return;
    o = o || {};
    var lw = o.labelWidth || 150, size = 10, lh = size * 1.38;
    this.font("normal", 9, C.mute); var ll = this.pdf.splitTextToSize(safeText(label), lw - 10);
    this.font("normal", size, C.ink); var vl = this.pdf.splitTextToSize(safeText(value), this.width - lw);
    var n = Math.max(ll.length, vl.length);
    this.need(Math.min(n, 3) * lh);
    var top = this.y;
    for (var k = 0; k < n; k++) {
      if (top + k * lh > this.bottom()) { this.breakPage(); top = this.y - k * lh; }
      if (ll[k]) { this.font("normal", 9, C.mute); this.pdf.text(ll[k], M.left, top + k * lh); }
      if (vl[k]) { this.font("normal", size, C.ink); this.pdf.text(vl[k], M.left + lw, top + k * lh); }
    }
    this.y = top + n * lh + 5;
  };
  // Small rounded pill; returns its width. tone: "good" | "warn" | "neutral".
  Writer.prototype.chip = function (text, x, baseline, tone) {
    var bg = tone === "good" ? C.goodBg : tone === "warn" ? C.warnBg : C.panel;
    var ink = tone === "good" ? C.goodInk : tone === "warn" ? C.warnInk : C.mute;
    this.font("semibold", 8, ink);
    var t = safeText(text), w = this.pdf.getTextWidth(t) + 14;
    this.pdf.setFillColor(bg[0], bg[1], bg[2]);
    this.pdf.roundedRect(x, baseline - 9.5, w, 14, 7, 7, "F");
    this.font("semibold", 8, ink); this.pdf.text(t, x + 7, baseline);
    return w;
  };
  // A row of stat tiles: [{ label, value, sub, tone, chip, span }]. `span` (default 1) gives a
  // tile more of the row, for a long value such as a position title. Kept together on one page.
  // A value is set at the largest size from 15pt down to 10.5pt at which its longest word fits
  // the tile, so "$25.59–$31.16/hr" is never split in the middle; labels wrap to two lines.
  Writer.prototype.tiles = function (items) {
    items = (items || []).filter(function (t) { return t && (t.value != null || t.chip); });
    if (!items.length) return;
    var gap = 10, units = items.reduce(function (s, t) { return s + (t.span || 1); }, 0), unit = (this.width - gap * (items.length - 1)) / units, pad = 12;
    var self = this;
    // A word that will not fit at the smallest size may break after a slash ("Eugene/Springfield").
    function breakable(text, avail) {
      self.font("bold", 10.5);
      var words = safeText(text).split(/\s+/).filter(Boolean);
      return words.some(function (w) { return self.pdf.getTextWidth(w) > avail && w.indexOf("/") > 0; }) ? safeText(text).replace(/\/(?=\S)/g, "/ ") : safeText(text);
    }
    function fitSize(text, avail) {
      var words = breakable(text, avail).split(/\s+/), size = 15;
      for (; size > 10.5; size -= 0.5) {
        self.font("bold", size);
        var widest = Math.max.apply(null, words.map(function (w) { return self.pdf.getTextWidth(w); }));
        if (widest <= avail) break;
      }
      return size;
    }
    var measured = items.map(function (t) {
      var tw = unit * (t.span || 1) + gap * ((t.span || 1) - 1), avail = tw - pad * 2;
      self.font("semibold", 7.5); var ll = self.pdf.splitTextToSize(safeText(t.label || "").toUpperCase(), avail - 6).slice(0, 2);
      var vtext = t.value == null ? "" : breakable(t.value, avail);
      var vs = t.value == null ? 0 : fitSize(t.value, avail);
      self.font("bold", vs || 15); var vl = t.value == null ? [] : self.pdf.splitTextToSize(vtext, avail);
      self.font("normal", 8.5); var sl = t.sub ? self.pdf.splitTextToSize(safeText(t.sub), avail) : [];
      var vlh = vs * 1.2;
      var h = pad + 8 + (ll.length - 1) * 9.5 + (vl.length ? 6 + vl.length * vlh : 0) + (t.chip ? 22 : 0) + (sl.length ? 4 + sl.length * 11.5 : 0) + pad - 2;
      return { tw: tw, ll: ll, vl: vl, vs: vs, vlh: vlh, sl: sl, h: h };
    });
    var h = Math.max.apply(null, measured.map(function (m) { return m.h; }));
    this.need(h + 6);
    var top = this.y - 4, x = M.left;
    for (var i = 0; i < items.length; i++) {
      var t = items[i], m = measured[i];
      this.pdf.setFillColor(C.panel[0], C.panel[1], C.panel[2]).setDrawColor(C.line[0], C.line[1], C.line[2]).setLineWidth(0.6);
      this.pdf.roundedRect(x, top, m.tw, h, 5, 5, "FD");
      var y = top + pad + 8;
      this.font("semibold", 7.5, C.mute);
      for (var l = 0; l < m.ll.length; l++) { this.pdf.text(m.ll[l], x + pad, y, { charSpace: 0.5 }); if (l < m.ll.length - 1) y += 9.5; }
      y += 6;
      if (m.vl.length) { this.font("bold", m.vs, t.tone === "warn" ? C.warnInk : C.ink); for (var k = 0; k < m.vl.length; k++) { y += m.vlh; this.pdf.text(m.vl[k], x + pad, y); } }
      if (t.chip) { y += 18; this.chip(t.chip, x + pad, y, t.tone); y += 2; }
      if (m.sl.length) { y += 4; this.font("normal", 8.5, C.mute); for (var s = 0; s < m.sl.length; s++) { y += 11.5; this.pdf.text(m.sl[s], x + pad, y); } }
      x += m.tw + gap;
    }
    this.y = top + h + 18;
  };
  // Table. cols: [{ label, width, align }] (widths are scaled to the text width); rows: arrays of
  // strings or { text, link, color, style }. The header repeats after a page break and never sits
  // alone at the foot of a page.
  Writer.prototype.tableHeader = function (ctx) {
    var hh = 20;
    this.pdf.setFillColor(C.accentSoft[0], C.accentSoft[1], C.accentSoft[2]);
    this.pdf.rect(M.left, this.y - 4, this.width, hh, "F");
    var x = M.left;
    for (var i = 0; i < ctx.cols.length; i++) {
      var c = ctx.cols[i]; this.font("semibold", 8.5, C.accent);
      var label = truncate(safeText(c.label), 40);
      this.pdf.text(label, c.align === "right" ? x + c.width - 6 : x + 6, this.y + 9.5, c.align === "right" ? { align: "right" } : undefined);
      x += c.width;
    }
    this.y += hh + 10;
  };
  Writer.prototype.table = function (cols, rows, o) {
    o = o || {};
    var total = cols.reduce(function (s, c) { return s + (c.width || 1); }, 0), self = this;
    var ctx = { cols: cols.map(function (c) { return { label: c.label, width: (c.width || 1) / total * self.width, align: c.align || "left" }; }) };
    var size = o.size || 9.5, lh = size * 1.36;
    function cell(v) { return v == null ? { text: "" } : typeof v === "object" ? v : { text: String(v) }; }
    // Measure the first row so the header never stands alone.
    function measure(r) {
      return r.map(function (v, i) { var c = cell(v); self.font(c.style || "normal", size); return self.pdf.splitTextToSize(safeText(c.text), ctx.cols[i].width - 12); });
    }
    var first = rows.length ? measure(rows[0]) : [[""]];
    var firstH = Math.max.apply(null, first.map(function (w) { return w.length; })) * lh + 8;
    this.need(30 + firstH);
    this.tableHeader(ctx);
    this.tableCtx = ctx;
    for (var r = 0; r < rows.length; r++) {
      var wrapped = r === 0 ? first : measure(rows[r]);
      var n = Math.max.apply(null, wrapped.map(function (w) { return w.length; }));
      var h = n * lh + 8;
      this.need(h);
      var x = M.left, top = this.y;
      for (var i = 0; i < ctx.cols.length; i++) {
        var c = cell(rows[r][i]), col = ctx.cols[i], w = wrapped[i];
        this.font(c.style || "normal", size, c.color || (c.link ? C.link : C.ink));
        for (var k = 0; k < w.length; k++) {
          var tx = col.align === "right" ? x + col.width - 6 : x + 6;
          this.pdf.text(w[k], tx, top + k * lh, col.align === "right" ? { align: "right" } : undefined);
        }
        if (c.link) this.pdf.link(x + 2, top - lh + 3, col.width - 4, w.length * lh, { url: c.link });
        x += col.width;
      }
      this.y = top + (n - 1) * lh + 8;
      this.pdf.setDrawColor(C.line[0], C.line[1], C.line[2]).setLineWidth(0.5);
      this.pdf.line(M.left, this.y, PAGE.w - M.right, this.y);
      this.y += lh;
    }
    this.tableCtx = null;
    if (!rows.length) { this.font("italic", 9.5, C.mute); this.pdf.text(safeText(o.empty || "Nothing to show."), M.left + 6, this.y); this.y += lh; }
    this.y += 6;
  };
  // Numbered source list: title as the link, host in grey. Compact: forty sources fit on half a page.
  Writer.prototype.sources = function (list) {
    var size = 8.5, lh = size * 1.4, numW = 18, self = this;
    (list || []).forEach(function (s, i) {
      var url = s.url || "", host = domainOf(url);
      var title = stripHtml(s.title) || (url ? truncate(url.replace(/^[a-z]+:\/\/(www\.)?/i, ""), 90) : "Source");
      title = truncate(title, 110);
      self.font("normal", size, C.link);
      var tw = self.pdf.getTextWidth(safeText(title));
      var hostText = host && title.toLowerCase().indexOf(host) === -1 ? "  " + host : "";
      self.font("normal", size, C.faint);
      var hw = self.pdf.getTextWidth(hostText);
      var avail = self.width - numW;
      var lines;
      if (tw + hw <= avail) lines = [title]; else { self.font("normal", size, C.link); lines = self.pdf.splitTextToSize(safeText(title), avail - (hw && hw < avail / 3 ? hw : 0)); }
      self.need(Math.min(lines.length, 2) * lh);
      self.font("normal", size, C.faint); self.pdf.text(String(i + 1) + ".", M.left + numW - 6, self.y, { align: "right" });
      for (var k = 0; k < lines.length; k++) {
        if (k) self.need(lh);
        self.font("normal", size, C.link);
        if (url) self.pdf.textWithLink(lines[k], M.left + numW, self.y, { url: url }); else self.pdf.text(lines[k], M.left + numW, self.y);
        if (k === lines.length - 1 && hostText) { self.font("normal", size, C.faint); self.pdf.text(hostText, M.left + numW + self.pdf.getTextWidth(lines[k]) + 2, self.y); }
        self.y += lh;
      }
      self.y += 1.5;
    });
    this.y += 4;
  };
  // Shaded note panel for caveats; kept together when it fits on one page.
  Writer.prototype.note = function (text) {
    var size = 8.5, lh = size * 1.4, pad = 10;
    this.font("italic", size, C.mute);
    var lines = this.pdf.splitTextToSize(safeText(text), this.width - pad * 2);
    var h = lines.length * lh + pad * 2 - 4;
    this.y += 6; this.need(Math.min(h, this.bottom() - M.top - 40));
    var top = this.y - 8;
    this.pdf.setFillColor(C.panel[0], C.panel[1], C.panel[2]);
    this.pdf.roundedRect(M.left, top, this.width, Math.min(h, this.bottom() - top), 4, 4, "F");
    var y = top + pad + size * 0.8;
    for (var i = 0; i < lines.length; i++) {
      if (y > this.bottom()) { this.breakPage(); y = this.y; }
      this.font("italic", size, C.mute); this.pdf.text(lines[i], M.left + pad, y); y += lh;
    }
    this.y = y + 6;
  };

  // Create a document: returns { pdf, w } with the first-page header drawn.
  async function create(opts) {
    var jspdf = window.jspdf;
    if (!jspdf || !jspdf.jsPDF) throw new Error("The PDF library did not load. Check your connection and reload the page.");
    var loaded = await loadAssets();
    var pdf = new jspdf.jsPDF({ unit: "pt", format: "letter", compress: true });
    pdf.setProperties({ title: safeText(opts.docTitle || opts.title || ""), subject: safeText(opts.kind || ""), creator: "Rexius Recruiter" });
    var w = new Writer(pdf, loaded, opts);
    w.header();
    return { pdf: pdf, w: w };
  }
  // Characters a file system or mail client might choke on are dropped from a file-name part.
  function slug(s) { return String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }

  window.RR = window.RR || {};
  window.RR.pdfKit = { create: create, safeText: safeText, stripHtml: stripHtml, domainOf: domainOf, slug: slug, M: M, PAGE: PAGE, C: C };
})();
