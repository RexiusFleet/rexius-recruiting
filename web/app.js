/* Rexius Recruiter tracker (Phase 6).
 * Plain JS on supabase-js v2. Everything lives in schema `recruiting`; row-level security
 * decides what each role may read and write, so this file only has to pick the right source:
 *   admin / hr  -> applications (+ application_status, application_files, forms, positions)
 *   manager     -> applications_for_managers (curated view; no notes, tags, offers, contacts,
 *                  raw answers) and their own manager_feedback rows
 *   no profile  -> the "no access" screen
 */
(function () {
  "use strict";

  var CFG = window.RECRUITER_CONFIG || {};
  if (!window.supabase || !CFG.supabaseUrl || !CFG.supabaseKey) {
    document.body.textContent = "config.js is missing the Supabase URL or key, or supabase-js did not load.";
    return;
  }
  var sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { db: { schema: "recruiting" } });

  var PAGE = 1000;              // PostgREST max rows per request (config.toml max_rows)
  var SHOW_STEP = 250;          // "Show more" step, as in the prototype
  var SIGNED_URL_SECONDS = 300; // resumes open through short-lived signed URLs
  var BUCKET = "recruiting-files";
  var STAGE_COLORS = ["var(--s-new)", "var(--s-rev)", "var(--s-sent)", "var(--s-int)", "var(--s-offer)", "var(--s-hired)", "var(--s-no)", "var(--s-x)"];
  var SKIP_TYPES = { control_text: 1, control_head: 1, control_button: 1, control_divider: 1, control_pagebreak: 1, control_collapse: 1, control_signature: 1 };

  // ---------- State ----------
  var session = null, profile = null, role = null, staff = false;
  var stages = [], stageById = {};
  var forms = [], formById = {}, formByLabel = {};
  var positionById = {};
  var profileNames = {};      // user_id -> name, for history and feedback
  var apps = [], appById = {};
  var filters = emptyFilters();
  var sort = { key: "date", dir: "desc" };
  var selectedId = null;
  var shown = SHOW_STEP;
  var lastLoaded = null;
  var loading = false;
  var notesTimer = null;
  var writeChain = {};

  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  function emptyFilters() { return { q: "", forms: {}, locs: {}, pos: {}, src: {}, stages: {}, from: "", to: "", resumeOnly: false, dupOnly: false }; }

  // ---------- Text helpers ----------
  function toText(v) {
    if (v == null) return "";
    if (Array.isArray(v)) return v.map(toText).filter(Boolean).join(", ");
    if (typeof v === "object") {
      if (v.full) return v.full;
      if (v.first !== undefined || v.last !== undefined) return [v.first, v.middle, v.last].map(function (s) { return (s || "").trim(); }).filter(Boolean).join(" ");
      if (v.datetime) return String(v.datetime).slice(0, 10);
      if (v.year !== undefined && v.month !== undefined) return [v.year, pad(v.month), pad(v.day)].join("-");
      if (v.addr_line1 !== undefined) return [v.addr_line1, v.addr_line2, v.city, v.state, v.postal].map(function (s) { return (s || "").trim(); }).filter(Boolean).join(", ");
      return Object.keys(v).map(function (k) { return typeof v[k] === "string" ? v[k] : ""; }).filter(Boolean).join(" ");
    }
    return String(v);
  }
  function pad(n) { return String(n || "").padStart(2, "0"); }
  function firstLang(s) { s = (s || "").trim(); var i = s.indexOf("/"); if (i > 0) s = s.slice(0, i).trim(); return s; }
  function digits(s) { return (s || "").replace(/\D+/g, ""); }
  function ymd(d) { if (!d) return ""; return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function fmtDate(d) { if (!d) return "—"; return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }); }
  function fmtDateTime(d) { if (!d) return "—"; return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); }
  function fmtDay(s) { if (!s) return ""; var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (!m) return s; return fmtDate(new Date(+m[1], +m[2] - 1, +m[3])); }
  function relTime(d) { var s = Math.round((Date.now() - d.getTime()) / 1000); if (s < 60) return "just now"; if (s < 3600) return Math.round(s / 60) + " min ago"; if (s < 86400) return Math.round(s / 3600) + " h ago"; return fmtDate(d); }
  function fileName(p) { try { var s = decodeURIComponent(String(p).split("?")[0]); return s.slice(s.lastIndexOf("/") + 1) || "file"; } catch (e) { return "file"; } }
  function errText(e) { if (!e) return "unknown error"; return e.message || e.error_description || e.details || String(e); }
  function one(x) { return Array.isArray(x) ? x[0] || null : x || null; }

  function shortFormLabel(f) {
    if (!f) return "";
    if (f.default_location === "CAS" || /CAS/.test(f.label)) return "CAS";
    if (f.language === "es") return "Spanish";
    return "English";
  }
  function stageColor(stageId) { var s = stageById[stageId]; if (!s) return "var(--s-x)"; return STAGE_COLORS[s.index % STAGE_COLORS.length]; }
  function stageName(stageId) { var s = stageById[stageId]; return s ? s.name : "Unknown stage"; }
  function stageIndex(stageId) { var s = stageById[stageId]; return s ? s.index : 999; }

  // ---------- Notices ----------
  function notice(text, btnLabel, onClick) {
    $("noticeText").textContent = text;
    var b = $("noticeBtn");
    if (btnLabel) { b.textContent = btnLabel; b.hidden = false; b.onclick = onClick; } else { b.hidden = true; b.onclick = null; }
    $("notice").hidden = false;
  }
  function clearNotice() { $("notice").hidden = true; }
  function setSaving(t) { var e = $("savingNote"); if (e) e.textContent = t; }

  // ---------- Views ----------
  function show(view) {
    ["loginView", "noAccessView", "appView"].forEach(function (id) { $(id).hidden = id !== view; });
    if (view !== "appView") closeDrawer();
  }

  // ---------- Auth ----------
  async function signIn(email, password) {
    $("loginError").textContent = "";
    $("loginBtn").disabled = true;
    var res = await sb.auth.signInWithPassword({ email: email, password: password });
    $("loginBtn").disabled = false;
    if (res.error) { $("loginError").textContent = res.error.message === "Invalid login credentials" ? "Wrong email or password." : res.error.message; return; }
    $("loginPassword").value = "";
  }
  async function signOut() {
    await sb.auth.signOut();
    resetData();
    show("loginView");
  }
  function resetData() {
    apps = []; appById = {}; selectedId = null; filters = emptyFilters(); shown = SHOW_STEP; lastLoaded = null;
    $("rows").innerHTML = ""; $("pipeline").innerHTML = ""; $("meta").textContent = "Loading…";
  }

  async function onSession(s) {
    session = s;
    if (!s) { profile = null; role = null; staff = false; show("loginView"); return; }
    var res = await sb.from("profiles").select("user_id, role, name, location").eq("user_id", s.user.id).maybeSingle();
    if (res.error) { show("loginView"); $("loginError").textContent = "Could not read your profile: " + errText(res.error); return; }
    if (!res.data) { $("noAccessEmail").textContent = s.user.email || s.user.id; show("noAccessView"); return; }
    profile = res.data; role = profile.role; staff = role === "admin" || role === "hr";
    $("who").textContent = profile.name + " · " + role;
    document.body.dataset.role = role;
    show("appView");
    await loadRefs();
    await loadApps();
  }

  // ---------- Reference data ----------
  async function loadRefs() {
    var r = await Promise.all([
      sb.from("stages").select("id, name, sort_order, is_terminal, is_hired").order("sort_order"),
      sb.from("forms").select("id, jotform_form_id, label, language, default_location, questions, field_map"),
      sb.from("positions").select("id, title, location, status"),
      sb.from("profiles").select("user_id, name, role")
    ]);
    var failed = r.filter(function (x) { return x.error; });
    if (failed.length) notice("Could not load reference data: " + errText(failed[0].error));
    stages = r[0].data || []; stageById = {};
    stages.forEach(function (s, i) { s.index = i; stageById[s.id] = s; });
    forms = r[1].data || []; formById = {}; formByLabel = {};
    forms.forEach(function (f) { f.short = shortFormLabel(f); formById[f.id] = f; formByLabel[f.label] = f; });
    positionById = {}; (r[2].data || []).forEach(function (p) { positionById[p.id] = p; });
    profileNames = {}; (r[3].data || []).forEach(function (p) { profileNames[p.user_id] = p.name; });
  }

  // ---------- Applications ----------
  var STAFF_COLUMNS = "id, jotform_submission_id, form_id, submitted_at, name, email, email_norm, phone, phone_norm, city, state, location, position_text, position_id, source, source_detail, referred_by, available_start, has_resume, language, jotform_url, " +
    "application_status(stage_id, assigned_to, notes, tags, stage_since, updated_at), application_files(id, storage_path, original_name, kind)";

  async function fetchAll(table, columns) {
    var out = [], from = 0;
    for (;;) {
      var res = await sb.from(table).select(columns).order("submitted_at", { ascending: false }).order("id").range(from, from + PAGE - 1);
      if (res.error) throw res.error;
      out = out.concat(res.data || []);
      $("meta").textContent = "Loading applications… " + out.length.toLocaleString() + " so far";
      if (!res.data || res.data.length < PAGE) break;
      from += PAGE;
    }
    return out;
  }

  function normalizeStaff(row) {
    var st = one(row.application_status) || {};
    var f = formById[row.form_id];
    var when = new Date(row.submitted_at);
    var files = (row.application_files || []).slice().sort(function (a, b) { return (a.kind || "").localeCompare(b.kind || ""); });
    var pos = positionById[row.position_id];
    return finish({
      id: row.id, when: when, dateKey: ymd(when), name: row.name || "(no name)", email: row.email || "", phone: row.phone || "",
      emailNorm: row.email_norm || "", phoneNorm: row.phone_norm || "", city: row.city, state: row.state,
      location: row.location || "", positionText: row.position_text || "", positionId: row.position_id, positionTitle: pos ? pos.title : "",
      source: row.source || "", sourceDetail: row.source_detail || "", referredBy: row.referred_by || "", availableStart: row.available_start || "",
      hasResume: !!row.has_resume || files.length > 0, language: row.language, formId: row.form_id, form: f ? f.short : "", formLabel: f ? f.label : "",
      jotformUrl: row.jotform_url || "", submissionId: row.jotform_submission_id,
      stageId: st.stage_id, assignedTo: st.assigned_to || "", notes: st.notes || "", tags: st.tags || [], stageSince: st.stage_since ? new Date(st.stage_since) : null,
      files: files
    });
  }
  function normalizeManager(row) {
    var f = formByLabel[row.form_label];
    var when = new Date(row.submitted_at);
    var files = (row.files || []).slice();
    return finish({
      id: row.id, when: when, dateKey: ymd(when), name: row.name || "(no name)", email: row.email || "", phone: row.phone || "",
      emailNorm: (row.email || "").trim().toLowerCase(), phoneNorm: digits(row.phone).slice(-10), city: row.city, state: row.state,
      location: row.location || "", positionText: row.position_text || "", positionId: row.position_id, positionTitle: row.position_title || "",
      source: row.source || "", sourceDetail: "", referredBy: row.referred_by || "", availableStart: row.available_start || "",
      hasResume: !!row.has_resume || files.length > 0, language: row.language, formId: f ? f.id : null, form: f ? f.short : row.form_label, formLabel: row.form_label,
      jotformUrl: "", submissionId: null,
      stageId: row.stage_id, assignedTo: row.assigned_to || "", notes: "", tags: [], stageSince: row.stage_since ? new Date(row.stage_since) : null,
      files: files,
      curated: {
        education: toText(row.education), skills: toText(row.relevant_skills), workedBefore: toText(row.worked_at_rexius_before), appliedBefore: toText(row.applied_before),
        employers: (row.employment_history || []).map(function (e) { return { employer: toText(e.employer), location: toText(e.location), title: toText(e.title), start: toText(e.start), end: toText(e.end), reason: toText(e.reason) }; })
      }
    });
  }
  function finish(a) {
    a.nameKey = a.name.toLowerCase();
    a.search = [a.name, a.email, a.phone, digits(a.phone), a.positionText, a.positionTitle, a.location, a.source, a.referredBy, a.assignedTo].join(" ").toLowerCase();
    return a;
  }

  function buildDupIndex() {
    var index = {};
    apps.forEach(function (a) {
      a.dupKeys = [];
      if (a.emailNorm) a.dupKeys.push("e:" + a.emailNorm);
      if (a.phoneNorm && a.phoneNorm.length >= 7) a.dupKeys.push("p:" + a.phoneNorm);
      a.dupKeys.forEach(function (k) { (index[k] = index[k] || []).push(a.id); });
    });
    apps.forEach(function (a) {
      var others = {};
      a.dupKeys.forEach(function (k) { index[k].forEach(function (id) { if (id !== a.id) others[id] = true; }); });
      a.dups = Object.keys(others).map(function (id) { return appById[id]; }).filter(Boolean).sort(function (x, y) { return y.when - x.when; });
    });
  }

  async function loadApps() {
    if (loading) return;
    loading = true; clearNotice();
    $("refreshBtn").disabled = true; $("refreshBtn").textContent = "Loading…";
    try {
      var rows = staff ? await fetchAll("applications", STAFF_COLUMNS) : await fetchAll("applications_for_managers", "*");
      apps = rows.map(staff ? normalizeStaff : normalizeManager);
      appById = {}; apps.forEach(function (a) { appById[a.id] = a; });
      buildDupIndex();
      lastLoaded = new Date();
    } catch (e) {
      notice("Could not load applications: " + errText(e), "Try again", loadApps);
    }
    loading = false;
    $("refreshBtn").disabled = false; $("refreshBtn").textContent = "Refresh";
    $("exportBtn").disabled = !apps.length;
    $("skel").hidden = true;
    buildFilterOptions();
    render();
    updateMeta();
    if (selectedId && appById[selectedId]) renderDrawer(); else closeDrawer();
  }
  function updateMeta() {
    if (!apps.length) { $("meta").textContent = lastLoaded ? "No applications found." : $("meta").textContent; return; }
    var perForm = {};
    apps.forEach(function (a) { perForm[a.form] = (perForm[a.form] || 0) + 1; });
    var parts = Object.keys(perForm).sort(function (a, b) { return perForm[b] - perForm[a]; }).map(function (k) { return perForm[k].toLocaleString() + " " + k; }).join(", ");
    $("meta").textContent = apps.length.toLocaleString() + " applications (" + parts + ") · updated " + (lastLoaded ? relTime(lastLoaded) : "—");
  }

  // ---------- Writes (staff) ----------
  function queue(id, work) {
    var chain = writeChain[id] || Promise.resolve();
    writeChain[id] = chain.then(function () { setSaving("Saving…"); return work(); })
      .then(function (res) { if (res && res.error) throw res.error; setSaving("Saved"); })
      .catch(function (e) { setSaving(""); notice("Could not save: " + errText(e), "Reload", loadApps); });
    return writeChain[id];
  }
  function setStage(id, stageId) {
    var a = appById[id]; if (!a || a.stageId === stageId) return;
    a.stageId = stageId; a.stageSince = new Date();
    render(); if (selectedId === id) renderDrawer();
    queue(id, function () { return sb.from("application_status").update({ stage_id: stageId, updated_by: session.user.id }).eq("application_id", id); });
  }
  function saveStatusFields(id, patch) {
    var a = appById[id]; if (!a) return;
    if (patch.assigned_to !== undefined) a.assignedTo = patch.assigned_to || "";
    if (patch.notes !== undefined) a.notes = patch.notes || "";
    if (patch.tags !== undefined) a.tags = patch.tags;
    patch.updated_by = session.user.id;
    queue(id, function () { return sb.from("application_status").update(patch).eq("application_id", id); });
  }

  // ---------- Filters ----------
  function uniqCounts(key) {
    var m = {};
    apps.forEach(function (a) { var v = a[key] || "(blank)"; m[v] = (m[v] || 0) + 1; });
    return Object.keys(m).sort(function (a, b) { return m[b] - m[a] || a.localeCompare(b); }).map(function (k) { return { v: k, n: m[k] }; });
  }
  function checkList(container, items, store) {
    container.innerHTML = "";
    items.forEach(function (it) {
      var lab = el("label", "check");
      var cb = el("input"); cb.type = "checkbox"; cb.checked = !!store[it.v];
      cb.addEventListener("change", function () { if (cb.checked) store[it.v] = true; else delete store[it.v]; shown = SHOW_STEP; render(); });
      lab.appendChild(cb); lab.appendChild(el("span", null, it.v)); lab.appendChild(el("span", "n", String(it.n)));
      container.appendChild(lab);
    });
  }
  function buildFilterOptions() {
    checkList($("f-form"), uniqCounts("form"), filters.forms);
    checkList($("f-loc"), uniqCounts("location"), filters.locs);
    checkList($("f-pos"), uniqCounts("positionText").slice(0, 40), filters.pos);
    checkList($("f-src"), uniqCounts("source").slice(0, 25), filters.src);
  }
  function hasAny(o) { for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) return true; return false; }
  function applyFilters() {
    var q = filters.q.trim().toLowerCase();
    var fF = hasAny(filters.forms), fL = hasAny(filters.locs), fP = hasAny(filters.pos), fS = hasAny(filters.src), fSt = hasAny(filters.stages);
    return apps.filter(function (a) {
      if (q && a.search.indexOf(q) < 0) return false;
      if (fF && !filters.forms[a.form || "(blank)"]) return false;
      if (fL && !filters.locs[a.location || "(blank)"]) return false;
      if (fP && !filters.pos[a.positionText || "(blank)"]) return false;
      if (fS && !filters.src[a.source || "(blank)"]) return false;
      if (fSt && !filters.stages[a.stageId]) return false;
      if (filters.from && a.dateKey < filters.from) return false;
      if (filters.to && a.dateKey > filters.to) return false;
      if (filters.resumeOnly && !a.files.length) return false;
      if (filters.dupOnly && !(a.dups && a.dups.length)) return false;
      return true;
    });
  }
  function sortRows(rows) {
    var k = sort.key, dir = sort.dir === "asc" ? 1 : -1;
    rows.sort(function (a, b) {
      var r = 0;
      if (k === "date") r = a.when - b.when;
      else if (k === "name") r = a.nameKey.localeCompare(b.nameKey);
      else if (k === "status") { r = stageIndex(a.stageId) - stageIndex(b.stageId); if (!r) r = b.when - a.when; }
      else if (k === "position") { r = (a.positionText || "zz").localeCompare(b.positionText || "zz"); if (!r) r = b.when - a.when; }
      return r * dir;
    });
    return rows;
  }

  // ---------- Rendering ----------
  function renderPipeline() {
    var p = $("pipeline"); p.innerHTML = "";
    if (!apps.length || !stages.length) return;
    var counts = {}; stages.forEach(function (s) { counts[s.id] = 0; });
    var other = 0;
    apps.forEach(function (a) { if (counts.hasOwnProperty(a.stageId)) counts[a.stageId]++; else other++; });
    var bar = el("div", "bar");
    stages.forEach(function (s) { var sp = el("span"); sp.style.width = (100 * counts[s.id] / apps.length) + "%"; sp.style.background = stageColor(s.id); sp.title = s.name + ": " + counts[s.id]; bar.appendChild(sp); });
    p.appendChild(bar);
    var chips = el("div", "chips");
    var any = hasAny(filters.stages);
    stages.forEach(function (s) {
      var c = el("button", "chip" + (filters.stages[s.id] ? " on" : (any ? " off" : "")));
      c.type = "button";
      var d = el("span", "dot"); d.style.background = stageColor(s.id); c.appendChild(d);
      c.appendChild(el("span", null, s.name + " ")); c.appendChild(el("b", null, counts[s.id].toLocaleString()));
      c.setAttribute("aria-pressed", filters.stages[s.id] ? "true" : "false");
      c.addEventListener("click", function () { if (filters.stages[s.id]) delete filters.stages[s.id]; else filters.stages[s.id] = true; shown = SHOW_STEP; render(); });
      chips.appendChild(c);
    });
    if (other) chips.appendChild(el("span", "chip", other + " in a stage that no longer exists"));
    p.appendChild(chips);
  }
  function statusControl(a) {
    if (!staff) {
      var pill = el("span", "status-pill");
      var dot = el("span", "sdot"); dot.style.background = stageColor(a.stageId); pill.appendChild(dot);
      pill.appendChild(el("span", null, stageName(a.stageId)));
      return pill;
    }
    var sel = el("select", "status-select");
    sel.setAttribute("aria-label", "Status for " + a.name);
    stages.forEach(function (s) { var o = el("option", null, s.name); o.value = String(s.id); if (s.id === a.stageId) o.selected = true; sel.appendChild(o); });
    if (!stageById[a.stageId]) { var o = el("option", null, "Unknown stage"); o.value = ""; o.selected = true; sel.appendChild(o); }
    sel.style.borderColor = stageColor(a.stageId);
    sel.addEventListener("click", function (e) { e.stopPropagation(); });
    sel.addEventListener("change", function (e) { e.stopPropagation(); if (sel.value) setStage(a.id, parseInt(sel.value, 10)); });
    return sel;
  }
  function fileButton(f, label) {
    var b = el("button", "link", label);
    b.type = "button"; b.title = f.original_name || fileName(f.storage_path);
    b.addEventListener("click", function (e) { e.stopPropagation(); openFile(f); });
    return b;
  }
  async function openFile(f) {
    // Open the tab first so popup blockers see a user gesture, then point it at the signed URL.
    var w = window.open("about:blank", "_blank");
    var res = await sb.storage.from(BUCKET).createSignedUrl(f.storage_path, SIGNED_URL_SECONDS);
    if (res.error || !res.data) { if (w) w.close(); notice("Could not open " + (f.original_name || "the file") + ": " + errText(res.error)); return; }
    if (w) w.location.href = res.data.signedUrl; else window.location.href = res.data.signedUrl;
  }
  function render() {
    var rows = sortRows(applyFilters());
    renderPipeline();
    var tbody = $("rows"); tbody.innerHTML = "";
    var filtered = rows.length !== apps.length;
    $("count").textContent = apps.length ? (filtered ? rows.length.toLocaleString() + " of " + apps.length.toLocaleString() + " applications match" : rows.length.toLocaleString() + " applications") : "";
    $("table").hidden = !rows.length;
    $("empty").hidden = !!rows.length || !apps.length;
    $("empty").textContent = filters.q || filtered ? "No applications match these filters. Clear a filter or widen the date range." : "No applications yet.";
    var frag = document.createDocumentFragment();
    rows.slice(0, shown).forEach(function (a) {
      var tr = el("tr", a.id === selectedId ? "selected" : "");
      tr.dataset.id = a.id;
      var tdN = el("td", "name");
      tdN.appendChild(document.createTextNode(a.name));
      if (a.dups && a.dups.length) { var dup = el("span", "dup", "×" + (a.dups.length + 1)); dup.title = "Applied " + (a.dups.length + 1) + " times (same email or phone)"; tdN.appendChild(dup); }
      tdN.appendChild(el("small", null, a.email || a.phone || ""));
      tr.appendChild(tdN);
      var tdD = el("td", "date", fmtDate(a.when)); tdD.title = fmtDateTime(a.when); tr.appendChild(tdD);
      tr.appendChild(el("td", "col-loc", a.location || "—"));
      var tdP = el("td", "pos"); tdP.appendChild(document.createTextNode(a.positionText || "—")); tdP.appendChild(el("span", "tag", a.form)); tr.appendChild(tdP);
      tr.appendChild(el("td", "col-src", a.source || "—"));
      var tdS = el("td"); tdS.appendChild(statusControl(a)); tr.appendChild(tdS);
      var tdA = el("td", "att");
      a.files.forEach(function (f) { tdA.appendChild(fileButton(f, f.kind === "resume" ? "📄" : "📎")); });
      tr.appendChild(tdA);
      tr.addEventListener("click", function () { openDrawer(a.id); });
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
    var more = $("moreBtn");
    if (rows.length > shown) { more.hidden = false; more.textContent = "Show " + Math.min(SHOW_STEP, rows.length - shown) + " more (" + (rows.length - shown).toLocaleString() + " remaining)"; } else more.hidden = true;
  }

  // ---------- Drawer ----------
  function openDrawer(id) {
    selectedId = id;
    $("drawer").hidden = false;
    renderDrawer();
    document.querySelectorAll("#rows tr").forEach(function (tr) { tr.classList.toggle("selected", tr.dataset.id === id); });
  }
  function closeDrawer() { selectedId = null; $("drawer").hidden = true; document.querySelectorAll("#rows tr.selected").forEach(function (tr) { tr.classList.remove("selected"); }); }
  function kv(dl, k, v, link) {
    if (!v) return;
    dl.appendChild(el("dt", null, k));
    var dd = el("dd");
    if (link) { var a = el("a", null, v); a.href = link; if (/^https?:/.test(link)) { a.target = "_blank"; a.rel = "noopener"; } dd.appendChild(a); } else dd.textContent = v;
    dl.appendChild(dd);
  }
  function section(body, title) { var sec = el("div", "sec"); sec.appendChild(el("h3", null, title)); body.appendChild(sec); return sec; }

  // Staff read the cleaned answers through the form's field_map; managers get the same facts
  // pre-extracted by the view.
  function detailsFromAnswers(a, answers) {
    var f = formById[a.formId]; var fm = (f && f.field_map) || {}; var es = a.language === "es";
    var get = function (key) { var q = fm[key]; return q && typeof q === "string" ? answers[q] : undefined; };
    var txt = function (key, lang) { var t = toText(get(key)); return lang && es ? firstLang(t) : t; };
    var employers = (fm.employers || []).map(function (e) {
      return { employer: toText(answers[e.name]), location: toText(answers[e.location]), title: toText(answers[e.title]), start: toText(answers[e.start]), end: toText(answers[e.end]), reason: toText(answers[e.reason]) };
    }).filter(function (e) { return e.employer || e.title; });
    return {
      altPhone: txt("phone_alt"), phoneType: txt("phone_type", true), address: txt("address"), contactMethod: txt("contact_method", true),
      education: txt("education", true), skills: txt("relevant_skills"), workedBefore: txt("worked_before", true), appliedBefore: txt("applied_before", true),
      student: txt("student", true), forklift: txt("forklift", true), herbicide: txt("herbicide_licence", true), portfolioLink: txt("portfolio_link").trim(),
      employers: employers
    };
  }

  function renderDrawer() {
    var a = appById[selectedId]; if (!a) return;
    $("dName").textContent = a.name;
    $("dSub").textContent = "Applied " + fmtDateTime(a.when) + " · " + a.form + " form" + (a.location ? " · " + a.location : "");
    var body = $("dBody"); body.innerHTML = "";

    // Review / status
    var sec = section(body, staff ? "Review" : "Status");
    var rv = el("div", "review");
    if (staff) {
      var l1 = el("label", null, "Status"); l1.appendChild(statusControl(a)); rv.appendChild(l1);
      var l2 = el("label", null, "Sent to / hiring manager"); var inp = el("input"); inp.type = "text"; inp.value = a.assignedTo; inp.placeholder = "Name of the manager you passed this to";
      inp.addEventListener("change", function () { saveStatusFields(a.id, { assigned_to: inp.value.trim() || null }); }); l2.appendChild(inp); rv.appendChild(l2);
      var l4 = el("label", null, "Tags (comma separated)"); var tg = el("input"); tg.type = "text"; tg.value = a.tags.join(", "); tg.placeholder = "spring, bilingual, CDL";
      tg.addEventListener("change", function () { var tags = tg.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean); saveStatusFields(a.id, { tags: tags }); }); l4.appendChild(tg); rv.appendChild(l4);
      var l3 = el("label", null, "Notes (HR and admin only)"); var ta = el("textarea"); ta.value = a.notes; ta.placeholder = "Interview impressions, follow-ups, anything worth remembering";
      ta.addEventListener("input", function () { clearTimeout(notesTimer); notesTimer = setTimeout(function () { if (a.notes !== ta.value) saveStatusFields(a.id, { notes: ta.value }); }, 900); });
      ta.addEventListener("blur", function () { clearTimeout(notesTimer); if (a.notes !== ta.value) saveStatusFields(a.id, { notes: ta.value }); });
      l3.appendChild(ta); rv.appendChild(l3);
      var sv = el("div", "saving"); sv.id = "savingNote"; rv.appendChild(sv);
      var hist = el("ul", "history"); hist.id = "historyList"; hist.appendChild(el("li", null, "Loading history…")); rv.appendChild(hist);
    } else {
      var dl0 = el("dl", "kv");
      var dd = el("dd"); dd.appendChild(statusControl(a)); dl0.appendChild(el("dt", null, "Status")); dl0.appendChild(dd);
      kv(dl0, "Since", a.stageSince ? fmtDateTime(a.stageSince) : "");
      kv(dl0, "Sent to", a.assignedTo);
      rv.appendChild(dl0);
    }
    sec.appendChild(rv);

    // Contact
    sec = section(body, "Contact");
    var dl = el("dl", "kv"); dl.id = "contactKv";
    kv(dl, "Email", a.email, a.email ? "mailto:" + a.email : null);
    kv(dl, "Phone", a.phone, a.phone ? "tel:" + digits(a.phone) : null);
    kv(dl, "City", [a.city, a.state].filter(Boolean).join(", "));
    sec.appendChild(dl);

    // Application
    sec = section(body, "Application");
    dl = el("dl", "kv"); dl.id = "applicationKv";
    kv(dl, "Location", a.location); kv(dl, "Position", a.positionText);
    if (a.positionTitle && a.positionTitle !== a.positionText) kv(dl, "Matched opening", a.positionTitle);
    kv(dl, "Heard from", a.source + (a.sourceDetail ? " (" + a.sourceDetail + ")" : "")); kv(dl, "Referred by", a.referredBy);
    kv(dl, "Can start", fmtDay(a.availableStart));
    sec.appendChild(dl);
    if (a.curated) fillDetails(a.curated);

    // Employment history placeholder (filled by fillDetails)
    sec = section(body, "Employment history"); sec.id = "employmentSec";
    sec.appendChild(el("div", "hint", staff ? "Loading…" : "None given."));
    if (a.curated) fillEmployment(a.curated.employers);

    // Files and links
    sec = section(body, "Files and links");
    var links = el("div", "links");
    a.files.forEach(function (f) { links.appendChild(fileButton(f, (f.kind === "resume" ? "📄 " : "📎 ") + (f.original_name || fileName(f.storage_path)))); });
    if (!a.files.length) links.appendChild(el("div", "meta", "No resume uploaded."));
    var pl = el("span"); pl.id = "portfolioLink"; links.appendChild(pl);
    if (a.jotformUrl) { var jl = el("a", null, "Open in Jotform inbox"); jl.href = a.jotformUrl; jl.target = "_blank"; jl.rel = "noopener"; links.appendChild(jl); }
    sec.appendChild(links);

    // Duplicates
    if (a.dups && a.dups.length) {
      sec = section(body, "Also applied (same email or phone)");
      var dups = el("div", "dups");
      a.dups.forEach(function (o) {
        var link = el("a", null, fmtDate(o.when) + " — " + (o.positionText || "no position") + " (" + o.form + ", " + stageName(o.stageId) + ")");
        link.href = "#"; link.addEventListener("click", function (e) { e.preventDefault(); openDrawer(o.id); }); dups.appendChild(link);
      });
      sec.appendChild(dups);
    }

    if (staff) {
      // Contact log
      sec = section(body, "Contact log"); sec.id = "contactSec";
      var log = el("ul", "log"); log.id = "contactList"; log.appendChild(el("li", "hint", "Loading…")); sec.appendChild(log);
      sec.appendChild(contactForm(a));
      // Manager feedback (read)
      sec = section(body, "Manager feedback"); sec.id = "feedbackSec";
      sec.appendChild(el("div", "hint", "Loading…"));
      // Full application
      sec = section(body, "Full application"); sec.id = "answersSec";
      sec.appendChild(el("div", "hint", "Loading…"));
      loadStaffDetails(a);
    } else {
      sec = section(body, "Your feedback"); sec.id = "feedbackSec";
      sec.appendChild(el("div", "hint", "Loading…"));
      loadManagerFeedback(a);
    }
    body.scrollTop = 0;
  }

  function fillDetails(d) {
    var c = $("contactKv"), ap = $("applicationKv"); if (!c || !ap) return;
    kv(c, "Alternate phone", d.altPhone, d.altPhone ? "tel:" + digits(d.altPhone) : null);
    kv(c, "Phone type", d.phoneType);
    kv(c, "Prefers", d.contactMethod);
    kv(c, "Address", d.address);
    kv(ap, "Education", d.education); kv(ap, "Worked here before", d.workedBefore); kv(ap, "Applied before", d.appliedBefore);
    kv(ap, "Student", d.student); kv(ap, "Forklift", d.forklift); kv(ap, "Herbicide licence", d.herbicide);
    kv(ap, "Skills", d.skills);
    var pl = $("portfolioLink");
    if (pl && d.portfolioLink) { var link = el("a", null, "Portfolio link"); link.href = /^https?:/.test(d.portfolioLink) ? d.portfolioLink : "https://" + d.portfolioLink; link.target = "_blank"; link.rel = "noopener"; pl.appendChild(link); }
  }
  function fillEmployment(employers) {
    var sec = $("employmentSec"); if (!sec) return;
    sec.querySelectorAll(".hint, .jobs").forEach(function (n) { n.remove(); });
    employers = (employers || []).filter(function (e) { return e.employer || e.title; });
    if (!employers.length) { sec.appendChild(el("div", "hint", "None given.")); return; }
    var wrap = el("div", "jobs");
    employers.forEach(function (e) {
      var j = el("div", "job");
      j.appendChild(el("div", null, [e.title, e.employer].filter(Boolean).join(" at ")));
      var when = [e.start, e.end || "present"].filter(Boolean).join(" – ");
      j.appendChild(el("div", "meta", [e.location, when].filter(Boolean).join(" · ")));
      if (e.reason) j.appendChild(el("div", "meta", "Left: " + e.reason));
      wrap.appendChild(j);
    });
    sec.appendChild(wrap);
  }

  async function loadStaffDetails(a) {
    var id = a.id;
    var r = await Promise.all([
      sb.from("applications").select("answers").eq("id", id).single(),
      sb.from("status_history").select("id, from_stage_id, to_stage_id, changed_by, changed_at").eq("application_id", id).order("changed_at", { ascending: false }),
      sb.from("contacts").select("id, kind, direction, summary, by_name, at").eq("application_id", id).order("at", { ascending: false }),
      sb.from("manager_feedback").select("id, manager_user_id, verdict, note, at").eq("application_id", id).order("at", { ascending: false })
    ]);
    if (selectedId !== id) return; // user moved on
    var answers = (r[0].data && r[0].data.answers) || {};
    if (r[0].error) notice("Could not load the full application: " + errText(r[0].error));
    var d = detailsFromAnswers(a, answers);
    fillDetails(d); fillEmployment(d.employers);
    renderHistory(r[1].data || [], r[1].error);
    renderContacts(r[2].data || [], r[2].error);
    renderFeedbackList(r[3].data || [], r[3].error);
    renderAnswers(a, answers);
  }
  function renderHistory(rows, error) {
    var ul = $("historyList"); if (!ul) return; ul.innerHTML = "";
    if (error) { ul.appendChild(el("li", null, "Could not load history: " + errText(error))); return; }
    if (!rows.length) { ul.appendChild(el("li", null, "No stage changes yet.")); return; }
    rows.forEach(function (h) {
      var who = h.changed_by ? (profileNames[h.changed_by] || "a removed user") : "import";
      var what = h.from_stage_id ? stageName(h.from_stage_id) + " → " + stageName(h.to_stage_id) : "Applied";
      ul.appendChild(el("li", null, fmtDateTime(new Date(h.changed_at)) + " — " + what + " · " + who));
    });
  }
  var KIND_LABEL = { email: "Email", call: "Call", text: "Text", in_person: "In person" };
  function renderContacts(rows, error) {
    var ul = $("contactList"); if (!ul) return; ul.innerHTML = "";
    if (error) { ul.appendChild(el("li", "hint", "Could not load the contact log: " + errText(error))); return; }
    if (!rows.length) { ul.appendChild(el("li", "hint", "No contact logged yet.")); return; }
    rows.forEach(function (c) {
      var li = el("li");
      li.appendChild(el("div", "when", fmtDateTime(new Date(c.at)) + " · " + (KIND_LABEL[c.kind] || c.kind) + ", " + c.direction + (c.by_name ? " · " + c.by_name : "")));
      li.appendChild(el("div", null, c.summary));
      ul.appendChild(li);
    });
  }
  function contactForm(a) {
    var form = el("form", "review");
    var row = el("div", "row");
    var lk = el("label", null, "Kind"); var kind = el("select");
    Object.keys(KIND_LABEL).forEach(function (k) { var o = el("option", null, KIND_LABEL[k]); o.value = k; kind.appendChild(o); }); lk.appendChild(kind); row.appendChild(lk);
    var ld = el("label", null, "Direction"); var dir = el("select");
    [["outbound", "We reached out"], ["inbound", "They reached out"]].forEach(function (p) { var o = el("option", null, p[1]); o.value = p[0]; dir.appendChild(o); }); ld.appendChild(dir); row.appendChild(ld);
    form.appendChild(row);
    var ls = el("label", null, "What happened"); var sum = el("textarea"); sum.required = true; sum.placeholder = "Left a voicemail about interview times"; sum.style.minHeight = "56px"; ls.appendChild(sum); form.appendChild(ls);
    var btn = el("button", "btn small", "Log contact"); btn.type = "submit"; form.appendChild(btn);
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      var summary = sum.value.trim(); if (!summary) return;
      btn.disabled = true;
      var res = await sb.from("contacts").insert({ application_id: a.id, kind: kind.value, direction: dir.value, summary: summary, by_user_id: session.user.id, by_name: profile.name }).select("id, kind, direction, summary, by_name, at");
      btn.disabled = false;
      if (res.error) { notice("Could not log the contact: " + errText(res.error)); return; }
      sum.value = "";
      if (selectedId !== a.id) return;
      var r2 = await sb.from("contacts").select("id, kind, direction, summary, by_name, at").eq("application_id", a.id).order("at", { ascending: false });
      renderContacts(r2.data || [], r2.error);
    });
    return form;
  }
  var VERDICT_LABEL = { interested: "Interested", pass: "Pass", undecided: "Undecided" };
  function renderFeedbackList(rows, error) {
    var sec = $("feedbackSec"); if (!sec) return;
    sec.querySelectorAll(".hint, .log").forEach(function (n) { n.remove(); });
    if (error) { sec.appendChild(el("div", "hint", "Could not load feedback: " + errText(error))); return; }
    if (!rows.length) { sec.appendChild(el("div", "hint", "No manager has left feedback.")); return; }
    var ul = el("ul", "log");
    rows.forEach(function (f) {
      var li = el("li");
      li.appendChild(el("div", "when", fmtDateTime(new Date(f.at)) + " · " + (profileNames[f.manager_user_id] || "a removed user")));
      li.appendChild(el("div", null, (VERDICT_LABEL[f.verdict] || f.verdict) + (f.note ? " — " + f.note : "")));
      ul.appendChild(li);
    });
    sec.appendChild(ul);
  }
  async function loadManagerFeedback(a) {
    var res = await sb.from("manager_feedback").select("id, verdict, note, at").eq("application_id", a.id).eq("manager_user_id", session.user.id).order("at", { ascending: false }).limit(1);
    if (selectedId !== a.id) return;
    var sec = $("feedbackSec"); if (!sec) return;
    sec.querySelectorAll(".hint, .review").forEach(function (n) { n.remove(); });
    if (res.error) { sec.appendChild(el("div", "hint", "Could not load your feedback: " + errText(res.error))); return; }
    var existing = (res.data || [])[0] || null;
    var form = el("form", "review");
    var lv = el("label", null, "Verdict"); var sel = el("select");
    var o0 = el("option", null, "Choose…"); o0.value = ""; sel.appendChild(o0);
    Object.keys(VERDICT_LABEL).forEach(function (k) { var o = el("option", null, VERDICT_LABEL[k]); o.value = k; if (existing && existing.verdict === k) o.selected = true; sel.appendChild(o); });
    lv.appendChild(sel); form.appendChild(lv);
    var ln = el("label", null, "Note for HR"); var ta = el("textarea"); ta.value = existing ? (existing.note || "") : ""; ta.placeholder = "Anything HR should know before the next step"; ln.appendChild(ta); form.appendChild(ln);
    var btn = el("button", "btn small", existing ? "Update feedback" : "Save feedback"); btn.type = "submit"; form.appendChild(btn);
    var st = el("div", "saving"); form.appendChild(st);
    if (existing) st.textContent = "Last saved " + fmtDateTime(new Date(existing.at));
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      if (!sel.value) { st.textContent = "Pick a verdict first."; return; }
      btn.disabled = true; st.textContent = "Saving…";
      var payload = { verdict: sel.value, note: ta.value.trim() || null, at: new Date().toISOString() };
      var r = existing
        ? await sb.from("manager_feedback").update(payload).eq("id", existing.id).select("id, verdict, note, at").single()
        : await sb.from("manager_feedback").insert(Object.assign({ application_id: a.id, manager_user_id: session.user.id }, payload)).select("id, verdict, note, at").single();
      btn.disabled = false;
      if (r.error) { st.textContent = ""; notice("Could not save your feedback: " + errText(r.error)); return; }
      existing = r.data; btn.textContent = "Update feedback"; st.textContent = "Saved " + fmtDateTime(new Date(existing.at));
    });
    sec.appendChild(form);
  }
  function renderAnswers(a, answers) {
    var sec = $("answersSec"); if (!sec) return;
    sec.querySelectorAll(".hint, .answers").forEach(function (n) { n.remove(); });
    var f = formById[a.formId]; var qs = (f && f.questions) || {};
    var ids = Object.keys(answers);
    ids.sort(function (x, y) { var ox = qs[x] ? parseInt(qs[x].order, 10) : 9999, oy = qs[y] ? parseInt(qs[y].order, 10) : 9999; return ox - oy; });
    var wrap = el("div", "answers"), n = 0;
    ids.forEach(function (q) {
      var meta = qs[q]; var type = meta ? meta.type : "";
      if (SKIP_TYPES[type]) return;
      var v = answers[q], txt;
      if (type === "control_fileupload" || (Array.isArray(v) && v.every(function (u) { return /^https?:\/\//.test(String(u)); }))) txt = (Array.isArray(v) ? v : [v]).filter(Boolean).map(fileName).join(", ");
      else txt = toText(v);
      if (!txt) return;
      var label = meta ? (a.language === "es" ? firstLang(meta.text) : meta.text) : "Question " + q;
      label = label.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(); if (label.length > 140) label = label.slice(0, 137) + "…";
      var box = el("div"); box.appendChild(el("div", "q", label)); box.appendChild(el("div", "a", txt)); wrap.appendChild(box); n++;
    });
    if (!n) wrap.appendChild(el("div", "hint", "No answers to show."));
    sec.appendChild(wrap);
  }

  // ---------- Export ----------
  function csvCell(v) { v = v == null ? "" : String(v); return /[",\n\r]/.test(v) ? "\"" + v.replace(/"/g, "\"\"") + "\"" : v; }
  function exportCsv() {
    var rows = sortRows(applyFilters());
    var head = ["Name", "Email", "Phone", "City", "State", "Applied", "Form", "Location", "Position", "Matched opening", "Heard from", "Referred by", "Can start", "Status", "In stage since", "Sent to", "Resume", "Files"];
    if (staff) head = head.concat(["Tags", "Notes", "Jotform link"]);
    var lines = [head.join(",")];
    rows.forEach(function (a) {
      var cells = [a.name, a.email, a.phone, a.city, a.state, a.dateKey, a.form, a.location, a.positionText, a.positionTitle, a.source + (a.sourceDetail ? " (" + a.sourceDetail + ")" : ""), a.referredBy, a.availableStart,
        stageName(a.stageId), a.stageSince ? ymd(a.stageSince) : "", a.assignedTo, a.files.length ? "yes" : "no", a.files.map(function (f) { return f.original_name || fileName(f.storage_path); }).join("; ")];
      if (staff) cells = cells.concat([a.tags.join("; "), a.notes, a.jotformUrl]);
      lines.push(cells.map(csvCell).join(","));
    });
    var blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var link = el("a"); link.href = url; link.download = "rexius-applicants-" + ymd(new Date()) + ".csv";
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---------- Wiring ----------
  $("loginForm").addEventListener("submit", function (e) { e.preventDefault(); signIn($("loginEmail").value.trim(), $("loginPassword").value); });
  $("signOutBtn").addEventListener("click", signOut);
  $("noAccessSignOut").addEventListener("click", signOut);
  $("q").addEventListener("input", function () { filters.q = this.value; shown = SHOW_STEP; render(); });
  $("from").addEventListener("change", function () { filters.from = this.value; render(); });
  $("to").addEventListener("change", function () { filters.to = this.value; render(); });
  $("resumeOnly").addEventListener("change", function () { filters.resumeOnly = this.checked; render(); });
  $("dupOnly").addEventListener("change", function () { filters.dupOnly = this.checked; render(); });
  $("sort").addEventListener("change", function () { var p = this.value.split(":"); sort = { key: p[0], dir: p[1] }; render(); });
  $("clearBtn").addEventListener("click", function () {
    filters = emptyFilters();
    $("q").value = ""; $("from").value = ""; $("to").value = ""; $("resumeOnly").checked = false; $("dupOnly").checked = false;
    buildFilterOptions(); shown = SHOW_STEP; render();
  });
  $("moreBtn").addEventListener("click", function () { shown += SHOW_STEP; render(); });
  $("toggleFilters").addEventListener("click", function () { $("filters").classList.toggle("open"); });
  $("dClose").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("drawer").hidden) closeDrawer(); });
  $("refreshBtn").addEventListener("click", loadApps);
  $("exportBtn").addEventListener("click", exportCsv);
  setInterval(updateMeta, 60000);

  // ---------- Boot ----------
  // getSession() restores a persisted session from localStorage; onAuthStateChange covers sign-in,
  // sign-out and token refresh after that.
  var booted = false;
  sb.auth.getSession().then(function (res) {
    booted = true;
    onSession(res.data ? res.data.session : null);
  });
  sb.auth.onAuthStateChange(function (event, s) {
    if (!booted) return;
    if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") {
      if (!s || !session || s.user.id !== session.user.id) onSession(s); else session = s;
    } else if (s) session = s;
  });
})();
