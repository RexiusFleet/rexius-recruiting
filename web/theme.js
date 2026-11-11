/* Light / dark toggle. Three states: system (default, follows the OS), light, dark.
   The choice is kept per browser in localStorage as "rr.theme"; the inline script in <head> applies it
   before first paint, and this file wires the buttons marked data-theme-toggle (header and sign-in screens).
   Colours themselves are the custom properties on :root in styles.css. Generated PDFs never read them. */
(function () {
  "use strict";
  var KEY = "rr.theme";
  var ORDER = ["system", "light", "dark"];
  var LABEL = { system: "System", light: "Light", dark: "Dark" };
  var svg = function (body) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + "</svg>";
  };
  var ICON = {
    system: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
    light: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    dark: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>')
  };

  function read() {
    var t = null;
    try { t = localStorage.getItem(KEY); } catch (e) {}
    return t === "light" || t === "dark" ? t : "system";
  }
  function apply(t) {
    var root = document.documentElement;
    if (t === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", t);
    // The sign-in logo is a <picture> whose dark source only follows the OS; point it at the choice.
    var media = t === "dark" ? "all" : t === "light" ? "not all" : "(prefers-color-scheme: dark)";
    document.querySelectorAll("picture.logo source[data-dark]").forEach(function (s) { s.media = media; });
    document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      var next = ORDER[(ORDER.indexOf(t) + 1) % ORDER.length];
      b.innerHTML = ICON[t];
      b.title = "Theme: " + LABEL[t] + ". Click for " + LABEL[next] + ".";
      b.setAttribute("aria-label", "Theme: " + LABEL[t] + ". Switch to " + LABEL[next]);
    });
  }
  var current = read();
  function set(t) {
    current = t; // kept in memory too, so the toggle still cycles where storage is blocked
    try { if (t === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch (e) {}
    apply(t);
  }

  function init() {
    document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      b.addEventListener("click", function () { set(ORDER[(ORDER.indexOf(current) + 1) % ORDER.length]); });
    });
    apply(current);
    // Another tab changed it: follow along.
    window.addEventListener("storage", function (e) { if (e.key === KEY) { current = read(); apply(current); } });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
