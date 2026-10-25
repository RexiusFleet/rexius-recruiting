#!/usr/bin/env node
// Keeps `supabase db push` working when another repo shares the same Supabase project.
//
// The Supabase CLI records every applied migration in one history table per project
// (supabase_migrations.schema_migrations) and refuses to push while that table lists versions
// that have no file in this repo's supabase/migrations/. The inventory app pushes its own
// migrations to am-projects from its own repo, so this script asks the project which versions
// are applied, and for each one this repo does not have, writes an empty placeholder file with
// the same version. The CLI then treats those versions as already applied and pushes only this
// repo's new migrations. Placeholders are no-ops if ever run locally (`supabase db reset`).
//
// Usage (from the repo root, after `npx supabase link`):
//   node scripts/sync-migration-stubs.mjs            # linked project
//   node scripts/sync-migration-stubs.mjs --dry-run  # show what would be written
// Any other arguments (for example --db-url ...) are passed through to `supabase migration list`.
//
// The inventory app's repo needs the same script with the placeholder suffix changed.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLACEHOLDER_SUFFIX = "_external_app_placeholder.sql";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(repoRoot, "supabase", "migrations");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const passthrough = args.filter((a) => a !== "--dry-run");
const target = passthrough.some((a) => a.startsWith("--db-url") || a.startsWith("--project-ref"))
  ? []
  : ["--linked"];

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(
  npx,
  ["-y", "supabase@latest", "migration", "list", "--output-format", "json", ...target, ...passthrough],
  { cwd: repoRoot, encoding: "utf8", shell: process.platform === "win32" },
);
if (result.error) {
  console.error(`Could not run the Supabase CLI: ${result.error.message}`);
  process.exit(1);
}

// The JSON object is the last line of stdout; progress text goes to stderr.
const jsonLine = (result.stdout || "").trim().split("\n").filter((l) => l.startsWith("{")).pop();
let listing;
try {
  listing = JSON.parse(jsonLine);
} catch {
  console.error("Unexpected output from `supabase migration list`:");
  console.error(result.stdout, result.stderr);
  process.exit(1);
}
if (listing._tag === "Error" || !Array.isArray(listing.migrations)) {
  console.error(listing.error?.message || "supabase migration list failed");
  if (listing.error?.suggestion) console.error(listing.error.suggestion);
  process.exit(1);
}

mkdirSync(migrationsDir, { recursive: true });
const localVersions = new Set(
  readdirSync(migrationsDir)
    .map((f) => /^(\d{14})_.*\.sql$/.exec(f)?.[1])
    .filter(Boolean),
);

const missing = listing.migrations
  .filter((m) => m.remote && !m.local && !localVersions.has(m.remote))
  .map((m) => m.remote);

if (missing.length === 0) {
  console.log("Every applied migration on the project has a file here. Nothing to do.");
  process.exit(0);
}

for (const version of missing) {
  const file = join(migrationsDir, `${version}${PLACEHOLDER_SUFFIX}`);
  const body =
    `-- Placeholder for migration ${version}, applied to the shared Supabase project by another\n` +
    `-- app's repository. It exists so that \`supabase db push\` from this repo sees the version as\n` +
    `-- already applied. Intentionally empty. Do not delete while the project's migration history\n` +
    `-- still lists this version.\n`;
  if (dryRun) {
    console.log(`would write ${file}`);
  } else if (existsSync(file)) {
    console.log(`already present ${file}`);
  } else {
    writeFileSync(file, body);
    console.log(`wrote ${file}`);
  }
}
if (!dryRun) {
  console.log("Commit the placeholder files so the next `supabase db push` works for everyone.");
}
