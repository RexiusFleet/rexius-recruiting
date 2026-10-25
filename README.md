# Rexius Recruiter

A standalone web app for Rexius' recruiting lead, HR team, and hiring managers. It logs every
job application from three Jotform forms, tracks each one through the pipeline, keeps positions,
postings, and channel spend in one place, and reports on recruiting. `CLAUDE.md` is the full
brief; this file is the operator's guide.

Backend: Supabase project `am-projects` (shared with the inventory app; this app owns the
Postgres schema `recruiting`). Frontend: static HTML/JS in `web/`, run locally for now and on
GitHub Pages later.

## Repo layout

| Path | What it holds | Phase |
| --- | --- | --- |
| `supabase/config.toml` | Supabase CLI config. `recruiting` is in the exposed schemas; auth defaults match the dashboard steps below | 2 |
| `supabase/migrations/` | Database migrations, applied with `npx supabase db push`. One file per change, never edited after it has been pushed | 2+ |
| `supabase/seed.sql` | Local-only seed for `npx supabase start` / `db reset` | 3 |
| `supabase/functions/recruiting-jotform-webhook/` | Edge Function that receives Jotform submissions | 5 |
| `scripts/backfill/` | One-time import of existing Jotform submissions | 4 |
| `scripts/sync-migration-stubs.mjs` | Keeps `db push` working alongside the inventory app's repo (see "Two repos, one project") | 2 |
| `web/` | The tracker frontend | 6 |
| `docs/` | `database-conventions.md`, `positions-seed.csv` (fill in before Phase 3) | 2+ |
| `reference/` | Jotform question maps, submission shape, the Phase 0 prototype | 0 |

## What Phase 2 created in the database

Migration `20261025000000_create_recruiting_schema_and_profiles.sql`:

- Schema `recruiting`, with `usage` granted to `authenticated` and `service_role` only. The
  `anon` role gets nothing, so an unsigned-in request fails before it reaches a table.
- Enum `recruiting.user_role`: `admin`, `hr`, `manager`.
- Table `recruiting.profiles`: `user_id` (FK to `auth.users`), `role`, `name`, `location`,
  `created_at`. Row-level security is on. Anyone with a profile can read all profiles. Only
  admins can insert, update, or delete. A signed-in user with no profile row sees nothing.
- Function `recruiting.current_role()`: returns the calling user's role or null. Every later
  policy uses it.

The migration was run through the Supabase CLI against a local Postgres 16 with the policies
exercised as admin, HR, a user with no profile, `anon`, and `service_role`. It has not yet been
applied to `am-projects`; that is step 4 below.

## Manual steps in Supabase (do these in order)

You need: a terminal with Node 18 or newer (the CLI runs through `npx`, nothing to install),
and owner access to the `am-projects` project in the Supabase dashboard. Run every command from
the root of this repo.

Never paste a key, password, or token into chat, a file in this repo, or a commit. Everything
secret is set either in the dashboard or as an environment variable in your own shell. The
`.gitignore` keeps `.env` files and the CLI's link state out of git.

### 1. Confirm the project is on a paid plan

Dashboard → your organization → **Billing**. The plan must be Pro (or higher). Free projects
pause after 7 idle days, which would silently drop the Jotform webhook once Phase 5 is live.

### 2. Collect the project's public details

- **Project ref**: Dashboard → **Project Settings** → **General** → "Project ID". It is 20
  lowercase letters. The project URL is `https://<ref>.supabase.co`.
- **Public key for the frontend**: **Project Settings** → **API Keys**. Use the **publishable
  key** (`sb_publishable_…`). If the page shows only the Legacy tab, the `anon` key does the same
  job. Either is safe to ship in the browser; RLS does the protecting. Do not copy the
  `service_role` or `sb_secret_` key anywhere.
- **Postgres version**: Dashboard → **SQL Editor** → run `show server_version;`. If the major
  version is not 17, change `major_version` under `[db]` in `supabase/config.toml` to match (the
  local Docker stack must match the hosted database; the migration itself runs on 15, 16, or 17).

### 3. Link the CLI to the project

```sh
npx supabase login
```

This opens a browser to approve the CLI. If a browser is not available, create a personal
access token at Dashboard → account menu → **Access Tokens**, then run
`npx supabase login --token <token>` (the token stays in your home directory, not in the repo).
Alternatively export it as `SUPABASE_ACCESS_TOKEN` in your shell for the session.

```sh
npx supabase link --project-ref <ref>
```

The CLI asks for the database password. That is the password you chose when creating the
project. If you do not have it: **Project Settings** → **Database** → **Reset database
password**. To avoid the prompt in future runs, export it as `SUPABASE_DB_PASSWORD` for the
session. The link state is written to `supabase/.temp/`, which is gitignored.

The link command may print a warning that the local config differs from the remote project
(auth and API settings). That is expected until steps 5 and 6 are done.

### 4. Apply the migration

```sh
node scripts/sync-migration-stubs.mjs
npx supabase db push --dry-run
npx supabase db push
npx supabase migration list
```

The first command only matters once the inventory app has pushed migrations of its own to
`am-projects` (see "Two repos, one project" below); today it prints that there is nothing to do.
The dry run lists `20261025000000_create_recruiting_schema_and_profiles.sql`; the real push
asks for confirmation and applies it; the list shows the same version under both Local and
Remote. Then in the dashboard, **Table Editor** → schema selector (top left, says `public`) →
pick `recruiting` → you should see `profiles`.

### 5. Expose the `recruiting` schema in the Data API

Dashboard → **Project Settings** → **Data API** → **Exposed schemas** → add `recruiting` → Save.
Leave `public` in the list; the inventory app uses it.

Check from a terminal (replace the two placeholders):

```sh
curl -s "https://<ref>.supabase.co/rest/v1/profiles?select=user_id" \
  -H "apikey: <publishable key>" \
  -H "Authorization: Bearer <publishable key>" \
  -H "Accept-Profile: recruiting"
```

Expected result: an error whose message says `permission denied for schema recruiting`. That is
correct: the request ran as `anon`, which has no access by design. If instead the message says
the schema must be one of `public, graphql_public`, the schema is not exposed yet; wait a minute
after saving and retry.

### 6. Auth settings

Dashboard → **Authentication** → **URL Configuration**:

- **Site URL**: `http://localhost:3000`
- **Redirect URLs**: add `http://localhost:3000/**` and `http://127.0.0.1:3000/**`

Phase 8 adds the GitHub Pages URL here and moves Site URL to it.

Dashboard → **Authentication** → **Sign In / Providers**:

- **Email** provider: enabled (it is by default). Keep "Confirm email" on.
- **Allow new users to sign up**: turn **off**. Users are invited by an admin; nobody should be
  able to create an account from the login page. (Admin-created users and invites still work
  with this off.)

Do these in the dashboard, not with `npx supabase config push`. Auth URLs and exposed schemas
are project-wide settings shared with the inventory app, and a config push from either repo
would replace them with that repo's `config.toml`. `npx supabase config diff` is safe to run to
compare, and `config.toml` still drives the local Docker stack.

### 7. Create your own admin user

Dashboard → **Authentication** → **Users** → **Add user** → **Create new user**. Enter your
Rexius email and a password (10 characters or more) and tick **Auto Confirm User**.

Then **SQL Editor** → new query → run, with your email substituted:

```sql
insert into recruiting.profiles (user_id, role, name)
select id, 'admin', 'Your Name'
from auth.users
where email = 'you@rexius.com';
```

Check with `select * from recruiting.profiles;` — one row, role `admin`. Phase 3 adds the same
SQL as a reusable script and the invite flow for HR and managers arrives in Phase 8.

### 8. Where secrets go (nothing to set yet)

| Secret | Needed from | Where to set it |
| --- | --- | --- |
| Database password | Step 3 | Prompted by `supabase link`, or `SUPABASE_DB_PASSWORD` in your shell |
| CLI access token | Step 3 | `supabase login`, or `SUPABASE_ACCESS_TOKEN` in your shell |
| `JOTFORM_API_KEY` | Phase 4 (backfill) and 5 (webhook) | `npx supabase secrets set --env-file ./supabase/.env` with the key in that gitignored file, or Dashboard → **Edge Functions** → **Secrets**. The backfill script reads it from your local environment |
| `JOTFORM_WEBHOOK_SECRET` | Phase 5 | Same as above |
| `ANTHROPIC_API_KEY` | Phase 9 | Same as above |

`supabase/.env` and every `.env*` file are gitignored. Jotform's API key comes from Jotform →
account settings → API; that happens in Phase 4.

### 9. Local development (optional)

The frontend is static, so for day-to-day work it is enough to point `web/` at the hosted
project and serve it locally:

```sh
npx serve web        # http://localhost:3000, which is why that URL is registered in step 6
```

A full local Supabase stack (`npx supabase start`) needs Docker Desktop and gives you a
throwaway database at `http://127.0.0.1:54321` with Studio at `http://127.0.0.1:54323`.
`npx supabase db reset` replays the migrations and `supabase/seed.sql` into it. This is useful
from Phase 3 on; nothing in Phase 2 requires it.

## Two repos, one project

The inventory app lives in its own repository and shares `am-projects`. Three things follow.

**Schemas.** This app creates objects only in schema `recruiting` (plus its own Storage bucket
and `recruiting-` prefixed Edge Functions). The inventory app must do the same in its own
schema and never touch `recruiting`. `auth.users` is shared; each app keeps its own `profiles`
table.

**Migration history.** The Supabase CLI records every applied migration in one table per project
(`supabase_migrations.schema_migrations`) and `supabase db push` refuses to run while that table
lists a version that has no file in the local `supabase/migrations/` folder. So once the
inventory repo has pushed, a push from this repo fails with "Remote migration versions not found
in local migrations directory", and the other way round. Do not follow the CLI's suggestion to
run `migration repair --status reverted`: that erases the other app's history and its next push
would re-run its migrations.

Instead run `node scripts/sync-migration-stubs.mjs` before every `db push`. It asks the project
which versions are applied and writes an empty placeholder file
(`<version>_external_app_placeholder.sql`) for each one this repo lacks. The CLI then treats
those versions as applied and pushes only this repo's new migrations. Commit the placeholders.
The inventory repo needs a copy of the same script (change the suffix so the two sets of
placeholders are told apart). The script was tested against a database seeded with foreign
history entries: the push failed before, and succeeded after, with only the new file applied.

Two rules keep it painless:

- Name new migrations with the current timestamp, so they sort after everything already on the
  project. If a push complains that a local file sorts before the last remote migration, rename
  the file with a fresh timestamp rather than using `--include-all`.
- Run the sync script and commit its output as part of the same pull request as the migration.

**Project-wide settings.** Exposed schemas, auth URLs, signup, and email settings are shared.
Change them in the dashboard, adding to what is there rather than replacing it, and never run
`supabase config push` from either repo.

## Conventions

See `docs/database-conventions.md` for the rules every migration follows (schema, grants, RLS,
naming, personal-information handling). The phase plan and the Jotform field maps are in
`CLAUDE.md`.
