/* Positions page (Phase 7). Lists and edits recruiting.positions, shows applicants per position
 * and a funnel, flags drift between open positions and the English form's dropdowns, manages
 * position aliases (so applications match), and, for staff, postings and channel spend.
 * A position is the role, kept for good: each period it was open is an opening, and each change
 * of the advertised range is logged in its pay history (both written by database triggers).
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
    drawerClosed: function () { openId = null; stopMarketPoll(); stopNationalPoll(); history.replaceState(null, "", "#/positions"); },
    reset: function () { aliases = []; postings = []; spend = []; docs = []; loaded = false; openId = null; stopMarketPoll(); stopNationalPoll(); }
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
  // CAS applications keep their free-text position as entered (the CAS form has no dropdown
  // and the handful of CAS roles are not tracked as positions), so they are never "unmatched".
  var FREE_TEXT_LOCATION = "CAS";
  function unmatchedGroups() {
    var m = {}, skipped = 0, total = 0, linked = 0, freeText = 0;
    RR.state().apps.forEach(function (a) {
      total++;
      if (a.positionId) { linked++; return; }
      if (a.location === FREE_TEXT_LOCATION) { freeText++; return; }
      var t = (a.positionText || "").trim();
      if (!t || t.toLowerCase() === "any") { skipped++; return; }
      var k = a.location + "\u0000" + t.toLowerCase();
      var g = m[k] || (m[k] = { text: t, location: a.location || "", count: 0 });
      g.count++;
    });
    var groups = Object.keys(m).map(function (k) { return m[k]; }).sort(function (a, b) { return b.count - a.count || a.text.localeCompare(b.text); });
    return { groups: groups, skipped: skipped, total: total, linked: linked, freeText: freeText };
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
      var lo = p.lastOpening;
      var tdO = el("td", "col-open date", lo ? RR.fmtDay(lo.opened_at) : "—");
      if (lo) tdO.title = (lo.closed_at ? "Closed " + RR.fmtDay(lo.closed_at) : "Open now") + (p.openings.length > 1 ? " · " + p.openings.length + " openings" : "");
      tr.appendChild(tdO);
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
    $("posMatchRate").textContent = u.linked.toLocaleString() + " of " + u.total.toLocaleString() + " applications are linked to a position (" + pct + "%). " + u.skipped.toLocaleString() + " answered “Any” or left it blank and cannot be linked." + (u.freeText ? " " + u.freeText.toLocaleString() + " CAS application" + (u.freeText === 1 ? " keeps" : "s keep") + " the position as typed." : "");
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
        RR.kv(dl, "Form label", p.jotform_option_label);
        var d = docById(p.description_doc_id); if (d) { RR.kv(dl, "Description", d.title); }
        sec.appendChild(dl);
      }
      // Openings and pay history: the position's record across seasons
      sec = RR.section(body, "Openings");
      renderOpenings(sec, p);
      sec = RR.section(body, "Pay history");
      renderPayHistory(sec, p);
      // Funnel
      sec = RR.section(body, "Funnel (furthest stage reached)");
      sec.appendChild(funnelBars(stats));
      // Aliases
      sec = RR.section(body, "Also matches (aliases)");
      renderAliases(sec, p);
      // Postings and spend
      sec = RR.section(body, "Postings" + (st.staff ? " and spend" : ""));
      renderPostings(sec, p);
      // Market check (Phase 9a)
      sec = RR.section(body, "Market check");
      renderMarket(sec, p);
      // National market check with cost-of-living adjustment
      sec = RR.section(body, "National market check");
      renderNational(sec, p);
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
    form.appendChild(el("div", "hint", "Open starts an opening and Closed ends it; the position keeps its applicants, postings, pay and market history from one season to the next. Correct the dates under Openings."));
    var r2 = el("div", "row");
    r2.appendChild(field("Department", "department"));
    r2.appendChild(field("Hiring manager", "hiring_manager"));
    form.appendChild(r2);
    var r3 = el("div", "row");
    r3.appendChild(field("Pay from", "pay_min", "number", { step: "0.01", min: "0" }));
    r3.appendChild(field("Pay to", "pay_max", "number", { step: "0.01", min: "0" }));
    r3.appendChild(select("Per", "pay_unit", [["hour", "Hour"], ["year", "Year"]], true));
    form.appendChild(r3);
    form.appendChild(el("div", "hint", "The advertised range only. An individual's wage is never stored here or anywhere in the app. Every change is kept in the pay history."));
    // Why the range changed: shown once a pay field differs from what is saved, and written to
    // the pay history row the database adds for this save.
    var payNote = field("Why the pay changed (optional)", "pay_note", "text", { placeholder: "For example: raised to fill spring crews" });
    payNote.hidden = true; form.appendChild(payNote);
    function payOf(src) { return [src.pay_min == null || src.pay_min === "" ? null : Number(src.pay_min), src.pay_max == null || src.pay_max === "" ? null : Number(src.pay_max), src.pay_unit || null].join("|"); }
    var savedPay = payOf(p);
    function currentPay() { return payOf({ pay_min: f.pay_min.value, pay_max: f.pay_max.value, pay_unit: f.pay_unit.value }); }
    [f.pay_min, f.pay_max, f.pay_unit].forEach(function (i) { i.addEventListener(i.tagName === "SELECT" ? "change" : "input", function () { payNote.hidden = currentPay() === savedPay; }); });
    form.appendChild(field("Label in the form's dropdown", "jotform_option_label", "text", { placeholder: "Exact option text on the English form (blank: use the title)" }));
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
        if (!confirm("Delete “" + p.title + "” (" + p.location + ") for good? " + (n ? n + " applications lose their link (they are not deleted). " : "") +
          "Its openings, pay history, market and national checks, postings, spend and aliases are deleted with it.\n\nTo take it off the list until next season, set it to Closed instead.")) return;
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
        jotform_option_label: f.jotform_option_label.value.trim() || null,
        description_doc_id: f.description_doc_id.value || null
      };
      var note = currentPay() !== savedPay ? f.pay_note.value.trim() : "";
      save.disabled = true; status.textContent = "Saving…";
      var r = isNew ? await sb.from("positions").insert(payload).select("id").single() : await sb.from("positions").update(payload).eq("id", p.id).select("id").single();
      save.disabled = false;
      if (r.error) { status.textContent = ""; RR.notice("Could not save the position: " + RR.errText(r.error)); return; }
      status.textContent = "Saved";
      var id = r.data.id;
      if (note) {
        var h = await sb.from("position_pay_history").select("id").eq("position_id", id).order("id", { ascending: false }).limit(1);
        var hr = h.data && h.data[0] ? await sb.from("position_pay_history").update({ note: note }).eq("id", h.data[0].id) : h;
        if (hr.error) RR.notice("The position was saved, but the pay note was not: " + RR.errText(hr.error));
      }
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

  // ---------- Openings ----------
  // One row per period the position was open, written by a trigger when the status changes.
  // Applications count towards the opening they were submitted in, up to the day the position
  // next opened, and hires are those applicants who reached Hired (as in report_time_to_fill).
  // Staff can correct the dates and add a note; the current opening is closed by closing the
  // position, and the database refuses overlapping openings.
  function daysBetween(fromYmd, toYmd) {
    var a = /^(\d{4})-(\d{2})-(\d{2})/.exec(fromYmd), b = /^(\d{4})-(\d{2})-(\d{2})/.exec(toYmd);
    return Math.round((Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3])) / 86400000);
  }
  function openingStats(p) {
    var st = RR.state();
    var hired = st.stages.filter(function (s) { return s.is_hired; })[0];
    var asc = p.openings.slice().reverse(), out = {};
    asc.forEach(function (o) { out[o.id] = { applicants: 0, hires: 0 }; });
    st.apps.forEach(function (a) {
      if (a.positionId !== p.id) return;
      for (var i = asc.length - 1; i >= 0; i--) {
        if (a.dateKey >= asc[i].opened_at) { var s = out[asc[i].id]; s.applicants++; if (hired && a.furthestSort >= hired.sort_order) s.hires++; return; }
      }
    });
    return out;
  }
  function renderOpenings(sec, p) {
    var st = RR.state();
    sec.querySelectorAll(".openings").forEach(function (n) { n.remove(); });
    var box = el("div", "openings"); sec.appendChild(box);
    if (!p.openings.length) {
      box.appendChild(el("div", "hint", p.status === "draft" ? "A draft. Setting the status to Open starts its first opening."
        : p.status === "open" ? "No opening recorded." : "Not open since the tracker started recording openings. Setting the status to Open starts one."));
      return;
    }
    var stats = openingStats(p), today = RR.ymd(new Date());
    var tbl = el("table", "mini");
    var thead = el("thead"), trh = el("tr");
    ["Opened", "Closed", "Days", "Applicants", "Hired", ""].forEach(function (h, i) { trh.appendChild(el("th", i >= 2 && i <= 4 ? "num" : null, h)); });
    thead.appendChild(trh); tbl.appendChild(thead);
    var tbody = el("tbody");
    p.openings.forEach(function (o) {
      var tr = el("tr"), s = stats[o.id];
      tr.appendChild(el("td", null, RR.fmtDay(o.opened_at)));
      tr.appendChild(el("td", null, o.closed_at ? RR.fmtDay(o.closed_at) : "Open now"));
      tr.appendChild(el("td", "num", o.closed_at ? String(daysBetween(o.opened_at, o.closed_at)) : daysBetween(o.opened_at, today) + " so far"));
      tr.appendChild(el("td", "num", s.applicants.toLocaleString()));
      tr.appendChild(el("td", "num", s.hires.toLocaleString()));
      var td = el("td");
      if (st.staff) td.appendChild(linkBtn("Edit", function () { editOpening(sec, p, o); }));
      tr.appendChild(td);
      tbody.appendChild(tr);
      if (o.note) { var trn = el("tr"); var tdn = el("td", "meta", o.note); tdn.colSpan = 6; trn.appendChild(tdn); tbody.appendChild(trn); }
    });
    tbl.appendChild(tbody); box.appendChild(tbl);
    box.appendChild(el("div", "hint", "Setting the position to Open starts an opening and Closed ends it. Applicants count towards the opening they applied in, up to the day the position next opened."));
  }
  function editOpening(sec, p, o) {
    sec.querySelectorAll(".opening-edit").forEach(function (n) { n.remove(); });
    var form = el("form", "review opening-edit");
    form.appendChild(el("div", "q", "Correct the opening from " + RR.fmtDay(o.opened_at)));
    var row = el("div", "row");
    var lo = el("label", null, "Opened"); var io = el("input"); io.type = "date"; io.required = true; io.value = o.opened_at; lo.appendChild(io); row.appendChild(lo);
    var lc = el("label", null, "Closed"); var ic = el("input"); ic.type = "date"; ic.value = o.closed_at || "";
    if (!o.closed_at) { ic.disabled = true; ic.title = "Set the position to Closed to end the current opening."; }
    lc.appendChild(ic); row.appendChild(lc);
    form.appendChild(row);
    var ln = el("label", null, "Note"); var inote = el("input"); inote.type = "text"; inote.value = o.note || ""; inote.placeholder = "For example: spring crews, or the Bend contract"; ln.appendChild(inote); form.appendChild(ln);
    var btns = el("div", "row");
    var save = el("button", "btn small primary", "Save"); save.type = "submit"; btns.appendChild(save);
    btns.appendChild(linkBtn("Cancel", function () { form.remove(); }));
    form.appendChild(btns);
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      var patch = { opened_at: io.value, note: inote.value.trim() || null };
      if (o.closed_at) { if (!ic.value) { RR.notice("A past opening needs a closing date."); return; } patch.closed_at = ic.value; }
      save.disabled = true;
      var r = await sb.from("position_openings").update(patch).eq("id", o.id);
      save.disabled = false;
      if (r.error) { RR.notice("Could not save the opening: " + RR.errText(r.error)); return; }
      await RR.reloadPositions(); renderAll();
      if (openId === p.id) openPosition(p.id);
    });
    sec.appendChild(form);
    io.focus();
  }

  // ---------- Pay history ----------
  // An append-only log of the advertised range, written by a trigger on every change of Pay
  // from, Pay to or Per. Only the note saying why can be added or edited.
  async function renderPayHistory(sec, p) {
    var st = RR.state();
    sec.querySelectorAll(".pay-history").forEach(function (n) { n.remove(); });
    var box = el("div", "pay-history"); sec.appendChild(box);
    box.appendChild(el("div", "hint", "Loading…"));
    var r = await sb.from("position_pay_history").select("id, pay_min, pay_max, pay_unit, note, changed_by, changed_at").eq("position_id", p.id).order("id", { ascending: false });
    if (openId !== p.id || !box.isConnected) return;
    box.innerHTML = "";
    if (r.error) { box.appendChild(el("div", "hint", "Could not load the pay history: " + RR.errText(r.error))); return; }
    var rows = r.data || [];
    if (!rows.length) { box.appendChild(el("div", "hint", "No advertised range yet. Every change to the range is recorded here.")); return; }
    var ul = el("ul", "log");
    rows.forEach(function (h, i) {
      var li = el("li"), prev = rows[i + 1];
      li.appendChild(el("b", null, fmtPay(h) || "Range removed"));
      if (prev) li.appendChild(document.createTextNode(" (was " + (fmtPay(prev) || "no range") + ")"));
      var who = h.changed_by ? (st.profileNames[h.changed_by] || "a removed user") : null;
      li.appendChild(el("div", "when", RR.fmtDateTime(new Date(h.changed_at)) + (who ? " · " + who : "")));
      if (h.note) li.appendChild(el("div", null, h.note));
      if (st.staff) li.appendChild(linkBtn(h.note ? "Edit note" : "Add a note", function () { editPayNote(sec, li, p, h); }));
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }
  function editPayNote(sec, li, p, h) {
    var form = el("form", "row");
    var input = el("input"); input.type = "text"; input.value = h.note || ""; input.placeholder = "Why the range changed"; input.setAttribute("aria-label", "Note");
    form.appendChild(input);
    var save = el("button", "btn small", "Save"); save.type = "submit"; form.appendChild(save);
    form.appendChild(linkBtn("Cancel", function () { renderPayHistory(sec, p); }));
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      save.disabled = true;
      var r = await sb.from("position_pay_history").update({ note: input.value.trim() || null }).eq("id", h.id);
      save.disabled = false;
      if (r.error) { RR.notice("Could not save the note: " + RR.errText(r.error)); return; }
      renderPayHistory(sec, p);
    });
    li.querySelectorAll("button.link").forEach(function (b) { b.remove(); });
    li.appendChild(form);
    input.focus();
  }

  // ---------- Market check (Phase 9a) ----------
  // One run = one market_checks row, written by the Edge Function recruiting-market-check:
  // summary and error both null while it runs. The section shows the latest run, the history,
  // and for staff the tracking toggle and the Check now button. The result is a sample from web
  // search results, never a complete count.
  var marketPoll = null;
  var MARKET_COLS = "id, position_id, ran_at, finished_at, trigger, requested_by, summary, pay_ranges, postings, sources, comparison, below_market, input_tokens, output_tokens, searches, model, error";
  var TRIGGER_LABEL = { manual: "Check now", schedule: "scheduled", opened: "opened with tracking on" };
  function stopMarketPoll() { if (marketPoll) { clearTimeout(marketPoll); marketPoll = null; } }
  async function loadMarket(positionId) {
    var r = await sb.from("market_checks").select(MARKET_COLS).eq("position_id", positionId).order("ran_at", { ascending: false }).limit(24);
    if (r.error) { RR.notice("Could not load market checks: " + RR.errText(r.error)); return []; }
    return r.data || [];
  }
  function isRunning(c) { return c.summary == null && c.error == null && (Date.now() - new Date(c.ran_at).getTime()) < 15 * 60 * 1000; }
  function money(n) { return n == null ? "—" : "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
  function unitSuffix(u) { return u === "year" ? "/yr" : "/hr"; }
  function rangeText(lo, hi, unit) {
    if (lo == null && hi == null) return "—";
    return (lo != null && hi != null && Number(lo) !== Number(hi) ? money(lo) + "–" + money(hi) : money(lo != null ? lo : hi)) + unitSuffix(unit);
  }
  function extLink(url, text) { var a = el("a", null, text || url); a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; return a; }

  async function renderMarket(sec, p) {
    var st = RR.state();
    stopMarketPoll();
    sec.querySelectorAll(".market").forEach(function (n) { n.remove(); });
    var box = el("div", "market"); sec.appendChild(box);
    box.appendChild(el("div", "hint", "Loading…"));
    var checks = await loadMarket(p.id);
    if (openId !== p.id) return;
    drawMarket(box, p, checks);
    if (checks.some(isRunning)) scheduleMarketPoll(box, p);
  }
  function scheduleMarketPoll(box, p) {
    stopMarketPoll();
    marketPoll = setTimeout(async function () {
      if (openId !== p.id || !box.isConnected) return;
      var checks = await loadMarket(p.id);
      if (openId !== p.id || !box.isConnected) return;
      drawMarket(box, p, checks);
      if (checks.some(isRunning)) scheduleMarketPoll(box, p);
    }, 4000);
  }
  function drawMarket(box, p, checks) {
    var st = RR.state();
    box.innerHTML = "";
    var latest = checks[0] || null;
    var running = latest && isRunning(latest);
    // Controls (staff): tracking toggle, cadence, Check now.
    if (st.staff) {
      var row = el("div", "row market-controls");
      var lt = el("label", "check"); var cb = el("input"); cb.type = "checkbox"; cb.checked = !!p.market_tracking;
      lt.appendChild(cb); lt.appendChild(document.createTextNode(" Track on a schedule while open")); row.appendChild(lt);
      var sel = el("select"); sel.setAttribute("aria-label", "Cadence");
      [[7, "Weekly"], [30, "Monthly"]].forEach(function (o) { var opt = el("option", null, o[1]); opt.value = String(o[0]); if (Number(p.market_interval_days || 30) === o[0]) opt.selected = true; sel.appendChild(opt); });
      sel.disabled = !cb.checked; row.appendChild(sel);
      var saveTracking = async function () {
        cb.disabled = true; sel.disabled = true;
        var r = await sb.from("positions").update({ market_tracking: cb.checked, market_interval_days: Number(sel.value) }).eq("id", p.id);
        cb.disabled = false; sel.disabled = !cb.checked;
        if (r.error) { RR.notice("Could not save tracking: " + RR.errText(r.error)); cb.checked = !!p.market_tracking; sel.disabled = !cb.checked; return; }
        await RR.reloadPositions();
        var np = RR.state().positionById[p.id]; if (np) { p.market_tracking = np.market_tracking; p.market_interval_days = np.market_interval_days; }
        if (cb.checked && p.status === "open") { // the trigger may have started a run
          setTimeout(async function () { if (openId !== p.id || !box.isConnected) return; var cs = await loadMarket(p.id); drawMarket(box, p, cs); if (cs.some(isRunning)) scheduleMarketPoll(box, p); }, 2500);
        }
      };
      cb.addEventListener("change", saveTracking); sel.addEventListener("change", saveTracking);
      // Search depth: how many web searches one run may use for this position (null = standard).
      var depth = el("select"); depth.setAttribute("aria-label", "Search depth"); depth.title = "Web searches per run. Each costs about a cent plus tokens; a run is about $0.55 at Standard, $0.85 at Deeper, $1.30 at Deepest.";
      [["", "Standard (6 searches)"], ["10", "Deeper (10)"], ["15", "Deepest (15)"]].forEach(function (o) { var opt = el("option", null, o[1]); opt.value = o[0]; depth.appendChild(opt); });
      depth.value = p.market_max_searches == null ? "" : String(p.market_max_searches);
      if (depth.value !== String(p.market_max_searches == null ? "" : p.market_max_searches)) { var oc = el("option", null, "Custom (" + p.market_max_searches + ")"); oc.value = String(p.market_max_searches); oc.selected = true; depth.appendChild(oc); }
      depth.addEventListener("change", async function () {
        depth.disabled = true;
        var v = depth.value === "" ? null : Number(depth.value);
        var r = await sb.from("positions").update({ market_max_searches: v }).eq("id", p.id);
        depth.disabled = false;
        if (r.error) { RR.notice("Could not save the search depth: " + RR.errText(r.error)); depth.value = p.market_max_searches == null ? "" : String(p.market_max_searches); return; }
        p.market_max_searches = v; await RR.reloadPositions();
      });
      row.appendChild(depth);
      var btn = el("button", "btn small", running ? "Running…" : "Check now"); btn.type = "button"; btn.disabled = !!running;
      btn.addEventListener("click", async function () {
        btn.disabled = true; btn.textContent = "Starting…";
        var r = await sb.functions.invoke("recruiting-market-check", { body: { position_id: p.id } });
        var payload = r.data || null;
        if (r.error && r.error.context && typeof r.error.context.json === "function") { try { payload = await r.error.context.json(); } catch (e) { payload = null; } }
        if (r.error && !(payload && payload.status === "running")) {
          RR.notice("Could not start the market check: " + ((payload && payload.error) || RR.errText(r.error)));
          btn.disabled = false; btn.textContent = "Check now"; return;
        }
        var cs = await loadMarket(p.id);
        if (openId !== p.id || !box.isConnected) return;
        drawMarket(box, p, cs);
        if (cs.some(isRunning)) scheduleMarketPoll(box, p);
      });
      row.appendChild(btn);
      box.appendChild(row);
      box.appendChild(el("div", "hint", p.status === "open"
        ? "A scheduled check runs the morning after the last successful one is older than the cadence. A run costs about fifty cents at the standard depth; use Deeper or Deepest for rare titles that run out of searches. The figures below are a sample from web search results, not a complete count."
        : "Scheduled checks only run while the position is open. Check now works on any position; Deeper and Deepest give rare titles more searches."));
    } else if (p.market_tracking) {
      box.appendChild(el("div", "hint", "Tracked " + (Number(p.market_interval_days) === 7 ? "weekly" : "monthly") + " while open."));
    }
    if (!latest) { box.appendChild(el("div", "hint", "No market check yet." + (st.staff ? " Use Check now to run one." : ""))); return; }
    box.appendChild(renderRun(latest, p, true));
    var earlier = checks.slice(1);
    if (earlier.length) {
      var det = el("details", "market-history");
      det.appendChild(el("summary", null, "Earlier runs (" + earlier.length + (checks.length >= 24 ? "+" : "") + ")"));
      earlier.forEach(function (c) {
        var d = el("details", "market-run");
        var sm = el("summary", null, RR.fmtDateTime(new Date(c.ran_at)) + " · " + runOutcome(c));
        d.appendChild(sm); d.appendChild(renderRun(c, p, false));
        det.appendChild(d);
      });
      box.appendChild(det);
    }
  }
  function runOutcome(c) {
    if (isRunning(c)) return "running";
    if (c.error) return "failed";
    if (c.summary == null) return "did not finish";
    var n = (c.pay_ranges || []).length, m = (c.postings || []).length;
    var cmp = c.comparison;
    return m + " posting" + (m === 1 ? "" : "s") + ", " + n + " with pay" + (cmp && cmp.market_low_median != null ? " · others " + rangeText(cmp.market_low_median, cmp.market_high_median, cmp.unit) : "") + (c.below_market ? " · below market" : "");
  }
  function renderRun(c, p, isLatest) {
    var st = RR.state();
    var wrap = el("div", "market-run-body");
    var who = c.requested_by ? (st.profileNames[c.requested_by] || "a removed user") : null;
    var head = (isLatest ? "Latest run: " : "") + RR.fmtDateTime(new Date(c.ran_at)) + " · " + (TRIGGER_LABEL[c.trigger] || c.trigger) + (who ? " by " + who : "");
    wrap.appendChild(el("div", "meta", head));
    if (isRunning(c)) { wrap.appendChild(el("div", "hint", "Running… started " + RR.relTime(new Date(c.ran_at)) + ". This page refreshes on its own; a run takes one to two minutes.")); return wrap; }
    if (c.error) {
      var n = el("div", "notice-inline"); n.appendChild(el("span", "tag", "Failed")); n.appendChild(document.createTextNode(c.error));
      wrap.appendChild(n);
      if (!c.summary) return wrap;
    }
    if (c.summary == null) { wrap.appendChild(el("div", "notice-inline", "The run did not finish (the function was interrupted). Run it again.")); return wrap; }
    if (c.below_market) { var b = el("div", "notice-inline"); b.appendChild(el("span", "tag", "Below market")); b.appendChild(document.createTextNode("The top of the advertised range is below the median low end others advertise.")); wrap.appendChild(b); }
    wrap.appendChild(el("p", "market-summary", c.summary));
    var cmp = c.comparison;
    if (cmp && cmp.market_low_median != null) {
      wrap.appendChild(el("div", "meta", "Others advertise " + rangeText(cmp.market_low_median, cmp.market_high_median, cmp.unit) + " (medians of " + cmp.ranges_compared + " range" + (cmp.ranges_compared === 1 ? "" : "s") + ")" +
        (cmp.position_min != null || cmp.position_max != null ? " · Rexius advertises " + rangeText(cmp.position_min, cmp.position_max, cmp.unit) : " · no Rexius range set")));
    }
    var pr = c.pay_ranges || [];
    if (pr.length) {
      var tbl = el("table", "mini");
      var thead = el("thead"); var trh = el("tr"); ["Employer", "Title", "Pay"].forEach(function (h) { trh.appendChild(el("th", null, h)); }); thead.appendChild(trh); tbl.appendChild(thead);
      var tbody = el("tbody");
      pr.forEach(function (r) {
        var tr = el("tr");
        var td = el("td"); if (r.url) td.appendChild(extLink(r.url, r.employer || "—")); else td.textContent = r.employer || "—"; tr.appendChild(td);
        tr.appendChild(el("td", null, r.title || "—"));
        tr.appendChild(el("td", "num", rangeText(r.min, r.max, r.unit)));
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody); wrap.appendChild(tbl);
    }
    var po = c.postings || [];
    if (po.length) {
      wrap.appendChild(el("div", "q", "Who else is hiring (" + po.length + " found)"));
      var ul = el("ul", "log");
      po.forEach(function (x) {
        var li = el("li");
        var label = (x.employer || "Unknown") + (x.title ? " · " + x.title : "");
        if (x.url) li.appendChild(extLink(x.url, label)); else li.appendChild(document.createTextNode(label));
        var bits = [x.pay_text, x.location, x.posted ? "posted " + RR.fmtDay(x.posted) : null].filter(Boolean);
        if (bits.length) li.appendChild(el("span", "meta", " · " + bits.join(" · ")));
        ul.appendChild(li);
      });
      wrap.appendChild(ul);
    } else wrap.appendChild(el("div", "hint", "No competing postings found in this run."));
    var src = c.sources || [];
    if (src.length) {
      var det = el("details"); det.appendChild(el("summary", "hint", "Sources (" + src.length + " pages the search returned)"));
      var sl = el("ul", "log");
      src.forEach(function (s) { var li = el("li"); li.appendChild(extLink(s.url, s.title || s.url)); if (s.age) li.appendChild(el("span", "meta", " · " + s.age)); sl.appendChild(li); });
      det.appendChild(sl); wrap.appendChild(det);
    }
    var usage = [];
    if (c.searches != null) usage.push(c.searches + " search" + (c.searches === 1 ? "" : "es"));
    if (c.input_tokens != null || c.output_tokens != null) usage.push(Number(c.input_tokens || 0).toLocaleString() + " in / " + Number(c.output_tokens || 0).toLocaleString() + " out tokens");
    if (c.model) usage.push(c.model);
    if (c.finished_at) usage.push(Math.round((new Date(c.finished_at) - new Date(c.ran_at)) / 1000) + " s");
    if (usage.length) wrap.appendChild(el("div", "meta", usage.join(" · ")));
    // Share: a PDF for a hiring manager, or the same report as text for an email.
    var share = el("div", "row market-share");
    var me = st.profile && st.profile.name ? st.profile.name : null;
    var dl = el("button", "btn small", "Download report (PDF)"); dl.type = "button";
    dl.title = "A one-to-three page report of this run, named " + (RR.marketReport ? RR.marketReport.fileName(p, c) : "market-check.pdf") + ", to send to the hiring manager.";
    dl.addEventListener("click", async function () {
      if (!RR.marketReport) { RR.notice("The report module did not load. Reload the page and try again."); return; }
      dl.disabled = true; dl.textContent = "Building…";
      try { await RR.marketReport.download(p, c, me); } catch (e) { RR.notice("Could not build the report: " + RR.errText(e)); }
      dl.disabled = false; dl.textContent = "Download report (PDF)";
    });
    share.appendChild(dl);
    share.appendChild(linkBtn("Copy as text", async function () {
      if (!RR.marketReport) { RR.notice("The report module did not load. Reload the page and try again."); return; }
      var ok = false; try { ok = await RR.marketReport.copyText(p, c, me); } catch (e) { ok = false; }
      RR.notice(ok ? "Report copied. Paste it into an email or message." : "Could not copy; your browser blocked clipboard access.");
    }));
    wrap.appendChild(share);
    return wrap;
  }

  // ---------- National market check (cost-of-living adjusted) ----------
  // One run = one national_checks row written by recruiting-national-check in two passes:
  // pass 1 postings and BLS, pass 2 cost of living and the adjustment. pass < 2 with no error
  // = still running. On demand only; no schedule.
  var nationalPoll = null;
  var NATIONAL_COLS = "id, position_id, ran_at, finished_at, requested_by, pass, summary, pay_samples, bls, cost_of_living, adjusted, comparison, below_market, sources, input_tokens, output_tokens, searches, model, error";
  function stopNationalPoll() { if (nationalPoll) { clearTimeout(nationalPoll); nationalPoll = null; } }
  async function loadNational(positionId) {
    var r = await sb.from("national_checks").select(NATIONAL_COLS).eq("position_id", positionId).order("ran_at", { ascending: false }).limit(12);
    if (r.error) { RR.notice("Could not load national checks: " + RR.errText(r.error)); return []; }
    return r.data || [];
  }
  function isNationalRunning(c) { return c.pass < 2 && c.error == null && (Date.now() - new Date(c.ran_at).getTime()) < 20 * 60 * 1000; }
  async function renderNational(sec, p) {
    stopNationalPoll();
    sec.querySelectorAll(".market").forEach(function (n) { n.remove(); });
    var box = el("div", "market national"); sec.appendChild(box);
    box.appendChild(el("div", "hint", "Loading…"));
    var checks = await loadNational(p.id);
    if (openId !== p.id) return;
    drawNational(box, p, checks);
    if (checks.some(isNationalRunning)) scheduleNationalPoll(box, p);
  }
  function scheduleNationalPoll(box, p) {
    stopNationalPoll();
    nationalPoll = setTimeout(async function () {
      if (openId !== p.id || !box.isConnected) return;
      var checks = await loadNational(p.id);
      if (openId !== p.id || !box.isConnected) return;
      drawNational(box, p, checks);
      if (checks.some(isNationalRunning)) scheduleNationalPoll(box, p);
    }, 5000);
  }
  function drawNational(box, p, checks) {
    var st = RR.state();
    box.innerHTML = "";
    var latest = checks[0] || null, running = latest && isNationalRunning(latest);
    if (st.staff) {
      var row = el("div", "row market-controls");
      var depth = el("select"); depth.setAttribute("aria-label", "National search depth"); depth.title = "Web searches per run across both passes. About $1.50 a run at Standard, $2.50 at Deepest.";
      [["", "Standard (15 searches)"], ["10", "Lighter (10)"], ["20", "Deepest (20)"]].forEach(function (o) { var opt = el("option", null, o[1]); opt.value = o[0]; depth.appendChild(opt); });
      depth.value = p.national_max_searches == null ? "" : String(p.national_max_searches);
      if (depth.value !== String(p.national_max_searches == null ? "" : p.national_max_searches)) { var oc = el("option", null, "Custom (" + p.national_max_searches + ")"); oc.value = String(p.national_max_searches); oc.selected = true; depth.appendChild(oc); }
      depth.addEventListener("change", async function () {
        depth.disabled = true;
        var v = depth.value === "" ? null : Number(depth.value);
        var r = await sb.from("positions").update({ national_max_searches: v }).eq("id", p.id);
        depth.disabled = false;
        if (r.error) { RR.notice("Could not save the search depth: " + RR.errText(r.error)); depth.value = p.national_max_searches == null ? "" : String(p.national_max_searches); return; }
        p.national_max_searches = v; await RR.reloadPositions();
      });
      row.appendChild(depth);
      var btn = el("button", "btn small", running ? "Running…" : "Run national check"); btn.type = "button"; btn.disabled = !!running;
      btn.addEventListener("click", async function () {
        if (!confirm("Run a national market check for “" + p.title + "”? It takes three to six minutes and costs about $1.50 to $2.50 in the Claude Console.")) return;
        btn.disabled = true; btn.textContent = "Starting…";
        var r = await sb.functions.invoke("recruiting-national-check", { body: { position_id: p.id } });
        var payload = r.data || null;
        if (r.error && r.error.context && typeof r.error.context.json === "function") { try { payload = await r.error.context.json(); } catch (e) { payload = null; } }
        if (r.error && !(payload && payload.status === "running")) {
          RR.notice("Could not start the national check: " + ((payload && payload.error) || RR.errText(r.error)));
          btn.disabled = false; btn.textContent = "Run national check"; return;
        }
        var cs = await loadNational(p.id);
        if (openId !== p.id || !box.isConnected) return;
        drawNational(box, p, cs);
        if (cs.some(isNationalRunning)) scheduleNationalPoll(box, p);
      });
      row.appendChild(btn);
      box.appendChild(row);
    }
    box.appendChild(el("div", "hint", "For specialised roles: what the role pays across the United States (postings and the Bureau of Labor Statistics), scaled to the " + p.location + " cost of living. On demand only; a sample from search results, not a complete count."));
    if (!latest) { box.appendChild(el("div", "hint", "No national check yet.")); return; }
    box.appendChild(renderNationalRun(latest, p, true));
    var earlier = checks.slice(1);
    if (earlier.length) {
      var det = el("details", "market-history");
      det.appendChild(el("summary", null, "Earlier runs (" + earlier.length + ")"));
      earlier.forEach(function (c) {
        var d = el("details", "market-run");
        d.appendChild(el("summary", null, RR.fmtDateTime(new Date(c.ran_at)) + " · " + nationalOutcome(c)));
        d.appendChild(renderNationalRun(c, p, false)); det.appendChild(d);
      });
      box.appendChild(det);
    }
  }
  function nationalOutcome(c) {
    if (isNationalRunning(c)) return "running";
    if (c.error) return c.pass >= 1 ? "first pass only" : "failed";
    var cmp = c.comparison;
    return (c.pay_samples || []).length + " postings" + (cmp && cmp.adjusted_low_median != null ? " · adjusted " + rangeText(cmp.adjusted_low_median, cmp.adjusted_high_median, cmp.unit) : "") + (c.below_market ? " · below market" : "");
  }
  function renderNationalRun(c, p, isLatest) {
    var st = RR.state();
    var wrap = el("div", "market-run-body");
    var who = c.requested_by ? (st.profileNames[c.requested_by] || "a removed user") : null;
    wrap.appendChild(el("div", "meta", (isLatest ? "Latest run: " : "") + RR.fmtDateTime(new Date(c.ran_at)) + (who ? " by " + who : "")));
    if (isNationalRunning(c)) { wrap.appendChild(el("div", "hint", (c.pass === 0 ? "Searching postings and BLS figures… " : "Postings found; looking up cost of living… ") + "started " + RR.relTime(new Date(c.ran_at)) + ". This page refreshes on its own; a run takes three to six minutes.")); return wrap; }
    if (c.error) { var n = el("div", "notice-inline"); n.appendChild(el("span", "tag", c.pass >= 1 ? "Incomplete" : "Failed")); n.appendChild(document.createTextNode(c.error)); wrap.appendChild(n); if (c.pass < 1) return wrap; }
    if (c.summary == null) { wrap.appendChild(el("div", "notice-inline", "The run did not finish (the function was interrupted). Run it again.")); return wrap; }
    if (c.below_market) { var b = el("div", "notice-inline"); b.appendChild(el("span", "tag", "Below market")); b.appendChild(document.createTextNode("The top of the advertised range is below the median low end of the cost-of-living-adjusted national postings.")); wrap.appendChild(b); }
    wrap.appendChild(el("p", "market-summary", c.summary));
    var cmp = c.comparison;
    if (cmp && cmp.adjusted_low_median != null) {
      wrap.appendChild(el("div", "meta", "Adjusted to " + p.location + ": " + rangeText(cmp.adjusted_low_median, cmp.adjusted_high_median, cmp.unit) + " (medians of " + cmp.samples_compared + ")" +
        (cmp.raw_low_median != null ? " · as advertised elsewhere " + rangeText(cmp.raw_low_median, cmp.raw_high_median, cmp.unit) : "") +
        (cmp.bls_national_median_adjusted != null ? " · BLS national median adjusted " + money(cmp.bls_national_median_adjusted) + unitSuffix(cmp.unit) : "") +
        (cmp.position_min != null || cmp.position_max != null ? " · Rexius advertises " + rangeText(cmp.position_min, cmp.position_max, cmp.unit) : " · no Rexius range set")));
    }
    if (c.bls) {
      var bl = c.bls;
      var bt = "BLS " + bl.occupation + (bl.soc_code ? " (" + bl.soc_code + ")" : "") + (bl.year ? ", " + bl.year : "") + ": national median " + (bl.national_median != null ? money(bl.national_median) + unitSuffix(bl.unit) : "—") +
        (bl.p25 != null || bl.p75 != null ? ", 25th–75th " + rangeText(bl.p25, bl.p75, bl.unit) : "") + (bl.area_median != null ? "; " + (bl.area_name || "area") + " " + money(bl.area_median) + unitSuffix(bl.unit) : "");
      var bd = el("div", "meta"); if (bl.source_url) bd.appendChild(extLink(bl.source_url, bt)); else bd.textContent = bt; wrap.appendChild(bd);
    }
    var adj = c.adjusted || [];
    if (adj.length) {
      var tbl = el("table", "mini");
      var thead = el("thead"); var trh = el("tr"); ["Employer", "Metro", "Index", "As posted", "Adjusted"].forEach(function (h) { trh.appendChild(el("th", null, h)); }); thead.appendChild(trh); tbl.appendChild(thead);
      var tbody = el("tbody");
      adj.forEach(function (r) {
        var src = (c.pay_samples || []).filter(function (s) { return s.employer === r.employer && s.metro === r.metro; })[0];
        var tr = el("tr");
        var td = el("td"); if (src && src.url) td.appendChild(extLink(src.url, r.employer || "—")); else td.textContent = r.employer || "—"; if (r.title) td.appendChild(el("small", null, r.title)); tr.appendChild(td);
        tr.appendChild(el("td", null, r.metro || "—"));
        tr.appendChild(el("td", "num", r.index == null ? "—" : String(r.index)));
        tr.appendChild(el("td", "num", rangeText(r.min, r.max, r.unit)));
        tr.appendChild(el("td", "num", r.adjusted_min == null ? "—" : rangeText(r.adjusted_min, r.adjusted_max, r.unit)));
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody); wrap.appendChild(tbl);
    } else if ((c.pay_samples || []).length) {
      var ul = el("ul", "log");
      c.pay_samples.forEach(function (s) { var li = el("li"); var label = (s.employer || "Unknown") + (s.title ? " · " + s.title : ""); if (s.url) li.appendChild(extLink(s.url, label)); else li.appendChild(document.createTextNode(label)); li.appendChild(el("span", "meta", " · " + rangeText(s.min, s.max, s.unit) + (s.metro ? " · " + s.metro : ""))); ul.appendChild(li); });
      wrap.appendChild(ul);
    }
    var col = c.cost_of_living;
    if (col) {
      var ct = "Cost of living: " + col.source_name + (col.year ? " " + col.year : "") + " · " + (col.rexius_metro || p.location) + " " + (col.rexius_index == null ? "—" : col.rexius_index) + " (US average 100)" + (col.notes ? " · " + col.notes : "");
      var cd = el("div", "meta"); if (col.source_url) cd.appendChild(extLink(col.source_url, ct)); else cd.textContent = ct; wrap.appendChild(cd);
    }
    var src2 = c.sources || [];
    if (src2.length) {
      var det = el("details"); det.appendChild(el("summary", "hint", "Sources (" + src2.length + " pages the search returned)"));
      var sl = el("ul", "log"); src2.forEach(function (s) { var li = el("li"); li.appendChild(extLink(s.url, s.title || s.url)); if (s.age) li.appendChild(el("span", "meta", " · " + s.age)); sl.appendChild(li); });
      det.appendChild(sl); wrap.appendChild(det);
    }
    var usage = [];
    if (c.searches != null) usage.push(c.searches + " search" + (c.searches === 1 ? "" : "es"));
    if (c.input_tokens != null || c.output_tokens != null) usage.push(Number(c.input_tokens || 0).toLocaleString() + " in / " + Number(c.output_tokens || 0).toLocaleString() + " out tokens");
    if (c.model) usage.push(c.model);
    if (c.finished_at) usage.push(Math.round((new Date(c.finished_at) - new Date(c.ran_at)) / 1000) + " s");
    if (usage.length) wrap.appendChild(el("div", "meta", usage.join(" · ")));
    if (c.pass >= 2 && RR.marketReport && RR.marketReport.downloadNational) {
      var share = el("div", "row market-share");
      var me = st.profile && st.profile.name ? st.profile.name : null;
      var dl = el("button", "btn small", "Download report (PDF)"); dl.type = "button";
      dl.addEventListener("click", async function () {
        dl.disabled = true; dl.textContent = "Building…";
        try { await RR.marketReport.downloadNational(p, c, me); } catch (e) { RR.notice("Could not build the report: " + RR.errText(e)); }
        dl.disabled = false; dl.textContent = "Download report (PDF)";
      });
      share.appendChild(dl);
      share.appendChild(linkBtn("Copy as text", async function () {
        var ok = false; try { ok = await RR.marketReport.copyNationalText(p, c, me); } catch (e) { ok = false; }
        RR.notice(ok ? "Report copied. Paste it into an email or message." : "Could not copy; your browser blocked clipboard access.");
      }));
      wrap.appendChild(share);
    }
    return wrap;
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
