// Theme before first paint (theme.js wires the toggle). "light" or "dark" pins it; anything else
// follows the system. Loaded from the <head>, so keep it tiny.
(function () {
  var t = null;
  try { t = localStorage.getItem("rr.theme"); } catch (e) {}
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
})();
