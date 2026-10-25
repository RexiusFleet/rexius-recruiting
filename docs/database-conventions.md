# Database conventions

Rules every migration in `supabase/migrations/` follows. Phase 2 established them; later phases
must not drift from them without updating this file.

## Schema and ownership

- Everything the app owns is in schema `recruiting`: tables, views, enums, functions, triggers.
  Nothing is created in `public`, which belongs to the inventory app sharing the project.
- `auth.users` is shared with the inventory app. Each app has its own `profiles` table in its own
  schema; a person can have a row in both.
- Storage uses the bucket `recruiting-files` (Phase 4). Edge Functions are prefixed
  `recruiting-`.

## Grants

Objects in a custom schema are invisible to the Data API until granted, so every migration grants
explicitly. There are no default privileges set on the schema; forgetting a grant fails closed.

| Role | Gets |
| --- | --- |
| `anon` | Nothing. Not even `usage` on the schema. The frontend always sends a signed-in user's JWT |
| `authenticated` | `usage` on the schema; `select`/`insert`/`update`/`delete` on tables as the feature needs; `execute` on helper functions. RLS filters the rows |
| `service_role` | `all` on tables; `execute` on functions. Used only by the backfill script and Edge Functions, never by the browser |

Functions are executable by `public` by default in Postgres. Every function the app creates does
`revoke execute … from public` and then grants `authenticated` and `service_role` as needed.

## Row-level security

- `alter table … enable row level security` appears in the same migration that creates the
  table, before any grant on it.
- Policies are written `to authenticated` and use `recruiting.current_role()`, which returns
  `admin`, `hr`, `manager`, or null (no profile). Null means no access everywhere.
- Policy names are `"<table>: <who> can <verb> <what>"` so `pg_policies` reads as a sentence.
- Role matrix (from CLAUDE.md section 7):
  - `admin`: read and write everything, including `profiles`.
  - `hr`: read and write everything except `profiles`.
  - `manager`: read only, and only through curated views that omit notes, offers, and the raw
    `answers` JSON. Managers get `select` on those views and nothing on the underlying tables.
- Helper functions used inside policies are `security definer` with `set search_path = ''` and
  fully schema-qualified references, so they can read `profiles` without recursing through its
  own policies and cannot be hijacked by a malicious search path.

## Shared project

The inventory app shares the Supabase project from its own, unrelated repository. This repo
applies migrations with `npm run db:migrate` (`scripts/db-migrate.mjs`), which records them in
`recruiting.schema_migrations`, and never with `supabase db push`, which would write to the
CLI's project-wide history table and break the inventory app's pushes. Never run `supabase
config push` either; project-wide settings are changed in the dashboard. README.md, "Two repos,
one project", has the reasoning.

Consequences for writing migrations: each file runs in one transaction (so no `create index
concurrently` or other statements that refuse to run inside a transaction; an enum value added
with `alter type … add value` cannot be used in the same file), plain SQL only (no psql
meta-commands), and a file is never edited after it has been applied (the runner stores a
checksum and warns).

## Naming

- Migrations: `YYYYMMDDHHMMSS_short_description.sql`, lower snake case. Once a migration has been
  pushed to the hosted project it is never edited; write a new one.
- Tables plural, columns snake case, timestamps `timestamptz` ending in `_at`, foreign keys
  `<table singular>_id`.
- Enums are `recruiting.<thing>` (`user_role`, later `stage`, `channel`, `offer_outcome`, …).

## Personal information

CLAUDE.md section 5 is binding. In the database that means: no column anywhere for Social
Security numbers, bank details, dates of birth, government IDs, wages, or signed offer letters;
driver licence, signature, and initials answers are dropped before `answers` is written; resumes
are private objects in Storage served through short-lived signed URLs.

## Local validation before pushing

Before `npm run db:migrate` against the hosted project, apply the new migration to a local database (`npx supabase db
reset` with Docker, or any Postgres 15–17 with stand-ins for the `auth` schema and the three
roles) and exercise the policies as each role. Phase 2's migration was checked that way.
