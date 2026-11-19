/* Update prompt (2026-11-18). The tracker is also used as an installed app (iPhone "Add to Home
 * Screen", Safari "Add to Dock" on a Mac), which can stay open for days and never reloads by itself.
 * The Pages deploy stamps the page with a version (scripts/pages/stamp-version.sh: the commit) and
 * writes version.json beside it. This script compares the two when the app comes back to the
 * front, when the window gets focus, and every five minutes while it is visible; when the site has
 * moved on it shows a bar with Restart. Nothing reloads on its own, so a half-written note or form
 * is never lost: the person picks the moment. Restart loads the new files, because the deploy also
 * puts the version on every script and stylesheet address. A local copy (`npx serve web`) has the
 * version "dev" and never checks.
 */
(function () {
  "use strict";
  var meta = document.querySelector('meta[name="app-version"]');
  var current = meta ? meta.getAttribute("content") : "";
  if (!current || current === "dev") return;

  var EVERY_MS = 5 * 60 * 1000, MIN_GAP_MS = 30 * 1000;
  var lastCheck = 0, shown = false, timer = null;

  async function check() {
    if (shown || document.visibilityState !== "visible") return;
    var now = Date.now();
    if (now - lastCheck < MIN_GAP_MS) return;
    lastCheck = now;
    try {
      var res = await fetch("version.json?t=" + now, { cache: "no-store" });
      if (!res.ok) return;
      var v = (await res.json()).version;
      if (typeof v === "string" && v && v !== current) show();
    } catch (e) { /* offline or between deploys: try again later */ }
  }

  function show() {
    shown = true;
    var bar = document.createElement("div");
    bar.className = "update-bar"; bar.setAttribute("role", "status");
    var text = document.createElement("span");
    text.textContent = "A new version of Rexius Recruiter is ready.";
    var later = document.createElement("button");
    later.type = "button"; later.className = "btn"; later.textContent = "Later";
    later.addEventListener("click", function () { bar.remove(); });
    var go = document.createElement("button");
    go.type = "button"; go.className = "btn primary"; go.textContent = "Restart";
    go.addEventListener("click", function () { go.disabled = true; location.reload(); });
    bar.appendChild(text); bar.appendChild(later); bar.appendChild(go);
    document.body.appendChild(bar);
  }

  document.addEventListener("visibilitychange", check);
  window.addEventListener("focus", check);
  window.addEventListener("pageshow", function (e) { if (e.persisted) check(); });
  timer = setInterval(check, EVERY_MS);
  setTimeout(check, 5000);
})();
