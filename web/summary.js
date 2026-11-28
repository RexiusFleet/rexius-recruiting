/* Phase 9b: applicant summaries and translation in the application drawer.
 *
 * HR and admins get a Summary section near the top of the drawer. Summarize asks the Edge
 * Function recruiting-applicant-summary to have Claude read the application against its
 * position; the run is one applicant_summaries row (finished_at and error both null while it
 * runs), and this section polls it until it is done. A summary lists what the application says
 * that relates to the position, what it does not say, and an English translation of answers
 * written in Spanish. It never scores, ranks or recommends (docs/applicant-summary-rules.md).
 * The same run compares the application with the other open and closed positions at its
 * location and lists up to three it relates to, each with the stated facts behind it; the
 * function sets their order (open first, then title), so the order is not a ranking.
 * Summarize shown (the tracker's header) runs it for up to 25 of the filtered applications that
 * have no such run yet.
 *
 * Under the contact log, Translate a message turns a reply into Spanish (or an applicant's
 * Spanish message into English) for HR to copy. Nothing is sent to the applicant and the text is
 * not stored.
 *
 * Managers never see a summary. When one has translated answers they can already read, their
 * drawer shows that English translation (the `translation` column of applications_for_managers).
 *
 * app.js calls RR.summary.render / translator / managerTranslation / latestTranslations / bulk.
 */
(function () {
  "use strict";
  var RR = window.RR; if (!RR) return;
  var sb = RR.sb, el = RR.el;
  var FN = "recruiting-applicant-summary";
  var COLS = "id, application_id, position_id, requested_by, created_at, finished_at, answer_language, summary, translations, other_positions, catalog_size, had_description, model, input_tokens, output_tokens, cost_usd, error";
  var RUNNING_MS = 5 * 60 * 1000;
  var poll = null;

  function stopPoll() { if (poll) { clearTimeout(poll); poll = null; } }
  function isRunning(s) { return !s.finished_at && !s.error && (Date.now() - new Date(s.created_at).getTime()) < RUNNING_MS; }
  function isGood(s) { return !!s.finished_at && !s.error && !!s.summary; }
  function linkBtn(text, onClick) { var b = el("button", "linkbtn", text); b.type = "button"; b.addEventListener("click", onClick); return b; }
  function list(items) { var ul = el("ul", "sum-list"); items.forEach(function (t) { ul.appendChild(el("li", null, t)); }); return ul; }
  function money(n) { return n == null ? "" : n < 0.01 ? "under a cent" : "about $" + Number(n).toFixed(2); }

  async function load(appId) {
    var r = await sb.from("applicant_summaries").select(COLS).eq("application_id", appId).order("created_at", { ascending: false }).limit(12);
    if (r.error) { RR.notice("Could not load summaries: " + RR.errText(r.error)); return null; }
    return r.data || [];
  }

  // The function answers JSON on errors too; supabase-js puts the response on error.context.
  async function invoke(body) {
    var r = await sb.functions.invoke(FN, { body: body });
    var payload = r.data || null;
    if (r.error && r.error.context && typeof r.error.context.json === "function") { try { payload = await r.error.context.json(); } catch (e) { payload = null; } }
    return { error: r.error, payload: payload };
  }

  // ---------- Summary section (admin and hr) ----------
  function render(sec, a) {
    stopPoll();
    sec.dataset.appId = a.id;
    sec.querySelectorAll(".sum").forEach(function (n) { n.remove(); });
    var box = el("div", "sum"); sec.appendChild(box);
    box.appendChild(el("div", "hint", "Loading…"));
    load(a.id).then(function (rows) {
      if (!box.isConnected || sec.dataset.appId !== a.id || rows == null) return;
      draw(box, sec, a, rows);
    });
  }
  function schedulePoll(box, sec, a) {
    stopPoll();
    poll = setTimeout(async function () {
      if (!box.isConnected || sec.dataset.appId !== a.id) return;
      var rows = await load(a.id);
      if (!box.isConnected || sec.dataset.appId !== a.id || rows == null) return;
      draw(box, sec, a, rows);
    }, 3000);
  }

  function draw(box, sec, a, rows) {
    box.innerHTML = "";
    var latest = rows[0] || null, running = latest && isRunning(latest);
    var good = rows.filter(isGood), shown = good[0] || null;

    var row = el("div", "row sum-controls");
    var btn = el("button", "btn small", running ? "Summarizing…" : shown ? "Summarize again" : "Summarize"); btn.type = "button"; btn.disabled = !!running;
    btn.title = "Claude reads this application against its position and the other positions at its location. Five to ten cents a run; the facts come from the application only.";
    btn.addEventListener("click", async function () {
      btn.disabled = true; btn.textContent = "Starting…";
      var r = await invoke({ action: "summarize", application_id: a.id });
      if (r.error && !(r.payload && r.payload.status === "running")) {
        RR.notice("Could not start the summary: " + ((r.payload && r.payload.error) || RR.errText(r.error)));
        btn.disabled = false; btn.textContent = shown ? "Summarize again" : "Summarize"; return;
      }
      var fresh = await load(a.id);
      if (!box.isConnected || sec.dataset.appId !== a.id || fresh == null) return;
      draw(box, sec, a, fresh);
    });
    row.appendChild(btn);
    box.appendChild(row);

    if (running) {
      box.appendChild(el("div", "hint", "Claude is reading the application; started " + RR.relTime(new Date(latest.created_at)) + ". This usually takes under a minute and the section refreshes on its own."));
      schedulePoll(box, sec, a);
    } else if (latest && latest.error) {
      var bad = el("div", "notice-inline sum-error");
      bad.appendChild(el("span", "tag warn", "Last run failed"));
      bad.appendChild(document.createTextNode(" " + latest.error + " (" + RR.fmtDateTime(new Date(latest.created_at)) + ")"));
      box.appendChild(bad);
    }
    if (!shown) {
      if (!running) box.appendChild(el("div", "hint", "No summary yet. Claude reads this application against its position and lists what relates to it, what it does not say, other positions the application relates to, and an English translation of anything written in Spanish. It does not score, rank or recommend; the decision stays with you."));
      return;
    }
    box.appendChild(summaryBody(shown, a, true));
    var earlier = rows.filter(function (s) { return s !== shown && !isRunning(s); });
    if (earlier.length) {
      var det = el("details", "sum-history");
      det.appendChild(el("summary", null, "Earlier runs (" + earlier.length + ")"));
      earlier.forEach(function (s) {
        var d = el("details", "sum-run");
        d.appendChild(el("summary", null, RR.fmtDateTime(new Date(s.created_at)) + " · " + (s.error ? "failed" : "summary")));
        d.appendChild(s.error ? el("div", "hint", s.error) : summaryBody(s, a, false));
        det.appendChild(d);
      });
      box.appendChild(det);
    }
  }

  function summaryBody(s, a, isLatest) {
    var st = RR.state(), m = s.summary || {};
    var wrap = el("div", "sum-body");
    var p = s.position_id ? st.positionById[s.position_id] : null;
    var who = s.requested_by ? (st.profileNames[s.requested_by] || "a removed user") : null;
    var head = el("div", "meta", "Written by Claude " + (isLatest ? RR.relTime(new Date(s.created_at)) : "on " + RR.fmtDateTime(new Date(s.created_at))) +
      " against " + (p ? p.title + ", " + p.location : "the position as written") + (s.had_description ? " and its job description" : " (no job description on file)") +
      (who ? " · asked by " + who : ""));
    wrap.appendChild(head);
    if (s.answer_language === "es" || s.answer_language === "mixed") {
      var lang = el("div", "notice-inline");
      lang.appendChild(el("span", "tag", s.answer_language === "es" ? "Written in Spanish" : "Spanish and English"));
      lang.appendChild(document.createTextNode(" Reply in Spanish: Translate a message is under Contact log."));
      wrap.appendChild(lang);
    }
    if (m.overview) wrap.appendChild(el("p", "sum-overview", m.overview));
    function block(title, items) { if (!items || !items.length) return; wrap.appendChild(el("div", "q", title)); wrap.appendChild(list(items)); }
    block("Related to the position", m.experience);
    block("Licences and certifications", m.licences);
    var dl = el("dl", "kv");
    RR.kv(dl, "Availability", m.availability); RR.kv(dl, "Location", m.location);
    if (dl.children.length) wrap.appendChild(dl);
    block("Not stated in the application", m.not_stated);
    wrap.appendChild(otherPositions(s));
    if (m.check_in_application && m.check_in_application.length) {
      var chk = el("div", "notice-inline sum-check");
      chk.appendChild(el("div", "q", "Check in the application"));
      chk.appendChild(list(m.check_in_application));
      wrap.appendChild(chk);
    }
    var tr = s.translations || [];
    if (tr.length) {
      wrap.appendChild(el("div", "q", "English translation of the applicant's answers"));
      wrap.appendChild(translationList(tr));
    }
    var usage = [s.model, (s.input_tokens != null ? Number(s.input_tokens).toLocaleString() + " in / " + Number(s.output_tokens || 0).toLocaleString() + " out tokens" : ""), money(s.cost_usd)];
    if (s.finished_at) usage.push(Math.max(1, Math.round((new Date(s.finished_at) - new Date(s.created_at)) / 1000)) + " s");
    wrap.appendChild(el("div", "hint", usage.filter(Boolean).join(" · ") + ". Facts from the application only: no scores, rankings or recommendations."));
    return wrap;
  }

  // Other positions the application relates to. The status shown is the position's status now
  // (the run stored it as it was then); a closed role says when it was last open, since a
  // seasonal role is the reason closed positions are compared at all.
  function positionStatus(p, o) {
    if (!p) return "No longer on file";
    if (p.status === "open") return "Open now";
    if (p.status === "draft") return "Draft";
    var last = (p.openings || []).slice().sort(function (a, b) { return String(b.opened_at).localeCompare(String(a.opened_at)); })[0];
    if (!last) return "Closed";
    return "Closed · last open " + RR.fmtDay(last.opened_at) + (last.closed_at ? " to " + RR.fmtDay(last.closed_at) : "");
  }
  function otherPositions(s) {
    var st = RR.state(), items = s.other_positions || [];
    var box = el("div", "sum-other");
    box.appendChild(el("div", "q", "Other positions this application relates to"));
    if (s.catalog_size == null) {
      box.appendChild(el("div", "hint", "This run is from before the tracker compared applications with other positions. Summarize again to add that."));
      return box;
    }
    if (!items.length) {
      box.appendChild(el("div", "hint", s.catalog_size
        ? "None. Claude compared the application with " + s.catalog_size + " other position" + (s.catalog_size === 1 ? "" : "s") + " (open and closed) and found no stated fact that meets a stated requirement of one."
        : "None. There were no other open or closed positions to compare with."));
      return box;
    }
    items.forEach(function (o) {
      var p = st.positionById[o.position_id];
      var d = el("div", "sum-pos");
      var head = el("div", "sum-pos-head");
      if (p) {
        var link = el("a", null, p.title); link.href = "#/positions/" + p.id;
        link.addEventListener("click", function (e) { e.preventDefault(); RR.go("#/positions/" + p.id); });
        head.appendChild(link);
      } else head.appendChild(el("span", null, o.title || "A position"));
      head.appendChild(el("span", "meta", " · " + ((p && p.location) || o.location || "")));
      head.appendChild(el("span", "tag" + (p && p.status === "open" ? " open" : ""), positionStatus(p, o)));
      d.appendChild(head);
      d.appendChild(list(o.matches || []));
      if (o.not_stated && o.not_stated.length) { d.appendChild(el("div", "q", "Not stated for this position")); d.appendChild(list(o.not_stated)); }
      if (!o.had_description) d.appendChild(el("div", "hint", "No description text on file for this position, so it was compared on its title alone."));
      box.appendChild(d);
    });
    box.appendChild(el("div", "hint", "Compared with " + s.catalog_size + " other position" + (s.catalog_size === 1 ? "" : "s") + ". Open positions are listed first, then by title: the order is not a ranking, and this is a pointer to read, not a recommendation."));
    return box;
  }

  function translationList(items) {
    var box = el("div", "answers sum-translation");
    items.forEach(function (t) {
      var d = el("div");
      d.appendChild(el("div", "q", t.label || t.key));
      d.appendChild(el("div", "a", t.english || ""));
      if (t.original) { var o = el("div", "orig", "Original: " + t.original); o.lang = "es"; d.appendChild(o); }
      box.appendChild(d);
    });
    return box;
  }

  // ---------- Translate a message (admin and hr) ----------
  function translator(sec, a) {
    var det = el("details", "translator");
    if (a.language === "es") det.open = true;
    det.appendChild(el("summary", null, "Translate a message (English ↔ Spanish)"));
    var f = el("div", "review");
    var dir = el("select"); dir.setAttribute("aria-label", "Direction");
    [["en-es", "English to Spanish, for the applicant"], ["es-en", "Spanish to English, from the applicant"]].forEach(function (o) { var opt = el("option", null, o[1]); opt.value = o[0]; dir.appendChild(opt); });
    var src = el("textarea"); src.maxLength = 4000; src.setAttribute("aria-label", "Message to translate");
    var setPh = function () { src.placeholder = dir.value === "en-es" ? "Write the message in English" : "Paste the applicant's message in Spanish"; };
    dir.addEventListener("change", setPh); setPh();
    var row = el("div", "row");
    var go = el("button", "btn small", "Translate"); go.type = "button"; row.appendChild(go);
    var out = el("textarea"); out.readOnly = true; out.hidden = true; out.setAttribute("aria-label", "Translation");
    var copy = el("button", "btn small", "Copy"); copy.type = "button"; copy.hidden = true;
    var status = el("div", "hint");
    go.addEventListener("click", async function () {
      var text = src.value.trim();
      if (!text) { src.focus(); return; }
      go.disabled = true; go.textContent = "Translating…"; status.textContent = "";
      var r = await invoke({ action: "translate", application_id: a.id, direction: dir.value, text: text });
      go.disabled = false; go.textContent = "Translate";
      if (r.error || !r.payload || !r.payload.translation) { status.textContent = "Could not translate: " + ((r.payload && r.payload.error) || RR.errText(r.error)); return; }
      out.value = r.payload.translation; out.hidden = false; copy.hidden = false; out.lang = dir.value === "en-es" ? "es" : "en";
      status.textContent = "Translated by Claude (" + money(r.payload.cost_usd) + "). Read it over before you send it.";
    });
    copy.addEventListener("click", async function () {
      try { await navigator.clipboard.writeText(out.value); status.textContent = "Copied. Paste it into your email or text, then log the contact above."; }
      catch (e) { out.select(); status.textContent = "Select-all is done; copy with Ctrl+C or ⌘C."; }
    });
    row.appendChild(copy);
    f.appendChild(dir); f.appendChild(src); f.appendChild(row); f.appendChild(out); f.appendChild(status);
    f.appendChild(el("div", "hint", "Nothing is sent to the applicant and the text is not stored. About a cent per message."));
    det.appendChild(f);
    sec.appendChild(det);
  }

  // ---------- Managers: the English translation they may read ----------
  function managerTranslation(sec, items) {
    sec.appendChild(el("div", "hint", "Translated by Claude from the applicant's own answers; the original is under each one."));
    sec.appendChild(translationList(items));
  }

  // For the application PDF (staff): the newest finished summary's translations.
  async function latestTranslations(appId) {
    var r = await sb.from("applicant_summaries").select("translations, finished_at, error, created_at").eq("application_id", appId).not("finished_at", "is", null).is("error", null).order("created_at", { ascending: false }).limit(1);
    if (r.error || !r.data || !r.data.length) return [];
    return r.data[0].translations || [];
  }

  // ---------- Summarize shown (admin and hr) ----------
  // Runs Summarize for the filtered applications that have no finished run with the position
  // comparison yet: at most 25 a click, two at a time, after a confirmation that says how many
  // and roughly what it costs. Each run is the same one the drawer starts.
  var BULK_MAX = 25, BULK_PARALLEL = 2, BULK_WAIT_MS = 4 * 60 * 1000, BULK_COST = 0.08;
  var bulkBusy = false;
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  async function alreadySummarized(ids) {
    var have = {};
    for (var i = 0; i < ids.length; i += 100) {
      var r = await sb.from("applicant_summaries").select("application_id").in("application_id", ids.slice(i, i + 100))
        .not("finished_at", "is", null).is("error", null).not("catalog_size", "is", null).limit(1000);
      if (r.error) throw r.error;
      (r.data || []).forEach(function (row) { have[row.application_id] = true; });
    }
    return have;
  }
  async function runOne(appId) {
    var r = await invoke({ action: "summarize", application_id: appId });
    var id = r.payload && r.payload.summary_id;
    if (!id) return false;
    var until = Date.now() + BULK_WAIT_MS;
    while (Date.now() < until) {
      await wait(3000);
      var q = await sb.from("applicant_summaries").select("finished_at, error").eq("id", id).maybeSingle();
      if (q.error || !q.data) continue;
      if (q.data.error) return false;
      if (q.data.finished_at) return true;
    }
    return false;
  }
  async function bulk(rows, btn) {
    if (bulkBusy) return;
    if (!rows.length) { RR.notice("No applications are shown."); return; }
    bulkBusy = true;
    var label = btn.textContent; btn.disabled = true; btn.textContent = "Checking…";
    try {
      var have = await alreadySummarized(rows.map(function (a) { return a.id; }));
      var todo = rows.filter(function (a) { return !have[a.id]; });
      if (!todo.length) { RR.notice("All " + rows.length.toLocaleString() + " applications shown already have a summary with the position comparison."); return; }
      var batch = todo.slice(0, BULK_MAX);
      if (!window.confirm("Summarize " + batch.length + " application" + (batch.length === 1 ? "" : "s") + "?\n\n" +
        (todo.length > batch.length ? todo.length.toLocaleString() + " of the applications shown have no summary yet; this runs the first " + batch.length + " in the order shown.\n\n" : "") +
        "Claude reads each one against its position and the other positions at its location. About $" + (batch.length * BULK_COST).toFixed(2) +
        " in all, and a few minutes. Keep this tab open until it finishes.")) return;
      var done = 0, ok = 0, next = 0;
      var show = function () { btn.textContent = "Summarizing " + Math.min(done + 1, batch.length) + " of " + batch.length + "…"; };
      show();
      var worker = async function () {
        while (next < batch.length) {
          var a = batch[next++];
          var good = false;
          try { good = await runOne(a.id); } catch (e) { good = false; }
          done++; if (good) ok++;
          show();
        }
      };
      var workers = [];
      for (var w = 0; w < BULK_PARALLEL; w++) workers.push(worker());
      await Promise.all(workers);
      var left = todo.length - batch.length;
      RR.notice("Summarized " + ok + " of " + batch.length + " application" + (batch.length === 1 ? "" : "s") + "." +
        (ok < batch.length ? " " + (batch.length - ok) + " did not finish; open one to see why." : "") +
        (left > 0 ? " " + left.toLocaleString() + " more shown have no summary yet." : ""));
    } catch (e) {
      RR.notice("Could not summarize the applications shown: " + RR.errText(e));
    } finally {
      bulkBusy = false; btn.disabled = false; btn.textContent = label;
    }
  }

  RR.summary = { render: render, translator: translator, managerTranslation: managerTranslation, latestTranslations: latestTranslations, bulk: bulk, stop: stopPoll };
})();
