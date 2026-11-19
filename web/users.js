/* Users page (admins only): add people (with a temporary password or a sign-in link the admin passes on; by emailed invite only when config.js has emailSignIn), switch two-factor sign-in on or off per person, change their role or name, re-send an invite, clear
 * someone's authenticator apps after a lost phone, and remove access. Everything goes through
 * the Edge Function recruiting-users, which checks for an admin with a two-factor session and
 * uses the service role for the parts the browser cannot do (sending invites, reading logins,
 * removing another person's authenticators). The database refuses to lose the last admin
 * (migration 20261115000100), so neither this page nor the SQL Editor can lock everyone out.
 * Only tracker users are listed: the Supabase project is shared with another app, and its other
 * logins are never shown or touched here.
 */
(function () {
  "use strict";
  var RR = window.RR; if (!RR) return;
  var sb = RR.sb, $ = RR.$, el = RR.el;
  var FN = "recruiting-users";
  // The tracker sends email (invites, re-sends) only when config.js says so; off in the testing window.
  var EMAIL = !!(window.RECRUITER_CONFIG || {}).emailSignIn;
  var ROLE_LABEL = { admin: "Admin", hr: "HR", manager: "Manager" };

  var users = [], loaded = false, busy = false;

  RR.registerPage("users", {
    show: show,
    hide: function () {},
    reset: function () { users = []; loaded = false; $("usersRows").innerHTML = ""; }
  });

  function pageUrl() { return location.origin + location.pathname; }

  // The function answers JSON on errors too; supabase-js puts the response on error.context.
  async function invoke(body) {
    var r = await sb.functions.invoke(FN, { body: body });
    var payload = r.data || null;
    if (r.error && r.error.context && typeof r.error.context.json === "function") { try { payload = await r.error.context.json(); } catch (e) { payload = null; } }
    if (r.error) return { error: (payload && payload.error) || RR.errText(r.error) };
    return { data: payload };
  }

  async function show() {
    RR.setHeader("Users", loaded ? metaLine() : "Loading…");
    await load();
  }
  async function load() {
    var r = await invoke({ action: "list" });
    if (r.error) { RR.notice("Could not load the users: " + r.error); RR.setHeader("Users", ""); return; }
    users = r.data.users || []; loaded = true;
    render();
  }
  function metaLine() {
    var n = { admin: 0, hr: 0, manager: 0 }, pending = 0;
    users.forEach(function (u) { n[u.role]++; if (!u.accepted) pending++; });
    var parts = [users.length + (users.length === 1 ? " user" : " users"), n.admin + " admin", n.hr + " HR", n.manager + (n.manager === 1 ? " manager" : " managers")];
    if (pending) parts.push(pending + " invite" + (pending === 1 ? "" : "s") + " not yet accepted");
    return parts.join(" · ");
  }
  function adminCount() { return users.filter(function (u) { return u.role === "admin"; }).length; }

  function statusText(u) {
    if (u.must_change_password) {
      var exp = u.temp_password_expires_at ? new Date(u.temp_password_expires_at) : null;
      return exp && exp.getTime() < Date.now() ? "Temporary password expired, never changed" : "Temporary password sent, not changed yet" + (exp ? " (works until " + exp.toLocaleDateString() + ")" : "");
    }
    if (!u.accepted) return "Invited " + (u.invited_at ? RR.relTime(new Date(u.invited_at)) : "") + ", not accepted yet";
    if (!u.last_sign_in_at) return "Never signed in";
    return "Last sign-in " + RR.relTime(new Date(u.last_sign_in_at));
  }

  function render() {
    RR.setHeader("Users", metaLine());
    var tbody = $("usersRows"); tbody.innerHTML = "";
    $("usersTable").hidden = !users.length;
    $("usersEmpty").hidden = !!users.length;
    $("usersEmpty").textContent = "No users yet.";
    var lastAdmin = adminCount() <= 1;
    users.forEach(function (u) {
      var tr = el("tr");

      // Name: click to rename.
      var tdName = el("td");
      var nameBtn = el("button", "linkish", u.name + (u.is_self ? " (you)" : "")); nameBtn.type = "button";
      nameBtn.title = "Rename";
      nameBtn.addEventListener("click", function () { rename(u); });
      tdName.appendChild(nameBtn); tr.appendChild(tdName);

      tr.appendChild(el("td", null, u.email || "—"));

      // Role: inline select, like the stage select on the applications list.
      var tdRole = el("td");
      var sel = el("select"); sel.setAttribute("aria-label", "Role for " + u.name);
      ["admin", "hr", "manager"].forEach(function (r) { var o = el("option", null, ROLE_LABEL[r]); o.value = r; if (r === u.role) o.selected = true; sel.appendChild(o); });
      if (u.is_self) { sel.disabled = true; sel.title = "Another admin can change your role."; }
      else if (u.role === "admin" && lastAdmin) { sel.disabled = true; sel.title = "The tracker must keep at least one admin."; }
      sel.addEventListener("change", function () { changeRole(u, sel); });
      tdRole.appendChild(sel); tr.appendChild(tdRole);

      var tdStatus = el("td", null, statusText(u));
      if (!u.accepted || u.must_change_password) tdStatus.appendChild(el("span", "tag warn", "Pending"));
      tr.appendChild(tdStatus);

      // Two-factor: required or not (a select, like the role), and how many authenticators.
      var tdMfa = el("td");
      var mfa = el("select"); mfa.setAttribute("aria-label", "Two-factor sign-in for " + u.name);
      [["on", "Required"], ["off", "Off (password only)"]].forEach(function (x) { var o = el("option", null, x[1]); o.value = x[0]; mfa.appendChild(o); });
      mfa.value = u.mfa_required === false ? "off" : "on";
      mfa.addEventListener("change", function () { changeMfa(u, mfa); });
      tdMfa.appendChild(mfa);
      if (u.mfa_required !== false || u.authenticators) tdMfa.appendChild(el("span", "hint", " " + (u.authenticators ? u.authenticators + (u.authenticators === 1 ? " authenticator" : " authenticators") : "none set up yet")));
      tr.appendChild(tdMfa);

      var tdAct = el("td"), acts = el("div", "actions"); tdAct.appendChild(acts);
      if (!u.is_self) addBtn(acts, "Temporary password", function () { tempPassword(u); });
      if (!u.accepted) addBtn(acts, "Copy sign-in link", function () { copyLinkFor(u); });
      if (!u.accepted && EMAIL) addBtn(acts, "Re-send invite", function () { resend(u); });
      if (!u.is_self && u.authenticators > 0) addBtn(acts, "Reset authenticator", function () { resetMfa(u); });
      if (!u.is_self && !(u.role === "admin" && lastAdmin)) addBtn(acts, "Remove", function () { remove(u); });
      tr.appendChild(tdAct);

      tbody.appendChild(tr);
    });
  }
  function addBtn(td, label, fn) {
    var b = el("button", "btn small", label); b.type = "button";
    b.addEventListener("click", async function () {
      if (busy) return; busy = true; b.disabled = true;
      try { await fn(); } finally { busy = false; b.disabled = false; }
    });
    td.appendChild(b);
  }
  function replace(u) {
    users = users.map(function (x) { return x.user_id === u.user_id ? u : x; });
    render();
  }

  // ---------- Actions ----------
  async function changeRole(u, sel) {
    var to = sel.value;
    var msg = "Make " + u.name + " " + { admin: "an admin", hr: "HR", manager: "a manager" }[to] + "?";
    if (to === "admin") msg += " Admins can invite and remove users, including other admins.";
    if (to === "manager") msg += " Managers are read only and do not see notes, offers, summaries or reports.";
    if (!confirm(msg)) { sel.value = u.role; return; }
    sel.disabled = true;
    var r = await invoke({ action: "update", user_id: u.user_id, role: to });
    sel.disabled = false;
    if (r.error) { sel.value = u.role; RR.notice("Could not change the role: " + r.error); return; }
    RR.clearNotice();
    replace(r.data.user);
  }
  async function changeMfa(u, sel) {
    var on = sel.value === "on";
    var msg = on
      ? "Require an authenticator app for " + u.name + "? At their next sign-in they enter a code, or set up an app if they have none."
      : "Let " + u.name + " sign in with a password alone? Their password is then the only thing protecting the applicant data their role can see. Meant for the testing window.";
    if (!confirm(msg)) { sel.value = on ? "off" : "on"; return; }
    sel.disabled = true;
    var r = await invoke({ action: "update", user_id: u.user_id, mfa_required: on });
    sel.disabled = false;
    if (r.error) { sel.value = on ? "off" : "on"; RR.notice("Could not change two-factor sign-in: " + r.error); return; }
    RR.clearNotice();
    replace(r.data.user);
  }
  async function tempPassword(u) {
    if (!confirm("Make a temporary password for " + u.name + " (" + (u.email || "no email") + ")? Their current password stops working, here and in any other Rexius app that uses the same login. They must choose a new one at their next sign-in.")) return;
    var r = await invoke({ action: "temp_password", user_id: u.user_id });
    if (r.error) { RR.notice("Could not make a temporary password: " + r.error); return; }
    RR.clearNotice();
    replace(r.data.user);
    showSecret(r.data.user, r.data.password, "password");
  }
  async function rename(u) {
    var name = prompt("Name for " + (u.email || "this user") + ":", u.name);
    if (name == null) return;
    name = name.trim();
    if (!name || name === u.name) return;
    var r = await invoke({ action: "update", user_id: u.user_id, name: name });
    if (r.error) { RR.notice("Could not rename: " + r.error); return; }
    RR.clearNotice();
    replace(r.data.user);
    if (u.is_self) { var me = RR.state().profile; if (me) { me.name = name; $("who").textContent = name + " · " + me.role; } }
  }
  async function resend(u) {
    var r = await invoke({ action: "resend", user_id: u.user_id, redirect_to: pageUrl() });
    if (r.error) { RR.notice("Could not re-send the invite: " + r.error); return; }
    RR.notice("A fresh invite is on its way to " + u.email + ".");
    replace(r.data.user);
  }
  async function copyLinkFor(u) {
    var r = await invoke({ action: "invite_link", user_id: u.user_id, redirect_to: pageUrl() });
    if (r.error) { RR.notice("Could not make a sign-in link: " + r.error); return; }
    RR.clearNotice();
    replace(r.data.user);
    showLink(u, r.data.link);
  }
  async function resetMfa(u) {
    if (!confirm("Remove every authenticator " + u.name + " has set up? Use this when they have lost or replaced their phone. On their next sign-in they enter their password and set up an authenticator again.")) return;
    var r = await invoke({ action: "reset_mfa", user_id: u.user_id });
    if (r.error) { RR.notice("Could not reset the authenticators: " + r.error); return; }
    RR.notice(u.name + "'s authenticators are cleared. They set up a new one on their next sign-in.");
    replace(r.data.user);
  }
  async function remove(u) {
    if (!confirm("Remove " + u.name + " (" + (u.email || "no email") + ") from the tracker? They lose access at once. Their notes, stage changes and contact log entries stay, with their name.")) return;
    var r = await invoke({ action: "remove", user_id: u.user_id });
    if (r.error) { RR.notice("Could not remove: " + r.error); return; }
    RR.notice(u.name + " no longer has access to the tracker.");
    users = users.filter(function (x) { return x.user_id !== u.user_id; });
    render();
  }

  // ---------- Invite ----------
  function openInvite() {
    $("inviteError").textContent = "";
    $("inviteEmail").value = ""; $("inviteName").value = ""; $("inviteRole").value = "manager";
    $("inviteSave").disabled = false;
    var d = document.querySelector('input[name="inviteDelivery"][value="password"]'); if (d) d.checked = true;
    $("inviteEmailChoice").hidden = !EMAIL; $("inviteMfa").checked = true;
    $("inviteModal").hidden = false;
    $("inviteEmail").focus();
  }
  function closeInvite() { $("inviteModal").hidden = true; }
  async function sendInvite(ev) {
    ev.preventDefault();
    var email = $("inviteEmail").value.trim(), name = $("inviteName").value.trim(), role = $("inviteRole").value;
    $("inviteError").textContent = "";
    if (!email || !name) { $("inviteError").textContent = "Enter an email and a name."; return; }
    if (!/@rexius\.com$/i.test(email) && !confirm(email + " is not a rexius.com address. Invite them anyway?")) return;
    $("inviteSave").disabled = true;
    var delivery = (document.querySelector('input[name="inviteDelivery"]:checked') || {}).value || "password";
    var r = await invoke({ action: "invite", email: email, name: name, role: role, redirect_to: pageUrl(), delivery: delivery, mfa_required: $("inviteMfa").checked });
    $("inviteSave").disabled = false;
    if (r.error) { $("inviteError").textContent = r.error; return; }
    closeInvite();
    users = users.concat([r.data.user]).sort(function (a, b) { return a.name.localeCompare(b.name); });
    render();
    if (r.data.password) { RR.clearNotice(); showSecret(r.data.user, r.data.password, "password"); return; }
    if (r.data.link) { RR.clearNotice(); showLink(r.data.user, r.data.link); return; }
    RR.notice(r.data.emailed
      ? "Invite sent to " + email + ". The link opens this site; they choose a password."
      : email + " already had a login for another Rexius app, so they can sign in now with that password. Use Temporary password on their row if they do not know it.");
  }

  // ---------- Sign-in link (no email) ----------
  // One dialog shows either secret: a one-time sign-in link or a temporary password. Neither is
  // kept by the page or the function once the dialog closes.
  var SECRET_TEXT = {
    link: { title: "Sign-in link", help: "Send it to that person only: it lets them set their password. It works once and expires after a while (an hour unless the Supabase setting has been raised). If it expires, use Copy sign-in link on their row for a fresh one; a new link replaces the old one." },
    password: { title: "Temporary password", help: "Send it to that person only, with the address of this site. They sign in with their email and this password and must choose their own straight away; until they do it opens nothing. It is shown only now: if it is lost, or not used within seven days, use Temporary password on their row for a new one." }
  };
  function showLink(u, link) { showSecret(u, link, "link"); }
  function showSecret(u, text, kind) {
    $("linkTitle").textContent = SECRET_TEXT[kind].title; $("linkHelp").textContent = SECRET_TEXT[kind].help;
    $("linkText").setAttribute("aria-label", SECRET_TEXT[kind].title);
    $("linkFor").textContent = "For " + u.name + " (" + (u.email || "") + "), " + ROLE_LABEL[u.role] + ".";
    $("linkText").value = text;
    $("linkNote").textContent = "";
    $("linkModal").hidden = false;
    copyLink();
  }
  async function copyLink() {
    var t = $("linkText");
    try { await navigator.clipboard.writeText(t.value); $("linkNote").textContent = "Copied. Paste it into a message to them."; }
    catch (e) { t.focus(); t.select(); $("linkNote").textContent = "Select the text above and copy it (Ctrl+C or ⌘C)."; }
  }
  function closeLink() { $("linkModal").hidden = true; $("linkText").value = ""; }

  $("usersInviteBtn").addEventListener("click", openInvite);
  $("usersRefresh").addEventListener("click", load);
  $("inviteForm").addEventListener("submit", sendInvite);
  $("inviteCancel").addEventListener("click", closeInvite);
  $("inviteClose").addEventListener("click", closeInvite);
  $("linkCopy").addEventListener("click", copyLink);
  $("linkDone").addEventListener("click", closeLink);
  $("linkClose").addEventListener("click", closeLink);
})();
