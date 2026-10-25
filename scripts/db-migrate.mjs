#!/usr/bin/env node
// Applies supabase/migrations/*.sql to the hosted database, tracking what has been applied in
// recruiting.schema_migrations.
//
// Why not `supabase db push`: the Supabase CLI keeps one migration history per project
// (supabase_migrations.schema_migrations) and refuses to push while that table lists a version
// it cannot find locally. The inventory app shares the am-projects project from its own,
// unrelated repository. If both repos used `db push`, each would break the other's. This runner
// never touches the CLI's history table, so the inventory app can use the CLI however it likes
// and never needs to know this repo exists.
//
// Usage (from the repo root; needs `npm install` once):
//   npm run db:migrate              apply pending migrations, oldest first, one transaction each
//   npm run db:migrate -- --dry-run list what would be applied
//   npm run db:status               show applied and pending migrations
//
// Connection: SUPABASE_DB_URL in the environment or in a gitignored .env file at the repo root.
// Use the project's *Session pooler* connection string (port 5432), not the transaction pooler
// (port 6543): this script relies on an advisory lock and transactions, which need a session.
//
// Rules for migration files:
//   * YYYYMMDDHHMMSS_description.sql, applied in version order, never edited after it has been
//     applied here (the checksum is recorded and a change is reported).
//   * Each file runs inside one transaction, so a failure leaves the database as it was. That
//     also means no statements that refuse to run in a transaction (create index concurrently,
//     vacuum, alter type ... add value used in the same file).
//   * Plain SQL only: no psql meta-commands such as \echo or \i.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(repoRoot, "supabase", "migrations");
const HISTORY = "recruiting.schema_migrations";
const LOCK_KEY = "rexius-recruiting:migrations";

const flags = new Set(process.argv.slice(2));
const dryRun = flags.has("--dry-run");
const statusOnly = flags.has("--status");
for (const f of flags) {
  if (!["--dry-run", "--status"].includes(f)) {
    console.error(`Unknown option ${f}. Use --dry-run or --status.`);
    process.exit(2);
  }
}

const envFile = join(repoRoot, ".env");
if (!process.env.SUPABASE_DB_URL && existsSync(envFile) && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(envFile);
}
const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error(
    "SUPABASE_DB_URL is not set.\n" +
      "Put the project's Session pooler connection string in a .env file at the repo root:\n" +
      "  SUPABASE_DB_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres\n" +
      "Dashboard -> Connect (top bar) -> Session pooler. .env is gitignored; never commit it.",
  );
  process.exit(2);
}

const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(dbUrl);
const clientConfig = { connectionString: dbUrl };
if (!local && !/[?&]sslmode=disable/.test(dbUrl)) {
  // Verify the server certificate against the system trust store, or against Supabase's own CA
  // if SUPABASE_DB_SSL_CA points at the certificate downloaded from Project Settings -> Database.
  clientConfig.ssl = { rejectUnauthorized: true };
  if (process.env.SUPABASE_DB_SSL_CA) {
    clientConfig.ssl.ca = readFileSync(process.env.SUPABASE_DB_SSL_CA, "utf8");
  }
}

function loadLocalMigrations() {
  if (!existsSync(migrationsDir)) return [];
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const seen = new Map();
  const out = [];
  for (const file of files) {
    const m = /^(\d{14})_([A-Za-z0-9_-]+)\.sql$/.exec(file);
    if (!m) {
      throw new Error(`${file}: migration files must be named YYYYMMDDHHMMSS_description.sql`);
    }
    const [, version, name] = m;
    if (seen.has(version)) {
      throw new Error(`Two migrations share version ${version}: ${seen.get(version)} and ${file}`);
    }
    seen.set(version, file);
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    out.push({ file, version, name, sql, checksum: createHash("sha256").update(sql).digest("hex") });
  }
  return out;
}

async function ensureHistory(client) {
  // The history table lives in the app's schema but is granted to nobody: the Data API never
  // sees it (no privileges means PostgREST does not list it), and RLS is on by convention.
  await client.query(`
    create schema if not exists recruiting;
    create table if not exists ${HISTORY} (
      version    text primary key,
      name       text not null,
      checksum   text not null,
      applied_at timestamptz not null default now()
    );
    alter table ${HISTORY} enable row level security;
    comment on table ${HISTORY} is
      'Migrations applied by scripts/db-migrate.mjs. Separate from the Supabase CLI''s history table on purpose.';
  `);
}

async function main() {
  const migrations = loadLocalMigrations();
  const client = new pg.Client(clientConfig);
  try {
    await client.connect();
  } catch (err) {
    if (/self.signed|certificate/i.test(String(err.message))) {
      console.error(
        `Could not verify the database server's certificate: ${err.message}\n` +
          "Download the CA certificate from Dashboard -> Project Settings -> Database -> SSL " +
          "and set SUPABASE_DB_SSL_CA=/path/to/that/file.crt in .env.",
      );
      process.exit(1);
    }
    throw err;
  }

  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [LOCK_KEY]);
    await ensureHistory(client);
    const { rows } = await client.query(`select version, name, checksum, applied_at from ${HISTORY} order by version`);
    const applied = new Map(rows.map((r) => [r.version, r]));

    const pending = migrations.filter((m) => !applied.has(m.version));
    const changed = migrations.filter((m) => applied.has(m.version) && applied.get(m.version).checksum !== m.checksum);
    const orphaned = rows.filter((r) => !migrations.some((m) => m.version === r.version));

    for (const m of changed) {
      console.warn(`warning: ${m.file} was edited after it was applied. Put the change in a new migration instead.`);
    }
    for (const r of orphaned) {
      console.warn(`warning: version ${r.version} (${r.name}) is applied on the database but has no file here. Is your checkout up to date?`);
    }

    if (statusOnly || dryRun) {
      for (const m of migrations) {
        const a = applied.get(m.version);
        console.log(`${a ? "applied " + a.applied_at.toISOString().slice(0, 16).replace("T", " ") : "pending                 "}  ${m.file}`);
      }
      if (pending.length === 0) console.log("Nothing pending.");
      else if (dryRun) console.log(`${pending.length} migration(s) would be applied.`);
      return;
    }

    if (pending.length === 0) {
      console.log("Nothing pending. The database is up to date.");
      return;
    }

    for (const m of pending) {
      process.stdout.write(`Applying ${m.file} ... `);
      try {
        await client.query("begin");
        await client.query(m.sql);
        await client.query(`insert into ${HISTORY} (version, name, checksum) values ($1, $2, $3)`, [m.version, m.name, m.checksum]);
        await client.query("commit");
        console.log("ok");
      } catch (err) {
        await client.query("rollback").catch(() => {});
        console.log("FAILED");
        const where = err.position ? ` (at character ${err.position})` : "";
        console.error(`${m.file}: ${err.message}${where}`);
        if (err.hint) console.error(`hint: ${err.hint}`);
        console.error("Rolled back. Nothing from this file was applied; earlier files in this run stay applied.");
        process.exitCode = 1;
        return;
      }
    }
    console.log(`Applied ${pending.length} migration(s).`);
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
