/* File viewer: shows a PDF or an image inside the tracker instead of opening a new tab or
 * downloading it, with Download and Open in new tab in its header. The tracker's Files column
 * and the drawer's file links use it for resumes, portfolios and scans from the private
 * recruiting-files bucket, and for the application PDF built in the browser.
 *
 *   RR.fileViewer.open({ title, fileName, load })     load: async () => Blob
 *
 * The caller fetches the bytes (a storage download as the signed-in user, or jsPDF output); the
 * viewer never sees a URL to the bucket and nothing is cached once it closes.
 *
 * Uploaded files are untrusted, so what is shown is decided from the file's first bytes, never
 * from its name or stored content type: only a real PDF, PNG, JPEG, GIF or WebP is displayed,
 * re-wrapped in a Blob of exactly that type. Anything else (a Word resume, or an HTML file
 * renamed .pdf) is offered as a download only and is never rendered in the page.
 */
(function () {
  "use strict";

  var node = null, state = null, seq = 0;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function has(bytes, at, sig) { for (var i = 0; i < sig.length; i++) if (bytes[at + i] !== sig.charCodeAt(i)) return false; return true; }
  // The type a browser can safely display, from the leading bytes; "" when it is none of them.
  function sniff(bytes) {
    if (bytes[0] === 0x89 && has(bytes, 1, "PNG")) return "image/png";
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "image/jpeg";
    if (has(bytes, 0, "GIF8")) return "image/gif";
    if (has(bytes, 0, "RIFF") && has(bytes, 8, "WEBP")) return "image/webp";
    // PDF readers accept a little junk before the header, so look through the first kilobyte.
    for (var i = 0; i + 5 <= bytes.length; i++) if (has(bytes, i, "%PDF-")) return "application/pdf";
    return "";
  }

  function build() {
    node = el("div", "modal viewer"); node.id = "fileViewer"; node.hidden = true;
    node.setAttribute("role", "dialog"); node.setAttribute("aria-modal", "true"); node.setAttribute("aria-labelledby", "fileViewerTitle");
    var card = el("div", "viewer-card");
    var head = el("div", "viewer-head");
    var title = el("h2", null, ""); title.id = "fileViewerTitle";
    var actions = el("div", "viewer-actions");
    var dl = el("button", "btn small primary", "Download"); dl.type = "button";
    var tab = el("button", "btn small", "Open in new tab"); tab.type = "button";
    var close = el("button", "btn small", "Close"); close.type = "button";
    actions.appendChild(dl); actions.appendChild(tab); actions.appendChild(close);
    head.appendChild(title); head.appendChild(actions);
    var body = el("div", "viewer-body");
    card.appendChild(head); card.appendChild(body); node.appendChild(card);
    document.body.appendChild(node);
    node.refs = { title: title, dl: dl, tab: tab, close: close, body: body };
    close.addEventListener("click", shut);
    node.addEventListener("mousedown", function (e) { if (e.target === node) shut(); });
    dl.addEventListener("click", function () {
      if (!state || !state.url) return;
      var a = el("a"); a.href = state.url; a.download = state.fileName || "file";
      document.body.appendChild(a); a.click(); a.remove();
    });
    tab.addEventListener("click", function () {
      if (!state || !state.url || !state.type) return;
      state.keepUrl = true;                        // the new tab still needs it after this closes
      window.open(state.url, "_blank", "noopener");
    });
    // Capture phase, so Escape closes the viewer and not the drawer behind it.
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || !node || node.hidden) return;
      e.stopPropagation(); e.preventDefault(); shut();
    }, true);
  }

  function message(text, cls) {
    var b = node.refs.body; b.textContent = "";
    b.appendChild(el("p", "viewer-msg" + (cls ? " " + cls : ""), text));
  }

  function shut() {
    if (!node || node.hidden) return;
    seq++;                                         // a load still in flight is dropped when it lands
    node.hidden = true; node.refs.body.textContent = "";
    if (state && state.url && !state.keepUrl) URL.revokeObjectURL(state.url);
    var back = state && state.returnTo; state = null;
    if (back && back.isConnected && back.focus) back.focus();
  }

  async function open(opts) {
    if (!node) build();
    if (!node.hidden) shut();
    var mine = ++seq, r = node.refs;
    state = { fileName: opts.fileName || "file", returnTo: document.activeElement };
    r.title.textContent = opts.title || state.fileName; r.title.title = state.fileName;
    r.dl.disabled = true; r.tab.disabled = true; r.tab.hidden = false;
    message("Loading…");
    node.hidden = false; r.close.focus();
    var blob;
    try { blob = await opts.load(); if (!blob) throw new Error("the file is empty"); }
    catch (e) { if (mine === seq) message("Could not open " + state.fileName + ": " + ((e && (e.message || e.error_description)) || String(e)), "error"); return; }
    var type = "";
    try { type = sniff(new Uint8Array(await blob.slice(0, 1024).arrayBuffer())); } catch (e) { type = ""; }
    if (mine !== seq) return;                      // closed, or another file opened, while loading
    state.type = type;
    state.url = URL.createObjectURL(new Blob([blob], { type: type || "application/octet-stream" }));
    r.dl.disabled = false;
    r.body.textContent = "";
    if (type === "application/pdf") {
      var frame = el("iframe", "viewer-frame"); frame.title = state.fileName; frame.src = state.url;
      r.body.appendChild(frame); r.tab.disabled = false;
    } else if (type) {
      var img = el("img", "viewer-img"); img.alt = state.fileName; img.src = state.url;
      r.body.appendChild(img); r.tab.disabled = false;
    } else {
      r.tab.hidden = true;
      message("This file type cannot be shown in the tracker (Word documents, for example). Use Download to open it on your computer.");
    }
  }

  window.RR = window.RR || {};
  window.RR.fileViewer = { open: open, close: shut, sniff: sniff };
})();
