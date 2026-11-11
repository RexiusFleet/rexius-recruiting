// Rexius Recruiter: user management for admins (the Users page, 2026-11-10).
//
// Before this, adding a person meant Supabase dashboard -> Authentication -> Invite user, then
// scripts/make-profile.sql in the SQL Editor, and an invite sent from the dashboard returned to
// the project's Site URL, which the shared project may point at another app or at localhost.
// This function does both steps in one call, sends the invite back to the tracker's own address,
// and covers the rest of the job: change a role or name, remove access, re-send an invite, and
// clear someone's authenticator apps when they lose their phone.
//
// Scope: only people with a recruiting.profiles row are listed or touched. auth.users is shared
// with the inventory app on the same project, so this function never lists other logins and
// never deletes a login: "remove" deletes the tracker profile, which ends access at once
// (recruiting.current_role() reads the profile on every request), and leaves the login for the
// other app. The last admin can never be removed or demoted (trigger from migration
// 20261115000100, which also covers the SQL Editor and the dashboard).
//
// Request:  POST /functions/v1/recruiting-users   JSON body {action, ...}
//   `Authorization: Bearer <the user's Supabase JWT>`. Admins only, with a two-factor session,
//   checked through recruiting.current_role() like every table policy. The gateway's JWT check is
//   off (`verify_jwt = false`) as for the other tracker functions; the function checks itself.
//   {action: "list"}
//   {action: "invite", email, name, role, redirect_to}
//   {action: "update", user_id, name?, role?}
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
function fail(where: string, err: { message?: string } | null | undefined): never {
  const msg = err?.message ?? "unknown error";
  console.error(`[${FUNCTION}] ${where}: ${msg}`);
  if (/at least one admin/i.test(msg)) throw new Refused(409, "The tracker must keep at least one admin. Make someone else an admin first.");
  throw new Refused(500, `${where}: ${msg}`);
}

interface Profile { user_id: string; role: Role; name: string; location: string | null; created_at: string }

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
  const r = await admin.schema("recruiting").from("profiles").select("user_id, role, name, location, created_at").eq("user_id", userId).maybeSingle();
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
    is_self: p.user_id === selfId,
  };
}

async function list(admin: SupabaseClient, selfId: string): Promise<Json> {
  const r = await admin.schema("recruiting").from("profiles").select("user_id, role, name, location, created_at").order("name");
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

  const existing = await findLoginByEmail(admin, email);
  if (existing) {
    const had = await admin.schema("recruiting").from("profiles").select("user_id").eq("user_id", existing.id).maybeSingle();
    if (had.error) fail("check the profile", had.error);
    if (had.data) throw new Refused(409, `${email} is already a tracker user. Change their role in the list instead.`);
  }

  let userId: string;
  let emailed = false;
  if (existing && existing.email_confirmed_at) {
    // Someone with a working login on the shared project (the other app): give them the role.
    // They sign in with the password they have; the tracker asks them to set up an
    // authenticator on the first sign-in.
    userId = existing.id;
  } else {
    // New, or invited before and never accepted: Supabase (re)sends the invite email.
    const r = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
    if (r.error || !r.data?.user) fail("send the invite", r.error);
    userId = r.data.user.id;
    emailed = true;
  }

  const ins = await admin.schema("recruiting").from("profiles").insert({ user_id: userId, role, name });
  if (ins.error) {
    // Do not leave a fresh login behind without a profile; an existing one is not ours to delete.
    if (!existing) await admin.auth.admin.deleteUser(userId);
    fail("save the profile", ins.error);
  }
  console.log(`[${FUNCTION}] invite: ${role} added by ${selfId}${emailed ? ", email sent" : ", existing login"}`);
  return { user: await describe(admin, await profileOf(admin, userId), selfId), emailed, redirect_to: emailed ? redirectTo : null };
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
  // been used may belong to the other app on this project as well, so it stays.
  const u = await admin.auth.admin.getUserById(p.user_id);
  let loginDeleted = false;
  if (!u.error && u.data?.user && !u.data.user.email_confirmed_at && !u.data.user.last_sign_in_at) {
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

  // 1. Who is calling: an admin with a two-factor session.
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json(401, { error: "sign in first" });
  const asUser = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
  const who = await asUser.auth.getUser(token);
  if (who.error || !who.data.user) return json(401, { error: "invalid session" });
  const role = await asUser.schema("recruiting").rpc("current_role");
  if (role.error) { console.error(`[${FUNCTION}] current_role: ${role.error.message}`); return json(500, { error: "could not check your role" }); }
  if (role.data !== "admin") return json(403, { error: "only admins can manage users" });
  const selfId = who.data.user.id;

  let body: Json;
  try { body = await req.json(); } catch { return json(400, { error: "send a JSON body" }); }
  if (!body || typeof body !== "object") return json(400, { error: "send a JSON body" });

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    switch (body.action) {
      case "list": return json(200, await list(admin, selfId));
      case "invite": return json(200, await invite(admin, body, selfId));
      case "update": return json(200, await update(admin, body, selfId));
      case "resend": return json(200, await resend(admin, body, selfId));
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
