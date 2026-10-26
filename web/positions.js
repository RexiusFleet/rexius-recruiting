/* Positions page (Phase 7). Lists and edits recruiting.positions, shows applicants per position
 * and a funnel, flags drift between open positions and the English form's dropdowns, manages
 * position aliases (so applications match), and, for staff, postings and channel spend.
 * Managers get the same page read-only (no spend; RLS returns nothing for them anyway).
 * Data: positions and applications come from app.js (window.RR); aliases, postings, spend and
 * the document list are loaded here on first show.
 */
(function () {
  "use strict";
  var RR = window.RR; if (!RR) return;
  var sb = RR.sb, $ = RR.$, el = RR.el;

  var ENGLISH_FORM = "260115636145148";
  var CHANNEL_LABEL = { rexius_com: "rexius.com", indeed: "Indeed", craigslist: "Craigslist", google_ads: "Google Ads", referral: "Referral", other: "Other" };
  var STATUS_LABEL = { draft: "Draft", open: "Open", closed: "Closed" };
  var ROLE_LABEL = { manager: "Managers, HR and admins", hr: "HR and admins", admin: "Admins only" };

  var aliases = [], postings = [], spend = [], docs = [];
  var loaded = false, loading = null;
  var openId = null;            // position id in the drawer, "new" for the add form
  var filters = { q: "", status: "open", loc: "" };

  RR.registerPage("positions", {
    show: show,
    hide: function () {},
    appsChanged: function () { renderAll(); if (openId && openId !== "new") openPosition(openId); },
    drawerClosed: function () { openId = null; history.replaceState(null, "", "#/positions"); },
    reset: function () { aliases = []; postings = []; spend = []; docs = []; loaded = false; openId = null; }
  });

  async function show(param) {
    RR.setHeader("Positions", loaded ? metaLine() : "Loading…");
    if (!loaded) await load();
    renderAll();
    if (param === "new") newPosition({});
    else if (param && RR.state().positionById[param]) openPosition(param);
  }

  async function load() {
    if (loading) return loading;
    loading = (async function () {
      var st = RR.state();
      var q = [
        sb.from("position_aliases").select("id, position_id, alias, location, note, created_at").order("alias"),
        sb.from("postings").select("id, position_id, channel, url, utm_source, utm_campaign, posted_at, ended_at, notes").order("posted_at", { ascending: false }),
        sb.from("documents").select("id, title, kind, position_id, min_role").order("title")
      ];
      if (st.staff) q.push(sb.from("channel_spend").select("id, posting_id, period_start, period_end, spend, views, applies, notes").order("period_start", { ascending: false }));
      var r = await Promise.all(q);
      var failed = r.filter(function (x) { return x.error; });
      if (failed.length) RR.notice("Could not load positions data: " + RR.errText(failed[0].error));
      aliases = r[0].data || []; postings = r[1].data || []; docs = r[2].data || []; spend = (r[3] && r[3].data) || [];
      loaded = true;
    })();
    await loading; loading = null;
  }

  // ---------- Derived data ----------
  function funnelStages() { return RR.state().stages.filter(function (s) { return !s.is_terminal || s.is_hired; }); }
  function statsByPosition() {
    var st = RR.state(), m = {};
    var fs = funnelStages();
    st.apps.forEach(function (a) {
      if (!a.positionId) return;
      var s = m[a.positionId];
      if (!s) { s = m[a.positionId] = { count: 0, last: null, funnel: {} }; fs.forEach(function (f) { s.funnel[f.id] = 0; }); }
      s.count++;
      if (!s.last || a.when > s.last) s.last = a.when;
      fs.forEach(function (f) { if (a.furthestSort >= f.sort_order) s.funnel[f.id]++; });
    });
    return m;
  }
  function unmatchedGroups() {
    var m = {}, skipped = 0, total = 0, linked = 0;
    RR.state().apps.forEach(function (a) {
      total++;
      if (a.positionId) { linked++; return; }
      var t = (a.positionText || "").trim();
      if (!t || t.toLowerCase() === "any") { skipped++; return; }
      var k = a.location + "\u0000" + t.toLowerCase();
      var g = m[k] || (m[k] = { text: t, location: a.location || "", count: 0 });
      g.count++;
    });
    var groups = Object.keys(m).map(function (k) { return m[k]; }).sort(function (a, b) { return b.count - a.count || a.text.localeCompare(b.text); });
    return { groups: groups, skipped: skipped, total: total, linked: linked };
  }
  function labelOf(p) { return (p.jotform_option_label || p.title || "").trim(); }
  function driftIssues() {
    var st = RR.state();
    var form = st.forms.filter(function (f) { return f.jotform_form_id === ENGLISH_FORM; })[0];
    if (!form) return [];
    var posMap = (form.field_map && typeof form.field_map.position === "object") ? form.field_map.position : {};
    var issues = [];
    Object.keys(posMap).forEach(function (loc) {
      var q = (form.questions || {})[String(posMap[loc])];
      var labels = Object.keys((q && q.options) || {}).map(function (s) { return s.trim(); }).filter(function (s) { return s && s.toLowerCase() !== "any"; });
      var atLoc = st.positions.filter(function (p) { return p.location === loc; });
      var open = atLoc.filter(function (p) { return p.status === "open"; });
      labels.forEach(function (l) {
        var lk = l.toLowerCase();
        if (open.some(function (p) { return labelOf(p).toLowerCase() === lk; })) return;
        var other = atLoc.filter(function (p) { return labelOf(p).toLowerCase() === lk; })[0];
        issues.push({ kind: other ? "closed-on-form" : "unknown-on-form", location: loc, label: l, position: other || null });
      });
      open.forEach(function (p) {
        var lk = labelOf(p).toLowerCase();
        if (!labels.some(function (l) { return l.toLowerCase() === lk; })) issues.push({ kind: "open-not-on-form", location: loc, label: labelOf(p), position: p });
      });
    });
    return issues;
  }
  function metaLine() {
    var st = RR.state();
    var open = st.positions.filter(function (p) { return p.status === "open"; }).length;
    var u = unmatchedGroups();
    return open + " open of " + st.positions.length + " positions · " + u.linked.toLocaleString() + " of " + u.total.toLocaleString() + " applications linked" + (u.total ? " (" + Math.round(100 * u.linked / u.total) + "%)" : "");
  }
  function fmtPay(p) {
    if (p.pay_min == null && p.pay_max == null) return "";
    var f = function (n) { return n == null ? "" : "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 }); };
    var range = p.pay_min != null && p.pay_max != null && Number(p.pay_min) !== Number(p.pay_max) ? f(p.pay_min) + "–" + f(p.pay_max) : f(p.pay_min != null ? p.pay_min : p.pay_max);
    return range + (p.pay_unit === "hour" ? "/hr" : p.pay_unit === "year" ? "/yr" : "");
  }
  function locations() {
    var m = {};
    RR.state().positions.forEach(function (p) { m[p.location] = true; });
    RR.state().apps.forEach(function (a) { if (a.location) m[a.location] = true; });
    return Object.keys(m).sort();
  }

  // ---------- Rendering ----------
  function renderAll() {
    var st = RR.state();
    RR.setHeader("Positions", metaLine());
    var sel = $("posLoc"), cur = sel.value;
    sel.innerHTML = ""; var o0 = el("option", null, "All locations"); o0.value = ""; sel.appendChild(o0);
    locations().forEach(function (l) { var o = el("option", null, l); o.value = l; sel.appendChild(o); });
    sel.value = cur; filters.loc = sel.value;
    renderDrift();
    renderTable(statsByPosition());
    renderUnmatched();
  }
  function renderDrift() {
    var box = $("posDrift"); box.innerHTML = "";
    var issues = driftIssues();
    if (!issues.length) { box.hidden = true; return; }
    box.hidden = false;
    var st = RR.state();
    box.appendChild(el("h2", null, "Form dropdowns vs open positions"));
    var ul = el("ul");
    issues.forEach(function (i) {
      var li = el("li");
      if (i.kind === "open-not-on-form") {
        li.appendChild(el("b", null, "Open role not on the form: "));
        li.appendChild(document.createTextNode(i.label + " (" + i.location + "). "));
        li.appendChild(linkBtn("Open", function () { openPosition(i.position.id); }));
      } else if (i.kind === "closed-on-form") {
        li.appendChild(el("b", null, "Dropdown still lists a " + i.position.status + " role: "));
        li.appendChild(document.createTextNode(i.label + " (" + i.location + "). "));
        li.appendChild(linkBtn("Open", function () { openPosition(i.position.id); }));
      } else {
        li.appendChild(el("b", null, "Dropdown lists a role with no position: "));
        li.appendChild(document.createTextNode(i.label + " (" + i.location + "). "));
        if (st.staff) li.appendChild(linkBtn("Add position", function () { newPosition({ title: i.label, location: i.location, jotform_option_label: i.label, status: "open" }); }));
      }
      ul.appendChild(li);
    });
    box.appendChild(ul);
    box.appendChild(el("p", "hint", "Compared against the English form's position dropdowns (one per location) as stored in the forms table. Change the dropdown in Jotform, or the position's status or label here."));
  }
  function linkBtn(label, onClick) { var b = el("button", "link", label); b.type = "button"; b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); onClick(); }); return b; }

  function filteredPositions() {
    var q = filters.q.trim().toLowerCase();
    return RR.state().positions.filter(function (p) {
      if (filters.status && p.status !== filters.status) return false;
      if (filters.loc && p.location !== filters.loc) return false;
      if (q && [p.title, p.department, p.hiring_manager, p.jotform_option_label, p.location].join(" ").toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }
  function funnelCells(stats) {
    var wrap = el("div", "funnel");
    var fs = funnelStages();
    var base = stats ? stats.count : 0;
    fs.forEach(function (s) {
      var n = stats ? stats.funnel[s.id] : 0;
      var c = el("span", "fcell" + (n ? "" : " zero"), String(n));
      c.style.background = RR.stageColor(s.id);
      c.title = s.name + ": " + n + (base ? " (" + Math.round(100 * n / base) + "%)" : "");
      wrap.appendChild(c);
    });
    return wrap;
  }
  function renderTable(stats) {
    var rows = filteredPositions();
    var tbody = $("posRows"); tbody.innerHTML = "";
    $("posTable").hidden = !rows.length;
    $("posEmpty").hidden = !!rows.length;
    $("posEmpty").textContent = RR.state().positions.length ? "No positions match. Change the status or location filter." : "No positions yet.";
    rows.sort(function (a, b) { return a.location.localeCompare(b.location) || a.title.localeCompare(b.title); });
    rows.forEach(function (p) {
      var tr = el("tr", p.id === openId ? "selected" : ""); tr.dataset.id = p.id;
      var s = stats[p.id];
      var tdT = el("td", "name"); tdT.appendChild(document.createTextNode(p.title));
      if (p.jotform_option_label && p.jotform_option_label !== p.title) tdT.appendChild(el("small", null, "Form label: " + p.jotform_option_label));
      tr.appendChild(tdT);
      tr.appendChild(el("td", null, p.location));
      var tdS = el("td"); tdS.appendChild(statusPill(p.status)); tr.appendChild(tdS);
      tr.appendChild(el("td", "col-dept", p.department || "—"));
      tr.appendChild(el("td", "col-mgr", p.hiring_manager || "—"));
      tr.appendChild(el("td", "col-pay", fmtPay(p) || "—"));
      var tdO = el("td", "col-open date", p.opened_at ? RR.fmtDay(p.opened_at) : "—"); if (p.closed_at) tdO.title = "Closed " + RR.fmtDay(p.closed_at); tr.appendChild(tdO);
      var tdN = el("td", "num", s ? s.count.toLocaleString() : "0"); if (s && s.last) tdN.title = "Latest " + RR.fmtDate(s.last); tr.appendChild(tdN);
      var tdF = el("td", "col-funnel"); tdF.appendChild(funnelCells(s)); tr.appendChild(tdF);
      tr.addEventListener("click", function () { openPosition(p.id); });
      tbody.appendChild(tr);
    });
  }
  function statusPill(status) { var sp = el("span", "status-pill st-" + status, STATUS_LABEL[status] || status); return sp; }

  function renderUnmatched() {
    var st = RR.state();
    var u = unmatchedGroups();
    var pct = u.total ? Math.round(100 * u.linked / u.total) : 0;
    $("posMatchRate").textContent = u.linked.toLocaleString() + " of " + u.total.toLocaleString() + " applications are linked to a position (" + pct + "%). " + u.skipped.toLocaleString() + " answered “Any” or left it blank and cannot be linked.";
    var tbody = $("unmatchedRows"); tbody.innerHTML = "";
    $("unmatchedTable").hidden = !u.groups.length;
    $("unmatchedHint").textContent = u.groups.length
      ? (st.staff ? "Pick the position each text means and link it: an alias is saved and every application with that text at that location is linked now and in future imports. Or add it as a new position." : "HR links these to positions.")
      : (u.total ? "Every application with a position answer is linked." : "");
    u.groups.forEach(function (g) {
      var tr = el("tr");
      tr.appendChild(el("td", "name", g.text));
      tr.appendChild(el("td", null, g.location || "—"));
      tr.appendChild(el("td", "num", g.count.toLocaleString()));
      var td = el("td", "staff-only");
      if (st.staff) {
        var row = el("div", "row");
        var sel = positionSelectAt(g.location);
        row.appendChild(sel);
        var btn = el("button", "btn small", "Link"); btn.type = "button";
        btn.addEventListener("click", async function () {
          if (!sel.value) { RR.notice("Pick a position first."); return; }
          btn.disabled = true;
          var ok = await addAlias(sel.value, g.text, g.location, "Linked from the unmatched list");
          btn.disabled = false;
          if (ok) await RR.reloadApps();
        });
        row.appendChild(btn);
        row.appendChild(linkBtn("New position", function () { newPosition({ title: g.text, location: g.location, jotform_option_label: g.text, status: "closed" }); }));
        td.appendChild(row);
      }
      tr.appendChild(td);
      tbody.appendChild(tr);
    });
  }
  function positionSelectAt(loc) {
    var sel = el("select");
    var o0 = el("option", null, "Choose a position…"); o0.value = ""; sel.appendChild(o0);
    var ps = RR.state().positions.slice().sort(function (a, b) { return (a.location === loc ? 0 : 1) - (b.location === loc ? 0 : 1) || a.location.localeCompare(b.location) || a.title.localeCompare(b.title); });
    var lastLoc = null, og = null;
    ps.forEach(function (p) {
      if (p.location !== lastLoc) { og = el("optgroup"); og.label = p.location; sel.appendChild(og); lastLoc = p.location; }
      var o = el("option", null, p.title + (p.status !== "open" ? " (" + p.status + ")" : "")); o.value = p.id; og.appendChild(o);
    });
    return sel;
  }

  // ---------- Writes ----------
  async function addAlias(positionId, text, location, note) {
    var r = await sb.from("position_aliases").insert({ position_id: positionId, alias: text, location: location, note: note || null, created_by: RR.state().session.user.id }).select("id, position_id, alias, location, note, created_at").single();
    if (r.error) { RR.notice("Could not add the alias: " + RR.errText(r.error)); return false; }
    aliases.push(r.data);
    return true;
  }
  async function relinkAll() {
    var btn = $("posRelinkBtn"); btn.disabled = true; btn.textContent = "Re-linking…";
    var r = await sb.rpc("relink_applications", { p_all: false });
    btn.disabled = false; btn.textContent = "Re-link applications";
    if (r.error) { RR.notice("Re-link failed: " + RR.errText(r.error)); return; }
    RR.notice((r.data || 0) + " application" + (r.data === 1 ? "" : "s") + " newly linked to a position.");
    if (r.data) await RR.reloadApps();
  }

  // ---------- Drawer: one position ----------
  function newPosition(prefill) {
    openId = "new";
    history.replaceState(null, "", "#/positions/new");
    RR.showDrawer("New position", prefill.location || "", function (body) {
      body.appendChild(positionForm(Object.assign({ status: "open", location: filters.loc || "" }, prefill), true));
    });
  }
  function openPosition(id) {
    var st = RR.state(); var p = st.positionById[id]; if (!p) return;
    openId = id;
    history.replaceState(null, "", "#/positions/" + id);
    document.querySelectorAll("#posRows tr").forEach(function (tr) { tr.classList.toggle("selected", tr.dataset.id === id); });
    var stats = statsByPosition()[id];
    RR.showDrawer(p.title, p.location + " · " + (STATUS_LABEL[p.status] || p.status) + (stats ? " · " + stats.count.toLocaleString() + " applicant" + (stats.count === 1 ? "" : "s") : " · no applicants"), function (body) {
      var sec;
      // Details (edit for staff, read for managers)
      sec = RR.section(body, st.staff ? "Details" : "Position");
      if (st.staff) sec.appendChild(positionForm(p, false));
      else {
        var dl = el("dl", "kv");
        RR.kv(dl, "Department", p.department); RR.kv(dl, "Hiring manager", p.hiring_manager); RR.kv(dl, "Pay range", fmtPay(p));
        RR.kv(dl, "Opened", p.opened_at ? RR.fmtDay(p.opened_at) : ""); RR.kv(dl, "Closed", p.closed_at ? RR.fmtDay(p.closed_at) : "");
        RR.kv(dl, "Form label", p.jotform_option_label);
        var fb = st.appById[p.filled_by_application_id]; if (fb) RR.kv(dl, "Filled by", fb.name);
        var d = docById(p.description_doc_id); if (d) { RR.kv(dl, "Description", d.title); }
        sec.appendChild(dl);
      }
      // Funnel
      sec = RR.section(body, "Funnel (furthest stage reached)");
      sec.appendChild(funnelBars(stats));
      // Aliases
      sec = RR.section(body, "Also matches (aliases)");
      renderAliases(sec, p);
      // Postings and spend
      sec = RR.section(body, "Postings" + (st.staff ? " and spend" : ""));
      renderPostings(sec, p);
      // Applicants
      sec = RR.section(body, "Applicants");
      renderApplicants(sec, p);
    });
  }
  function docById(id) { return docs.filter(function (d) { return d.id === id; })[0] || null; }

  function positionForm(p, isNew) {
    var st = RR.state();
    var form = el("form", "review");
    var f = {};
    function field(label, key, type, attrs) {
      var l = el("label", null, label); var i = el("input"); i.type = type || "text"; i.value = p[key] == null ? "" : String(p[key]);
      if (attrs) Object.keys(attrs).forEach(function (k) { i[k] = attrs[k]; });
      l.appendChild(i); f[key] = i; return l;
    }
    function select(label, key, options, allowBlank) {
      var l = el("label", null, label); var s = el("select");
      if (allowBlank) { var o0 = el("option", null, allowBlank === true ? "—" : allowBlank); o0.value = ""; s.appendChild(o0); }
      options.forEach(function (o) { var opt = el("option", null, o[1]); opt.value = o[0]; if (String(p[key] || "") === o[0]) opt.selected = true; s.appendChild(opt); });
      l.appendChild(s); f[key] = s; return l;
    }
    form.appendChild(field("Title", "title", "text", { required: true, placeholder: "As it will appear on the careers page" }));
    var r1 = el("div", "row");
    var ll = el("label", null, "Location"); var loc = el("input"); loc.type = "text"; loc.required = true; loc.value = p.location || ""; loc.setAttribute("list", "posLocList");
    var dl = el("datalist"); dl.id = "posLocList"; locations().forEach(function (l) { var o = el("option"); o.value = l; dl.appendChild(o); }); ll.appendChild(loc); ll.appendChild(dl); f.location = loc; r1.appendChild(ll);
    r1.appendChild(select("Status", "status", [["draft", "Draft"], ["open", "Open"], ["closed", "Closed"]]));
    form.appendChild(r1);
    var r2 = el("div", "row");
    r2.appendChild(field("Department", "department"));
    r2.appendChild(field("Hiring manager", "hiring_manager"));
    form.appendChild(r2);
    var r3 = el("div", "row");
    r3.appendChild(field("Pay from", "pay_min", "number", { step: "0.01", min: "0" }));
    r3.appendChild(field("Pay to", "pay_max", "number", { step: "0.01", min: "0" }));
    r3.appendChild(select("Per", "pay_unit", [["hour", "Hour"], ["year", "Year"]], true));
    form.appendChild(r3);
    form.appendChild(el("div", "hint", "The advertised range only. An individual's wage is never stored here or anywhere in the app."));
    var r4 = el("div", "row");
    r4.appendChild(field("Opened", "opened_at", "date"));
    r4.appendChild(field("Closed", "closed_at", "date"));
    form.appendChild(r4);
    form.appendChild(field("Label in the form's dropdown", "jotform_option_label", "text", { placeholder: "Exact option text on the English form (blank: use the title)" }));
    if (!isNew) {
      // Filled by: applications linked to this position, furthest stage first.
      var linked = st.apps.filter(function (a) { return a.positionId === p.id; }).sort(function (a, b) { return b.furthestSort - a.furthestSort || b.when - a.when; }).slice(0, 200);
      var lf = el("label", null, "Filled by"); var fb = el("select");
      var o0 = el("option", null, "—"); o0.value = ""; fb.appendChild(o0);
      if (p.filled_by_application_id && !linked.some(function (a) { return a.id === p.filled_by_application_id; })) { var cur = st.appById[p.filled_by_application_id]; var oc = el("option", null, cur ? cur.name : "(application)"); oc.value = p.filled_by_application_id; oc.selected = true; fb.appendChild(oc); }
      linked.forEach(function (a) { var o = el("option", null, a.name + " · " + RR.fmtDate(a.when) + " · " + RR.stageName(a.stageId)); o.value = a.id; if (a.id === p.filled_by_application_id) o.selected = true; fb.appendChild(o); });
      lf.appendChild(fb); f.filled_by_application_id = fb; form.appendChild(lf);
    }
    var ld = el("label", null, "Job description (document library)"); var ds = el("select");
    var od = el("option", null, "—"); od.value = ""; ds.appendChild(od);
    docs.filter(function (d) { return d.kind === "description" || d.id === p.description_doc_id; }).forEach(function (d) { var o = el("option", null, d.title); o.value = d.id; if (d.id === p.description_doc_id) o.selected = true; ds.appendChild(o); });
    ld.appendChild(ds); f.description_doc_id = ds; form.appendChild(ld);
    var btns = el("div", "row");
    var save = el("button", "btn small primary", isNew ? "Add position" : "Save"); save.type = "submit"; btns.appendChild(save);
    var status = el("span", "saving"); btns.appendChild(status);
    if (!isNew) {
      var del = el("button", "link", "Delete position"); del.type = "button";
      del.addEventListener("click", async function () {
        var n = st.apps.filter(function (a) { return a.positionId === p.id; }).length;
        if (!confirm("Delete “" + p.title + "” (" + p.location + ")? " + (n ? n + " applications lose their link (they are not deleted). " : "") + "Postings, spend and aliases for it are removed.")) return;
        var r = await sb.from("positions").delete().eq("id", p.id);
        if (r.error) { RR.notice("Could not delete: " + RR.errText(r.error)); return; }
        RR.closeDrawer(); await afterPositionChange(true);
      });
      btns.appendChild(del);
    }
    form.appendChild(btns);
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      var payload = {
        title: f.title.value.trim(), location: f.location.value.trim(), status: f.status.value,
        department: f.department.value.trim() || null, hiring_manager: f.hiring_manager.value.trim() || null,
        pay_min: f.pay_min.value === "" ? null : Number(f.pay_min.value), pay_max: f.pay_max.value === "" ? null : Number(f.pay_max.value), pay_unit: f.pay_unit.value || null,
        opened_at: f.opened_at.value || null, closed_at: f.closed_at.value || null,
        jotform_option_label: f.jotform_option_label.value.trim() || null,
        description_doc_id: f.description_doc_id.value || null
      };
      if (f.filled_by_application_id) payload.filled_by_application_id = f.filled_by_application_id.value || null;
      if (payload.status === "open" && !payload.opened_at && isNew) payload.opened_at = RR.ymd(new Date());
      if (!isNew && payload.status === "closed" && p.status !== "closed" && !payload.closed_at) payload.closed_at = RR.ymd(new Date());
      save.disabled = true; status.textContent = "Saving…";
      var r = isNew ? await sb.from("positions").insert(payload).select("id").single() : await sb.from("positions").update(payload).eq("id", p.id).select("id").single();
      save.disabled = false;
      if (r.error) { status.textContent = ""; RR.notice("Could not save the position: " + RR.errText(r.error)); return; }
      status.textContent = "Saved";
      var id = r.data.id;
      await afterPositionChange(isNew || payload.jotform_option_label !== p.jotform_option_label || payload.title !== p.title);
      openPosition(id);
    });
    return form;
  }
  // Positions changed: reload them, re-link applications if labels may now match, redraw.
  async function afterPositionChange(relink) {
    await RR.reloadPositions();
    if (relink) { var r = await sb.rpc("relink_applications", { p_all: false }); if (!r.error && r.data) await RR.reloadApps(); }
    renderAll();
  }

  function funnelBars(stats) {
    var wrap = el("div", "bars");
    var fs = funnelStages();
    var base = stats ? stats.count : 0;
    if (!base) { wrap.appendChild(el("div", "hint", "No applications linked to this position.")); return wrap; }
    fs.forEach(function (s) {
      var n = stats.funnel[s.id];
      var row = el("div", "barrow");
      row.appendChild(el("span", "barlabel", s.name));
      var track = el("span", "track"); var fill = el("span", "fill"); fill.style.width = (100 * n / base) + "%"; fill.style.background = RR.stageColor(s.id); track.appendChild(fill); row.appendChild(track);
      row.appendChild(el("span", "barnum", n.toLocaleString() + (s.sort_order > fs[0].sort_order ? " (" + Math.round(100 * n / base) + "%)" : "")));
      wrap.appendChild(row);
    });
    return wrap;
  }

  function renderAliases(sec, p) {
    var st = RR.state();
    sec.querySelectorAll(".log, .review, .hint").forEach(function (n) { n.remove(); });
    var mine = aliases.filter(function (a) { return a.position_id === p.id; });
    if (!mine.length) sec.appendChild(el("div", "hint", "No aliases. Applications match this position when their position text equals the form label or the title at " + p.location + "."));
    else {
      var ul = el("ul", "log");
      mine.forEach(function (a) {
        var li = el("li");
        li.appendChild(document.createTextNode("“" + a.alias + "” at " + a.location));
        if (a.note) li.appendChild(el("span", "meta", " · " + a.note));
        if (st.staff) { var del = linkBtn("Remove", async function () {
          var r = await sb.from("position_aliases").delete().eq("id", a.id);
          if (r.error) { RR.notice("Could not remove the alias: " + RR.errText(r.error)); return; }
          aliases = aliases.filter(function (x) { return x.id !== a.id; }); renderAliases(sec, p);
        }); del.style.marginLeft = "8px"; li.appendChild(del); }
        ul.appendChild(li);
      });
      sec.appendChild(ul);
    }
    if (!st.staff) return;
    var form = el("form", "review");
    var row = el("div", "row");
    var la = el("label", null, "Text applicants chose or typed"); var txt = el("input"); txt.type = "text"; txt.required = true; txt.placeholder = "Landscape Material Blower Truck Crew Member"; la.appendChild(txt); row.appendChild(la);
    var ll = el("label", null, "At location"); var loc = el("input"); loc.type = "text"; loc.required = true; loc.value = p.location; loc.setAttribute("list", "posLocList2");
    var dl = el("datalist"); dl.id = "posLocList2"; locations().forEach(function (l) { var o = el("option"); o.value = l; dl.appendChild(o); }); ll.appendChild(loc); ll.appendChild(dl); row.appendChild(ll);
    form.appendChild(row);
    var btn = el("button", "btn small", "Add alias"); btn.type = "submit"; form.appendChild(btn);
    form.addEventListener("submit", async function (e) {
      e.preventDefault(); btn.disabled = true;
      var ok = await addAlias(p.id, txt.value.trim(), loc.value.trim(), null);
      btn.disabled = false;
      if (ok) { txt.value = ""; renderAliases(sec, p); await RR.reloadApps(); }
    });
    sec.appendChild(form);
  }

  function renderPostings(sec, p) {
    var st = RR.state();
    sec.querySelectorAll(".postings, .hint, .btn").forEach(function (n) { n.remove(); });
    var mine = postings.filter(function (x) { return x.position_id === p.id; });
    var wrap = el("div", "postings");
    if (!mine.length) wrap.appendChild(el("div", "hint", "Not posted anywhere yet."));
    mine.forEach(function (po) { wrap.appendChild(st.staff ? postingForm(p, po, sec) : postingView(po)); });
    sec.appendChild(wrap);
    if (st.staff) {
      var add = el("button", "btn small", "Add posting"); add.type = "button";
      add.addEventListener("click", function () { wrap.querySelectorAll(".hint").forEach(function (n) { n.remove(); }); wrap.appendChild(postingForm(p, null, sec)); });
      sec.appendChild(add);
    }
  }
  function postingView(po) {
    var d = el("div", "posting");
    var head = el("div", null, (CHANNEL_LABEL[po.channel] || po.channel) + " · posted " + RR.fmtDay(po.posted_at) + (po.ended_at ? ", ended " + RR.fmtDay(po.ended_at) : ", still up"));
    d.appendChild(head);
    if (po.url) { var a = el("a", null, po.url); a.href = po.url; a.target = "_blank"; a.rel = "noopener"; d.appendChild(a); }
    if (po.utm_source || po.utm_campaign) d.appendChild(el("div", "meta", "UTM " + [po.utm_source, po.utm_campaign].filter(Boolean).join(" / ")));
    if (po.notes) d.appendChild(el("div", "meta", po.notes));
    return d;
  }
  function postingForm(p, po, sec) {
    var isNew = !po; po = po || { channel: "indeed", posted_at: RR.ymd(new Date()) };
    var form = el("form", "review posting");
    var r1 = el("div", "row");
    var lc = el("label", null, "Channel"); var ch = el("select"); Object.keys(CHANNEL_LABEL).forEach(function (k) { var o = el("option", null, CHANNEL_LABEL[k]); o.value = k; if (po.channel === k) o.selected = true; ch.appendChild(o); }); lc.appendChild(ch); r1.appendChild(lc);
    var lp = el("label", null, "Posted"); var pd = el("input"); pd.type = "date"; pd.required = true; pd.value = po.posted_at || ""; lp.appendChild(pd); r1.appendChild(lp);
    var le = el("label", null, "Ended"); var ed = el("input"); ed.type = "date"; ed.value = po.ended_at || ""; le.appendChild(ed); r1.appendChild(le);
    form.appendChild(r1);
    var lu = el("label", null, "URL"); var url = el("input"); url.type = "url"; url.value = po.url || ""; url.placeholder = "https://www.indeed.com/viewjob?jk=…"; lu.appendChild(url); form.appendChild(lu);
    var r2 = el("div", "row");
    var ls = el("label", null, "utm_source"); var us = el("input"); us.type = "text"; us.value = po.utm_source || ""; ls.appendChild(us); r2.appendChild(ls);
    var lk = el("label", null, "utm_campaign"); var uc = el("input"); uc.type = "text"; uc.value = po.utm_campaign || ""; lk.appendChild(uc); r2.appendChild(lk);
    form.appendChild(r2);
    var ln = el("label", null, "Notes"); var nt = el("input"); nt.type = "text"; nt.value = po.notes || ""; ln.appendChild(nt); form.appendChild(ln);
    var btns = el("div", "row");
    var save = el("button", "btn small", isNew ? "Add posting" : "Save posting"); save.type = "submit"; btns.appendChild(save);
    var status = el("span", "saving"); btns.appendChild(status);
    if (!isNew) btns.appendChild(linkBtn("Remove posting", async function () {
      if (!confirm("Remove this posting and its spend rows?")) return;
      var r = await sb.from("postings").delete().eq("id", po.id);
      if (r.error) { RR.notice("Could not remove the posting: " + RR.errText(r.error)); return; }
      postings = postings.filter(function (x) { return x.id !== po.id; }); spend = spend.filter(function (x) { return x.posting_id !== po.id; });
      renderPostings(sec, p);
    }));
    form.appendChild(btns);
    form.addEventListener("submit", async function (e) {
      e.preventDefault(); save.disabled = true; status.textContent = "Saving…";
      var payload = { position_id: p.id, channel: ch.value, url: url.value.trim() || null, utm_source: us.value.trim() || null, utm_campaign: uc.value.trim() || null, posted_at: pd.value, ended_at: ed.value || null, notes: nt.value.trim() || null };
      var cols = "id, position_id, channel, url, utm_source, utm_campaign, posted_at, ended_at, notes";
      var r = isNew ? await sb.from("postings").insert(payload).select(cols).single() : await sb.from("postings").update(payload).eq("id", po.id).select(cols).single();
      save.disabled = false;
      if (r.error) { status.textContent = ""; RR.notice("Could not save the posting: " + RR.errText(r.error)); return; }
      if (isNew) postings.unshift(r.data); else { var i = postings.findIndex(function (x) { return x.id === po.id; }); if (i >= 0) postings[i] = r.data; }
      renderPostings(sec, p);
    });
    if (isNew) return form;
    var wrap = el("div", "posting-wrap"); wrap.appendChild(form); wrap.appendChild(spendBlock(po));
    return wrap;
  }
  function spendBlock(po) {
    var box = el("div", "spend");
    box.appendChild(el("div", "q", "Spend per period (from the channel's own reporting)"));
    var rows = spend.filter(function (s) { return s.posting_id === po.id; }).sort(function (a, b) { return b.period_start.localeCompare(a.period_start); });
    var tbl = el("table", "mini");
    var thead = el("thead"); var trh = el("tr"); ["Period", "Spend", "Views", "Applies", ""].forEach(function (h) { trh.appendChild(el("th", null, h)); }); thead.appendChild(trh); tbl.appendChild(thead);
    var tbody = el("tbody");
    if (!rows.length) { var tr0 = el("tr"); var td0 = el("td", "hint", "No spend entered."); td0.colSpan = 5; tr0.appendChild(td0); tbody.appendChild(tr0); }
    rows.forEach(function (s) {
      var tr = el("tr");
      tr.appendChild(el("td", null, RR.fmtDay(s.period_start) + " – " + RR.fmtDay(s.period_end)));
      tr.appendChild(el("td", "num", "$" + Number(s.spend).toLocaleString(undefined, { minimumFractionDigits: 2 })));
      tr.appendChild(el("td", "num", s.views == null ? "—" : Number(s.views).toLocaleString()));
      tr.appendChild(el("td", "num", s.applies == null ? "—" : Number(s.applies).toLocaleString()));
      var td = el("td"); td.appendChild(linkBtn("Remove", async function () {
        var r = await sb.from("channel_spend").delete().eq("id", s.id);
        if (r.error) { RR.notice("Could not remove: " + RR.errText(r.error)); return; }
        spend = spend.filter(function (x) { return x.id !== s.id; }); box.replaceWith(spendBlock(po));
      })); tr.appendChild(td);
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody); box.appendChild(tbl);
    // Add a period: defaults to last month.
    var now = new Date(); var first = new Date(now.getFullYear(), now.getMonth() - 1, 1); var last = new Date(now.getFullYear(), now.getMonth(), 0);
    var row = el("div", "row spend-add");
    var ps = el("input"); ps.type = "date"; ps.value = RR.ymd(first); ps.title = "Period start"; ps.setAttribute("aria-label", "Period start");
    var pe = el("input"); pe.type = "date"; pe.value = RR.ymd(last); pe.title = "Period end"; pe.setAttribute("aria-label", "Period end");
    var sp = el("input"); sp.type = "number"; sp.step = "0.01"; sp.min = "0"; sp.placeholder = "Spend $"; sp.setAttribute("aria-label", "Spend");
    var vw = el("input"); vw.type = "number"; vw.min = "0"; vw.placeholder = "Views"; vw.setAttribute("aria-label", "Views");
    var ap = el("input"); ap.type = "number"; ap.min = "0"; ap.placeholder = "Applies"; ap.setAttribute("aria-label", "Applies");
    var btn = el("button", "btn small", "Add"); btn.type = "button";
    btn.addEventListener("click", async function () {
      if (!ps.value || !pe.value || sp.value === "") { RR.notice("Enter the period and the spend."); return; }
      btn.disabled = true;
      var payload = { posting_id: po.id, period_start: ps.value, period_end: pe.value, spend: Number(sp.value), views: vw.value === "" ? null : Number(vw.value), applies: ap.value === "" ? null : Number(ap.value) };
      var r = await sb.from("channel_spend").insert(payload).select("id, posting_id, period_start, period_end, spend, views, applies, notes").single();
      btn.disabled = false;
      if (r.error) { RR.notice("Could not add spend: " + RR.errText(r.error)); return; }
      spend.push(r.data); box.replaceWith(spendBlock(po));
    });
    [ps, pe, sp, vw, ap, btn].forEach(function (x) { row.appendChild(x); });
    box.appendChild(row);
    return box;
  }

  function renderApplicants(sec, p) {
    var st = RR.state();
    var mine = st.apps.filter(function (a) { return a.positionId === p.id; }).sort(function (a, b) { return b.when - a.when; });
    if (!mine.length) { sec.appendChild(el("div", "hint", "None linked.")); return; }
    var ul = el("ul", "log");
    var LIMIT = 40;
    mine.slice(0, LIMIT).forEach(function (a) {
      var li = el("li");
      var link = el("a", null, a.name); link.href = "#/applications"; link.addEventListener("click", function (e) { e.preventDefault(); RR.openApplicant(a.id); });
      li.appendChild(link);
      li.appendChild(el("span", "meta", " · " + RR.fmtDate(a.when) + " · " + RR.stageName(a.stageId) + (a.source ? " · " + a.source : "")));
      ul.appendChild(li);
    });
    sec.appendChild(ul);
    if (mine.length > LIMIT) sec.appendChild(el("div", "hint", (mine.length - LIMIT).toLocaleString() + " more. Filter the Applications page by position to see them all."));
  }

  // ---------- Wiring ----------
  $("posQ").addEventListener("input", function () { filters.q = this.value; renderTable(statsByPosition()); });
  $("posStatus").addEventListener("change", function () { filters.status = this.value; renderTable(statsByPosition()); });
  $("posLoc").addEventListener("change", function () { filters.loc = this.value; renderTable(statsByPosition()); });
  $("posAddBtn").addEventListener("click", function () { newPosition({}); });
  $("posRelinkBtn").addEventListener("click", relinkAll);
})();
