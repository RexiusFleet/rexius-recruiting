#!/usr/bin/env node
// Gives an existing auth user the admin role in recruiting.profiles.
//
//   npm run db:make-admin -- you@rexius.com "Your Name"
//
// Uses the same connection as scripts/db-migrate.mjs: SUPABASE_DB_URL (and optional
// SUPABASE_DB_SSL_CA) from the environment or the gitignored .env at the repo root. The SQL is
// the same as scripts/make-admin.sql, which can be pasted into the dashboard's SQL Editor when
// the connection string is not available.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [email, name] = process.argv.slice(2);
if (!email || !name || !email.includes("@")) {
  console.error('Usage: npm run db:make-admin -- you@rexius.com "Your Name"');
  process.exit(2);
}

const envFile = join(repoRoot, ".env");
if (!process.env.SUPABASE_DB_URL && existsSync(envFile) && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(envFile);
}
const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("SUPABASE_DB_URL is not set. See README.md, manual step 4.");
  process.exit(2);
}

const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(dbUrl);
const clientConfig = { connectionString: dbUrl };
if (!local && !/[?&]sslmode=disable/.test(dbUrl)) {
  clientConfig.ssl = { rejectUnauthorized: true };
  if (process.env.SUPABASE_DB_SSL_CA) {
    clientConfig.ssl.ca = readFileSync(process.env.SUPABASE_DB_SSL_CA, "utf8");
  }
}

const client = new pg.Client(clientConfig);
await client.connect();
try {
  const { rows } = await client.query(
    `insert into recruiting.profiles (user_id, role, name)
     select u.id, 'admin', $2
     from auth.users u
     where lower(u.email) = lower($1)
     on conflict (user_id) do update set role = excluded.role, name = excluded.name
     returning user_id, role, name, created_at`,
    [email, name],
  );
  if (rows.length === 0) {
    console.error(`No auth user has the email ${email}. Create the user first (Dashboard -> Authentication -> Users).`);
    process.exitCode = 1;
  } else {
    const r = rows[0];
    console.log(`${email} is now ${r.role} ("${r.name}"), profile created ${r.created_at.toISOString()}.`);
  }
} finally {
  await client.end();
}
