/* Security page: the signed-in user's own authenticators (Supabase Auth TOTP factors).
 * Every sign-in needs a six-digit code, so a user with one phone is locked out when it is lost
 * or replaced. Here they add a second device (work phone with Duo Mobile, personal phone,
 * password manager) and remove an old one. Each device has its own secret; the sign-in screen
 * asks which device the code is from when more than one is enrolled (app.js showChallenge).
 * Nothing here touches other users: Supabase only lets a session manage its own factors, and
 * unenrolling a verified factor needs the aal2 session every tracker user already has.
 */
(function () {
  "use strict";
  var RR = window.RR; if (!RR) return;
  var sb = RR.sb, $ = RR.$, el = RR.el;

  var factors = [], loaded = false, pendingId = null;

  RR.registerPage("security", {
    show: show,
    hide: function () {},
    reset: function () { factors = []; loaded = false; $("secRows").innerHTML = ""; }
  });

  async function show() {
    RR.setHeader("Security", loaded ? metaLine() : "Loading…");
    await load();
    render();
  }
  async function load() {
    var r = await sb.auth.mfa.listFactors();
    if (r.error) { RR.notice("Could not load your authenticators: " + RR.errText(r.error)); return; }
    factors = (r.data.totp || []).slice().sort(function (a, b) { return String(a.created_at).localeCompare(String(b.created_at)); });
    loaded = true;
  }
  function verified() { return factors.filter(function (f) { return f.status === "verified"; }); }
  function metaLine() {
    var n = verified().length;
    return n === 1 ? "1 authenticator. Add a second one so a lost phone does not lock you out." : n + " authenticators.";
  }
  function render() {
    RR.setHeader("Security", metaLine());
    var rows = verified();
    var tbody = $("secRows"); tbody.innerHTML = "";
    $("secTable").hidden = !rows.length;
    $("secEmpty").hidden = !!rows.length;
    $("secEmpty").textContent = "No authenticator is enrolled. Sign out and in again to set one up.";
    rows.forEach(function (f) {
      var tr = el("tr");
      tr.appendChild(el("td", null, f.friendly_name || "Authenticator"));
      var d = f.created_at ? new Date(f.created_at) : null;
      tr.appendChild(el("td", null, d && !isNaN(d) ? RR.fmtDate(d) : "—"));
      tr.appendChild(el("td", null, "Active"));
      var td = el("td");
      var btn = el("button", "btn small", "Remove"); btn.type = "button";
      btn.disabled = rows.length < 2;
      btn.title = rows.length < 2 ? "Add another authenticator before removing this one." : "";
      btn.addEventListener("click", function () { remove(f); });
      td.appendChild(btn); tr.appendChild(td);
      tbody.appendChild(tr);
    });
  }

  // ---------- Add ----------
  // Two steps in one form: name the device (the name is fixed at enrolment; Supabase has no
  // rename), then scan the QR code and enter the first code it shows.
  async function openAdd() {
    $("secError").textContent = ""; $("secCode").value = ""; $("secName").value = ""; $("secName").readOnly = false;
    $("secQr").hidden = true; $("secQr").removeAttribute("src"); $("secSecret").textContent = "…";
    $("secStep2").hidden = true; $("secSave").textContent = "Show QR code"; $("secSave").disabled = false;
    pendingId = null;
    $("secModal").hidden = false;
    // A previous attempt that was never verified would block reuse of its name; drop any.
    for (var i = 0; i < factors.length; i++) if (factors[i].status === "unverified") await sb.auth.mfa.unenroll({ factorId: factors[i].id });
    $("secName").focus();
  }
  async function cancelAdd() {
    $("secModal").hidden = true;
    if (pendingId) { var id = pendingId; pendingId = null; await sb.auth.mfa.unenroll({ factorId: id }); }
    await load(); render();
  }
  async function finishAdd(ev) {
    ev.preventDefault();
    $("secError").textContent = "";
    var name = $("secName").value.trim();
    if (!pendingId) {
      if (!name) { $("secError").textContent = "Give the device a name, like \"Work phone (Duo)\"."; return; }
      if (factors.some(function (f) { return (f.friendly_name || "").toLowerCase() === name.toLowerCase(); })) { $("secError").textContent = "You already have an authenticator with that name."; return; }
      $("secSave").disabled = true;
      var res = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: name, issuer: "Rexius Recruiter" });
      $("secSave").disabled = false;
      if (res.error) { $("secError").textContent = "Could not start: " + RR.errText(res.error); return; }
      pendingId = res.data.id;
      $("secName").readOnly = true;
      $("secQr").src = res.data.totp.qr_code; $("secQr").hidden = false;
      $("secSecret").textContent = res.data.totp.secret;
      $("secStep2").hidden = false; $("secSave").textContent = "Verify and add";
      $("secCode").focus();
      return;
    }
    var code = $("secCode").value.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(code)) { $("secError").textContent = "Enter the six digits shown in the app."; return; }
    $("secSave").disabled = true;
    var v = await sb.auth.mfa.challengeAndVerify({ factorId: pendingId, code: code });
    $("secSave").disabled = false;
    if (v.error) { $("secError").textContent = /invalid|expired/i.test(v.error.message) ? "That code did not match. Wait for the app to show a new one and try again." : RR.errText(v.error); return; }
    pendingId = null;
    $("secModal").hidden = true;
    await load(); render();
  }

  // ---------- Remove ----------
  async function remove(f) {
    if (verified().length < 2) return;
    if (!confirm("Remove \"" + (f.friendly_name || "this authenticator") + "\"? Codes from that device will stop working at sign-in.")) return;
    var r = await sb.auth.mfa.unenroll({ factorId: f.id });
    if (r.error) { RR.notice("Could not remove it: " + RR.errText(r.error)); return; }
    await load(); render();
  }

  $("secAddBtn").addEventListener("click", openAdd);
  $("secForm").addEventListener("submit", finishAdd);
  $("secCancel").addEventListener("click", cancelAdd);
  $("secClose").addEventListener("click", cancelAdd);
})();
