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
 * re-wrapped in a Blob of exactly that type. Anything else (an old .doc, or an HTML file
 * renamed .pdf) is offered as a download only and is never rendered in the page.
 *
 * Word files (.docx) get a preview, not a conversion: docx-preview lays the document out as
 * pages inside a sandboxed frame. The frame has an opaque origin (sandbox="allow-scripts", no
 * allow-same-origin), so nothing in it can reach the tracker's session, storage or page, and its
 * own Content-Security-Policy allows the two pinned library scripts and nothing else: no
 * network requests, no inline handlers. The file's bytes are posted in; Download still hands
 * over the original Word file. If the preview fails for any reason the viewer falls back to the
 * download-only message.
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

  function isZip(bytes) { return bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04; }

  // Pinned builds with subresource integrity; both are loaded only inside the sandboxed frame.
  var JSZIP = { src: "https://cdn.jsdelivr.net/npm/jszip@3.10.2/dist/jszip.min.js", sri: "sha384-DdGlNq+wVXAn83gXqwyeFHB7iyXy6L0rLrNzgDmhKWPjiJLg9vj6qosYmZmkMfQ+" };
  var DOCX = { src: "https://cdn.jsdelivr.net/npm/docx-preview@0.4.1/dist/docx-preview.min.js", sri: "sha384-DifWB1GSGsQgwTegPEbGdEMnGZpmfhUsx9A3WuHv+rfQVCFXMhawW/v4AZcP1FzL" };
  var NO_PREVIEW = "This file cannot be shown in the tracker. Use Download to open it on your computer.";
  var DOCX_WAIT_MS = 20000;

  function nonce() { var a = new Uint8Array(16); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
  function scriptTag(lib, n) { return '<script nonce="' + n + '" src="' + lib.src + '" integrity="' + lib.sri + '" crossorigin="anonymous"><\/script>'; }
  // The whole document of the sandboxed frame. Links are dead (a click would navigate the frame
  // away), embedded HTML chunks are not rendered, and images and fonts come in as data URLs.
  function docxFrameHtml() {
    var n = nonce();
    return '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'nonce-' + n + '\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data: blob:">' +
      '<style>html,body{margin:0;background:#e9ebe7;font:14px system-ui,sans-serif;color:#5f6b63}#wait{padding:32px 24px;text-align:center}' +
      '.docx-wrapper{background:#e9ebe7!important;padding:16px!important}.docx-wrapper>section.docx{box-shadow:0 1px 4px rgba(0,0,0,.2)!important;margin-bottom:16px!important}a{pointer-events:none}</style>' +
      '</head><body><div id="wait">Preparing the preview…</div><div id="doc"></div>' +
      scriptTag(JSZIP, n) + scriptTag(DOCX, n) +
      '<script nonce="' + n + '">' +
      'addEventListener("click",function(e){var t=e.target;if(t&&t.closest&&t.closest("a"))e.preventDefault();},true);' +
      'function say(kind,message){parent.postMessage({rrDocx:kind,message:message||""},"*");}' +
      'addEventListener("message",function(e){if(e.source!==parent||!e.data||!e.data.rrDocxBytes)return;' +
      'docx.renderAsync(e.data.rrDocxBytes,document.getElementById("doc"),null,{useBase64URL:true,renderAltChunks:false,experimental:false})' +
      '.then(function(){document.getElementById("wait").remove();say("done");},function(err){say("error",String((err&&err.message)||err));});});' +
      'say(window.docx&&window.JSZip?"ready":"error","the preview library did not load");' +
      '<\/script></body></html>';
  }
  // Shows a .docx in the sandboxed frame; any failure (library blocked, not really a Word file,
  // a document the library cannot read, no answer in time) ends in the download-only message.
  function showDocx(blob, mine) {
    var r = node.refs, frame = el("iframe", "viewer-frame");
    frame.title = state.fileName; frame.setAttribute("sandbox", "allow-scripts"); frame.setAttribute("referrerpolicy", "no-referrer");
    var timer = null;
    function stop() { window.removeEventListener("message", onMessage); if (timer) clearTimeout(timer); }
    function fail() { stop(); if (mine === seq) message(NO_PREVIEW); }
    async function onMessage(e) {
      if (e.source !== frame.contentWindow || !e.data || !e.data.rrDocx) return;
      if (mine !== seq) { stop(); return; }
      if (e.data.rrDocx === "ready") {
        var buf = await blob.arrayBuffer();
        if (mine === seq) frame.contentWindow.postMessage({ rrDocxBytes: buf }, "*", [buf]);   // "*": the frame's origin is opaque
      } else if (e.data.rrDocx === "done") stop();
      else fail();
    }
    window.addEventListener("message", onMessage);
    timer = setTimeout(fail, DOCX_WAIT_MS);
    state.stop = stop;
    frame.srcdoc = docxFrameHtml();
    r.body.textContent = ""; r.body.appendChild(frame);
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
    if (state && state.stop) state.stop();
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
    var type = "", word = false;
    try {
      var lead = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
      type = sniff(lead);
      // A .docx is a zip; the name only chooses to try the preview, which is sandboxed either way.
      word = !type && isZip(lead) && /\.docx$/i.test(state.fileName);
    } catch (e) { type = ""; }
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
      r.tab.hidden = true;                         // a preview is not a file a new tab could show
      if (word) showDocx(blob, mine); else message(NO_PREVIEW);
    }
  }

  window.RR = window.RR || {};
  window.RR.fileViewer = { open: open, close: shut, sniff: sniff };
})();
