# Rexius Recruiter

A standalone web app for Rexius' recruiting lead, HR team, and hiring managers. It logs every
job application from three Jotform forms, tracks each one through the pipeline, keeps positions,
postings, and channel spend in one place, and reports on recruiting. `CLAUDE.md` is the full
brief; this file is the operator's guide.

Backend: one Supabase project shared with the inventory app, called `am-projects` throughout
these docs. In the dashboard it is currently named **Apparel** (ref `hibjqcgitqtgmkurghlw`);
the rename to am-projects waits on an organization Administrator and changes nothing that
runs, since every tool here connects by ref, not by name. This app owns the
Postgres schema `recruiting`). Frontend: static HTML/JS in `web/`, run locally for now and on
GitHub Pages later.

## Repo layout

| Path | What it holds | Phase |
| --- | --- | --- |
| `supabase/config.toml` | Supabase CLI config. `recruiting` is in the exposed schemas; auth defaults match the dashboard steps below | 2 |
| `supabase/migrations/` | Database migrations. Applied to the hosted project with `npm run db:migrate`, never with `supabase db push` (see "Two repos, one project"). One file per change, never edited after it has been applied | 2+ |
| `supabase/seed.sql` | Local-only seed: four test sign-ins and sample applications for `db reset` | 3 |
| `supabase/functions/recruiting-jotform-webhook/` | Edge Function that receives Jotform submissions | 5 |
| `scripts/backfill/` | One-time import of existing Jotform submissions and their files (`npm run backfill`, `npm run backfill:test`); its own README explains options and rules | 4 |
| `scripts/db-migrate.mjs` | The migration runner behind `npm run db:migrate`, `npm run db:status` and `npm run db:print` | 2 |
| `scripts/make-admin.mjs`, `scripts/make-admin.sql` | Give an auth user the admin role (`npm run db:make-admin`, or paste the SQL) | 3 |
| `scripts/test-policies.sql` | Policy checks as every role against the local stack | 3 |
| `package.json` | The runner's `pg` dependency, `@supabase/supabase-js` for the backfill, and the npm scripts. The frontend has no build step | 2+ |
| `web/` | The tracker frontend | 6 |
| `docs/` | `database-conventions.md`, `positions-seed.csv` (seeded in Phase 3; department, manager and pay still to fill) | 2+ |
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
applied to the hosted project; that is step 4 below.

## What Phase 3 created in the database

Migrations `20261026000100` to `20261026000400`, all in schema `recruiting`:

- Helpers `is_staff()` (admin or hr), `set_updated_at()` (trigger), `first_stage_id()`,
  `role_rank()`; enums for position status, posting channel, file kind, contact kind and
  direction, offer outcome, feedback verdict and document kind.
- Tables: `stages`, `positions`, `postings`, `channel_spend`, `forms`, `applications`,
  `application_files`, `application_status`, `status_history`, `contacts`, `offers`,
  `referrals`, `manager_feedback`, `documents`. Every one has RLS on and explicit grants.
- Triggers: inserting an application creates its `application_status` row in the first stage
  and the opening `status_history` row; changing `stage_id` stamps `stage_since` and appends to
  `status_history`. The app never writes `status_history` directly (no insert grant).
- View `applications_for_managers`: the only path managers have to applications. It omits the
  raw `answers`, notes, tags, offers, referrals and the contact log, and surfaces education,
  skills and employment history from `answers` through each form's `field_map`.
- Seed data: eight stages (Applied → Hired, plus Not selected and Withdrawn), the three Jotform
  forms with their full question lists and field maps, and 17 positions from
  `docs/positions-seed.csv` (department, manager and pay still blank).

Role summary: admin and hr read and write everything (profiles and application deletes are
admin-only); managers read stages, positions, postings, forms, profiles, documents their
`min_role` allows, and the curated view, and may write their own `manager_feedback`; no profile
or `anon` sees nothing. Checked locally with `scripts/test-policies.sql` and through the local
Data API as each user.

## What Phase 4 created

Migration `20261027000100_storage_bucket_recruiting_files.sql`: the private Storage bucket
`recruiting-files` (25 MiB per file) and one policy on `storage.objects` letting any signed-in
user with a profile read its objects, which is what lets the frontend request short-lived signed
URLs for managers as well as staff. There is no write policy for browser sessions; only
`service_role` (the backfill script and, later, the webhook) writes to the bucket.

`scripts/backfill/`: the import described in `scripts/backfill/README.md`. On the local stack it
imported every submission from the three forms (about 1,600) with their resumes and portfolios,
skipped nothing it had already imported on a second run, and stored none of the driver-licence,
signature or initials answers. Running it against the hosted project is step 10 below.

## Manual steps in Supabase (do these in order)

You need: a terminal with Node 22 or newer (the Supabase CLI runs through `npx`; the
migration runner needs one `npm install`), and access to the `am-projects` project (currently named Apparel) in the Supabase dashboard; steps 1, 5 and 6
need the Administrator or Owner role in the Supabase organization, the rest work as a Developer. Run every command from
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

Get the connection string: Dashboard → **Connect** (button in the top bar) → the **Direct /
Connection string** tile → under **Connection Method** pick **Session pooler** (not Direct, which
is IPv6-only, and not Transaction pooler, which is port 6543) → copy the URI and replace
`[YOUR-PASSWORD]` with the database password from step 3. The host looks like
`aws-1-us-west-2.pooler.supabase.com`; the number and region are the project's own. Put it in a file named `.env` at the root of this repo (copy
`.env.example`), which git ignores:

```
SUPABASE_DB_URL=postgresql://postgres.<ref>:<password>@aws-<n>-<region>.pooler.supabase.com:5432/postgres
```

Then:

```sh
npm install
npm run db:status
npm run db:migrate
npm run db:status
```

The first status lists every migration in `supabase/migrations/` as pending; migrate applies
each inside its own transaction and records it in `recruiting.schema_migrations`; the second
status shows them as applied. In the dashboard, **Table Editor** → schema selector (top left,
says `public`) → pick `recruiting` → you should see the tables. (In a narrow window the table
list is hidden; widen it or use **SQL Editor** → `select * from recruiting.schema_migrations;`.)

**If you cannot get the database password** (resetting it needs the Administrator or Owner role
in the Supabase organization; Developers can only read settings), the same SQL can go through
the dashboard, which connects with your dashboard login instead:

```sh
npm run db:print
```

prints each migration wrapped in `begin; … commit;` with the matching
`recruiting.schema_migrations` row, ready to paste into **SQL Editor** one file at a time, oldest
first, skipping any the history table already lists. The runner recognises them as applied
afterwards, so switching back to `npm run db:migrate` later is seamless.

If the runner reports a certificate error ("self-signed certificate in certificate chain"):
**Project Settings** → **Database** → **SSL Configuration** → download the certificate, and add
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

Then give that user the admin role, either from the repo root (uses the `.env` connection):

```sh
npm run db:make-admin -- you@rexius.com "Your Name"
```

or, without the connection string, open `scripts/make-admin.sql`, change the email and name on
its first `select` line, and run it in **SQL Editor**. Either way the result is one row in
`recruiting.profiles` with role `admin`. Re-running for the same email updates the row rather
than adding a second. Inviting HR and managers through the app arrives in Phase 8; until then
an admin can insert their profile rows the same way with `'hr'` or `'manager'`.

### 8. Where secrets go

| Secret | Needed from | Where to set it |
| --- | --- | --- |
| Database password | Step 3 | Prompted by `supabase link`, or `SUPABASE_DB_PASSWORD` in your shell |
| `SUPABASE_DB_URL` (connection string, contains the password) | Step 4 and every later migration | `.env` at the repo root, gitignored |
| CLI access token | Step 3 | `supabase login`, or `SUPABASE_ACCESS_TOKEN` in your shell |
| `JOTFORM_API_KEY` | Phase 4 (backfill) and 5 (webhook) | For the backfill: `.env` at the repo root (step 10). For the webhook: `npx supabase secrets set --env-file ./supabase/.env` with the key in that gitignored file, or Dashboard → **Edge Functions** → **Secrets** |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Phase 4 (backfill) | `.env` at the repo root. The service-role key is in **Project Settings** → **API Keys**; it bypasses RLS and never goes near the frontend |
| `JOTFORM_WEBHOOK_SECRET` | Phase 5 | Same as above |
| `ANTHROPIC_API_KEY` | Phase 9 | Same as above |

`supabase/.env` and every `.env*` file are gitignored. Jotform's API key comes from Jotform →
account settings → API (a read-only key is enough for the backfill).

### 9. Local development (optional)

The frontend is static, so for day-to-day work it is enough to point `web/` at the hosted
project and serve it locally:

```sh
npx serve web        # http://localhost:3000, which is why that URL is registered in step 6
```

A full local Supabase stack (`npx supabase start`) needs Docker Desktop running and gives you a
throwaway copy of the project: API at `http://127.0.0.1:54321`, Studio at
`http://127.0.0.1:54323`, Postgres at `127.0.0.1:54322`. Its API, auth and redirect settings
come from `supabase/config.toml`, so none of the dashboard steps above apply to it.
`npx supabase db reset` replays `supabase/migrations/` and then `supabase/seed.sql`, which
creates four local sign-ins (password `localdev-password` for all):

| Email | Role |
| --- | --- |
| `admin@local.test` | admin |
| `hr@local.test` | hr |
| `manager@local.test` | manager |
| `nobody@local.test` | none (auth user without a profile; must see nothing) |

plus five invented applications in different stages, a referral, a contact, a posting and a
month of spend. `scripts/test-policies.sql` exercises every policy as each of those users and as
`anon` and `service_role`; run it after any migration change:

```sh
docker exec -i supabase_db_rexius-recruiting psql -U postgres -d postgres -v ON_ERROR_STOP=0 -f - < scripts/test-policies.sql
```

Every line should begin with `PASS`. Its row counts assume the fresh seed, so run it right after
`db reset`, before a backfill. The runner can target the local database too, with
`SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres`, but `db reset` is the
simpler way locally. Starting only what the current phases need is faster:
`npx supabase start -x realtime,imgproxy,inbucket,edge-runtime,logflare,vector,supavisor`
(keep `storage-api`; the backfill uploads to it).

To fill the local stack with real applications, follow step 10 with `SUPABASE_URL` set to
`http://127.0.0.1:54321` and the local service-role key from `npx supabase status`; start with
`--limit 25`.

### 10. Run the backfill (Phase 4)

Order matters: the bucket migration first, then the schema exposed (step 5), then the script.

1. **Apply the migration.** `npm run db:migrate` if `SUPABASE_DB_URL` works for you. If the
   database password is still unavailable, `npm run db:print` and paste the
   `20261027000100_storage_bucket_recruiting_files.sql` block into **SQL Editor**, or send it
   through the Management API the way Phase 3 was applied (the CLI token stays in your keychain;
   nothing is pasted into chat):

   ```sh
   npm run db:print | awk '/20261027000100/,/^commit;$/' > /tmp/bucket.sql &&    curl -s -X POST "https://api.supabase.com/v1/projects/<ref>/database/query"      -H "Authorization: Bearer $(security find-generic-password -s 'Supabase CLI' -w)"      -H "Content-Type: application/json"      --data "$(node -e 'process.stdout.write(JSON.stringify({query: require("fs").readFileSync("/tmp/bucket.sql","utf8")}))')"
   ```

   Check: Dashboard → **Storage** shows a private bucket `recruiting-files`.
2. **Expose the schema** (step 5) if not done yet; the script talks to the Data API.
3. **Put the three variables in `.env`** at the repo root (never in chat or a commit):
   `JOTFORM_API_KEY` (Jotform → account settings → API), `SUPABASE_URL`
   (`https://<ref>.supabase.co`) and `SUPABASE_SERVICE_ROLE_KEY` (**Project Settings** → **API
   Keys** → the `service_role` key on the Legacy tab, or an `sb_secret_…` key). The service-role
   key bypasses RLS; it belongs only in `.env` and in Edge Function secrets.
4. **Dry run, then a small real run, then everything:**

   ```sh
   npm run backfill -- --dry-run
   npm run backfill -- --form 232764918957171 --limit 25
   npm run backfill
   ```

   Expect roughly 1,300 English, 230 Spanish and 55 CAS applications, a few hundred files, and
   zero failures. Re-running is safe; it skips what is already there. `scripts/backfill/README.md`
   has every option and the cleanup rules.
5. **Check in the dashboard.** **Table Editor** → schema `recruiting` → `applications` has the
   rows and `application_status` has one row per application in stage "Applied"; **Storage** →
   `recruiting-files` → `applications/` has one folder per form.

Delete the service-role key from `.env` afterwards if you prefer; the webhook (Phase 5) gets its
own copy as a function secret.

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
