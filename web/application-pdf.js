/* Application PDF: renders one applicant's details as a printable hand-off document so HR can
 * send it to a hiring manager without opening the Jotform inbox and downloading Jotform's own
 * PDF (which renders every answer, including the driver licence, signature and initials fields
 * this app never stores).
 *
 * The document is built here, in the browser, from what the tracker already holds: app.js
 * assembles a small document model (sections of label/value rows, employer blocks and
 * question/answer pairs) from the data the signed-in role may read, and this file lays it out
 * with the shared kit in pdf-kit.js (jsPDF, Public Sans, the Rexius wordmark). Nothing is
 * fetched from Jotform and nothing is written to Supabase; the PDF exists only as the download
 * in the user's browser.
 *
 * Model (everything optional except name and sections):
 *   { name, subtitle, byline, sections: [
 *       { title, rows: [[label, value], ...] }            key/value block
 *       { title, jobs: [{ title, employer, location, start, end, reason, responsibilities }] }
 *       { title, items: [{ q, a }] }                       question/answer list
 *       { title, text }                                    a paragraph
 *     ], note }
 * Empty values are skipped, so callers can pass every field without checking it first. Four
 * rows of the "Application" section (Position, Location, Can start, Heard from) are lifted
 * into the at-a-glance tiles under the title; the rest stay in the section.
 */
(function () {
  "use strict";

  var TILE_ROWS = { "Position": "Position", "Location": "Location", "Can start": "Can start", "Heard from": "Source" };

  function has(v) { return v != null && String(v).trim() !== ""; }

  function job(w, j, K) {
    var head = [j.title, j.employer].filter(Boolean).join(" at ");
    var when = [j.start, j.end || (j.start ? "present" : "")].filter(Boolean).join(" – ");
    var meta = [j.location, when].filter(Boolean).join(" · ");
    w.need(64);
    w.paragraph(head || "(employer not named)", { size: 10.5, style: "semibold", after: 1 });
    if (meta) w.paragraph(meta, { size: 9, color: K.C.mute, after: 3 });
    if (j.responsibilities) w.paragraph(j.responsibilities, { size: 10, after: 2 });
    if (j.reason) w.paragraph("Reason for leaving: " + j.reason, { size: 9.5, style: "italic", color: K.C.mute, after: 2 });
    w.space(7);
  }

  async function build(model) {
    var K = window.RR && RR.pdfKit;
    if (!K) throw new Error("The PDF module did not load. Reload the page and try again.");
    var doc = await K.create({
      kind: "Employment application",
      title: model.name,
      subtitle: model.subtitle,
      date: new Date().toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }),
      byline: model.byline,
      docTitle: model.name + " - application"
    });
    var w = doc.w;

    // At a glance: the four facts a manager asks first, lifted out of the Application section.
    var tiles = [], lifted = {};
    (model.sections || []).forEach(function (s) {
      if (s.title !== "Application") return;
      (s.rows || []).forEach(function (r) {
        if (TILE_ROWS[r[0]] && has(r[1]) && !lifted[r[0]]) { lifted[r[0]] = true; tiles.push({ label: TILE_ROWS[r[0]], value: r[1], span: r[0] === "Position" ? 2 : 1 }); }
      });
    });
    if (tiles.length) w.tiles(tiles);

    (model.sections || []).forEach(function (s) {
      var rows = (s.rows || []).filter(function (r) { return has(r[1]) && !(s.title === "Application" && lifted[r[0]]); });
      var jobs = (s.jobs || []).filter(function (j) { return j.employer || j.title; });
      var items = (s.items || []).filter(function (i) { return has(i.a); });
      if (!rows.length && !jobs.length && !items.length && !has(s.text)) return;
      w.heading(s.title);
      rows.forEach(function (r) { w.kv(r[0], r[1]); });
      jobs.forEach(function (j) { job(w, j, K); });
      items.forEach(function (i) {
        w.need(34);
        w.paragraph(i.q, { size: 9, color: K.C.mute, after: 1 });
        w.paragraph(i.a, { size: 10, after: 7 });
      });
      if (has(s.text)) w.paragraph(s.text, { size: 10 });
    });
    if (model.note) w.note(model.note);
    w.footers();
    return doc.pdf;
  }

  // "<Last>-<First>-application.pdf" from the stored "First [Middle] Last" name (last word, first
  // word; a middle name is left out).
  function fileName(name) {
    var K = window.RR && RR.pdfKit;
    var parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    var last = parts.length > 1 ? parts.pop() : "";
    var first = parts[0] || "";
    var stem = [K.slug(last), K.slug(first)].filter(Boolean).join("-") || "applicant";
    return stem + "-application.pdf";
  }

  async function download(model) {
    var pdf = await build(model);
    pdf.save(fileName(model.name));
  }

  window.RR = window.RR || {};
  window.RR.applicationPdf = { build: build, download: download, fileName: fileName,
    safeText: function (s) { return RR.pdfKit.safeText(s); } };
})();
