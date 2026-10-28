/* Application PDF: renders one applicant's details as a plain, printable application form so HR
 * can hand it to a hiring manager without opening the Jotform inbox and downloading Jotform's
 * own PDF (which renders every answer, including the driver licence, signature and initials
 * fields this app never stores).
 *
 * The document is built here, in the browser, from what the tracker already holds: app.js
 * assembles a small document model (sections of label/value rows, employer blocks and
 * question/answer pairs) from the data the signed-in role may read, and this file lays it out
 * with jsPDF (pinned in index.html). Nothing is fetched from Jotform and nothing is written to
 * Supabase; the PDF exists only as the download in the user's browser.
 *
 * Model (everything optional except name and sections):
 *   { name, subtitle, byline, sections: [
 *       { title, rows: [[label, value], ...] }            key/value block
 *       { title, jobs: [{ title, employer, location, start, end, reason, responsibilities }] }
 *       { title, items: [{ q, a }] }                       question/answer list
 *       { title, text }                                    a paragraph
 *     ], note }
 * Empty values are skipped, so callers can pass every field without checking it first.
 */
(function () {
  "use strict";

  var PAGE = { w: 612, h: 792 };            // US Letter, points
  var M = { top: 54, right: 54, bottom: 60, left: 54 };
  var LABEL_W = 132;                        // width of the label column in key/value blocks
  var INK = [23, 32, 25], MUTE = [95, 107, 99], LINE = [185, 195, 186], ACCENT = [47, 107, 63];
  var logoPromise = null;

  // jsPDF's built-in fonts are WinAnsi: accented Latin letters (Spanish answers) are fine, but
  // characters outside that range (emoji, CJK) would come out as garbage, so swap them for "?".
  function safeText(s) {
    return String(s == null ? "" : s).replace(/\r\n?/g, "\n").replace(/[^\n\x20-\x7E\xA0-\xFF–—‘’“”•…]/g, "?");
  }

  // The green Rexius mark for the page header, loaded once; the PDF works without it.
  function loadLogo() {
    if (logoPromise) return logoPromise;
    logoPromise = fetch("assets/rexius-mark.png").then(function (r) {
      if (!r.ok) throw new Error("logo " + r.status);
      return r.blob();
    }).then(function (b) {
      return new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onload = function () { resolve(fr.result); };
        fr.onerror = reject;
        fr.readAsDataURL(b);
      });
    }).catch(function () { return null; });
    return logoPromise;
  }

  function Writer(pdf, logo, name) {
    this.pdf = pdf; this.logo = logo; this.name = name;
    this.y = M.top; this.page = 1;
    this.width = PAGE.w - M.left - M.right;
  }
  Writer.prototype.need = function (h) {
    if (this.y + h <= PAGE.h - M.bottom) return;
    this.pdf.addPage(); this.page++; this.y = M.top;
    // Continuation header: the applicant's name, so loose pages can be matched up.
    this.pdf.setFont("helvetica", "normal").setFontSize(9).setTextColor(MUTE[0], MUTE[1], MUTE[2]);
    this.pdf.text(safeText(this.name) + " · application (continued)", M.left, this.y);
    this.y += 16;
  };
  Writer.prototype.rule = function () {
    this.pdf.setDrawColor(LINE[0], LINE[1], LINE[2]).setLineWidth(0.6);
    this.pdf.line(M.left, this.y, PAGE.w - M.right, this.y);
  };
  Writer.prototype.heading = function (title) {
    this.need(30);
    this.y += 10;
    this.pdf.setFont("helvetica", "bold").setFontSize(10.5).setTextColor(ACCENT[0], ACCENT[1], ACCENT[2]);
    this.pdf.text(safeText(title).toUpperCase(), M.left, this.y);
    this.y += 5; this.rule(); this.y += 12;
  };
  // Wrapped text at x, limited to width; returns the height used.
  Writer.prototype.paragraph = function (text, x, width, size, style, color) {
    this.pdf.setFont("helvetica", style || "normal").setFontSize(size).setTextColor(color[0], color[1], color[2]);
    var lines = this.pdf.splitTextToSize(safeText(text), width);
    var lh = size * 1.32;
    for (var i = 0; i < lines.length; i++) {
      this.need(lh);
      this.pdf.text(lines[i], x, this.y);
      this.y += lh;
    }
    return lines.length * lh;
  };
  Writer.prototype.kv = function (label, value) {
    if (value == null || String(value).trim() === "") return;
    var size = 10, lh = size * 1.32;
    var valueLines = this.pdf.setFont("helvetica", "normal").setFontSize(size).splitTextToSize(safeText(value), this.width - LABEL_W - 8);
    var labelLines = this.pdf.setFont("helvetica", "normal").setFontSize(9).splitTextToSize(safeText(label), LABEL_W - 6);
    var h = Math.max(valueLines.length, labelLines.length) * lh;
    this.need(Math.min(h, lh * 3)); // keep at least the first lines together
    var top = this.y;
    this.pdf.setFont("helvetica", "normal").setFontSize(9).setTextColor(MUTE[0], MUTE[1], MUTE[2]);
    for (var i = 0; i < labelLines.length; i++) this.pdf.text(labelLines[i], M.left, top + i * lh);
    this.pdf.setFont("helvetica", "normal").setFontSize(size).setTextColor(INK[0], INK[1], INK[2]);
    for (var j = 0; j < valueLines.length; j++) {
      if (top + j * lh > PAGE.h - M.bottom) { this.y = top + j * lh; this.need(lh); top = this.y - j * lh; }
      this.pdf.text(valueLines[j], M.left + LABEL_W, top + j * lh);
    }
    this.y = top + h + 4;
  };
  Writer.prototype.job = function (j) {
    var head = [j.title, j.employer].filter(Boolean).join(" at ");
    var when = [j.start, j.end || (j.start ? "present" : "")].filter(Boolean).join(" – ");
    var meta = [j.location, when].filter(Boolean).join(" · ");
    this.need(36);
    this.paragraph(head || "(employer not named)", M.left, this.width, 10.5, "bold", INK);
    if (meta) this.paragraph(meta, M.left, this.width, 9, "normal", MUTE);
    if (j.responsibilities) this.paragraph(j.responsibilities, M.left, this.width, 10, "normal", INK);
    if (j.reason) this.paragraph("Reason for leaving: " + j.reason, M.left, this.width, 9.5, "italic", MUTE);
    this.y += 6;
  };
  Writer.prototype.qa = function (item) {
    if (item.a == null || String(item.a).trim() === "") return;
    this.need(30);
    this.paragraph(item.q, M.left, this.width, 9, "normal", MUTE);
    this.paragraph(item.a, M.left, this.width, 10, "normal", INK);
    this.y += 5;
  };
  Writer.prototype.title = function (model) {
    var x = M.left;
    if (this.logo) { try { this.pdf.addImage(this.logo, "PNG", M.left, M.top - 14, 34, 34); x += 44; } catch (e) { /* no logo */ } }
    this.pdf.setFont("helvetica", "normal").setFontSize(9).setTextColor(MUTE[0], MUTE[1], MUTE[2]);
    this.pdf.text("Rexius · Employment application", x, this.y - 2);
    this.y += 14;
    this.pdf.setFont("helvetica", "bold").setFontSize(18).setTextColor(INK[0], INK[1], INK[2]);
    this.pdf.text(safeText(model.name), x, this.y);
    this.y += 16;
    if (model.subtitle) { this.pdf.setFont("helvetica", "normal").setFontSize(10).setTextColor(MUTE[0], MUTE[1], MUTE[2]); this.pdf.text(safeText(model.subtitle), x, this.y); this.y += 14; }
    this.y = Math.max(this.y, M.top + 28);
    this.y += 4; this.rule(); this.y += 6;
  };
  Writer.prototype.footers = function (model) {
    var n = this.pdf.getNumberOfPages();
    for (var p = 1; p <= n; p++) {
      this.pdf.setPage(p);
      this.pdf.setFont("helvetica", "normal").setFontSize(8).setTextColor(MUTE[0], MUTE[1], MUTE[2]);
      var left = safeText(model.byline || "");
      var right = "Page " + p + " of " + n;
      var y = PAGE.h - M.bottom + 24;
      if (left) this.pdf.text(this.pdf.splitTextToSize(left, this.width - 70)[0], M.left, y);
      this.pdf.text(right, PAGE.w - M.right, y, { align: "right" });
    }
  };

  async function build(model) {
    var jspdf = window.jspdf;
    if (!jspdf || !jspdf.jsPDF) throw new Error("The PDF library did not load. Check your connection and reload the page.");
    var logo = await loadLogo();
    var pdf = new jspdf.jsPDF({ unit: "pt", format: "letter", compress: true });
    pdf.setProperties({ title: safeText(model.name) + " - application", subject: "Employment application", creator: "Rexius Recruiter" });
    var w = new Writer(pdf, logo, model.name);
    w.title(model);
    (model.sections || []).forEach(function (s) {
      var rows = (s.rows || []).filter(function (r) { return r[1] != null && String(r[1]).trim() !== ""; });
      var jobs = (s.jobs || []).filter(function (j) { return j.employer || j.title; });
      var items = (s.items || []).filter(function (i) { return i.a != null && String(i.a).trim() !== ""; });
      if (!rows.length && !jobs.length && !items.length && !s.text) return;
      w.heading(s.title);
      rows.forEach(function (r) { w.kv(r[0], r[1]); });
      jobs.forEach(function (j) { w.job(j); });
      items.forEach(function (i) { w.qa(i); });
      if (s.text) w.paragraph(s.text, M.left, w.width, 10, "normal", INK);
    });
    if (model.note) {
      w.y += 14; w.need(40);
      w.paragraph(model.note, M.left, w.width, 8.5, "italic", MUTE);
    }
    w.footers(model);
    return pdf;
  }

  // "<Last>-<First>-application.pdf" from the stored "First [Middle] Last" name (last word, first
  // word; a middle name is left out); characters a file system or mail client might choke on
  // are dropped.
  function fileName(name) {
    var parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    var last = parts.length > 1 ? parts.pop() : "";
    var first = parts[0] || "";
    var clean = function (s) { return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); };
    var stem = [clean(last), clean(first)].filter(Boolean).join("-") || "applicant";
    return stem + "-application.pdf";
  }

  async function download(model) {
    var pdf = await build(model);
    pdf.save(fileName(model.name));
  }

  window.RR = window.RR || {};
  window.RR.applicationPdf = { build: build, download: download, fileName: fileName, safeText: safeText };
})();
