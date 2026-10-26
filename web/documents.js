/* Documents page (Phase 7): the library of job descriptions, interview guides and templates in
 * recruiting.documents. A document is either an uploaded file in bucket recruiting-files under
 * documents/<id>/<file name> (opened through a short-lived signed URL) or inline text (body).
 * RLS shows each user the documents their role allows (min_role); admin and hr add, edit,
 * replace and delete. The Storage policies for the documents/ prefix mirror that.
 */
(function () {
  "use strict";
  var RR = window.RR; if (!RR) return;
  var sb = RR.sb, $ = RR.$, el = RR.el;

  var KIND_LABEL = { description: "Job description", interview_guide: "Interview guide", template: "Template", other: "Other" };
  var ROLE_LABEL = { manager: "Everyone (managers too)", hr: "HR and admins", admin: "Admins only" };
  var COLS = "id, title, kind, position_id, storage_path, body, version, min_role, created_by, created_at, updated_at";
  var MAX_BYTES = 25 * 1024 * 1024;

  var docs = [], loaded = false, openId = null;
  var filters = { q: "", kind: "" };

  RR.registerPage("documents", {
    show: show,
    hide: function () {},
    drawerClosed: function () { openId = null; history.replaceState(null, "", "#/documents"); },
    reset: function () { docs = []; loaded = false; openId = null; $("docRows").innerHTML = ""; }
  });

  async function show(param) {
    RR.setHeader("Documents", loaded ? metaLine() : "Loading…");
    if (!loaded) await load();
    render();
    if (param === "new") newDocument();
    else if (param) { var d = byId(param); if (d) openDocument(d.id); }
  }
  async function load() {
    var r = await sb.from("documents").select(COLS).order("kind").order("title");
    if (r.error) { RR.notice("Could not load documents: " + RR.errText(r.error)); return; }
    docs = r.data || []; loaded = true;
  }
  function byId(id) { return docs.filter(function (d) { return d.id === id; })[0] || null; }
  function metaLine() {
    var n = {}; docs.forEach(function (d) { n[d.kind] = (n[d.kind] || 0) + 1; });
    var parts = Object.keys(KIND_LABEL).filter(function (k) { return n[k]; }).map(function (k) { return n[k] + " " + KIND_LABEL[k].toLowerCase() + (n[k] === 1 ? "" : "s"); });
    return docs.length ? docs.length + " documents (" + parts.join(", ") + ")" : "No documents yet.";
  }
  function positionName(id) { var p = RR.state().positionById[id]; return p ? p.title + " · " + p.location : ""; }
  function isFile(d) { return !!d.storage_path; }

  // ---------- List ----------
  function render() {
    RR.setHeader("Documents", metaLine());
    var q = filters.q.trim().toLowerCase();
    var rows = docs.filter(function (d) {
      if (filters.kind && d.kind !== filters.kind) return false;
      if (q && [d.title, positionName(d.position_id), KIND_LABEL[d.kind]].join(" ").toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var tbody = $("docRows"); tbody.innerHTML = "";
    $("docTable").hidden = !rows.length;
    $("docEmpty").hidden = !!rows.length;
    $("docEmpty").textContent = docs.length ? "No documents match." : (RR.state().staff ? "No documents yet. Add a job description, an interview guide or a message template." : "No documents have been shared with your role yet.");
    rows.forEach(function (d) {
      var tr = el("tr", d.id === openId ? "selected" : ""); tr.dataset.id = d.id;
      tr.appendChild(el("td", "name", d.title));
      tr.appendChild(el("td", null, KIND_LABEL[d.kind] || d.kind));
      tr.appendChild(el("td", "col-pos", positionName(d.position_id) || "—"));
      tr.appendChild(el("td", "col-role", ROLE_LABEL[d.min_role] || d.min_role));
      tr.appendChild(el("td", "num", String(d.version)));
      tr.appendChild(el("td", "col-upd date", RR.fmtDate(new Date(d.updated_at))));
      var tdT = el("td");
      if (isFile(d)) { var b = el("button", "link", "📄 " + RR.fileName(d.storage_path)); b.type = "button"; b.addEventListener("click", function (e) { e.stopPropagation(); openFile(d); }); tdT.appendChild(b); }
      else tdT.appendChild(el("span", "meta", "Text"));
      tr.appendChild(tdT);
      tr.addEventListener("click", function () { openDocument(d.id); });
      tbody.appendChild(tr);
    });
  }

  async function openFile(d) {
    var w = window.open("about:blank", "_blank");
    var res = await sb.storage.from(RR.BUCKET).createSignedUrl(d.storage_path, RR.SIGNED_URL_SECONDS, { download: RR.fileName(d.storage_path) });
    if (res.error || !res.data) { if (w) w.close(); RR.notice("Could not open the file: " + RR.errText(res.error)); return; }
    if (w) w.location.href = res.data.signedUrl; else window.location.href = res.data.signedUrl;
  }

  // ---------- Drawer ----------
  function newDocument() {
    openId = "new";
    history.replaceState(null, "", "#/documents/new");
    RR.showDrawer("New document", "", function (body) { body.appendChild(docForm(null)); });
  }
  function openDocument(id) {
    var d = byId(id); if (!d) return;
    var st = RR.state();
    openId = id;
    history.replaceState(null, "", "#/documents/" + id);
    document.querySelectorAll("#docRows tr").forEach(function (tr) { tr.classList.toggle("selected", tr.dataset.id === id); });
    RR.showDrawer(d.title, (KIND_LABEL[d.kind] || d.kind) + " · version " + d.version + " · updated " + RR.fmtDate(new Date(d.updated_at)), function (body) {
      var sec = RR.section(body, "Content");
      var links = el("div", "links");
      if (isFile(d)) { var b = el("button", "link", "📄 Open " + RR.fileName(d.storage_path)); b.type = "button"; b.addEventListener("click", function () { openFile(d); }); links.appendChild(b); links.appendChild(el("div", "hint", "Opens through a link that expires in a few minutes.")); }
      sec.appendChild(links);
      if (d.body) { var pre = el("div", "doc-body", d.body); sec.appendChild(pre); if (navigator.clipboard) { var cp = el("button", "btn small", "Copy text"); cp.type = "button"; cp.addEventListener("click", function () { navigator.clipboard.writeText(d.body).then(function () { cp.textContent = "Copied"; setTimeout(function () { cp.textContent = "Copy text"; }, 1500); }); }); sec.appendChild(cp); } }
      sec = RR.section(body, st.staff ? "Edit" : "About");
      if (st.staff) sec.appendChild(docForm(d));
      else {
        var dl = el("dl", "kv");
        RR.kv(dl, "Position", positionName(d.position_id)); RR.kv(dl, "Visible to", ROLE_LABEL[d.min_role]); RR.kv(dl, "Added", RR.fmtDate(new Date(d.created_at)));
        sec.appendChild(dl);
      }
    });
  }

  function docForm(d) {
    var isNew = !d; d = d || { kind: "description", min_role: "hr", version: 1 };
    var st = RR.state();
    var form = el("form", "review");
    var lt = el("label", null, "Title"); var title = el("input"); title.type = "text"; title.required = true; title.value = d.title || ""; lt.appendChild(title); form.appendChild(lt);
    var r1 = el("div", "row");
    var lk = el("label", null, "Kind"); var kind = el("select"); Object.keys(KIND_LABEL).forEach(function (k) { var o = el("option", null, KIND_LABEL[k]); o.value = k; if (d.kind === k) o.selected = true; kind.appendChild(o); }); lk.appendChild(kind); r1.appendChild(lk);
    var lr = el("label", null, "Visible to"); var role = el("select"); Object.keys(ROLE_LABEL).forEach(function (k) { var o = el("option", null, ROLE_LABEL[k]); o.value = k; if (d.min_role === k) o.selected = true; role.appendChild(o); }); lr.appendChild(role); r1.appendChild(lr);
    form.appendChild(r1);
    var lp = el("label", null, "Position (optional)"); var pos = RR.positionSelect(d.position_id || null, true); lp.appendChild(pos); form.appendChild(lp);
    // Content: a file, or inline text. New documents choose; existing ones keep their type
    // (a file document can be replaced by a new upload, a text one edited in place).
    var mode = isNew ? "file" : (isFile(d) ? "file" : "text");
    var lm = null, modeSel = null;
    if (isNew) {
      lm = el("label", null, "Content"); modeSel = el("select");
      [["file", "Upload a file (PDF, Word, …)"], ["text", "Text typed here (templates)"]].forEach(function (p) { var o = el("option", null, p[1]); o.value = p[0]; modeSel.appendChild(o); });
      lm.appendChild(modeSel); form.appendChild(lm);
    }
    var lf = el("label", null, isNew ? "File" : "Replace the file (optional)"); var file = el("input"); file.type = "file"; lf.appendChild(file);
    if (!isNew && isFile(d)) lf.appendChild(el("div", "hint", "Current: " + RR.fileName(d.storage_path) + ". Uploading a new file bumps the version and removes the old one."));
    form.appendChild(lf);
    var lb = el("label", null, "Text"); var bodyTa = el("textarea"); bodyTa.value = d.body || ""; bodyTa.style.minHeight = "160px"; bodyTa.placeholder = "Hi {name}, thanks for applying to Rexius…"; lb.appendChild(bodyTa); form.appendChild(lb);
    function syncMode() { mode = modeSel ? modeSel.value : mode; lf.hidden = mode !== "file"; lb.hidden = mode !== "text"; }
    if (modeSel) modeSel.addEventListener("change", syncMode);
    syncMode();
    var btns = el("div", "row");
    var save = el("button", "btn small primary", isNew ? "Add document" : "Save"); save.type = "submit"; btns.appendChild(save);
    var status = el("span", "saving"); btns.appendChild(status);
    if (!isNew) {
      var del = el("button", "link", "Delete document"); del.type = "button";
      del.addEventListener("click", async function () {
        if (!confirm("Delete “" + d.title + "”" + (isFile(d) ? " and its file" : "") + "?")) return;
        var r = await sb.from("documents").delete().eq("id", d.id);
        if (r.error) { RR.notice("Could not delete: " + RR.errText(r.error)); return; }
        if (isFile(d)) { var rs = await sb.storage.from(RR.BUCKET).remove([d.storage_path]); if (rs.error) RR.notice("The document is gone but its file could not be removed: " + RR.errText(rs.error)); }
        docs = docs.filter(function (x) { return x.id !== d.id; });
        RR.closeDrawer(); render();
      });
      btns.appendChild(del);
    }
    form.appendChild(btns);
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      var f = file.files && file.files[0];
      if (mode === "file" && isNew && !f) { status.textContent = "Choose a file."; return; }
      if (mode === "text" && !bodyTa.value.trim()) { status.textContent = "Type the text."; return; }
      if (f && f.size > MAX_BYTES) { status.textContent = "The file is over 25 MB."; return; }
      save.disabled = true; status.textContent = f ? "Uploading…" : "Saving…";
      var id = isNew ? newId() : d.id;
      var payload = { title: title.value.trim(), kind: kind.value, min_role: role.value, position_id: pos.value || null };
      var newPath = null;
      if (f) {
        newPath = "documents/" + id + "/" + safeName(f.name);
        var up = await sb.storage.from(RR.BUCKET).upload(newPath, f, { upsert: false, contentType: f.type || "application/octet-stream" });
        if (up.error) { save.disabled = false; status.textContent = ""; RR.notice("Upload failed: " + RR.errText(up.error)); return; }
        payload.storage_path = newPath; payload.body = null;
        if (!isNew) payload.version = (d.version || 1) + 1;
      } else if (mode === "text") {
        payload.body = bodyTa.value; payload.storage_path = null;
        if (!isNew && d.body !== payload.body) payload.version = (d.version || 1) + 1;
      }
      var r = isNew
        ? await sb.from("documents").insert(Object.assign({ id: id, created_by: st.session.user.id }, payload)).select(COLS).single()
        : await sb.from("documents").update(payload).eq("id", d.id).select(COLS).single();
      if (r.error) {
        if (newPath) await sb.storage.from(RR.BUCKET).remove([newPath]);
        save.disabled = false; status.textContent = ""; RR.notice("Could not save the document: " + RR.errText(r.error)); return;
      }
      if (newPath && !isNew && d.storage_path && d.storage_path !== newPath) await sb.storage.from(RR.BUCKET).remove([d.storage_path]);
      if (isNew) docs.push(r.data); else { var i = docs.findIndex(function (x) { return x.id === d.id; }); if (i >= 0) docs[i] = r.data; }
      save.disabled = false; status.textContent = "Saved";
      render(); openDocument(r.data.id);
    });
    return form;
  }
  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }
  // Storage keys: keep letters, digits, dots, dashes and underscores; spaces become dashes.
  function safeName(n) { n = (n || "file").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, ""); return n.replace(/^[.-]+/, "") || "file"; }

  // ---------- Wiring ----------
  $("docQ").addEventListener("input", function () { filters.q = this.value; render(); });
  $("docKind").addEventListener("change", function () { filters.kind = this.value; render(); });
  $("docAddBtn").addEventListener("click", newDocument);
})();
