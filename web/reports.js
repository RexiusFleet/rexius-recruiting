/* Reports page (Phase 7). Each report reads one recruiting.report_* view (staff only: the views
 * return no rows to managers, and app.js hides the page from them), renders it as a table with
 * a bar on the column that matters, and exports the table as CSV. Pivots (source x stage,
 * month x location) are done here from the long-format views.
 */
(function () {
  "use strict";
  var RR = window.RR; if (!RR) return;
  var sb = RR.sb, $ = RR.$, el = RR.el;

  var CHANNEL_LABEL = { rexius_com: "rexius.com", indeed: "Indeed", craigslist: "Craigslist", google_ads: "Google Ads", referral: "Referral", other: "Other" };
  var STATUS_LABEL = { draft: "Draft", open: "Open", closed: "Closed" };

  // Column: { key, label, num (right-align, number format), bar (draw a bar relative to the max), fmt(value, row) }
  var REPORTS = [
    { key: "source-stage", title: "Applications by source and stage", view: "report_applications_by_source_stage",
      desc: "Where applicants heard about the job (as answered on the form) against the stage each is in now.",
      build: function (rows) { return pivot(rows, "source", "stage_name", "applications", { allCols: stageNames(false), rowLabel: "Source", totalBar: true, desc: true }); } },
    { key: "time-in-stage", title: "Time in stage", view: "report_time_in_stage", order: "sort_order",
      desc: "How long applications stay in each stage: those that have moved on (average and median days) and those in it now.",
      columns: [
        { key: "stage_name", label: "Stage" },
        { key: "completed_visits", label: "Moved on", num: true },
        { key: "avg_days", label: "Avg days", num: true, bar: true },
        { key: "median_days", label: "Median days", num: true },
        { key: "currently_in_stage", label: "In it now", num: true },
        { key: "avg_days_so_far", label: "Avg days so far", num: true }
      ] },
    { key: "spend", title: "Spend by channel by month", view: "report_spend_by_channel_month",
      desc: "Hand-entered spend per channel, by the month each period starts in. Enter figures on the Positions page under each posting.",
      build: function (rows) { rows.forEach(function (r) { r.channel_label = CHANNEL_LABEL[r.channel] || r.channel; r.month_label = monthLabel(r.month); }); return pivot(rows, "month_label", "channel_label", "spend", { rowLabel: "Month", money: true, totalBar: true, sortRowsBy: "month", desc: true, rowSortKey: function (r) { return r.month; } }); } },
    { key: "funnel-position", title: "Funnel by position", view: "report_position_funnel",
      desc: "How many applications per position reached each stage (someone interviewed and then not selected still counts as interviewed). Rows with no position are applications nothing matched.",
      build: function (rows) { rows.forEach(function (r) { r.pos_label = (r.position_title || "(no matched position)") + " · " + r.location + (r.position_status && r.position_status !== "open" ? " (" + STATUS_LABEL[r.position_status] + ")" : ""); }); return pivot(rows, "pos_label", "stage_name", "applications", { allCols: stageNames(true), rowLabel: "Position", noTotal: true, barCol: "first", sortRowsBy: "first", desc: true }); } },
    { key: "funnel-source", title: "Funnel by source", view: "report_position_funnel",
      desc: "Source quality: of the applicants from each source, how many reached each stage.",
      build: function (rows) { return pivot(rows, "source", "stage_name", "applications", { allCols: stageNames(true), rowLabel: "Source", noTotal: true, barCol: "first", sortRowsBy: "first", desc: true, pct: true }); } },
    { key: "cost", title: "Cost per applicant and per hire by channel", view: "report_cost_by_channel",
      desc: "Total entered spend per channel divided by the applicants whose source maps to that channel, and by the hires among them. Channels with no spend entered show no cost.",
      columns: [
        { key: "channel", label: "Channel", fmt: function (v) { return CHANNEL_LABEL[v] || v; } },
        { key: "spend", label: "Spend", num: true, money: true, bar: true },
        { key: "first_period", label: "From", fmt: function (v) { return v ? RR.fmtDay(v) : ""; } },
        { key: "last_period", label: "To", fmt: function (v) { return v ? RR.fmtDay(v) : ""; } },
        { key: "applicants", label: "Applicants", num: true },
        { key: "hires", label: "Hires", num: true },
        { key: "cost_per_applicant", label: "Per applicant", num: true, money: true },
        { key: "cost_per_hire", label: "Per hire", num: true, money: true },
        { key: "views", label: "Views (entered)", num: true },
        { key: "reported_applies", label: "Applies (entered)", num: true }
      ] },
    { key: "offers", title: "Offer acceptance", view: "report_offer_acceptance",
      desc: "Offers recorded per position and their outcomes. Acceptance rate is accepted over accepted plus declined. No wages are stored.",
      columns: [
        { key: "position_title", label: "Position", fmt: function (v, r) { return (v || "(no position)") + (r.location ? " · " + r.location : ""); } },
        { key: "offers", label: "Offers", num: true, bar: true },
        { key: "accepted", label: "Accepted", num: true },
        { key: "declined", label: "Declined", num: true },
        { key: "withdrawn", label: "Withdrawn", num: true },
        { key: "pending", label: "Pending", num: true },
        { key: "acceptance_pct", label: "Acceptance %", num: true },
        { key: "avg_days_to_respond", label: "Avg days to respond", num: true },
        { key: "last_offer", label: "Last offer", fmt: function (v) { return v ? RR.fmtDay(v) : ""; } }
      ] },
    { key: "time-to-fill", title: "Time to fill per position", view: "report_time_to_fill",
      desc: "Days from opening to the first hire, and days open, per position. Set opened and closed dates on the Positions page.",
      columns: [
        { key: "title", label: "Position", fmt: function (v, r) { return v + " · " + r.location; } },
        { key: "status", label: "Status", fmt: function (v) { return STATUS_LABEL[v] || v; } },
        { key: "opened_at", label: "Opened", fmt: function (v) { return v ? RR.fmtDay(v) : ""; } },
        { key: "closed_at", label: "Closed", fmt: function (v) { return v ? RR.fmtDay(v) : ""; } },
        { key: "applicants", label: "Applicants", num: true },
        { key: "hires", label: "Hires", num: true },
        { key: "days_to_first_hire", label: "Days to first hire", num: true, bar: true },
        { key: "days_open", label: "Days open", num: true },
        { key: "days_open_so_far", label: "Open so far (days)", num: true },
        { key: "filled_by", label: "Filled by" }
      ],
      sort: function (a, b) { return (b.applicants || 0) - (a.applicants || 0); } },
    { key: "seasonality", title: "Seasonality", view: "report_seasonality",
      desc: "Applications per month by location. Spring is the peak; use it to time postings.",
      build: function (rows) { rows.forEach(function (r) { r.month_label = monthLabel(r.month); }); return pivot(rows, "month_label", "location", "applications", { rowLabel: "Month", totalBar: true, rowSortKey: function (r) { return r.month; }, desc: true }); } }
  ];

  var current = null, lastTable = null;

  RR.registerPage("reports", {
    show: show,
    hide: function () {},
    appsChanged: function () { if (current && document.body.dataset.page === "reports") open(current); },
    reset: function () { current = null; lastTable = null; }
  });

  function show(param) {
    RR.setHeader("Reports", "From the report views in the database; staff only.");
    var list = $("reportList"); if (!list.children.length) REPORTS.forEach(function (r) { var b = el("button", "rbtn", r.title); b.type = "button"; b.dataset.key = r.key; b.addEventListener("click", function () { RR.go("#/reports/" + r.key); }); list.appendChild(b); });
    var key = param && REPORTS.some(function (r) { return r.key === param; }) ? param : REPORTS[0].key;
    open(key);
  }
  // Always re-reads the view: the numbers change with every stage change, offer or spend row.
  async function open(key) {
    current = key;
    var rep = REPORTS.filter(function (r) { return r.key === key; })[0];
    document.querySelectorAll("#reportList .rbtn").forEach(function (b) { b.classList.toggle("on", b.dataset.key === key); });
    $("reportTitle").textContent = rep.title; $("reportDesc").textContent = rep.desc;
    $("reportCsv").disabled = true; $("reportNote").textContent = "";
    var box = $("reportTable"); box.innerHTML = ""; box.appendChild(el("div", "skel", "Loading…"));
    var q = sb.from(rep.view).select("*");
    if (rep.order) q = q.order(rep.order);
    var r = await q.limit(10000);
    if (current !== key) return;
    if (r.error) { box.innerHTML = ""; box.appendChild(el("div", "empty", "Could not load the report: " + RR.errText(r.error))); return; }
    var rows = r.data || [];
    var table = rep.build ? rep.build(rows.map(function (x) { return Object.assign({}, x); })) : { columns: rep.columns, rows: rep.sort ? rows.slice().sort(rep.sort) : rows.slice() };
    lastTable = table;
    box.innerHTML = "";
    if (!table.rows.length) { box.appendChild(el("div", "empty", "Nothing to report yet.")); return; }
    box.appendChild(renderTable(table));
    $("reportCsv").disabled = false;
    $("reportNote").textContent = table.note || "";
  }

  // Stage names in pipeline order; funnelOnly leaves out Not selected and Withdrawn.
  function stageNames(funnelOnly) { return RR.state().stages.filter(function (s) { return !funnelOnly || !s.is_terminal || s.is_hired; }).map(function (s) { return s.name; }); }

  // ---------- Pivot: long rows -> one row per rowKey, one column per colKey ----------
  // o.allCols: fixed column list in order (columns with no data still show); otherwise the
  // columns seen, ordered by o.orderCols or alphabetically.
  function pivot(rows, rowKey, colKey, valKey, o) {
    var cols = {}, colOrder = {}, data = {}, rowSort = {};
    rows.forEach(function (r) {
      var ck = r[colKey], rk = r[rowKey];
      cols[ck] = true; if (o.orderCols) colOrder[ck] = r[o.orderCols];
      var d = data[rk] || (data[rk] = { _label: rk, _total: 0 });
      d[ck] = (d[ck] || 0) + Number(r[valKey] || 0);
      d._total += Number(r[valKey] || 0);
      if (o.rowSortKey) rowSort[rk] = o.rowSortKey(r);
    });
    var colKeys = o.allCols ? o.allCols.slice() : Object.keys(cols).sort(function (a, b) { return o.orderCols ? (colOrder[a] - colOrder[b]) : a.localeCompare(b); });
    if (o.allCols) Object.keys(cols).forEach(function (c) { if (colKeys.indexOf(c) < 0) colKeys.push(c); });
    var out = Object.keys(data).map(function (k) { return data[k]; });
    var first = colKeys[0];
    out.sort(function (a, b) {
      var r = 0;
      if (o.rowSortKey) r = String(rowSort[a._label]).localeCompare(String(rowSort[b._label]));
      else if (o.sortRowsBy === "first") r = (a[first] || 0) - (b[first] || 0);
      else r = a._total - b._total;
      if (!r) r = a._label.localeCompare(b._label);
      return o.desc ? -r : r;
    });
    var columns = [{ key: "_label", label: o.rowLabel }];
    colKeys.forEach(function (ck, i) {
      var c = { key: ck, label: ck, num: true, money: !!o.money };
      if (o.barCol === "first" && i === 0) c.bar = true;
      if (o.pct && i > 0) c.fmt = function (v, r) { var base = r[first] || 0; return fmtNum(v, o.money) + (base && v != null ? " (" + Math.round(100 * v / base) + "%)" : ""); };
      columns.push(c);
    });
    if (!o.noTotal) columns.push({ key: "_total", label: "Total", num: true, money: !!o.money, bar: !!o.totalBar });
    return { columns: columns, rows: out };
  }

  // ---------- Table with bars ----------
  function fmtNum(v, money) {
    if (v == null || v === "") return "";
    var n = Number(v); if (isNaN(n)) return String(v);
    return money ? "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  }
  function cellText(c, r) { var v = r[c.key]; if (c.fmt) return c.fmt(v, r); return c.num ? fmtNum(v, c.money) : (v == null ? "" : String(v)); }
  function renderTable(t) {
    var table = el("table", "report-table");
    var thead = el("thead"), trh = el("tr");
    t.columns.forEach(function (c) { trh.appendChild(el("th", c.num ? "num" : "", c.label)); });
    thead.appendChild(trh); table.appendChild(thead);
    var max = {};
    t.columns.forEach(function (c) { if (c.bar) max[c.key] = t.rows.reduce(function (m, r) { return Math.max(m, Number(r[c.key]) || 0); }, 0); });
    var tbody = el("tbody");
    t.rows.forEach(function (r) {
      var tr = el("tr");
      t.columns.forEach(function (c) {
        var td = el("td", c.num ? "num" : "");
        if (c.bar && max[c.key]) {
          var cell = el("div", "barcell");
          var bar = el("span", "bar-in"); bar.style.width = (100 * (Number(r[c.key]) || 0) / max[c.key]) + "%"; cell.appendChild(bar);
          cell.appendChild(el("span", "bar-txt", cellText(c, r))); td.appendChild(cell);
        } else td.textContent = cellText(c, r);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }
  function monthLabel(ymdStr) { var m = /^(\d{4})-(\d{2})/.exec(ymdStr || ""); if (!m) return ymdStr || ""; return new Date(+m[1], +m[2] - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" }); }

  function exportCsv() {
    if (!lastTable || !current) return;
    var rep = REPORTS.filter(function (r) { return r.key === current; })[0];
    var head = lastTable.columns.map(function (c) { return c.label; });
    var rows = lastTable.rows.map(function (r) { return lastTable.columns.map(function (c) { var v = r[c.key]; return c.fmt ? c.fmt(v, r) : (v == null ? "" : v); }); });
    RR.downloadCsv("rexius-report-" + rep.key, head, rows);
  }
  $("reportCsv").addEventListener("click", exportCsv);
})();
