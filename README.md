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
| `supabase/migrations/` | Database migrations. Applied to the hosted project with `npm run db:migrate`, never with `supabase db push` (see "Two repos, one project"). One file per change, never edited after it has been applied | 2+ |
| `supabase/seed.sql` | Local-only seed for `npx supabase start` / `db reset` | 3 |
| `supabase/functions/recruiting-jotform-webhook/` | Edge Function that receives Jotform submissions | 5 |
| `scripts/backfill/` | One-time import of existing Jotform submissions | 4 |
| `scripts/db-migrate.mjs` | The migration runner behind `npm run db:migrate` and `npm run db:status` | 2 |
| `package.json` | Only the runner's `pg` dependency and the npm scripts. The frontend has no build step | 2 |
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

You need: a terminal with Node 20.12 or newer (the Supabase CLI runs through `npx`; the
migration runner needs one `npm install`), and owner access to the `am-projects` project in the Supabase dashboard. Run every command from
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
(auth and API settings). That is expected until steps 5 and 6 are done. Linking is for Edge
Functions and secrets in later phases; migrations do not go through it (next step).

### 4. Apply the migration

Migrations are applied by this repo's own runner, not by `npx supabase db push`. The reason is
in "Two repos, one project" below; the short version is that `db push` would make the
inventory app's CLI stop working on the shared project.

Get the connection string: Dashboard → **Connect** (button in the top bar) → **Session pooler**
tab (not Transaction pooler) → copy the URI and replace `[YOUR-PASSWORD]` with the database
password from step 3. Put it in a file named `.env` at the root of this repo (copy
`.env.example`), which git ignores:

```
SUPABASE_DB_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

Then:

```sh
npm install
npm run db:status
npm run db:migrate
npm run db:status
```

The first status shows `20261025000000_create_recruiting_schema_and_profiles.sql` as pending;
migrate applies it inside a transaction and records it in `recruiting.schema_migrations`; the
second status shows it as applied. In the dashboard, **Table Editor** → schema selector (top
left, says `public`) → pick `recruiting` → you should see `profiles` and `schema_migrations`.

If the runner reports a certificate error: **Project Settings** → **Database** → **SSL
Configuration** → download the certificate, and add
`SUPABASE_DB_SSL_CA=/path/to/prod-ca-2021.crt` to `.env`.

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
| `SUPABASE_DB_URL` (connection string, contains the password) | Step 4 and every later migration | `.env` at the repo root, gitignored |
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
from Phase 3 on; nothing in Phase 2 requires it. The runner can target it too, with
`SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres`, but `db reset` is the
simpler way locally.

## Two repos, one project

The inventory app is its own project in its own repository and environment; the only thing it
shares with this one is the `am-projects` Supabase project. Nothing in the inventory repo needs
to know this repo exists. Three things make that hold.

**Schemas.** This app creates objects only in schema `recruiting`, plus its own Storage bucket
and `recruiting-` prefixed Edge Functions. `auth.users` is shared; each app keeps its own
`profiles` table. The inventory app's only obligations are to use its own schema and not touch
`recruiting`.

**Migrations.** The Supabase CLI keeps one migration history per project
(`supabase_migrations.schema_migrations`), and `supabase db push` refuses to run while that
table lists a version it cannot find locally. If both repos used `db push`, each would break the
other's. So this repo never uses `db push`: `npm run db:migrate` applies files from
`supabase/migrations/` and records them in its own table, `recruiting.schema_migrations`. The
CLI's history table is never created or written by this repo, so the inventory repo can use
`db push`, `db pull`, or whatever it likes. (If it runs `db pull` or `db diff` it will see the
`recruiting` schema in the database; scoping those commands to its own schema with `-s` keeps
its files clean. That is its choice and nothing here depends on it.)

Do not run `npx supabase db push` from this repo, even once: it would write this app's versions
into the CLI's history and the inventory app's next push would fail. `npx supabase migration
list` and `db pull` are also not useful here. The local Docker stack is unaffected:
`npx supabase start` and `db reset` still apply `supabase/migrations/` locally.

**Project-wide settings.** Exposed schemas, auth URLs, signup, and email settings are shared.
Change them in the dashboard, adding to what is there rather than replacing it, and never run
`supabase config push` from this repo. `config.toml` drives only the local Docker stack.

## Conventions

See `docs/database-conventions.md` for the rules every migration follows (schema, grants, RLS,
naming, personal-information handling). The phase plan and the Jotform field maps are in
`CLAUDE.md`.
