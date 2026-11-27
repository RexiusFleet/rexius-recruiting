// Rexius Recruiter: user management for admins (the Users page, 2026-11-10).
//
// Before this, adding a person meant Supabase dashboard -> Authentication -> Invite user, then
// scripts/make-profile.sql in the SQL Editor, and an invite sent from the dashboard returned to
// the project's Site URL, which the shared project may point at another app or at localhost.
// This function does both steps in one call, sends the invite back to the tracker's own address,
// and covers the rest of the job: change a role or name, remove access, re-send an invite, and
// clear someone's authenticator apps when they lose their phone.
//
// Invite links without email (2026-11-11): `invite` with delivery "link", and `invite_link` for
// someone already invited, make the same one-time invite but send nothing; the admin copies the
// link and passes it on (Teams, text, their own mail). The link is the tracker's own address with
// `#invite=<token hash>` in the fragment, so the token never reaches a server log, and the page
// only redeems it when the person clicks Continue (verifyOtp). Mail and chat link scanners that
// open every link therefore cannot use it up, which they would with Supabase's /verify URL.
// Making a new link replaces the previous link or email for that person.
//
// Testing window (2026-11-19, migration 20261119000100): `invite` with delivery "password" and
// `temp_password` for someone already listed make a login with a generated temporary password and
// send nothing; the password is returned once for the admin to pass on, is never logged or
// stored, and the person must replace it at the first sign-in (`change_password`, the one action
// a non-admin may call, and only for themselves while their profile says must_change_password).
// It stops working after seven days if it was never replaced. `update` with `mfa_required`
// switches two-factor sign-in on or off for one person.
//
// Scope: only people with a recruiting.profiles row are listed or touched. auth.users is shared
// with the inventory app on the same project, so this function never lists other logins, and
// "remove" deletes the tracker profile, which ends access at once (recruiting.current_role()
// reads the profile on every request), and leaves a used login for the other app.
//
// Logins the tracker did not make (2026-11-26, migration 20261120000100): giving a role to an
// address that already has a login must not hand that login to the admin. The profile records
// whether this function created the login (login_made_by_tracker). Only then does it set a
// temporary password, make a sign-in link, or delete a login nobody used. An existing login keeps
// its password, and an address whose only login is another app's unaccepted invite is refused
// until that invite is accepted. The last admin can never be removed or demoted (trigger from migration
// 20261115000100, which also covers the SQL Editor and the dashboard).
//
// Request:  POST /functions/v1/recruiting-users   JSON body {action, ...}
//   `Authorization: Bearer <the user's Supabase JWT>`. Admins only, with a two-factor session,
//   checked through recruiting.current_role() like every table policy. The gateway's JWT check is
//   off (`verify_jwt = false`) as for the other tracker functions; the function checks itself.
//   {action: "list"}
//   {action: "invite", email, name, role, redirect_to, delivery?: "email" | "link" | "password", mfa_required?}
//   {action: "invite_link", user_id, redirect_to}
//   {action: "update", user_id, name?, role?, mfa_required?}
//   {action: "temp_password", user_id}
//   {action: "change_password", password}   any signed-in tracker user with a temporary password
//   {action: "resend", user_id, redirect_to}
//   {action: "reset_mfa", user_id}
//   {action: "remove", user_id}
// Response: JSON, always. 200 with the action's result; 400 bad input, 401 no or bad session,
//   403 not an admin (or no two-factor session), 404 no such tracker user, 405 not POST,
//   409 refused (last admin, already a user, own account), 500 Supabase error, 503 not configured.
//
// Environment:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY   injected by Supabase
//   RECRUITING_SITE_URLS   optional, comma-separated addresses invite links may return to; the
//                          first is used when the page sends anything else. Each must also be on
//                          the Auth redirect allow list. Default: the GitHub Pages site and
//                          http://localhost:3000/ and http://127.0.0.1:3000/ for local work.

import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2.118.0";

const FUNCTION = "recruiting-users";
const ROLES = ["admin", "hr", "manager"] as const;
type Role = typeof ROLES[number];
const DEFAULT_SITES = [
  "https://rexiusfleet.github.io/rexius-recruiting/",
  "http://localhost:3000/",
  "http://127.0.0.1:3000/",
];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

type Json = Record<string, unknown>;
class Refused extends Error { constructor(public status: number, message: string) { super(message); } }

function json(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}
function env(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v && v.trim() ? v.trim() : undefined;
}
function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}
function isUuid(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}
function cleanEmail(v: unknown): string {
  const e = str(v, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : "";
}
/** Trailing slash, no query or hash: the form pageUrl() in web/app.js sends. */
function normSite(u: string): string {
  try {
    const x = new URL(u);
    if (x.protocol !== "https:" && x.protocol !== "http:") return "";
    return x.origin + (x.pathname.endsWith("/") ? x.pathname : x.pathname.replace(/[^/]*$/, ""));
  } catch { return ""; }
}
function siteFor(requested: unknown): string {
  const allowed = (env("RECRUITING_SITE_URLS")?.split(",") ?? DEFAULT_SITES).map((s) => normSite(s.trim())).filter(Boolean);
  const want = typeof requested === "string" ? normSite(requested) : "";
  return allowed.includes(want) ? want : allowed[0];
}
/** Supabase's own messages are fine to show an admin; log the detail either way. */
/**
 * A one-time invite link that sends no email. generateLink creates the login when it is new and
 * refuses one that is already confirmed. The hashed token is what verifyOtp({token_hash}) takes.
 */
async function inviteLink(admin: SupabaseClient, email: string, redirectTo: string): Promise<{ link: string; userId: string }> {
  const r = await admin.auth.admin.generateLink({ type: "invite", email, options: { redirectTo } });
  const hash = r.data?.properties?.hashed_token;
  if (r.error || !hash || !r.data?.user) fail("make the invite link", r.error);
  return { link: `${redirectTo}#invite=${encodeURIComponent(hash)}`, userId: r.data.user.id };
}
function fail(where: string, err: { message?: string } | null | undefined): never {
  const msg = err?.message ?? "unknown error";
  console.error(`[${FUNCTION}] ${where}: ${msg}`);
  if (/at least one admin/i.test(msg)) throw new Refused(409, "The tracker must keep at least one admin. Make someone else an admin first.");
  throw new Refused(500, `${where}: ${msg}`);
}

interface Profile {
  user_id: string; role: Role; name: string; location: string | null; created_at: string;
  mfa_required: boolean; must_change_password: boolean; temp_password_expires_at: string | null;
  login_made_by_tracker: boolean;
}
const PROFILE_COLS = "user_id, role, name, location, created_at, mfa_required, must_change_password, temp_password_expires_at, login_made_by_tracker";
const NOT_OUR_LOGIN = "This login was not made by the tracker (they had it for another Rexius app first), so the tracker will not change how it signs in. They use the password they already have and reset it where they got it.";
const TEMP_PASSWORD_DAYS = 7;

/**
 * A temporary password: 16 random characters in four groups, without the look-alikes (0 O 1 l I),
 * always with an upper-case letter, a lower-case letter and a digit so it passes whatever
 * character rules the project's Auth settings ask for. About 92 bits.
 */
function tempPassword(): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const limit = 256 - (256 % abc.length);
  for (;;) {
    let out = "";
    while (out.length < 16) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      for (const b of bytes) if (b < limit && out.length < 16) out += abc[b % abc.length];
    }
    if (/[A-Z]/.test(out) && /[a-z]/.test(out) && /[0-9]/.test(out)) return out.match(/.{4}/g)!.join("-");
  }
}
function tempExpiry(): string {
  return new Date(Date.now() + TEMP_PASSWORD_DAYS * 86400_000).toISOString();
}

async function findLoginByEmail(admin: SupabaseClient, email: string): Promise<User | null> {
  // The project has a few dozen logins at most (two small apps); page through them.
  for (let page = 1; page <= 50; page++) {
    const r = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (r.error) fail("look up the email", r.error);
    const hit = r.data.users.find((u) => (u.email ?? "").toLowerCase() === email);
    if (hit) return hit;
    if (r.data.users.length < 200) return null;
  }
  return null;
}

async function profileOf(admin: SupabaseClient, userId: string): Promise<Profile> {
  const r = await admin.schema("recruiting").from("profiles").select(PROFILE_COLS).eq("user_id", userId).maybeSingle();
  if (r.error) fail("read the profile", r.error);
  if (!r.data) throw new Refused(404, "That person is not a tracker user.");
  return r.data as Profile;
}

async function describe(admin: SupabaseClient, p: Profile, selfId: string): Promise<Json> {
  const u = await admin.auth.admin.getUserById(p.user_id);
  const user = u.data?.user ?? null;
  let authenticators = 0;
  if (user) {
    const f = await admin.auth.admin.mfa.listFactors({ userId: p.user_id });
    if (!f.error) authenticators = (f.data?.factors ?? []).filter((x) => x.status === "verified").length;
  }
  return {
    user_id: p.user_id, name: p.name, role: p.role, location: p.location, added_at: p.created_at,
    email: user?.email ?? null,
    invited_at: user?.invited_at ?? null,
    // An invited person has no confirmed email until they open the link and choose a password.
    accepted: !!(user?.email_confirmed_at),
    last_sign_in_at: user?.last_sign_in_at ?? null,
    authenticators,
    mfa_required: p.mfa_required,
    must_change_password: p.must_change_password,
    temp_password_expires_at: p.temp_password_expires_at,
    login_made_by_tracker: p.login_made_by_tracker,
    is_self: p.user_id === selfId,
  };
}

async function list(admin: SupabaseClient, selfId: string): Promise<Json> {
  const r = await admin.schema("recruiting").from("profiles").select(PROFILE_COLS).order("name");
  if (r.error) fail("read the users", r.error);
  const users = await Promise.all((r.data as Profile[]).map((p) => describe(admin, p, selfId)));
  return { users };
}

async function invite(admin: SupabaseClient, body: Json, selfId: string): Promise<Json> {
  const email = cleanEmail(body.email);
  const name = str(body.name, 120);
  const role = body.role;
  if (!email) throw new Refused(400, "Enter a valid email address.");
  if (!name) throw new Refused(400, "Enter the person's name.");
  if (!isRole(role)) throw new Refused(400, "Pick a role: admin, hr or manager.");
  const redirectTo = siteFor(body.redirect_to);
  const byLink = body.delivery === "link";
  const byPassword = body.delivery === "password";
  const mfaRequired = body.mfa_required !== false;

  const existing = await findLoginByEmail(admin, email);
  if (existing) {
    const had = await admin.schema("recruiting").from("profiles").select("user_id").eq("user_id", existing.id).maybeSingle();
    if (had.error) fail("check the profile", had.error);
    if (had.data) throw new Refused(409, `${email} is already a tracker user. Change their role in the list instead.`);
  }

  let userId: string;
  let emailed = false;
  let link: string | null = null;
  let password: string | null = null;
  if (existing && existing.email_confirmed_at) {
    // Someone with a working login on the shared project (the other app): give them the role.
    // They sign in with the password they have; the tracker asks them to set up an
    // authenticator on the first sign-in.
    userId = existing.id;
  } else if (existing) {
    // A login nobody has confirmed and that has no tracker profile is another app's pending
    // invite (the tracker deletes its own unused logins on Remove). Setting a password on it, or
    // making a sign-in link for it, would hand that account to the admin.
    throw new Refused(409, `${email} has an invite from another Rexius app that they have not accepted yet. Ask them to accept it first, then add them here.`);
  } else if (byPassword) {
    // New: a login with a temporary password, no email.
    password = tempPassword();
    const r = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (r.error || !r.data?.user) fail("make the login", r.error);
    userId = r.data.user.id;
  } else if (byLink) {
    // New: a link for the admin to pass on, no email.
    const made = await inviteLink(admin, email, redirectTo);
    userId = made.userId; link = made.link;
  } else {
    // New: Supabase sends the invite email.
    const r = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
    if (r.error || !r.data?.user) fail("send the invite", r.error);
    userId = r.data.user.id;
    emailed = true;
  }

  const ins = await admin.schema("recruiting").from("profiles").insert({
    user_id: userId, role, name, mfa_required: mfaRequired,
    must_change_password: !!password, temp_password_expires_at: password ? tempExpiry() : null,
    login_made_by_tracker: !existing,
  });
  if (ins.error) {
    // Do not leave a fresh login behind without a profile; an existing one is not ours to delete.
    if (!existing) await admin.auth.admin.deleteUser(userId);
    fail("save the profile", ins.error);
  }
  console.log(`[${FUNCTION}] invite: ${role} added by ${selfId}${emailed ? ", email sent" : link ? ", link made" : password ? ", temporary password made" : ", existing login"}${mfaRequired ? "" : ", two-factor off"}`);
  return { user: await describe(admin, await profileOf(admin, userId), selfId), emailed, link, password, redirect_to: emailed || link ? redirectTo : null };
}

async function update(admin: SupabaseClient, body: Json, selfId: string): Promise<Json> {
  if (!isUuid(body.user_id)) throw new Refused(400, "Missing user_id.");
  const p = await profileOf(admin, body.user_id);
  const patch: Partial<Profile> = {};
  if (body.name !== undefined) {
    const name = str(body.name, 120);
    if (!name) throw new Refused(400, "The name cannot be empty.");
    patch.name = name;
  }
  if (body.role !== undefined) {
    if (!isRole(body.role)) throw new Refused(400, "Pick a role: admin, hr or manager.");
    if (p.user_id === selfId && body.role !== "admin") {
      throw new Refused(409, "You cannot take away your own admin role. Ask another admin to do it.");
    }
    patch.role = body.role;
  }
  if (body.mfa_required !== undefined) {
    if (typeof body.mfa_required !== "boolean") throw new Refused(400, "mfa_required must be true or false.");
    patch.mfa_required = body.mfa_required;
  }
  if (!Object.keys(patch).length) throw new Refused(400, "Nothing to change.");
  const r = await admin.schema("recruiting").from("profiles").update(patch).eq("user_id", p.user_id);
  if (r.error) fail("save the change", r.error);
  console.log(`[${FUNCTION}] update: ${Object.keys(patch).join(", ")} by ${selfId}`);
  return { user: await describe(admin, await profileOf(admin, p.user_id), selfId) };
}

async function resend(admin: SupabaseClient, body: Json, selfId: string): Promise<Json> {
  if (!isUuid(body.user_id)) throw new Refused(400, "Missing user_id.");
  const p = await profileOf(admin, body.user_id);
  const u = await admin.auth.admin.getUserById(p.user_id);
  if (u.error || !u.data?.user?.email) fail("read the login", u.error);
  if (u.data.user.email_confirmed_at) {
    throw new Refused(409, "They have already accepted the invite. If they forgot their password, they can use \"Forgot your password?\" on the sign-in screen.");
  }
  const redirectTo = siteFor(body.redirect_to);
  const r = await admin.auth.admin.inviteUserByEmail(u.data.user.email, { redirectTo });
  if (r.error) fail("re-send the invite", r.error);
  console.log(`[${FUNCTION}] resend by ${selfId}`);
  return { user: await describe(admin, p, selfId), redirect_to: redirectTo };
}

async function inviteLinkFor(admin: SupabaseClient, body: Json, selfId: string): Promise<Json> {
  if (!isUuid(body.user_id)) throw new Refused(400, "Missing user_id.");
  const p = await profileOf(admin, body.user_id);
  const u = await admin.auth.admin.getUserById(p.user_id);
  if (u.error || !u.data?.user?.email) fail("read the login", u.error);
  if (u.data.user.email_confirmed_at) {
    throw new Refused(409, "They have already accepted the invite. If they forgot their password, they can use \"Forgot your password?\" on the sign-in screen.");
  }
  if (!p.login_made_by_tracker) throw new Refused(409, NOT_OUR_LOGIN);
  const made = await inviteLink(admin, u.data.user.email, siteFor(body.redirect_to));
  console.log(`[${FUNCTION}] invite_link by ${selfId}`);
  return { user: await describe(admin, p, selfId), link: made.link };
}

/** A fresh temporary password for someone already listed (forgotten password, or an invite never opened). */
async function setTempPassword(admin: SupabaseClient, body: Json, selfId: string): Promise<Json> {
  if (!isUuid(body.user_id)) throw new Refused(400, "Missing user_id.");
  if (body.user_id === selfId) throw new Refused(409, "You cannot give yourself a temporary password. Ask another admin.");
  const p = await profileOf(admin, body.user_id);
  if (!p.login_made_by_tracker) throw new Refused(409, NOT_OUR_LOGIN);
  const password = tempPassword();
  const r = await admin.auth.admin.updateUserById(p.user_id, { password, email_confirm: true });
  if (r.error) fail("set the temporary password", r.error);
  const up = await admin.schema("recruiting").from("profiles")
    .update({ must_change_password: true, temp_password_expires_at: tempExpiry() }).eq("user_id", p.user_id);
  if (up.error) fail("mark the password as temporary", up.error);
  console.log(`[${FUNCTION}] temp_password by ${selfId}`);
  return { user: await describe(admin, await profileOf(admin, p.user_id), selfId), password };
}

/**
 * The person replaces their temporary password. Not an admin action: the caller is whoever holds
 * the session, and it works only while their own profile says must_change_password.
 */
async function changePassword(admin: SupabaseClient, supabaseUrl: string, anonKey: string, user: User, body: Json): Promise<Json> {
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 10) throw new Refused(400, "Use at least 10 characters.");
  if (password.length > 72) throw new Refused(400, "Use at most 72 characters.");
  const p = await profileOf(admin, user.id);
  if (!p.must_change_password) throw new Refused(409, "This account has no temporary password to replace.");
  if (p.temp_password_expires_at && new Date(p.temp_password_expires_at).getTime() < Date.now()) {
    throw new Refused(409, "The temporary password has expired. Ask an admin for a new one.");
  }
  // Refuse the temporary password itself as the new one: if it still signs in, it is the same.
  if (user.email) {
    const probe = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const same = await probe.auth.signInWithPassword({ email: user.email, password });
    if (!same.error) throw new Refused(400, "Choose a password different from the temporary one.");
  }
  const r = await admin.auth.admin.updateUserById(user.id, { password });
  if (r.error) throw new Refused(400, r.error.message || "That password was not accepted.");
  const up = await admin.schema("recruiting").from("profiles")
    .update({ must_change_password: false, temp_password_expires_at: null }).eq("user_id", user.id);
  if (up.error) fail("finish the password change", up.error);
  console.log(`[${FUNCTION}] change_password by ${user.id}`);
  return { changed: true };
}

async function resetMfa(admin: SupabaseClient, body: Json, selfId: string): Promise<Json> {
  if (!isUuid(body.user_id)) throw new Refused(400, "Missing user_id.");
  if (body.user_id === selfId) throw new Refused(409, "Manage your own authenticators on the Security page.");
  const p = await profileOf(admin, body.user_id);
  const f = await admin.auth.admin.mfa.listFactors({ userId: p.user_id });
  if (f.error) fail("read their authenticators", f.error);
  let removed = 0;
  for (const factor of f.data?.factors ?? []) {
    const d = await admin.auth.admin.mfa.deleteFactor({ userId: p.user_id, id: factor.id });
    if (d.error) fail("remove an authenticator", d.error);
    removed++;
  }
  console.log(`[${FUNCTION}] reset_mfa: ${removed} factor(s) by ${selfId}`);
  return { user: await describe(admin, p, selfId), removed };
}

async function remove(admin: SupabaseClient, body: Json, selfId: string): Promise<Json> {
  if (!isUuid(body.user_id)) throw new Refused(400, "Missing user_id.");
  if (body.user_id === selfId) throw new Refused(409, "You cannot remove yourself. Ask another admin to do it.");
  const p = await profileOf(admin, body.user_id);
  const r = await admin.schema("recruiting").from("profiles").delete().eq("user_id", p.user_id);
  if (r.error) fail("remove the user", r.error);
  // An invite nobody accepted leaves a login that was only ever for the tracker: delete it too, so
  // the old link stops working and the address can be invited again cleanly. A login that has
  // been used, or that the tracker did not make, may belong to the other app as well, so it stays.
  const u = await admin.auth.admin.getUserById(p.user_id);
  let loginDeleted = false;
  if (p.login_made_by_tracker && !u.error && u.data?.user && !u.data.user.email_confirmed_at && !u.data.user.last_sign_in_at) {
    const d = await admin.auth.admin.deleteUser(p.user_id);
    loginDeleted = !d.error;
    if (d.error) console.error(`[${FUNCTION}] remove: could not delete the unused login: ${d.error.message}`);
  }
  console.log(`[${FUNCTION}] remove by ${selfId}${loginDeleted ? " (unused login deleted)" : ""}`);
  return { removed: p.user_id, login_deleted: loginDeleted };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const supabaseUrl = env("SUPABASE_URL");
  const anonKey = env("SUPABASE_ANON_KEY");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) return json(503, { error: "function not configured (Supabase environment)" });

  // 1. Who is calling: an admin whose session current_role() accepts (two-factor unless an admin
  //    switched it off for them). `change_password` is the exception, handled before that check.
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json(401, { error: "sign in first" });
  const asUser = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
  const who = await asUser.auth.getUser(token);
  if (who.error || !who.data.user) return json(401, { error: "invalid session" });
  const selfId = who.data.user.id;

  let body: Json;
  try { body = await req.json(); } catch { return json(400, { error: "send a JSON body" }); }
  if (!body || typeof body !== "object") return json(400, { error: "send a JSON body" });

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    if (body.action === "change_password") return json(200, await changePassword(admin, supabaseUrl, anonKey, who.data.user, body));
    const role = await asUser.schema("recruiting").rpc("current_role");
    if (role.error) { console.error(`[${FUNCTION}] current_role: ${role.error.message}`); return json(500, { error: "could not check your role" }); }
    if (role.data !== "admin") return json(403, { error: "only admins can manage users" });
    switch (body.action) {
      case "list": return json(200, await list(admin, selfId));
      case "invite": return json(200, await invite(admin, body, selfId));
      case "update": return json(200, await update(admin, body, selfId));
      case "resend": return json(200, await resend(admin, body, selfId));
      case "invite_link": return json(200, await inviteLinkFor(admin, body, selfId));
      case "temp_password": return json(200, await setTempPassword(admin, body, selfId));
      case "reset_mfa": return json(200, await resetMfa(admin, body, selfId));
      case "remove": return json(200, await remove(admin, body, selfId));
      default: return json(400, { error: "unknown action" });
    }
  } catch (err) {
    if (err instanceof Refused) return json(err.status, { error: err.message });
    console.error(`[${FUNCTION}] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    return json(500, { error: "something went wrong; the function log has the detail" });
  }
});
