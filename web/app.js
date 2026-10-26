/* Rexius Recruiter tracker (Phase 6; Phase 7 adds pages and the shared RR API).
 * Plain JS on supabase-js v2. Everything lives in schema `recruiting`; row-level security
 * decides what each role may read and write, so this file only has to pick the right source:
 *   admin / hr  -> applications (+ application_status, application_files, forms, positions)
 *   manager     -> applications_for_managers (curated view; no notes, tags, offers, contacts,
 *                  raw answers) and their own manager_feedback rows
 *   no profile  -> the "no access" screen
 * This file owns sign-in, the Applications page and the drawer. positions.js, documents.js and
 * reports.js register the other pages through window.RR (bottom of this file) and get the
 * client, helpers and loaded reference data from it. Pages are picked by the URL hash:
 * #/applications, #/positions[/id], #/documents[/id], #/reports[/key].
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
  var MANUAL_ANSWER_LABELS = { manual_notes: "Notes and skills from the paper form" }; // keys a manual entry stores in `answers`
  var SKIP_TYPES = { control_text: 1, control_head: 1, control_button: 1, control_divider: 1, control_pagebreak: 1, control_collapse: 1, control_signature: 1 };

  // ---------- State ----------
  var session = null, profile = null, role = null, staff = false;
  var stages = [], stageById = {};
  var forms = [], formById = {}, formByLabel = {};
  var positions = [], positionById = {};
  var profileNames = {};      // user_id -> name, for history and feedback
  var pages = {};             // page name -> { show(param), hide() }, registered by the page scripts
  var currentPage = null;
  var drawerKind = null;      // "app" (applicant) or "custom" (a page's own drawer)
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
  // Same rules as normalizeEmail / normalizePhone in scripts/backfill/lib/clean.mjs, so a manual
  // entry lands in the same duplicate group as the applicant's Jotform submissions.
  function normalizeEmail(v) { if (typeof v !== "string") return null; v = v.trim().toLowerCase(); return v.indexOf("@") >= 0 ? v : null; }
  function normalizePhone(v) { var d = digits(String(v || "")); return d.length >= 10 ? d.slice(-10) : null; }
  // Same as storageSafeName in clean.mjs: an ASCII object key Storage accepts.
  function storageSafeName(name, index) {
    var cleaned = String(name || "").normalize("NFKD").replace(/[^\x20-\x7E]/g, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^[_.]+/, "").slice(0, 120);
    var base = cleaned || "file";
    return index > 0 ? index + "_" + base : base;
  }
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
    if (view !== "appView") { hideDrawer(); currentPage = null; }
  }

  // ---------- Pages and routing ----------
  // #/<page>[/<param>]. Unknown pages and pages the role may not use fall back to applications.
  function parseHash() {
    var h = location.hash.replace(/^#\/?/, "");
    var i = h.indexOf("/");
    return { name: (i < 0 ? h : h.slice(0, i)) || "applications", param: i < 0 ? "" : decodeURIComponent(h.slice(i + 1)) };
  }
  function route() {
    if ($("appView").hidden) return;
    var r = parseHash();
    if (!pages[r.name] || (r.name === "reports" && !staff)) { if (location.hash && location.hash !== "#/applications") { location.hash = "#/applications"; return; } r = { name: "applications", param: "" }; }
    if (currentPage && currentPage !== r.name) { hideDrawer(); if (pages[currentPage].hide) pages[currentPage].hide(); }
    var changed = currentPage !== r.name;
    currentPage = r.name;
    document.body.dataset.page = r.name;
    document.querySelectorAll(".page").forEach(function (p) { p.hidden = p.id !== "page-" + r.name; });
    document.querySelectorAll("#nav a").forEach(function (a) { a.classList.toggle("on", a.dataset.page === r.name); a.setAttribute("aria-current", a.dataset.page === r.name ? "page" : "false"); });
    pages[r.name].show(r.param, changed);
  }
  // Routes at once; the hashchange event that follows re-runs route() as a no-op.
  function go(hash) { if (location.hash !== hash) location.hash = hash; route(); }
  function registerPage(name, handlers) { pages[name] = handlers; }
  function setHeader(title, meta) { $("pageTitle").textContent = title; if (meta != null) $("meta").textContent = meta; }

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
    // The next sign-in may be a different role: every page drops what it cached.
    Object.keys(pages).forEach(function (n) { if (pages[n].reset) pages[n].reset(); });
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
    $("addBtn").hidden = !staff;
    show("appView");
    await loadRefs();
    route();
    await loadApps();
  }

  // ---------- Reference data ----------
  async function loadRefs() {
    var r = await Promise.all([
      sb.from("stages").select("id, name, sort_order, is_terminal, is_hired").order("sort_order"),
      sb.from("forms").select("id, jotform_form_id, label, language, default_location, questions, field_map"),
      sb.from("positions").select("id, title, location, department, hiring_manager, pay_min, pay_max, pay_unit, status, opened_at, closed_at, jotform_option_label, filled_by_application_id, description_doc_id, created_at, updated_at").order("location").order("title"),
      sb.from("profiles").select("user_id, name, role")
    ]);
    var failed = r.filter(function (x) { return x.error; });
    if (failed.length) notice("Could not load reference data: " + errText(failed[0].error));
    stages = r[0].data || []; stageById = {};
    stages.forEach(function (s, i) { s.index = i; stageById[s.id] = s; });
    forms = r[1].data || []; formById = {}; formByLabel = {};
    forms.forEach(function (f) { f.short = shortFormLabel(f); formById[f.id] = f; formByLabel[f.label] = f; });
    positions = r[2].data || []; positionById = {}; positions.forEach(function (p) { positionById[p.id] = p; });
    profileNames = {}; (r[3].data || []).forEach(function (p) { profileNames[p.user_id] = p.name; });
  }

  // ---------- Applications ----------
  var STAFF_COLUMNS = "id, jotform_submission_id, form_id, submitted_at, name, email, email_norm, phone, phone_norm, city, state, location, position_text, position_id, source, source_detail, referred_by, available_start, has_resume, language, jotform_url, origin, entered_by, entered_at, " +
    "application_status(stage_id, assigned_to, notes, tags, stage_since, updated_at), application_files(id, storage_path, original_name, kind), status_history(to_stage_id)";

  async function fetchAll(table, columns) {
    var out = [], from = 0;
    for (;;) {
      var res = await sb.from(table).select(columns).order("submitted_at", { ascending: false }).order("id").range(from, from + PAGE - 1);
      if (res.error) throw res.error;
      out = out.concat(res.data || []);
      if (currentPage === "applications") $("meta").textContent = "Loading applications… " + out.length.toLocaleString() + " so far";
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
    // Furthest pipeline stage ever reached (Not selected / Withdrawn are not progress): drives funnels.
    var furthest = 0;
    (row.status_history || []).forEach(function (h) { var s = stageById[h.to_stage_id]; if (s && (!s.is_terminal || s.is_hired) && s.sort_order > furthest) furthest = s.sort_order; });
    var manual = row.origin === "manual";
    return finish({
      id: row.id, when: when, dateKey: ymd(when), name: row.name || "(no name)", email: row.email || "", phone: row.phone || "",
      emailNorm: row.email_norm || "", phoneNorm: row.phone_norm || "", city: row.city, state: row.state,
      location: row.location || "", positionText: row.position_text || "", positionId: row.position_id, positionTitle: pos ? pos.title : "",
      source: row.source || "", sourceDetail: row.source_detail || "", referredBy: row.referred_by || "", availableStart: row.available_start || "",
      hasResume: !!row.has_resume || files.length > 0, language: row.language, formId: row.form_id, form: manual ? "Manual" : (f ? f.short : ""), formLabel: manual ? "Manual entry" : (f ? f.label : ""),
      origin: row.origin || "jotform", enteredBy: row.entered_by || null, enteredAt: row.entered_at ? new Date(row.entered_at) : null,
      jotformUrl: row.jotform_url || "", submissionId: row.jotform_submission_id,
      stageId: st.stage_id, assignedTo: st.assigned_to || "", notes: st.notes || "", tags: st.tags || [], stageSince: st.stage_since ? new Date(st.stage_since) : null,
      furthestSort: furthest,
      files: files
    });
  }
  function normalizeManager(row) {
    var f = formByLabel[row.form_label];
    var when = new Date(row.submitted_at);
    var files = (row.files || []).slice();
    var manual = row.origin === "manual";
    return finish({
      id: row.id, when: when, dateKey: ymd(when), name: row.name || "(no name)", email: row.email || "", phone: row.phone || "",
      emailNorm: normalizeEmail(row.email) || "", phoneNorm: normalizePhone(row.phone) || "", city: row.city, state: row.state,
      location: row.location || "", positionText: row.position_text || "", positionId: row.position_id, positionTitle: row.position_title || "",
      source: row.source || "", sourceDetail: "", referredBy: row.referred_by || "", availableStart: row.available_start || "",
      hasResume: !!row.has_resume || files.length > 0, language: row.language, formId: f ? f.id : null, form: manual ? "Manual" : (f ? f.short : row.form_label || ""), formLabel: manual ? "Manual entry" : (row.form_label || ""),
      origin: row.origin || "jotform", enteredBy: row.entered_by || null, enteredAt: row.entered_at ? new Date(row.entered_at) : null,
      jotformUrl: "", submissionId: null,
      stageId: row.stage_id, assignedTo: row.assigned_to || "", notes: "", tags: [], stageSince: row.stage_since ? new Date(row.stage_since) : null,
      furthestSort: stageById[row.furthest_stage_id] ? stageById[row.furthest_stage_id].sort_order : 0,
      files: files,
      curated: {
        education: toText(row.education), skills: toText(row.relevant_skills), workedBefore: toText(row.worked_at_rexius_before), appliedBefore: toText(row.applied_before),
        manualNotes: row.manual_notes || "",
        employers: (row.employment_history || []).map(function (e) { return { employer: toText(e.employer), location: toText(e.location), title: toText(e.title), start: toText(e.start), end: toText(e.end), reason: toText(e.reason), responsibilities: toText(e.responsibilities) }; })
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
    if (currentPage === "applications") $("meta").textContent = appsMeta();
    buildFilterOptions();
    render();
    updateMeta();
    if (drawerKind === "app") { if (selectedId && appById[selectedId]) renderDrawer(); else closeDrawer(); }
    if (currentPage && currentPage !== "applications" && pages[currentPage].appsChanged) pages[currentPage].appsChanged();
  }
  function appsMeta() {
    if (!apps.length) return lastLoaded ? "No applications found." : "Loading…";
    var perForm = {};
    apps.forEach(function (a) { perForm[a.form] = (perForm[a.form] || 0) + 1; });
    var parts = Object.keys(perForm).sort(function (a, b) { return perForm[b] - perForm[a]; }).map(function (k) { return perForm[k].toLocaleString() + " " + k; }).join(", ");
    return apps.length.toLocaleString() + " applications (" + parts + ") · updated " + (lastLoaded ? relTime(lastLoaded) : "—");
  }
  function updateMeta() {
    if (currentPage !== "applications") return;
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
  function fileIcon(f) { return f.kind === "resume" ? "📄" : f.kind === "scan" ? "🖨️" : "📎"; }
  function fileLabel(f) { return (f.kind === "scan" ? "Scan: " : "") + (f.original_name || fileName(f.storage_path)); }
  function formTag(a) {
    var t = el("span", "tag" + (a.origin === "manual" ? " manual" : ""), a.form);
    if (a.origin === "manual") t.title = "Typed in from a paper application" + (a.enteredAt ? " on " + fmtDate(a.enteredAt) : "");
    return t;
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
      var tdP = el("td", "pos"); tdP.appendChild(document.createTextNode(a.positionText || "—")); tdP.appendChild(formTag(a)); tr.appendChild(tdP);
      tr.appendChild(el("td", "col-src", a.source || "—"));
      var tdS = el("td"); tdS.appendChild(statusControl(a)); tr.appendChild(tdS);
      var tdA = el("td", "att");
      a.files.forEach(function (f) { tdA.appendChild(fileButton(f, fileIcon(f))); });
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
    selectedId = id; drawerKind = "app";
    $("drawer").hidden = false;
    renderDrawer();
    document.querySelectorAll("#rows tr").forEach(function (tr) { tr.classList.toggle("selected", tr.dataset.id === id); });
  }
  // A page's own drawer (position, document): same panel, the page fills the body.
  function showDrawer(title, sub, build) {
    selectedId = null; drawerKind = "custom";
    $("dName").textContent = title; $("dSub").textContent = sub || "";
    var body = $("dBody"); body.innerHTML = "";
    build(body); body.scrollTop = 0;
    $("drawer").hidden = false;
  }
  // hideDrawer: just hide (page switches, sign-out). closeDrawer: the user closed it, so the
  // page that owns a custom drawer gets to tidy up (clear its selection, reset the hash).
  function hideDrawer() {
    selectedId = null; drawerKind = null; $("drawer").hidden = true;
    document.querySelectorAll("tr.selected").forEach(function (tr) { tr.classList.remove("selected"); });
  }
  function closeDrawer() {
    var wasCustom = drawerKind === "custom";
    hideDrawer();
    if (wasCustom && currentPage && pages[currentPage].drawerClosed) pages[currentPage].drawerClosed();
  }
  // Open an applicant from another page: switch to Applications and show the drawer.
  function openApplicant(id) {
    if (currentPage !== "applications") go("#/applications");
    if (appById[id]) openDrawer(id);
  }
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
      return { employer: toText(answers[e.name]), location: toText(answers[e.location]), title: toText(answers[e.title]), start: toText(answers[e.start]), end: toText(answers[e.end]), reason: toText(answers[e.reason]), responsibilities: toText(answers[e.responsibilities]) };
    }).filter(function (e) { return e.employer || e.title; });
    return {
      altPhone: txt("phone_alt"), phoneType: txt("phone_type", true), address: txt("address"), contactMethod: txt("contact_method", true),
      education: txt("education", true), skills: txt("relevant_skills"), workedBefore: txt("worked_before", true), appliedBefore: txt("applied_before", true),
      student: txt("student", true), forklift: txt("forklift", true), herbicide: txt("herbicide_licence", true), portfolioLink: txt("portfolio_link").trim(),
      manualNotes: typeof answers.manual_notes === "string" ? answers.manual_notes : "",
      employers: employers
    };
  }

  function renderDrawer() {
    var a = appById[selectedId]; if (!a) return;
    $("dName").textContent = a.name;
    var manual = a.origin === "manual";
    $("dSub").textContent = (manual ? "Received " + fmtDate(a.when) + " · Manual entry" : "Applied " + fmtDateTime(a.when) + " · " + a.form + " form") + (a.location ? " · " + a.location : "");
    var body = $("dBody"); body.innerHTML = "";
    if (manual) {
      var badge = el("div", "notice-inline");
      badge.appendChild(formTag(a));
      badge.appendChild(document.createTextNode(" Paper application typed in" + (a.enteredBy ? " by " + (profileNames[a.enteredBy] || "a removed user") : "") + (a.enteredAt ? " on " + fmtDateTime(a.enteredAt) : "") + ". The scan is under Files."));
      body.appendChild(badge);
    }

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
    a.files.forEach(function (f) { links.appendChild(fileButton(f, fileIcon(f) + " " + fileLabel(f))); });
    if (!a.files.length) links.appendChild(el("div", "meta", manual ? "No scan or resume attached." : "No resume uploaded."));
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
      // Offers (never a wage) and referral bonus tracking
      sec = section(body, "Offers"); sec.id = "offersSec";
      sec.appendChild(el("div", "hint", "Loading…"));
      sec = section(body, "Referral"); sec.id = "referralSec";
      sec.appendChild(el("div", "hint", "Loading…"));
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
    kv(ap, "Notes from the paper form", d.manualNotes);
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
      if (e.responsibilities) j.appendChild(el("div", "resp", e.responsibilities));
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
      sb.from("manager_feedback").select("id, manager_user_id, verdict, note, at").eq("application_id", id).order("at", { ascending: false }),
      sb.from("offers").select(OFFER_COLS).eq("application_id", id).order("offered_at", { ascending: false }),
      sb.from("referrals").select("id, application_id, referrer_name, referrer_employee, hired, bonus_paid_at, notes").eq("application_id", id).maybeSingle()
    ]);
    if (selectedId !== id) return; // user moved on
    var answers = (r[0].data && r[0].data.answers) || {};
    if (r[0].error) notice("Could not load the full application: " + errText(r[0].error));
    var d = detailsFromAnswers(a, answers);
    fillDetails(d); fillEmployment(d.employers);
    renderHistory(r[1].data || [], r[1].error);
    renderContacts(r[2].data || [], r[2].error);
    renderFeedbackList(r[3].data || [], r[3].error);
    renderOffers(a, r[4].data || [], r[4].error);
    renderReferral(a, r[5].data || null, r[5].error);
    renderAnswers(a, answers);
  }

  // ---------- Offers (staff). No pay field exists and none may be added (CLAUDE.md section 5). ----------
  var OFFER_COLS = "id, position_id, offered_at, outcome, responded_at, notes, created_by, created_at";
  var OUTCOME_LABEL = { pending: "Pending", accepted: "Accepted", declined: "Declined", withdrawn: "Withdrawn" };
  function positionSelect(selectedId, allowNone) {
    var sel = el("select");
    if (allowNone) { var o0 = el("option", null, "No position"); o0.value = ""; sel.appendChild(o0); }
    var groups = {};
    positions.forEach(function (p) { (groups[p.location] = groups[p.location] || []).push(p); });
    Object.keys(groups).sort().forEach(function (loc) {
      var og = el("optgroup"); og.label = loc;
      groups[loc].forEach(function (p) { var o = el("option", null, p.title + (p.status !== "open" ? " (" + p.status + ")" : "")); o.value = p.id; if (p.id === selectedId) o.selected = true; og.appendChild(o); });
      sel.appendChild(og);
    });
    return sel;
  }
  async function reloadOffers(a) {
    var r = await sb.from("offers").select(OFFER_COLS).eq("application_id", a.id).order("offered_at", { ascending: false });
    if (selectedId === a.id) renderOffers(a, r.data || [], r.error);
  }
  function renderOffers(a, rows, error) {
    var sec = $("offersSec"); if (!sec) return;
    sec.querySelectorAll(".hint, .log, .review").forEach(function (n) { n.remove(); });
    if (error) { sec.appendChild(el("div", "hint", "Could not load offers: " + errText(error))); return; }
    if (!rows.length) sec.appendChild(el("div", "hint", "No offer recorded. Offers never store a wage; put pay in the position's advertised range."));
    else {
      var ul = el("ul", "log");
      rows.forEach(function (o) {
        var li = el("li");
        var p = positionById[o.position_id];
        li.appendChild(el("div", "when", "Offered " + fmtDay(o.offered_at) + (p ? " · " + p.title + ", " + p.location : "") + (o.created_by && profileNames[o.created_by] ? " · by " + profileNames[o.created_by] : "")));
        var row = el("div", "row");
        var outcome = el("select", "small");
        Object.keys(OUTCOME_LABEL).forEach(function (k) { var opt = el("option", null, OUTCOME_LABEL[k]); opt.value = k; if (o.outcome === k) opt.selected = true; outcome.appendChild(opt); });
        var resp = el("input"); resp.type = "date"; resp.value = o.responded_at || ""; resp.title = "Responded on";
        var save = async function () {
          var patch = { outcome: outcome.value, responded_at: resp.value || null };
          if (patch.outcome !== "pending" && !patch.responded_at) { patch.responded_at = ymd(new Date()); resp.value = patch.responded_at; }
          var r = await sb.from("offers").update(patch).eq("id", o.id);
          if (r.error) { notice("Could not save the offer: " + errText(r.error)); return; }
          o.outcome = patch.outcome; o.responded_at = patch.responded_at;
        };
        outcome.addEventListener("change", save); resp.addEventListener("change", save);
        row.appendChild(outcome); row.appendChild(resp);
        var del = el("button", "link", "Remove"); del.type = "button";
        del.addEventListener("click", async function () {
          if (!confirm("Remove this offer record?")) return;
          var r = await sb.from("offers").delete().eq("id", o.id);
          if (r.error) { notice("Could not remove the offer: " + errText(r.error)); return; }
          reloadOffers(a);
        });
        row.appendChild(del);
        li.appendChild(row);
        if (o.notes) li.appendChild(el("div", "meta", o.notes));
        ul.appendChild(li);
      });
      sec.appendChild(ul);
    }
    var form = el("form", "review");
    var r1 = el("div", "row");
    var ld = el("label", null, "Offered on"); var dt = el("input"); dt.type = "date"; dt.value = ymd(new Date()); dt.required = true; ld.appendChild(dt); r1.appendChild(ld);
    var lp = el("label", null, "Position"); var ps = positionSelect(a.positionId, true); lp.appendChild(ps); r1.appendChild(lp);
    form.appendChild(r1);
    var r2 = el("div", "row");
    var lo = el("label", null, "Outcome"); var oc = el("select"); Object.keys(OUTCOME_LABEL).forEach(function (k) { var opt = el("option", null, OUTCOME_LABEL[k]); opt.value = k; oc.appendChild(opt); }); lo.appendChild(oc); r2.appendChild(lo);
    var lr = el("label", null, "Responded on"); var rd = el("input"); rd.type = "date"; lr.appendChild(rd); r2.appendChild(lr);
    form.appendChild(r2);
    var ln = el("label", null, "Notes (no pay figures)"); var nt = el("textarea"); nt.style.minHeight = "48px"; nt.placeholder = "Start date discussed, conditions, who made the offer"; ln.appendChild(nt); form.appendChild(ln);
    var btn = el("button", "btn small", "Record offer"); btn.type = "submit"; form.appendChild(btn);
    form.addEventListener("submit", async function (e) {
      e.preventDefault(); btn.disabled = true;
      var payload = { application_id: a.id, position_id: ps.value || null, offered_at: dt.value, outcome: oc.value, responded_at: rd.value || null, notes: nt.value.trim() || null, created_by: session.user.id };
      if (payload.outcome !== "pending" && !payload.responded_at) payload.responded_at = ymd(new Date());
      var r = await sb.from("offers").insert(payload);
      btn.disabled = false;
      if (r.error) { notice("Could not record the offer: " + errText(r.error)); return; }
      reloadOffers(a);
    });
    sec.appendChild(form);
  }

  // ---------- Referral (staff): one row per application ----------
  function renderReferral(a, row, error) {
    var sec = $("referralSec"); if (!sec) return;
    sec.querySelectorAll(".hint, .review").forEach(function (n) { n.remove(); });
    if (error) { sec.appendChild(el("div", "hint", "Could not load the referral: " + errText(error))); return; }
    if (!row && !a.referredBy && a.source.toLowerCase().indexOf("refer") < 0) {
      var hint = el("div", "hint", "Not a referral. ");
      var add = el("button", "link", "Record one anyway"); add.type = "button"; add.addEventListener("click", function () { renderReferralForm(a, null, sec, hint); }); hint.appendChild(add);
      sec.appendChild(hint); return;
    }
    renderReferralForm(a, row, sec, null);
  }
  function renderReferralForm(a, row, sec, replace) {
    if (replace) replace.remove();
    var form = el("form", "review");
    var r1 = el("div", "row");
    var l1 = el("label", null, "Referred by (as written)"); var name = el("input"); name.type = "text"; name.required = true; name.value = row ? row.referrer_name : (a.referredBy || ""); l1.appendChild(name); r1.appendChild(l1);
    var l2 = el("label", null, "Matched employee"); var emp = el("input"); emp.type = "text"; emp.placeholder = "Employee name as on payroll"; emp.value = row ? (row.referrer_employee || "") : ""; l2.appendChild(emp); r1.appendChild(l2);
    form.appendChild(r1);
    var r2 = el("div", "row");
    var l3 = el("label", "check"); var hired = el("input"); hired.type = "checkbox"; hired.checked = !!(row && row.hired); l3.appendChild(hired); l3.appendChild(document.createTextNode(" Hired")); r2.appendChild(l3);
    var l4 = el("label", null, "Bonus paid on"); var paid = el("input"); paid.type = "date"; paid.value = row ? (row.bonus_paid_at || "") : ""; l4.appendChild(paid); r2.appendChild(l4);
    form.appendChild(r2);
    var l5 = el("label", null, "Notes"); var nt = el("textarea"); nt.style.minHeight = "40px"; nt.value = row ? (row.notes || "") : ""; l5.appendChild(nt); form.appendChild(l5);
    var btns = el("div", "row");
    var btn = el("button", "btn small", row ? "Save referral" : "Record referral"); btn.type = "submit"; btns.appendChild(btn);
    var st = el("span", "saving"); btns.appendChild(st);
    if (row) { var del = el("button", "link", "Remove"); del.type = "button"; del.addEventListener("click", async function () { if (!confirm("Remove the referral record?")) return; var r = await sb.from("referrals").delete().eq("id", row.id); if (r.error) { notice("Could not remove: " + errText(r.error)); return; } renderReferral(a, null, null); }); btns.appendChild(del); }
    form.appendChild(btns);
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      if (paid.value && !hired.checked) { st.textContent = "Tick Hired before recording a bonus payment."; return; }
      btn.disabled = true; st.textContent = "Saving…";
      var payload = { application_id: a.id, referrer_name: name.value.trim(), referrer_employee: emp.value.trim() || null, hired: hired.checked, bonus_paid_at: paid.value || null, notes: nt.value.trim() || null };
      var r = row ? await sb.from("referrals").update(payload).eq("id", row.id).select().single() : await sb.from("referrals").insert(payload).select().single();
      btn.disabled = false;
      if (r.error) { st.textContent = ""; notice("Could not save the referral: " + errText(r.error)); return; }
      row = r.data; btn.textContent = "Save referral"; st.textContent = "Saved";
      if (!form.querySelector("button.link")) { var del2 = el("button", "link", "Remove"); del2.type = "button"; del2.addEventListener("click", async function () { if (!confirm("Remove the referral record?")) return; var rr = await sb.from("referrals").delete().eq("id", row.id); if (rr.error) { notice("Could not remove: " + errText(rr.error)); return; } renderReferral(a, null, null); }); btns.appendChild(del2); }
    });
    sec.appendChild(form);
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
      var label = meta ? (a.language === "es" ? firstLang(meta.text) : meta.text) : (MANUAL_ANSWER_LABELS[q] || "Question " + q);
      label = label.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(); if (label.length > 140) label = label.slice(0, 137) + "…";
      var box = el("div"); box.appendChild(el("div", "q", label)); box.appendChild(el("div", "a", txt)); wrap.appendChild(box); n++;
    });
    if (!n) wrap.appendChild(el("div", "hint", "No answers to show."));
    sec.appendChild(wrap);
  }

  // ---------- Export ----------
  function csvCell(v) { v = v == null ? "" : String(v); return /[",\n\r]/.test(v) ? "\"" + v.replace(/"/g, "\"\"") + "\"" : v; }
  function downloadCsv(name, head, rows) {
    var lines = [head.map(csvCell).join(",")];
    rows.forEach(function (r) { lines.push(r.map(csvCell).join(",")); });
    var blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var link = el("a"); link.href = url; link.download = name + "-" + ymd(new Date()) + ".csv";
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function exportCsv() {
    var rows = sortRows(applyFilters());
    var head = ["Name", "Email", "Phone", "City", "State", "Applied", "Form", "Origin", "Entered by", "Location", "Position", "Matched opening", "Heard from", "Referred by", "Can start", "Status", "In stage since", "Sent to", "Resume", "Files"];
    if (staff) head = head.concat(["Tags", "Notes", "Jotform link"]);
    var lines = [head.join(",")];
    rows.forEach(function (a) {
      var cells = [a.name, a.email, a.phone, a.city, a.state, a.dateKey, a.form, a.origin, a.enteredBy ? (profileNames[a.enteredBy] || "removed user") : "", a.location, a.positionText, a.positionTitle, a.source + (a.sourceDetail ? " (" + a.sourceDetail + ")" : ""), a.referredBy, a.availableStart,
        stageName(a.stageId), a.stageSince ? ymd(a.stageSince) : "", a.assignedTo, a.files.some(function (f) { return f.kind === "resume"; }) ? "yes" : "no", a.files.map(fileLabel).join("; ")];
      if (staff) cells = cells.concat([a.tags.join("; "), a.notes, a.jotformUrl]);
      lines.push(cells.map(csvCell).join(","));
    });
    var blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var link = el("a"); link.href = url; link.download = "rexius-applicants-" + ymd(new Date()) + ".csv";
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---------- Manual entry (staff): a paper application typed in, with its scan ----------
  // One applications row (origin = manual, no Jotform ids; the trigger stamps entered_by/entered_at
  // and creates the status row), then each file goes to manual/<application id>/<name> in the
  // bucket with an application_files row of kind scan or resume. Nothing from the scan is read
  // into a column; it is stored as an image only.
  var OTHER_POSITION = "__other__";
  function openAddModal() {
    var f = $("addForm"); f.reset();
    $("mState").value = "OR"; $("mReceived").value = ymd(new Date()); $("mReceived").max = ymd(new Date());
    $("addError").textContent = ""; $("mEmailDup").textContent = ""; $("mPhoneDup").textContent = "";
    fillPositionOptions();
    $("addModal").hidden = false;
    $("mName").focus();
  }
  function closeAddModal() { $("addModal").hidden = true; }
  function fillPositionOptions() {
    var loc = $("mLocation").value, sel = $("mPosition"), prev = sel.value; sel.innerHTML = "";
    var o0 = el("option", null, "Not given"); o0.value = ""; sel.appendChild(o0);
    var open = Object.keys(positionById).map(function (id) { return positionById[id]; })
      .filter(function (p) { return p.status === "open" && p.location === loc; })
      .sort(function (a, b) { return a.title.localeCompare(b.title); });
    open.forEach(function (p) { var o = el("option", null, p.title); o.value = p.id; sel.appendChild(o); });
    var oo = el("option", null, open.length ? "Other / not listed (type it)" : "Type the position"); oo.value = OTHER_POSITION; sel.appendChild(oo);
    sel.value = prev && sel.querySelector("option[value=\"" + prev + "\"]") ? prev : "";
    togglePositionOther();
  }
  function togglePositionOther() { var other = $("mPosition").value === OTHER_POSITION; $("mPositionOtherWrap").hidden = !other; if (!other) $("mPositionOther").value = ""; }
  function dupHint(elId, key) {
    var hits = key ? apps.filter(function (a) { return a.dupKeys && a.dupKeys.indexOf(key) >= 0; }).sort(function (x, y) { return y.when - x.when; }) : [];
    $(elId).textContent = hits.length ? "Already applied: " + hits.slice(0, 3).map(function (a) { return a.name + ", " + fmtDate(a.when); }).join("; ") + (hits.length > 3 ? " and " + (hits.length - 3) + " more" : "") : "";
  }
  function dateAtNoon(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0) : null; }

  async function saveManualApplication() {
    var errBox = $("addError"); errBox.textContent = "";
    var name = $("mName").value.trim();
    if (!name) { errBox.textContent = "The applicant's name is required."; $("mName").focus(); return; }
    var received = $("mReceived").value, today = ymd(new Date());
    if (!received) { errBox.textContent = "Enter the date the application was received."; return; }
    if (received > today) { errBox.textContent = "The received date cannot be in the future."; return; }
    var posSel = $("mPosition").value, positionId = null, positionText = null;
    if (posSel === OTHER_POSITION) { positionText = $("mPositionOther").value.trim() || null; }
    else if (posSel) { positionId = posSel; positionText = positionById[posSel] ? positionById[posSel].title : null; }
    var source = $("mSource").value || null;
    var email = $("mEmail").value.trim() || null, phone = $("mPhone").value.trim() || null;
    var notes = $("mNotes").value.trim();
    var scans = Array.prototype.slice.call($("mScan").files || []);
    var resume = ($("mResume").files || [])[0] || null;
    var files = scans.map(function (f) { return { file: f, kind: "scan" }; });
    if (resume) files.push({ file: resume, kind: "resume" });
    var tooBig = files.filter(function (x) { return x.file.size > 25 * 1024 * 1024; });
    if (tooBig.length) { errBox.textContent = "Each file must be under 25 MB: " + tooBig.map(function (x) { return x.file.name; }).join(", "); return; }

    var row = {
      origin: "manual", submitted_at: (received === today ? new Date() : dateAtNoon(received)).toISOString(),
      name: name, email: email, email_norm: normalizeEmail(email), phone: phone, phone_norm: normalizePhone(phone),
      city: $("mCity").value.trim() || null, state: $("mState").value.trim().toUpperCase() || null,
      location: $("mLocation").value, position_text: positionText, position_id: positionId,
      source: source, source_detail: source === "Other" ? ($("mSourceDetail").value.trim() || null) : null,
      referred_by: $("mReferredBy").value.trim() || null, available_start: $("mStart").value || null,
      language: $("mLanguage").value, has_resume: false,
      answers: notes ? { manual_notes: notes } : {}
    };
    var btn = $("addSave"); btn.disabled = true; btn.textContent = "Saving…";
    var ins = await sb.from("applications").insert(row).select("id").single();
    if (ins.error) { btn.disabled = false; btn.textContent = "Save application"; errBox.textContent = "Could not save: " + errText(ins.error); return; }
    var id = ins.data.id, failed = [], hasResume = false, used = {};
    for (var i = 0; i < files.length; i++) {
      var x = files[i];
      var base = storageSafeName(x.file.name, 0), n = used[base] || 0; used[base] = n + 1;
      var path = "manual/" + id + "/" + storageSafeName(x.file.name, n);
      btn.textContent = "Uploading " + (i + 1) + " of " + files.length + "…";
      var up = await sb.storage.from(BUCKET).upload(path, x.file, { contentType: x.file.type || "application/octet-stream", upsert: false });
      if (up.error) { failed.push(x.file.name + " (" + errText(up.error) + ")"); continue; }
      var fr = await sb.from("application_files").insert({ application_id: id, storage_path: path, original_name: x.file.name, kind: x.kind, content_type: x.file.type || null, size_bytes: x.file.size });
      if (fr.error) { failed.push(x.file.name + " (" + errText(fr.error) + ")"); continue; }
      if (x.kind === "resume") hasResume = true;
    }
    if (hasResume) { var upd = await sb.from("applications").update({ has_resume: true }).eq("id", id); if (upd.error) failed.push("resume flag (" + errText(upd.error) + ")"); }
    btn.disabled = false; btn.textContent = "Save application";
    closeAddModal();
    if (failed.length) notice("Saved " + name + ", but could not attach: " + failed.join("; ") + ". Open the application and try again later, or keep the paper copy.");
    await loadApps();
    if (appById[id]) openDrawer(id);
  }

  // ---------- Wiring ----------
  $("addBtn").addEventListener("click", openAddModal);
  $("addClose").addEventListener("click", closeAddModal);
  $("addCancel").addEventListener("click", closeAddModal);
  $("addModal").addEventListener("click", function (e) { if (e.target === $("addModal")) closeAddModal(); });
  $("addForm").addEventListener("submit", function (e) { e.preventDefault(); saveManualApplication(); });
  $("mLocation").addEventListener("change", fillPositionOptions);
  $("mPosition").addEventListener("change", togglePositionOther);
  $("mSource").addEventListener("change", function () { $("mSourceDetailWrap").hidden = this.value !== "Other"; });
  $("mEmail").addEventListener("input", function () { var k = normalizeEmail(this.value); dupHint("mEmailDup", k ? "e:" + k : null); });
  $("mPhone").addEventListener("input", function () { var k = normalizePhone(this.value); dupHint("mPhoneDup", k ? "p:" + k : null); });
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
  document.addEventListener("keydown", function (e) { if (e.key !== "Escape") return; if (!$("addModal").hidden) closeAddModal(); else if (!$("drawer").hidden) closeDrawer(); });
  $("refreshBtn").addEventListener("click", loadApps);
  $("exportBtn").addEventListener("click", exportCsv);
  setInterval(updateMeta, 60000);
  window.addEventListener("hashchange", route);
  registerPage("applications", {
    show: function () { setHeader("Rexius applicants", appsMeta()); },
    hide: function () {}
  });

  // ---------- Shared API for the page scripts (positions.js, documents.js, reports.js) ----------
  window.RR = {
    sb: sb, $: $, el: el, BUCKET: BUCKET, SIGNED_URL_SECONDS: SIGNED_URL_SECONDS,
    fmtDate: fmtDate, fmtDay: fmtDay, fmtDateTime: fmtDateTime, ymd: ymd, relTime: relTime, errText: errText, fileName: fileName,
    notice: notice, clearNotice: clearNotice, downloadCsv: downloadCsv, csvCell: csvCell,
    registerPage: registerPage, go: go, setHeader: setHeader, showDrawer: showDrawer, closeDrawer: closeDrawer, openApplicant: openApplicant,
    section: section, kv: kv, stageColor: stageColor, stageName: stageName, positionSelect: positionSelect,
    state: function () { return { session: session, profile: profile, role: role, staff: staff, stages: stages, stageById: stageById, forms: forms, formById: formById, positions: positions, positionById: positionById, profileNames: profileNames, apps: apps, appById: appById, lastLoaded: lastLoaded }; },
    // Re-read positions (after an edit on the Positions page) and refresh the applications' matched titles.
    reloadPositions: async function () {
      var r = await sb.from("positions").select("id, title, location, department, hiring_manager, pay_min, pay_max, pay_unit, status, opened_at, closed_at, jotform_option_label, filled_by_application_id, description_doc_id, created_at, updated_at").order("location").order("title");
      if (r.error) { notice("Could not reload positions: " + errText(r.error)); return positions; }
      positions = r.data || []; positionById = {}; positions.forEach(function (p) { positionById[p.id] = p; });
      apps.forEach(function (a) { var p = positionById[a.positionId]; a.positionTitle = p ? p.title : ""; });
      return positions;
    },
    reloadApps: loadApps
  };

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
