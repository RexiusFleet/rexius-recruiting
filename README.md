# Rexius Recruiter

A standalone web app for Rexius' recruiting lead, HR team, and hiring managers. It logs every
job application from three Jotform forms, tracks each one through the pipeline, keeps positions,
postings, and channel spend in one place, and reports on recruiting. `CLAUDE.md` is the full
brief; this file is the operator's guide.

Backend: one Supabase project shared with the inventory app, called `am-projects` throughout
these docs. In the dashboard it is currently named **Apparel** (ref `hibjqcgitqtgmkurghlw`);
the rename to am-projects waits on an organization Administrator and changes nothing that
runs, since every tool here connects by ref, not by name. This app owns the
Postgres schema `recruiting`). Frontend: static HTML/JS in `web/`, run locally during development and
published to GitHub Pages at https://rexiusfleet.github.io/rexius-recruiting/ (step 13).

## Repo layout

| Path | What it holds | Phase |
| --- | --- | --- |
| `supabase/config.toml` | Supabase CLI config. `recruiting` is in the exposed schemas; auth defaults match the dashboard steps below | 2 |
| `supabase/migrations/` | Database migrations. Applied to the hosted project with `npm run db:migrate`, never with `supabase db push` (see "Two repos, one project"). One file per change, never edited after it has been applied | 2+ |
| `supabase/seed.sql` | Local-only seed: four test sign-ins and sample applications for `db reset` | 3 |
| `supabase/functions/recruiting-jotform-webhook/` | Edge Function that receives Jotform's webhook for each new submission, fetches the submission from Jotform's API and inserts it with the backfill's rules (step 14; its README has the request and response shapes) | 5 |
| `supabase/functions/_shared/clean.mjs` | The cleanup, field-map and never-import rules, one submission in and one `applications` row plus its files out. Canonical copy, used by the webhook and re-exported by `scripts/backfill/lib/clean.mjs` | 4, 5 |
| `supabase/functions/recruiting-retention/` | Edge Function the daily job calls to delete the files of applications past the six-month retention ("What the contact-retention change created") | retention |
| `supabase/functions/.env.example` | Names of the webhook's local variables; copy to the gitignored `supabase/functions/.env` for `functions serve` | 5 |
| `scripts/webhook-test/stub-jotform.mjs` | Stand-in for api.jotform.com (one made-up submission and resume) so the webhook can be tested on the local stack with no key and no real data (`npm run webhook:stub`) | 5 |
| `scripts/backfill/` | One-time import of existing Jotform submissions and their files (`npm run backfill`, `npm run backfill:test`); its own README explains options and rules | 4 |
| `scripts/db-migrate.mjs` | The migration runner behind `npm run db:migrate`, `npm run db:status` and `npm run db:print` | 2 |
| `scripts/make-admin.mjs`, `scripts/make-admin.sql` | Give an auth user the admin role (`npm run db:make-admin`, or paste the SQL) | 3 |
| `scripts/test-policies.sql` | Policy checks as every role against the local stack (126 checks after Phase 7 and manual entry) | 3+ |
| `package.json` | The runner's `pg` dependency, `@supabase/supabase-js` for the backfill, and the npm scripts. The frontend has no build step | 2+ |
| `web/pdf-kit.js`, `web/assets/fonts/` | The shared page frame, type and page-break rules for every PDF the tracker builds (application hand-off, market check, national check), and the four Public Sans weights it embeds (SIL Open Font License, `OFL.txt` beside them). See "What the PDF restyle created" | 9a+ |
| `scripts/pdf-samples/` | `npm run pdf:samples` renders the three PDFs from invented data into the gitignored `out/` folder, so a layout change can be checked without signing in | 9a+ |
| `web/` | The frontend: `index.html`, `styles.css`, `app.js` (sign-in, Applications, drawer, the Add application form for paper applications), `positions.js`, `documents.js`, `reports.js`, `config.js` (project URL and publishable key only). No build step | 6, 7 |
| `.claude/launch.json` | Lets the Claude desktop app start `npx serve web` on port 3000 for the in-app browser | 6 |
| `.github/workflows/pages.yml` | Publishes `web/` to GitHub Pages on every push to `main`, writing `config.js` from two repository variables on the way (step 13) | 8 |
| `scripts/make-profile.sql` | Give an invited user a role (`admin`, `hr` or `manager`) by pasting into SQL Editor | 8 |
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

## What Phase 6 created

Migration `20261028000100_manager_view_files.sql`: the curated view `applications_for_managers`
gains a `files` column (storage path, original name and kind of each resume or portfolio). Managers
have no select on `application_files`, so without it they could see that an applicant has a resume
but not open it. Nothing else in the view changed.

`web/`: the tracker. Plain HTML, CSS and JavaScript loading `@supabase/supabase-js` 2.118.0 from a
pinned jsDelivr URL, with the client created on schema `recruiting`. Email and password sign-in
through Supabase Auth, session persisted in the browser. After sign-in the app reads the user's
`profiles` row and:

- **admin / hr** get the full tracker over `applications` (joined to `application_status`,
  `application_files`, `forms`, `positions`): pipeline strip with clickable stage counts, filters
  (stage, form, location, position, source, date range, has resume, applied more than once, free
  text over name/email/phone/position), dense table sorted by submitted date with "Show more"
  paging at 100 rows, detail drawer with contact, application, education, skills and employment
  history read from `answers` through the form's `field_map`, resumes and portfolios opened through
  5-minute signed URLs from bucket `recruiting-files`, link to the Jotform submission, status change
  inline (the trigger writes `status_history`, shown in the drawer), assignee, tags and notes
  editing, duplicate badge and links when another application shares the email or phone, contact
  log (list and add), manager feedback (read), every answer with its question label, CSV export
  of the current filtered set with every column.
- **manager** gets the same screen fed from `applications_for_managers`: status as a read-only
  pill, no notes, tags, contact log, offers or raw answers, resumes through signed URLs, and a
  "Your feedback" form writing their own `manager_feedback` row. CSV export has the curated
  columns only.
- **no profile** sees a "No access, ask an admin" page with a sign-out button; the only request the
  app makes for them is the profile lookup, which returns nothing.

Verified in the browser against the local stack with all four `*@local.test` users, including
phone width (the filter rail collapses behind a Filters button; the table scrolls sideways).

## What Phase 7 created

Four migrations, all in schema `recruiting` (plus policies on `storage.objects` for this app's
bucket only):

- `20261029000100_position_aliases_and_matching.sql`: table `position_aliases` (text + location
  → position; unique per location ignoring case; anyone with a profile reads, staff write);
  `match_position(text, location)` (exact dropdown label, then title, then alias, all
  case-insensitive, open positions first); `relink_applications(p_all)` (sets `position_id` on
  applications that have none; staff only, returns the number changed); a `before insert`
  trigger on `applications` that runs the same matching so the webhook and backfill get aliases
  for free; an `after insert` trigger on `position_aliases` that links waiting applications the
  moment an alias is added. It also seeds ten **closed** positions for roles that appeared ten or
  more times in the backfilled data with no positions row (Retail Yard Associate, Marketing and
  Content Creator, CDL B Truck Driver, …; they were on the dropdowns before
  `docs/positions-seed.csv` was written) and nine aliases for Spanish-form labels that clearly
  name an existing position. On the local data that took the match rate from 543 to 1,221 of
  1,609 applications; most of the rest answered "Any".
- `20261029000200_manager_view_furthest_stage.sql`: `applications_for_managers` gains
  `furthest_stage_id` (the furthest non-terminal stage, or Hired, the application ever reached),
  so managers see the same funnel as staff without reading `status_history`.
- `20261029000300_documents_storage_policies.sql`: Storage rules for the document library.
  Objects under `documents/` in bucket `recruiting-files` are readable only when a
  `recruiting.documents` row points at them *and* the caller may read that row (so `min_role`
  applies to the file as well as the metadata); staff may upload, replace and delete under
  `documents/`; the resume prefix stays `service_role`-only. The Phase 4 read policy is
  re-created with the extra condition.
- `20261029000400_report_views.sql`: `source_channel(text)` (form answer → posting channel) and
  eight views, `report_applications_by_source_stage`, `report_time_in_stage`,
  `report_spend_by_channel_month`, `report_position_funnel`, `report_cost_by_channel`,
  `report_offer_acceptance`, `report_time_to_fill`, `report_seasonality`. Every one filters on
  `recruiting.is_staff()` inside the view, so managers and users without a profile get no rows.
  None carries notes, raw answers, pay or contact details; they are counts, sums and dates.

`web/`: four pages behind the header tabs (Applications, Positions, Documents, Reports; Reports
is hidden from managers and `#/reports` falls back to Applications for them):

- **Positions** (`positions.js`): list with status and location filters, applicants per position
  and a funnel (Applied → Reviewed → Sent → Interview → Offer → Hired, counting the furthest stage
  reached); a drift box comparing open positions with the English form's three position dropdowns
  in both directions ("dropdown still lists a closed role", "open role not on the form", plus
  "dropdown lists a role with no position" with an Add button); match rate and a list of
  still-unmatched position texts with a "Link" control that saves an alias and links the
  applications immediately, or "New position"; a "Re-link applications" button. The drawer edits
  every column (title, location, department, hiring manager, advertised pay range and unit,
  status, opened and closed dates, form label, filled-by application, description document),
  lists aliases (add/remove), postings (channel, URL, UTM source and campaign, posted and ended
  dates, notes) with spend rows per period (spend, views, applies) under each, and the linked
  applicants. Managers get the same page read-only without spend.
- **Documents** (`documents.js`): the library. Each document is an uploaded file (stored at
  `documents/<id>/<file name>` in the private bucket, opened through a 5-minute signed URL) or
  inline text (templates, shown with a Copy button). Staff add, edit, replace the file (version
  goes up, the old object is removed) and delete; everyone sees the documents their role allows.
- **Reports** (`reports.js`): one table per view with a bar on the column that matters and a CSV
  export of what is shown. Pivots (source × stage, month × channel, position × stage, source ×
  stage with percentages, month × location) are built in the browser from the long-format views.
  Reports re-read the view every time they are opened.
- **Applications drawer** (staff): an Offers section (offered on, position, outcome, responded on,
  notes; outcome and date editable inline; never a wage, there is no field for one) and a
  Referral section (referrer as written, matched employee, hired, bonus paid on, notes), on top of
  the Phase 6 contents.

Verified in the browser against the local stack as admin, hr and manager, and with
`scripts/test-policies.sql` (105 checks, all PASS after `db reset`). The four migrations were
applied to the hosted project on 2026-10-26 through the Management API SQL route (the database
password being unavailable to a Developer) and are recorded in `recruiting.schema_migrations`
there; the hosted project still holds no applicant data.

## What the manual-entry change created

Paper applications that arrive outside Jotform (handed in at a yard, mailed in) can now be typed
into the tracker by admin and hr, with a scan of the paper attached. Three migrations:

- `20261030000100_file_kind_scan.sql`: adds `scan` to the `file_kind` enum, in its own file because
  a new enum value cannot be used in the transaction that adds it.
- `20261030000200_manual_applications.sql`: `applications.origin` (enum `application_origin`:
  `jotform`, the default every existing row keeps, or `manual`), `entered_by` and `entered_at`
  (stamped by a before-insert trigger from the session, null for Jotform rows),
  `jotform_submission_id` and `form_id` nullable with check constraints (a Jotform row must have
  both, a manual row neither and no `jotform_url`), the submission-id uniqueness moved to a partial
  unique index, and one storage policy letting admin and hr upload objects under the `manual/`
  prefix of bucket `recruiting-files`. No update or delete policy, so a scan cannot be replaced or
  removed from the browser; the backfill and webhook are unaffected (they insert and update by row
  id, never with an `on conflict`).
- `20261030000300_manager_view_manual.sql`: `applications_for_managers` left-joins `forms` so manual
  rows appear, and appends `origin`, `entered_by`, `entered_at` and `manual_notes` (the one key of
  `answers` a manual entry writes). It keeps the `furthest_stage_id` column Phase 7's
  `20261029000200` appends, so apply Phase 7's migrations first; on a database without Phase 7
  the view simply gains that column here.

Apply with `npm run db:migrate` (or `npm run db:print` and the SQL editor, step 4). Nothing else
changes on the hosted project: the policy is on `storage.objects`, the bucket already exists.

`web/`: an **Add application** button for admin and hr opens a form with name (required), email,
phone, city and state, location (the three locations plus CAS), position (the open positions for
that location, or typed), source (the English form's options), referred by, available start,
language, notes and skills (stored in `answers.manual_notes`; managers see it), received date
(defaults to today, becomes `submitted_at`), one or more scans (PDF or image) and an optional
resume. Files go to `manual/<application id>/<file>` with `application_files` rows of kind `scan`
or `resume`; `has_resume` is set when a resume was attached. Email and phone are normalised the
same way as in the backfill (`scripts/backfill/lib/clean.mjs`), so the duplicate badge and the
"Also applied" list group a paper application with the same person's Jotform submissions, and the
form warns while typing when the email or phone is already on file. Manual rows carry a **Manual**
tag in the table and drawer (in place of the form tag), the drawer says who typed them in and
when, the scan opens through the same 5-minute signed URLs as resumes for staff and managers, the
Form filter and the header count have a "Manual" entry, and the CSV export gains `Origin` and
`Entered by` columns. The Phase 7 positions, reports and report views read `applications` without
joining `forms`, so manual rows count there like any other application; a source breakdown shows
them under whatever source was chosen.

Verified in the browser against the local stack as hr (created an application with a scan and a
resume, both opened), as manager (saw the row, the Manual tag, the notes and the scan; could not
upload or insert) and as admin (typed position, no files, duplicate warning on a known phone).
`scripts/test-policies.sql` has 21 new checks for the column defaults, the check constraints, a
manager being unable to insert an application, hr inserting a manual row with the trigger creating
its status and history rows, the view carrying the row, and `authenticated` writing under `manual/`
only; 126 PASS in all with Phase 7's checks.

**Before uploading a scan, black out any Social Security number, driver licence number, date of
birth or signature on the paper copy.** The scan is stored as an image only (nothing is read out of
it), but it is still a file anyone with a profile can open, and CLAUDE.md section 5 says those
values are never stored anywhere in this app.

## What Phase 8 created

Hosting and invites. Nothing changes in the database.

- `.github/workflows/pages.yml`: on every push to `main` that touches `web/`, uploads `web/` to
  GitHub Pages as-is (no build), except that it overwrites `web/config.js` with the hosted
  project's URL and publishable key, read from the repository variables `SUPABASE_URL` (optional,
  defaults to the am-projects URL) and `SUPABASE_PUBLISHABLE_KEY`. The committed `config.js` keeps
  the local Docker stack's values, so `npx serve web` still works unchanged. The workflow refuses
  a key that looks like a secret key. Both deployed values are public by design: the key only
  identifies the project, and `anon` has no access to schema `recruiting` (step 5's curl check).
- `web/`: an invite or password-reset email now works end to end. Supabase sends the person a
  link that opens the site with a session in the URL; the page notices the link type before
  supabase-js clears it and shows **Choose a password** (10 characters or more, typed twice)
  before anything else. An expired or already-used link shows a plain message on the sign-in
  card instead of a blank page. The sign-in card gained **Forgot your password?**, which asks
  Supabase to email a reset link back to the page's own address (it must be on the redirect
  allow list, step 6). Verified against the local stack: invite link → choose password →
  no-access screen for a user without a profile; expired link → message; forgot-password → a
  "Reset your password" email in the local mail catcher.
- `scripts/make-profile.sql`: `make-admin.sql` generalised to any role, for step 13.

## What the archive change created

The hosted backfill ran on 2026-10-27 (1,608 applications, 1,071 files, nothing failed). The team
decided to review only applications submitted on or after 2026-10-01 and keep the rest for
reference. Migration `20261031000100_archived_stage.sql`:

- `stages.is_archive` and one new terminal stage, **Archived** (id 9, after Withdrawn): neither a
  hire nor a rejection. The funnel, source-quality and position reports already ignore terminal
  stages that are not hires, so archived rows never count as progress or as "not selected";
  applicants per source and per month still count them.
- `recruiting.archive_before(cutoff date)`: moves every application still in the first stage and
  submitted before the cutoff to Archived and returns the count; the status_history trigger logs
  each move with `changed_by` null (the system). Rows anyone has already moved stay put, and a
  second run moves nothing. Staff only. Run on the hosted project with `'2026-10-01'`: 1,480
  archived, 128 left in Applied.
- `report_time_in_stage` redefined so a stay that ended by archiving is not counted as time in
  Applied (it would otherwise average in months of pre-tracker waiting).
- `web/`: a colour for the ninth stage chip. An archived application can be moved back into the
  pipeline from the drawer like any other.

Applied to the hosted project through the CLI's Management API route (`npx supabase db query
--linked -f <file>`, then the `schema_migrations` row by hand), since the `.env` database
connection does not work for a Developer.

## What the pre-2026 cleanup did

Decided 2026-10-28: the tracker keeps only applications from 2026 on. Candidates have to re-apply
after a year, nothing before the tracker existed carried status or notes, and Jotform keeps every
original submission. The 207 applications submitted before 2026-01-01 (Oregon time) were deleted
from the hosted project and the local stack with one statement:

```sql
delete from recruiting.applications
 where submitted_at < timestamptz '2026-01-01 00:00 America/Los_Angeles';
```

The cascades removed their status, history and file rows (there were none of the last). None of
them had files in the bucket, notes, contacts, offers or referrals, and none had filled a
position. Hosted now holds 1,405 applications, the oldest from 2026-01-04. The backfill gained a
`--since` option whose default is `2026-01-01`, so a re-run or `--refresh` leaves them out; see
`scripts/backfill/README.md`. The Phase 5 webhook only ever sees new submissions and needs no
change.

## What the October cutoff did

Decided 2026-10-30. The 1,232 applications from January to September 2026 had all been imported
by the backfill and bulk-archived by `archive_before`, with no notes, contacts, offers, referrals,
manager feedback or filled position among them. Half-logged rows at that volume confused the
people the tracker was shown to: totals and source counts were mostly archived imports, and
opening an old record gave a picture with no history behind it. Nearly every question anyone asks
is about recent applicants, Jotform keeps every original submission and the previous log covers
the earlier months, so the tracker now starts clean on **October 1, 2026** (Oregon time) and
builds complete records from there.

What was done, once, on the hosted project (`scripts/` holds no copy; the statements are here so
the local stack can be brought in line the same way):

1. The 943 resume files belonging to those applications were removed from the `recruiting-files`
   bucket through the Storage API with the service-role key, in batches of 100, and the
   `storage.objects` rows were checked gone before anything else ran. The row cascade would not
   have touched the bucket, and orphaned resumes are a privacy problem as much as a tidy-up one.
2. Then one statement deleted the rows; status, history and file rows cascaded:

   ```sql
   delete from recruiting.applications a
    where a.submitted_at < timestamptz '2026-10-01 00:00 America/Los_Angeles'
      and exists (select 1 from recruiting.application_status st
                    join recruiting.stages s on s.id = st.stage_id
                   where st.application_id = a.id and s.is_archive);
   ```

   The `is_archive` condition is deliberate: one application submitted at 9:47 PM on September 30
   had been moved to Sent to manager on 2026-10-28, so it is in use and was kept. Hosted now holds
   142 applications (that one plus 141 from October) and 109 bucket objects, with no orphaned file
   rows.
3. `scripts/backfill/backfill.mjs`: `DEFAULT_SINCE` is `2026-10-01` (it was `2026-01-01`), so a
   re-run or `--refresh` leaves the deleted months out. Passing an earlier `--since` would bring
   them back on purpose. The webhook only ever sees new submissions and needs no change, and
   `purged_submissions` is not involved: that table is for individual submissions removed by hand.
4. `web/index.html`: a line under the pipeline strip, "Records start October 1, 2026. Earlier
   applications are in Jotform and the previous log.", and one under each report title saying the
   figures cover applications received from that date. `web/styles.css` places the first.

Consequences to know about: the "Applied more than once" filter and the duplicate flag in the
drawer only see repeat applicants from October on (Jotform still shows earlier ones), and the
seasonality reports will show the spring peak for the first time in 2027. The Archived stage
stays for its original purpose, setting an application aside without an outcome.

## What the application-download change created

HR hands a candidate to a hiring manager by email, and until now that meant opening the Jotform
inbox, downloading Jotform's "New Document 1" PDF of the submission and attaching it with the
resume. The drawer now has a **Download application (PDF)** button under *Files and links* that
builds the same kind of document in the browser from what the tracker already holds, named
`<Last>-<First>-application.pdf` (last word of the name, then the first word). Nothing new is
stored anywhere and no new migration is needed.

**Why not Jotform's own PDF.** Two options were weighed:

1. Copy Jotform's generated PDF into the `recruiting-files` bucket during the backfill and the
   webhook, and list it next to the resume. Rejected. Jotform's PDF renders every answer,
   including the driver licence number, expiry and class, the three signatures and the initials
   fields that CLAUDE.md section 5 says are never stored (the example file was even named with
   what looks like a date of birth). Storing those PDFs would put never-store data in Supabase,
   and there is no supported way to redact them on the way in. Fetching them is also
   undocumented: Jotform's API reference lists no PDF endpoint; the only routes are support-forum
   answers (`api.jotform.com/generatePDF?formid=…&submissionid=…&apiKey=…&download=1`, and an
   older `server.php?action=getSubmissionPDF`) that render whichever PDF document is the form's
   default, with reports of hangs. Not something to build an import on.
2. Generate the PDF client-side from the cleaned data. Built. The importer already dropped the
   never-store questions, so the source data cannot contain them, and `answerItems` in
   `web/app.js` applies the form's `never_import` list again before anything is laid out.

**What is in it.** Exactly what the signed-in role's drawer shows, and nothing from the
staff-only review sections (status, assignee, tags, notes, offers, referral, contact log and
manager feedback are left out: it is a hand-off document, not an HR record):

- Header: name, applied date and form (or "paper application received" for a manual entry),
  location, and the Rexius mark.
- Contact: email, phone, alternate phone, phone type, preferred contact method, city and state
  (the street address is not stored; see "What the street-address change created").
- Application: position (and the matched opening when it differs), location, form, source,
  referred by, available start, education, worked at Rexius before, applied before, student,
  forklift experience, herbicide licence, driver licence class, skills, portfolio link, and the
  notes typed from a paper form.
- Employment history: each employer with title, location, dates, responsibilities and reason
  for leaving.
- Files: the names of the resume, portfolio and scan on file, so the reader knows what was sent
  alongside (the files themselves are opened or attached separately, as before).
- Other answers (admin and hr only, Jotform rows only): every remaining cleaned answer in form
  order with its question text, as the "Full application" section of the drawer shows it.
  Dates always carry the year, since the file outlives the screen.
- A footer on every page with who prepared it and when, the page count, and a note that
  licence details, signatures and initials are not stored in the tracker.

**Roles.** Admin and hr get the full document above. Managers get the button too, built from
the curated view (`applications_for_managers`), which is everything they can read: contact,
position, availability, education, skills, employment history and file names, with no "Other
answers" section because the raw `answers` are staff-only. Giving managers the button exposes
nothing they do not already see in the drawer and lets them print or forward an applicant to a
foreman without asking HR for the file.

**Driver licence class.** Many roles need a CDL, so question 35 ("Class or Type of License") is
now imported and shown as "Driver licence class" in the drawer, the PDF and the manager view. The
licence number (30) and expiry (31) stay dropped. Because 35 is a free-text box right under the
number, the importer refuses an answer with five or more digits in a row or over 60 characters
(a warning is logged instead), and the backfill tests cover both sides. Migration
`20261101000100_licence_class.sql` moves 35 out of each form's `never_import`, adds the
`licence_class` key to `field_map`, and appends `licence_class` to `applications_for_managers`.
Rows imported before the migration have no answer 35, so after applying it run the backfill once
with `--refresh --skip-files` (step 10) to re-clean every row from Jotform; new rows get it as
they arrive.

**How it works.** `web/application-pdf.js` lays the document out with jsPDF 3.0.3, loaded from a
pinned jsDelivr URL in `index.html` the same way as supabase-js, through the shared kit in
`web/pdf-kit.js` (since 2026-10-30; see "What the PDF restyle created"). `applicationModel(id)` in
`web/app.js` assembles the sections (for staff it reads the row's `answers` on click; managers
use the curated columns already loaded). The PDF is produced in the browser and handed to the
download; nothing is written to Supabase or fetched from Jotform. The embedded Public Sans covers
Latin text including Spanish accents; a character outside that range is replaced with "?".

Verified against the local stack with 1,404 applications: as hr, an English applicant with
three employers and a resume (3 pages), a Spanish applicant (2 pages, Spanish answers intact)
and the seeded paper application (1 page, scan and resume listed), each extracted back to text
and checked for licence, signature, initials, Social Security and birth-date terms (none outside
the footer note); the drawer button downloads without errors. As manager, the same button
produces the curated document only and no notes or tags reach the model.

## What the two-factor change created

Two-factor sign-in for every tracker user (2026-10-28). Each account needs an authenticator app
(TOTP: Google Authenticator, Microsoft Authenticator, 1Password, Authy and the like); a password
alone no longer reaches any data.

- Migration `20261102000100_require_mfa.sql`: `recruiting.current_role()` now returns null
  unless the session's JWT carries `aal = 'aal2'`, which Supabase Auth sets only after a code
  from an enrolled factor has been verified. Every policy, view and storage rule already goes
  through that function, so a password-only session behaves like a login with no profile: no
  rows, no files, no reports. One new policy lets a user read their own `profiles` row before
  the second factor, so the page can say "No access" to an account without a role instead of
  making it set up an app for nothing. `service_role` is unaffected (no `sub`, so no role, as
  before).
- `web/`: two gate screens. On the first sign-in (and after an invite's "choose a password")
  the page calls `auth.mfa.enroll`, shows the QR code and the key for manual entry, and
  verifies the first code. On every later sign-in it asks for the six-digit code
  (`listFactors` + `challengeAndVerify`) before loading the profile. A password-reset link for a
  user who already has a factor asks for the code first, because changing the password needs an
  aal2 session. Sessions stay in the browser as before, so a code is needed once per sign-in,
  not once per page load.
- `scripts/test-policies.sql`: the impersonation helper takes an `aal` argument (default
  `aal2`), and a new block checks that the admin at `aal1` sees no applications, view rows,
  stages, documents, reports or storage objects, only their own profile row, and cannot change
  it; a JWT with no `aal` claim counts as `aal1`.
- `supabase/config.toml`: TOTP enrol and verify switched on for the local stack. The hosted
  project has them on by default (Dashboard → **Authentication** → **Multi-Factor**; check
  that TOTP shows "Enabled", and that **Verification** is not disabled).

**Resetting a user's second factor.** Someone who loses their phone cannot sign in. An
Administrator opens Dashboard → **Authentication** → **Users** → the user, and removes their
factor; or runs this in the SQL Editor:

```sql
delete from auth.mfa_factors where user_id = '<the user id from the Users page>';
```

The user signs in with their password and is taken through enrolment again. Nothing else about
the account changes. There are no recovery codes; a second device on the Security page (below)
or the admin reset is the recovery path.

**Security page: more than one device (2026-10-29).** The **Security** tab lists the signed-in
user's own authenticators and lets them add another (a work phone with Duo Mobile, a personal
phone, a password manager) or remove one, so a lost or replaced phone does not lock them out.
`web/security.js` uses `auth.mfa.listFactors`, `enroll` (the device name is fixed at enrolment;
Supabase has no rename) and `unenroll`; a cancelled enrolment is unenrolled at once, and the
last remaining device cannot be removed. Each device has its own secret, so when more than one
is enrolled the sign-in screen asks which device the code is from (the choice is remembered in
the browser). Duo Mobile holds these codes as a "third-party account"; its push approvals only
work for services connected to Duo, which Supabase Auth is not. Supabase only lets a session
manage its own factors, so nothing here reaches another user.

**Deploying it.** Merge (Pages redeploys `web/`), then apply the migration. Any session that is
signed in at that moment keeps its `aal1` token and loses access until the person signs out
and in again, which takes them through enrolment. Apply the migration after the Pages deploy
has finished, not before, or the page cannot show the enrolment screen.

## What the street-address change created

Street addresses leave the tracker (2026-10-28). The address question on each form (263) carries
the street, apartment line, postal code, city and state. Nothing in the tracker needs more than
city and state, so the rest is now never stored; anyone who needs the full address opens the
submission in Jotform via the drawer's link.

- Migration `20261103000100_drop_street_address.sql`: adds `"263"` to `never_import` in every
  form's `field_map` (the `address` key stays, so the importer still reads city and state from
  it into `applications.city` and `applications.state`), and removes key 263 from `answers` on
  every application already imported. Jotform keeps the original submission, so nothing is lost.
- `supabase/functions/_shared/clean.mjs` needed no logic change: city and state were already read
  from the raw answer before the never-import filter. The backfill tests assert that 263 is
  absent from `answers` and that city and state still arrive.
- The drawer's Contact section and the application PDF drop the "Address" line; both keep "City".
  Managers never saw the street address (the curated view has only city and state).

Deploy order: merge, then apply the migration to the hosted project (`npm run db:migrate`). The
purge runs inside the migration; there is nothing to run afterwards.

## What the unmatched-purge change created

Applications whose position answer matched no position leave the tracker (2026-10-28). The
Positions page listed 55 of them (old dropdown labels such as "Specialty Production Worker
Level One" and free-text CAS titles); all were Archived or Not selected with no notes, contacts
or offers. Rather than link each old label to a current position, HR chose to delete them.
Jotform keeps every submission.

- Migration `20261104000100_purged_submissions.sql`: table `recruiting.purged_submissions`
  (`jotform_submission_id`, `reason`, `purged_at`), RLS on with no policies, so only the
  service role reads or writes it. It holds IDs, never applicant data.
- `scripts/backfill/backfill.mjs` and the webhook skip any submission listed there (the backfill
  report gains a `purged` column; the webhook answers `{status: "skipped", reason: "purged"}`).
  Without this, a backfill re-run or a Jotform redelivery would bring deleted rows back.
- `scripts/purge-unmatched.mjs` (`npm run purge:unmatched`): dry run by default; `--yes`
  removes the files from the bucket through the Storage API, records the submission IDs, and
  deletes the applications in one transaction. Safe to re-run.

Deploy order: merge, `npm run db:migrate`, then `npm run purge:unmatched` to see the list and
`npm run purge:unmatched -- --yes` to delete. Redeploy the webhook so it reads the new table
(`supabase functions deploy recruiting-jotform-webhook --no-verify-jwt`).

## What the CAS free-text change created

The CAS form has a free-text position box and no location question, and the few CAS roles are
not tracked on the Positions page, so the unmatched-position purge of 2026-10-28 deleted every
2026 CAS application (13) along with the old dropdown labels it was meant to remove. CAS is now
the one location where the position stays as the applicant typed it (2026-10-29): `position_id`
stays null, the tracker's position filter and drawer show the text, and nothing counts it as
unmatched.

- `web/positions.js`: the "Applications with no matched position" list skips location CAS and
  the match-rate sentence says how many CAS applications keep the position as typed. The funnel
  and time-to-fill reports still group CAS under "(no matched position) · CAS", since there is
  no position row to group by.
- `scripts/purge-unmatched.mjs`: its definition of unmatched excludes location CAS, so a later
  clean-up cannot delete CAS applications again.
- Migration `20261105000100_cas_freeform_positions.sql`: takes the 13 CAS submission IDs off
  `purged_submissions` (IDs only, no applicant data) and documents `position_text`.
- Migration `20261105000200_purged_submissions_grant.sql`: `20261104000100` created the purge
  list with no grant, so the backfill and the webhook (both on the service-role key) got
  "permission denied" instead of a list. The purge script worked because it connects to
  Postgres directly. With the grant the webhook works again without a redeploy.
- `scripts/backfill/backfill.mjs`: the purge list was read in `main()` but used in
  `importForm()`, which crashed every run with "purged is not defined"; it is now passed in.
- `supabase/functions/_shared/download.mjs` and `clean.mjs`: the approved-URL guard of
  2026-10-28 refused every resume, because Jotform answers a keyed request for an upload with a
  302 to a signed, short-lived URL on `files.jotform.com/jufs/...`. That one destination is now
  followed with no credentials (no header, no `apiKey` query); the key still goes only to
  `www.jotform.com/uploads/`, and any other redirect still ends the download. Three tests cover
  it (`npm run backfill:test`).

Done on the hosted project on 2026-10-29: both migrations applied, `npm run backfill -- --form
232764918957171 --refresh` restored the 13 CAS applications and copied their 9 resumes. Still to
do by hand: redeploy the webhook so new submissions get their resumes again
(`supabase functions deploy recruiting-jotform-webhook --no-verify-jwt`); until then it imports
the application and logs the file as failed. No submission arrived between the guard's deploy
and this fix, so nothing is missing; a plain `npm run backfill` (no `--refresh`) would pick up
stragglers if any appear, and `--refresh --form <id>` re-copies files for a form.

## What the contact-retention change created

Email and phone are kept for six months (decided 2026-10-30). After that the tracker has no use
for them: the applicant was hired, passed over, withdrew or was archived, and Jotform keeps the
original submission for the rare case someone needs it. A candidate who applies again arrives as
a new row with fresh contact details.

- Migration `20261109000100_contact_retention.sql`: `applications.contact_purged_at`;
  `recruiting.purge_contact_details(retention interval default '6 months')`, security definer,
  executable by `service_role` only (never by a browser session), which nulls `email`,
  `email_norm`, `phone` and `phone_norm`, drops the email, phone and alternate-phone keys from
  `answers`, and stamps `contact_purged_at` on every application submitted more than six months
  ago whose stage is terminal or has not changed in six months; a before-update trigger
  (`keep_contact_purged`) so a `--refresh` backfill, a webhook redelivery or an edit cannot bring
  the details back; a daily pg_cron job `recruiting-purge-contact-details` at 10:20 UTC; and
  `applications_for_managers` gains `contact_purged_at` (appended, as views require).
- `web/app.js`: the table's contact line reads "contact details removed", the drawer's Contact
  section explains the retention, and the PDF prints "removed after six months" for email and
  phone. Nothing else changes: name, city, state, position, source, stage, history, files and
  the rest of the application stay, so Reports are unaffected. A purged row no longer takes part
  in the duplicate check (its normalised email and phone are null).
- `scripts/test-policies.sql`: nine checks across both migrations (neither helper callable by
  `authenticated`, both cron jobs exist, a purged row cannot be un-purged, a purged application
  takes no new file and keeps `has_resume` false, the manager view carries both flags).

**Files follow, the same day** (migration `20261109000200_file_retention.sql` and the Edge
Function `supabase/functions/recruiting-retention/`). A resume carries the address, phone and
email the tracker no longer keeps, and a scan of a paper application shows the whole form, so
once an application's contact details are gone its files go too: every `application_files` row
and the objects behind them in `recruiting-files`, for every applicant including hires (the
personnel record lives in HR's own system). Deleting a `storage.objects` row from SQL leaves the
bytes behind, so the deletion runs through the Storage API in the function:

- `recruiting.request_file_purge()` (security definer, not callable by app users) posts to the
  function through pg_net with the vault entries the market-check jobs already use
  (`recruiting_market_check_url` with the function name swapped, and
  `recruiting_market_check_secret`); it returns at once when nothing is due. The daily pg_cron
  job `recruiting-purge-files` runs it at 10:40 UTC, twenty minutes after the contact purge.
  Until the vault entries exist (step 15) the job logs a warning and does nothing.
- The function checks `x-market-check-secret` against `MARKET_CHECK_SECRET` (the same Edge
  Function secret as the market checks; nothing new to set), removes each due application's
  files from Storage, confirms they are gone, deletes the rows, sets `has_resume` false and
  stamps `applications.files_purged_at`. It has no browser route.
- A before-insert trigger on `application_files` refuses a file for a purged application
  (a `--refresh` backfill would otherwise re-copy it; the backfill skips those too), and the
  update guard keeps `files_purged_at` and `has_resume` as they are.
- The drawer says "Files were removed after six months (retention)" where the file links were,
  the PDF's Files section says the same, and `applications_for_managers` gains `files_purged_at`.
- Deploy: `npx supabase functions deploy recruiting-retention --no-verify-jwt`, then the
  migration. Tested locally with `functions serve`: a seeded file on a purged application was
  removed from Storage, its row deleted, the stamp set, a wrong secret got 401, and a later
  insert of a file for that application was refused.

To run the contact purge by hand, or with a different window, as the database owner in the SQL
Editor (the files follow at the next 10:40 UTC run, or at once with
`select recruiting.request_file_purge();`):

```sql
select recruiting.purge_contact_details();                 -- six months
select recruiting.purge_contact_details(interval '1 year'); -- a longer window, one off
```

The Jotform submission (drawer link) still has the contact details for anyone who truly needs
them after six months. As of the hosted apply on 2026-10-30 the oldest application was submitted
on 2026-10-01, so the first purge happens around 2027-04-01.

## What Phase 5 created

`supabase/functions/recruiting-jotform-webhook/index.ts`: the Edge Function that keeps
`applications` current without anyone re-running the backfill. Jotform calls it once per new
submission on each of the three forms (step 14 adds the URL to the forms). The function:

- checks a shared secret on the URL (`?secret=…`, the `JOTFORM_WEBHOOK_SECRET` function
  secret) in constant time before reading anything else. The API gateway's JWT check is off
  for this function (`verify_jwt = false` in `config.toml`, `--no-verify-jwt` on deploy)
  because Jotform cannot send a Supabase JWT; the secret is the authentication;
- reads only `formID` and `submissionID` from Jotform's multipart POST and rejects a form ID
  that is not an active row in `recruiting.forms` (logged, HTTP 400);
- answers `{"status":"exists"}` when `applications` already holds the submission, so a retried
  or duplicated delivery never creates a second row (a race between two deliveries is caught by
  the unique index and answered the same way);
- fetches the submission from Jotform's REST API (`GET /submission/{id}`) with the
  `JOTFORM_API_KEY` secret rather than trusting the posted body, checks it belongs to the
  posted form, and skips submissions in Jotform's trash;
- builds the row with `supabase/functions/_shared/clean.mjs`, the same module the backfill
  uses, so the field map, the Spanish value cleanup, email and phone normalisation and the
  never-import list (driver licence 30/31/35, signatures 238/333/369, initials 324–332) are one
  piece of code. The insert trigger puts the application in the first stage, writes the first
  `status_history` row and matches the position; the function never writes those tables;
- responds to Jotform, then copies resumes and portfolios into `recruiting-files` and records
  them in `application_files` in the background (Jotform waits at most five seconds for a
  reply). A file that fails to copy is logged; `npm run backfill -- --refresh` re-copies it.

Logs (Dashboard → **Edge Functions** → the function → **Logs**) carry form and submission IDs
and outcomes only, never answers, names or secrets. The backfill stays useful for re-syncing
after an outage (it skips what the webhook already imported) and for `--refresh`.

`scripts/backfill/lib/clean.mjs` is now a one-line re-export of the shared module; the backfill,
its tests and its README are otherwise unchanged. `scripts/webhook-test/stub-jotform.mjs` and
`supabase/functions/.env.example` support the local test in step 14.

## What Phase 9a created

The per-position market check (CLAUDE.md section 8, "Phase 9 decisions"). One run asks Claude,
with its server-side web search tool, what others in the position's area are advertising for
the same role and who else is hiring for it right now. Claude summarises; it never scores or
ranks anything, and nothing about an applicant is sent. The result is a sample from search
results, never a complete count; the useful signal is the change from run to run.

- `supabase/migrations/20261106000100_market_checks.sql`: `positions.market_tracking` (off by
  default) and `positions.market_interval_days` (7 or 30); table `market_checks`, one row per
  run (`position_id`, `ran_at`, `trigger` manual/schedule/opened, `requested_by`, `summary`,
  `pay_ranges`, `postings`, `sources`, `comparison`, `below_market`, `input_tokens`,
  `output_tokens`, `searches`, `model`, `error`, `finished_at`), never overwritten; RLS: admin
  and hr read and write, managers read, no profile nothing. It also enables `pg_net` and
  `pg_cron`, adds `request_market_check(position_id, trigger)` (posts to the function through
  pg_net with the URL and shared secret read from Supabase Vault), `run_due_market_checks()`
  (open, tracked positions whose last successful run is older than their interval, skipping any
  position with a run in the last day), a trigger that checks a position the moment it becomes
  open with tracking on (or tracking is turned on while open), and the daily pg_cron job
  `recruiting-market-checks` at 13:00 UTC (6 am Pacific). Until the two vault secrets exist
  (step 15) the schedule and the trigger do nothing but write a warning to the Postgres logs.
- `supabase/functions/recruiting-market-check/index.ts`: the Edge Function. Two callers: the
  tracker's **Check now** button sends the user's JWT, and the function checks admin or hr with
  a two-factor session through `recruiting.current_role()`, exactly like the table policies;
  Postgres (the cron job and the trigger) sends the header `x-market-check-secret` matching the
  function secret `MARKET_CHECK_SECRET` and is refused for positions that are not open. The
  gateway's JWT check is off (`verify_jwt = false`, `--no-verify-jwt`) because pg_net cannot
  send a Supabase JWT. The function inserts the `market_checks` row, answers at once
  (`202 {check_id}`) and does the work in the background: it reads the position (title,
  location, department, pay range, the linked job description's text if it has one), calls
  `claude-opus-5-5` with `web_search_20260209` (at most `MARKET_CHECK_MAX_SEARCHES` searches,
  default 6, with the search area set to Eugene/Springfield, Bend or Lake Oswego), resumes a
  `pause_turn`, parses the JSON answer, collects the sources from the tool results (not from
  the model's text), converts the ranges found to the position's pay unit and compares them:
  `below_market` is true when the top of the position's advertised range is below the median
  low end others advertise. Usage from the response (`input_tokens`, `output_tokens`,
  `searches`) is stored on the row so real cost replaces estimates. Every failure after the row
  exists is stored in `market_checks.error`, never swallowed; the page shows it.
- `web/positions.js`: a **Market check** section in the position drawer: the latest run
  (summary, below-market flag, the medians against Rexius' range, the pay ranges found with
  links, who else is hiring, sources, usage), earlier runs under **Earlier runs**, and for staff
  the **Track on a schedule while open** toggle with Weekly/Monthly and **Check now**, which
  calls the function and refreshes the section every few seconds until the run finishes.
  Managers see the results read-only.
- `scripts/test-policies.sql`: 22 more checks (hr and manager access, the 7/30 constraint, the
  cron job, the helpers refusing to post without vault secrets and being uncallable by app
  users). `supabase/seed.sql` adds one made-up finished run for the local stack.

Search depth per position (migration `20261107000100_market_search_depth.sql`, 2026-10-30):
`positions.market_max_searches` (null = the standard limit, at most 20) overrides the secret for
one position; the drawer offers Standard (6), Deeper (10) and Deepest (15) next to the cadence.
Rare titles (Blower Truck Operator at Lake Oswego found one pay range in six searches) are the
reason; common crew roles find fifteen postings at Standard. The function logs the limit it used
and the row's `searches` shows what the run actually spent.

Sharing a run (`web/market-report.js`, 2026-10-30): every finished run has **Download report
(PDF)** and **Copy as text**. The PDF (one to three pages, built in the browser with jsPDF like
the application PDF, named `<title>-<location>-market-check-<date>.pdf`) has an at-a-glance block
(Rexius' range as it was at the run, the medians others advertise, the below-market verdict,
counts), the summary, the pay table, who else is hiring with links, the sources, and the same
caveat as the page: a sample from search results, no Rexius wage in it, which model and how
many searches. The text version is the same report for an email. Managers can use both too,
since they can read the runs. Nothing is written to Supabase; the file exists only as the
download.

Cost: about fifty cents a run at 2026-10 list prices (six searches at a cent each plus
tokens; the first hosted run was $0.56), about $0.85 at Deeper and $1.30 at Deepest. The `recruiting` workspace in the Claude Console carries the monthly spend cap; when
it is reached the run ends with "rate limit or spend cap reached" on the row.

## What the national check created

A second kind of market check for specialised roles, where the local one finds little
(2026-10-30, after Phase 9a). One national run asks Claude, with web search, what the same role
pays across the United States and what each place costs to live in compared with the Rexius
location, then scales every figure to the Rexius location and compares the adjusted median with
the position's advertised range. On demand only, from the drawer; there is no schedule, since a
run costs a few dollars.

- `supabase/migrations/20261108000100_national_checks.sql`: `positions.national_max_searches`
  (null = the standard limit, 4 to 20) and table `national_checks`, one row per run (`pass` 0, 1
  or 2, `summary`, `pay_samples`, `bls`, `cost_of_living`, `adjusted`, `comparison`,
  `below_market`, `sources`, usage, `error`), RLS as for `market_checks`.
- `supabase/functions/recruiting-national-check/index.ts`: the tracker's JWT only (admin or hr
  at aal2), same 202-then-background pattern as the local check, deployed with
  `--no-verify-jwt`. Two passes saved separately, so a run cut off in the second keeps the first
  (`pass` 1 with an error): pass 1 finds postings by larger employers across several metros plus
  the Bureau of Labor Statistics occupational wage page for the matching occupation (SOC code,
  national median and 25th/75th percentiles, the Oregon metro figure if shown); pass 2 finds one
  published cost-of-living index (100 = US average) for the Rexius metro and every metro from
  pass 1, same source and year throughout; it also has the web fetch tool (up to four pages)
  because search results only carry snippets and the index table has to be read from the page
  itself (the first two hosted runs stalled on exactly that). The adjustment is arithmetic in the function, not
  the model: each posting's pay times Rexius index over posting index, converted to the
  position's pay unit; `below_market` compares the top of Rexius' range with the median adjusted
  low end; the BLS national median is scaled the same way. The summary is the two passes'
  summaries plus one code-written closing sentence with the adjusted figures. Searches: 15 a
  run by default (secret `NATIONAL_CHECK_MAX_SEARCHES`, per-position override), about 65% to
  pass 1. The standard key `ANTHROPIC_API_KEY_RECRUITING` is used; no new secret.
- `web/positions.js`: a **National market check** section under the local one, with a depth
  dropdown (Lighter 10, Standard 15, Deepest 20), **Run national check** (confirms the cost
  first), the latest run (summary, below-market flag, adjusted medians, the BLS line with a
  link, a table of postings with metro, index, pay as posted and adjusted, the cost-of-living
  source, sources, usage), earlier runs, and **Download report (PDF)** / **Copy as text**
  (`web/market-report.js`, national variants with the adjusted table).
- `scripts/test-policies.sql`: 13 more checks. `supabase/seed.sql`: one made-up finished run.

Cost: about $1.50 a run at Standard at 2026-10 list prices (the first complete hosted run,
Commercial Landscape Project Lead at Eugene/Springfield on 2026-10-30, used 12 searches and
298,531 input / 10,129 output tokens, about $1.52, in 2 minutes 34 seconds), about $2.50 at
Deepest. Caveats the report carries: free cost-of-living indexes are rough and differ by
publisher, so the source is named and the adjustment is approximate; a run takes three to six
minutes, and the Edge Function's wall-clock limit means a very deep run can still end after
the first pass.

**Deploy** like the local check (step 15 item 1): `npm run db:migrate`, then
`npx supabase functions deploy recruiting-national-check --no-verify-jwt`. No vault entries.

## What the PDF restyle created

The three PDFs the tracker builds in the browser (the application hand-off, the market check
report and the national check report) were each laid out by their own copy of a small jsPDF
writer, and the copies had drifted: the market report drew a key/value label on one line, so a
long label ("BLS Heavy and Tractor-Trailer Truck Drivers (53-3032)") ran into its value; a table
heading could end a page with its rows on the next; forty full URLs filled a page of sources;
and a page title scraped from the web could carry an HTML comment into the PDF. The restyle
(2026-10-30, branch `claude/pdf-restyle`) puts the layout in one place and makes the three
documents a set.

- `web/pdf-kit.js` is the shared writer: US Letter page frame, the Rexius wordmark
  (`assets/rexius-logo.png`, converted from the site's WebP) with the document kind and date on
  the right and a green rule under them, a title and subtitle, a continuation header on later
  pages, and a footer with who prepared it and the page count. Section headings keep with their
  first lines, paragraphs never leave a single line behind, table headers repeat after a page
  break and never sit alone at the foot of one, and the caveat sits in a shaded note panel.
  "At a glance" tiles carry the few figures a reader asks first, with a green or amber verdict
  chip on the market reports. Sources are a numbered list with the page title as the link and
  only the host in grey, so forty sources take half a page and still open the page.
- Public Sans, the tracker's own typeface, is embedded (Regular, SemiBold, Bold and Italic,
  about 85 KB each, `web/assets/fonts/`, SIL Open Font License in `OFL.txt` beside them). The
  fonts and the wordmark are fetched once per session, when the first PDF is built, never on
  page load; if a font fails to load the document falls back to Helvetica and still builds.
- `web/application-pdf.js` and `web/market-report.js` keep their document models and the
  "Copy as text" output and only draw with the kit. The application lifts position, location,
  source and start date into tiles; the market reports lift Rexius' range, the market figure and
  the verdict, and move the BLS and cost-of-living detail of a national check into a "Method"
  section where the labels have room. Employer names in the tables link to the posting, which
  replaced the separate URL lines. `stripHtml` in the kit cleans every scraped title.
- `scripts/pdf-samples/` (`npm run pdf:samples`) renders the three documents from invented data
  with the same jsPDF version as a devDependency, into the gitignored `out/` folder. It is how
  the layout was checked and how the next change to it should be.

Nothing in the database or the Edge Functions changed; no migration, no manual step. The
GitHub Pages deploy picks up the new files with the next push to `main`.

---
## What the Spanish 2026 form created

The Spanish application form (Employment Application-ESP 2025, `232824275836160`) had kept the
2025 layout while the English 2026 form moved on: no resume or portfolio upload, no forklift or
herbicide-licence question, no "describe your role" boxes, the old physical-capability and safety
sections still in, and older agreement wording. Editing it in place was ruled out because Jotform
drops a question's answers from every past submission when the question is removed, and that form
is the archive for everything the tracker has purged. On 2026-10-31 (branch
`claude/spanish-form-2026`) a new form was built from the English one instead.

- **Employment Application-ESP 2026** (`263035461572051`, https://form.jotform.com/263035461572051)
  is a clone of the English 2026 form made by `scripts/jotform/clone-spanish-form.mjs` through the
  Jotform API. A clone keeps the question IDs, so every question, type, order, required flag and
  all 25 conditions match the English form, and the tracker reuses the English field map. Each
  label got a Spanish half in the existing "English/ Español" style from
  `scripts/jotform/spanish-2026.translations.mjs`; the English half is taken from the live English
  form at run time, so the two can never drift in wording. Options that are words ("Yes" → "Yes/
  Sí", "Home" → "Home/ Casa", the education levels, the student checkboxes) are bilingual; position
  titles, brand names and "No" stay as they are. The four conditions that compare against a changed
  value ("Yes" on the two "have you worked/applied before" questions, "Other" on the source question,
  the Eugene/Springfield location) were rewritten to the new values. The location option is stored
  as "Eugene-Springfield" because the import's Spanish rule keeps the text before the first "/" and
  the alias table maps it back.
- **Carried over by the clone** (checked on a throwaway clone first, then on the real one): the
  thank-you redirect, now pointed at the Spanish page
  `https://rexius.com/pages/solicitud-de-empleo-de-rexius-gracias` so analytics conversions keep
  working (both thank-you pages load the same Google Ads tag, so the conversion fires as before);
  the webhook into the tracker, with its secret; and the English form's emails. The English form's
  two auto-replies (switched off there) still describe the questionnaire that was dropped, so they
  were deleted from the new form on 2026-10-31; only the notification to the recruiting addresses
  remains. If HR wants Spanish applicants to get a reply, add a fresh autoresponder in the new
  form's **Settings → Emails**. The English form still carries the two stale auto-replies.
- **Migration `20261110000100_spanish_form_2026.sql`** inserts the `recruiting.forms` row (label
  "Employment Application-ESP 2026 (Spanish)", language `es`, the form's question list, the field
  map copied from the English row). Until it is applied the webhook rejects the form's submissions
  as "unknown form". `reference/jotform-forms.json` gained the new form's question map and
  `scripts/backfill/clean.test.mjs` checks a submission on it. The 2025 form's row stays active until
  the switch-over below.
- **The script** (`npm run jotform:spanish-form -- --dry-run | --test`) is kept for the record and
  for the next time the English form changes shape: `--dry-run` lists what it would change,
  `--test` builds a throwaway clone, verifies it against the English form and deletes it, and a
  plain run creates a form, the migration and the reference entry. It is not idempotent, so a real
  run makes another form each time. Read-only Jotform API keys cannot clone; the key in `.env`
  needs full access for this one script.

Switch-over, in order:

1. Read the new form through once at https://www.jotform.com/build/263035461572051 and have a
   Spanish speaker check the agreement, MVR and drug-test paragraphs (questions 219 to 331, 368 and
   238). Fix wording in the builder or in the translations file; a builder fix is final, a file fix
   only matters for a future re-run.
2. `npm run db:migrate` on the hosted project (adds the forms row).
3. Submit one test application on the new form and confirm it appears on the tracker with the
   Spanish location and "Yes" answers cleaned; delete the test afterwards (step 14.4).
4. Point the careers page's Spanish link and the Spanish QR code, if any, at
   `https://form.jotform.com/263035461572051`.
5. Disable the 2025 form in Jotform (**Settings → Form Status**) and run
   `update recruiting.forms set is_active = false where jotform_form_id = '232824275836160';` so a
   late submission through it is rejected rather than imported. Its submissions stay in Jotform
   as the archive.

---
## Manual steps in Supabase (do these in order)

You need: a terminal with Node 22 or newer (the Supabase CLI runs through `npx`; the
migration runner needs one `npm install`), and access to the `am-projects` project (currently named Apparel) in the Supabase dashboard; steps 1, 5 and 6
need the Administrator or Owner role in the Supabase organization, as does setting the Edge Function secrets in step 14; the rest work as a Developer. Run every command from
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

- **Site URL**: `https://rexiusfleet.github.io/rexius-recruiting/` once the site is published
  (step 13); `http://localhost:3000` until then. Invite and reset emails sent from the dashboard
  link to the Site URL, so it has to be the page people should land on. This setting is shared
  with the inventory app, whose code only uses password sign-in; the one effect is that a
  password-recovery email sent from the dashboard for one of its users would open the recruiter
  page, where the person can still set their password.
- **Redirect URLs**: add `https://rexiusfleet.github.io/rexius-recruiting/**`,
  `http://localhost:3000/**` and `http://127.0.0.1:3000/**`. The page's "Forgot your password?"
  link names the page's own address as the return address, and Supabase only honours addresses
  on this list.

Dashboard → **Authentication** → **Sign In / Providers**:

- **Email** provider: enabled (it is by default). Keep "Confirm email" on.
- **Allow new users to sign up**: turn **off**. Users are invited by an admin; nobody should be
  able to create an account from the login page. (Admin-created users and invites still work
  with this off.)

Dashboard → **Authentication** → **Multi-Factor**:

- **TOTP** (authenticator app): enabled, with enrolment and verification both allowed. It is on
  by default; only check it. The tracker requires it for every user (see "What the two-factor
  change created").

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
than adding a second. HR and managers are invited in step 13; `scripts/make-profile.sql` is the
same statement with the role as a third value.

### 8. Where secrets go

| Secret | Needed from | Where to set it |
| --- | --- | --- |
| Database password | Step 3 | Prompted by `supabase link`, or `SUPABASE_DB_PASSWORD` in your shell |
| `SUPABASE_DB_URL` (connection string, contains the password) | Step 4 and every later migration | `.env` at the repo root, gitignored |
| CLI access token | Step 3 | `supabase login`, or `SUPABASE_ACCESS_TOKEN` in your shell |
| `JOTFORM_API_KEY` | Phase 4 (backfill) and 5 (webhook) | For the backfill: `.env` at the repo root (step 10). For the webhook: an Edge Function secret (step 14): Dashboard → **Edge Functions** → **Secrets**, or `npx supabase secrets set --env-file supabase/functions/.env` with the key in that gitignored file (an org Administrator; a Developer can view secrets but not create them) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Phase 4 (backfill) | `.env` at the repo root. The service-role key is in **Project Settings** → **API Keys**; it bypasses RLS and never goes near the frontend |
| `JOTFORM_WEBHOOK_SECRET` | Phase 5 | Same as the webhook's `JOTFORM_API_KEY`. Any long random string you make up (`openssl rand -hex 32`); it goes on the webhook URL in Jotform and nowhere else |
| `ANTHROPIC_API_KEY_RECRUITING` | Phase 9 | Same as the webhook's `JOTFORM_API_KEY` (set 2026-10-30). Created in the Claude Console (platform.claude.com) inside the `recruiting` workspace, which carries its own monthly spend cap; linked to a service account, not a person. The suffix says which app on the shared project owns it |
| `MARKET_CHECK_SECRET` | Phase 9a (step 15) | Same as `JOTFORM_WEBHOOK_SECRET`: any long random string you make up. It is also stored in Supabase Vault as `recruiting_market_check_secret` (with the function URL as `recruiting_market_check_url`) so the daily job can send it; nowhere else |

`supabase/.env` and every `.env*` file are gitignored. Jotform's API key comes from Jotform →
account settings → API (a read-only key is enough for the backfill).

### 9. Local development (optional)

The frontend is static. Serve `web/` from the repo root:

```sh
npx serve web        # http://localhost:3000, which is why that URL is registered in step 6
```

(or `python3 -m http.server 3000 --directory web`). `web/config.js` is committed with the local
Docker stack's URL and publishable key, so out of the box the page talks to the local stack below;
to work against the hosted project instead, swap in its URL and publishable key as the comment in
that file explains, and do not commit that change until Phase 8. In the Claude desktop app,
`.claude/launch.json` starts the same server for the in-app browser.

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
month of spend. Sign in to the tracker with each to see the three role views and the no-access page. `scripts/test-policies.sql` exercises every policy as each of those users and as
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

### 11. Point the frontend at the hosted project (Phase 8 prerequisites)

The tracker is complete and verified locally; it works against the hosted project once:

1. Migrations `20261028000100` through `20261029000400` are applied (done, as of 2026-10-26).
   After the hosted backfill, click "Re-link applications" on the Positions page (or run
   `select recruiting.relink_applications();`) once; the insert trigger handles rows that arrive
   later. (Done 2026-10-27: 1,608 applications imported, 1,219 linked to a position.)
2. Schema `recruiting` is exposed in the Data API (step 5).
3. The page's URL is registered under Authentication → URL Configuration (step 6).
4. The deployed `config.js` holds the hosted URL and publishable key: the GitHub Pages workflow
   writes it from the repository variables in step 13. (For a hand-run copy against the hosted
   project, edit `web/config.js` locally as its comment says and do not commit it.)
5. Each user has an auth account and a `profiles` row (steps 7 and 13).
6. The three manual-entry migrations (`20261030000100` to `20261030000300`) are applied; the
   hosted project had the twelve files up to `20261029000400` as of 2026-10-26. Check with
   `select version from recruiting.schema_migrations order by 1;` in SQL Editor and apply any
   missing file with `npm run db:print` and the editor (step 4).

### 12. Phase 7 data to enter by hand

Nothing in Phase 7 is imported; these are typed in through the app by admin or hr:

- **Positions**: department, hiring manager, advertised pay range, opened and closed dates for
  the 17 seeded open roles, and dates for the ten closed roles the migration added from the data.
  Check the drift box on the Positions page after changing the Jotform dropdowns.
- **Aliases**: the Positions page lists every position text with no match. Link each to a
  position (or add it as a new, usually closed, position). Texts that cannot be linked ("Any",
  blank) are counted but not listed.
- **Postings and spend**: for each open position, add where it is posted and, per month, the
  spend, views and applies from Indeed, Craigslist and Google Ads reporting. The cost-per-applicant
  and cost-per-hire report stays empty for a channel until spend is entered for it.
- **Documents**: upload the current job descriptions and interview guides, set "Visible to"
  (managers may see descriptions; keep interview guides at HR), and paste message templates as
  text. Link each description to its position from the position's drawer.
- **Offers and referrals**: record offers from the applicant drawer as they happen (the
  acceptance and time-to-fill reports depend on them); tick Hired and enter the bonus date on
  the referral when paid.

### 13. Host on GitHub Pages and invite users (Phase 8)

The site is the same `web/` folder the workflow in `.github/workflows/pages.yml` uploads; nothing
is built. Its address is `https://rexiusfleet.github.io/rexius-recruiting/` (the rexius-apparel
site lives beside it). The repository moved from the personal account `andy-rexius` to the
`RexiusFleet` organization on 2026-10-30; GitHub redirects the old Git URL but not the old Pages
address, and only the organization's owners hold admin on the repository, so Pages settings,
repository variables and branch protection are theirs to change (an owner can also grant admin). GitHub Pages sites are public pages: anyone with the address sees the
sign-in card, and nothing else, because every piece of data is behind Supabase Auth and
row-level security and the page ships only the public key.

1. **Pages on a private repository.** `rexius-recruiting` is private, and GitHub only publishes
   Pages from a private repository on a paid plan (GitHub Pro for a personal account, Team for an
   organization). Open **Settings → Pages**; if it asks you to upgrade, either upgrade the plan
   or make the repository public (**Settings → General → Danger Zone → Change visibility**), as
   rexius-apparel is. Public would expose the code, migrations, docs, the Jotform question maps
   and `docs/positions-seed.csv` (titles and, once filled in, departments, managers and pay
   ranges). It holds no keys, passwords or applicant data; `.gitignore` keeps `.env` out.
2. **Source.** **Settings → Pages → Build and deployment → Source**: choose **GitHub Actions**
   (not "Deploy from a branch", which would publish the repo root).
3. **Variables.** **Settings → Secrets and variables → Actions → Variables → New repository
   variable**: `SUPABASE_PUBLISHABLE_KEY` = the publishable key from Supabase **Project
   Settings → API Keys** (`sb_publishable_…`, or the legacy `anon` JWT). Optionally
   `SUPABASE_URL` = `https://hibjqcgitqtgmkurghlw.supabase.co` (the default when unset). These are
   Variables, not Secrets: the value is public by design and ends up in the page.
4. **Deploy.** Merge the Phase 8 pull request; the workflow runs on the push to `main`. To run it
   by hand later: **Actions → Deploy web to GitHub Pages → Run workflow**. The run's summary
   shows the site address; the first deploy can take a few minutes to become reachable.
5. **Auth URLs.** Step 6 with the Pages address as Site URL and in the redirect list. Without the
   redirect entry, invite and reset links fail with "redirect_to is not allowed".
6. **Check.** Open the site, sign in as your admin (step 7). The Applications page is empty until
   the hosted backfill (step 10) has run; the local stack's data is never copied up.
7. **Email sending.** Supabase's built-in mailer is meant for development: a few messages per
   hour, from a `supabase.io` address, to any recipient. Before inviting more than a couple of
   people, set **Authentication → Emails → SMTP Settings** to Rexius' mail provider so invites
   come from a rexius.com address and are not rate-limited (an organization Administrator does
   this). The invite and recovery templates under **Authentication → Emails → Templates** can
   stay as they are; both link to the Site URL.
8. **Invite each HR user and manager.** For each person:
   1. **Authentication → Users → Invite user** → their rexius.com email. The user row appears at
      once and the email goes out.
   2. **SQL Editor**: `scripts/make-profile.sql` with their email, name and role (`hr` or
      `manager`; `admin` for a second admin). Do this straight after the invite, before they
      open the email, so they do not land on the "No access" screen.
   3. They click the link, land on the site, choose a password, and are in. The link is good
      for 24 hours by default (**Authentication → Sign In / Providers → Email → Email OTP
      Expiration**); if it has expired, they type their email on the sign-in card and use
      **Forgot your password?**, which sends a fresh link.
   Managers see every location for now; the `profiles.location` column is for a later scoping
   policy. Removing someone: delete their `profiles` row (`delete from recruiting.profiles where
   user_id = …`) and the auth user (**Authentication → Users → … → Delete user**).
9. **Local development keeps working.** `npx serve web` uses the committed `config.js` with the
   local stack's values. Do not commit hosted values into it; the workflow supplies them.

### 14. Turn on the Jotform webhook (Phase 5)

After this, every new submission on the three forms appears in the tracker within seconds,
and the backfill is only for catching up after an outage. The function is deployed by a
Developer; the two secrets need an organization Administrator or Owner (a Developer can see
secrets but not create them).

1. **Set the two secrets** (Administrator). Dashboard → **Edge Functions** → **Secrets** →
   add `JOTFORM_API_KEY` (Jotform → account settings → **API**; read-only is enough; the same
   key the backfill uses is fine) and `JOTFORM_WEBHOOK_SECRET` (a long random string, for
   example the output of `openssl rand -hex 32`; keep it somewhere you can paste it into Jotform
   in step 3). The CLI alternative is a gitignored file with those two lines and
   `npx supabase secrets set --env-file supabase/functions/.env`. `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase; do not add them. Optional:
   `JOTFORM_TIMEZONE` if the Jotform account is not on Pacific time, `JOTFORM_API_BASE` for an
   EU account. Nothing is pasted into chat, a file in this repo, or a commit.
2. **Deploy** (Developer is enough; the CLI must be linked, step 3):

   ```sh
   npx supabase functions deploy recruiting-jotform-webhook --no-verify-jwt
   ```

   The function's URL is `https://hibjqcgitqtgmkurghlw.supabase.co/functions/v1/recruiting-jotform-webhook`.
   Dashboard → **Edge Functions** should list it with JWT verification off. Deploying before the
   secrets exist is harmless: the function answers 503 "function not configured" until they do.
   Check from your shell (expect `{"ok":true,...}`; the secret value comes from the dashboard, not
   from this file):

   ```sh
   curl "https://hibjqcgitqtgmkurghlw.supabase.co/functions/v1/recruiting-jotform-webhook?secret=<JOTFORM_WEBHOOK_SECRET>"
   ```

3. **Add the webhook to each of the three forms** in Jotform: open the form → **Settings** →
   **Integrations** → search **Webhooks** → paste the function URL with the secret as its
   query string:

   ```
   https://hibjqcgitqtgmkurghlw.supabase.co/functions/v1/recruiting-jotform-webhook?secret=<JOTFORM_WEBHOOK_SECRET>
   ```

   → **Complete Integration**. Do this for Employment Application 2026 (`260115636145148`),
   Employment Application-ESP 2025 (`232824275836160`) and CAS Employment Application 2026
   (`232764918957171`). Employment Application-ESP 2026 (`263035461572051`) was cloned from the
   English form with the webhook already on it ("What the Spanish 2026 form created"). A form not
   in `recruiting.forms` (the QR card, internal and referral forms) would be rejected with
   "unknown form", so do not add it there.
4. **Confirm it works.** Submit a test application on one form (your own name, a throwaway
   email, a small PDF as the resume). Within a few seconds it is on the tracker's Applications
   page in stage Applied with the resume in the drawer; the function's **Logs** show
   `inserted application …` then `1 of 1 file(s) copied`. Delete the test row afterwards in
   **Table Editor** → `recruiting.applications` (the status, history and file rows go with it)
   and the file under **Storage** → `recruiting-files` → `applications/<form>/<submission>/`, or
   leave it and move it to Archived. If nothing arrives: Jotform → the form → **Settings** →
   **Integrations** → **Webhooks** shows the delivery status, and the function's Logs say why
   it was rejected.
5. **Catching up.** If the project was paused or the function was down, run
   `npm run backfill` (step 10); it skips every submission the webhook already imported.

**Test it locally** (no Jotform key, no real data), with the local stack running (step 9):

```sh
cp supabase/functions/.env.example supabase/functions/.env   # gitignored; dummy values are fine
npm run webhook:stub                                          # terminal 1: fake api.jotform.com on 8787
npx supabase functions serve --env-file supabase/functions/.env   # terminal 2
```

Then, in a third terminal, post what Jotform would post (the stub's sample is form
`260115636145148`, submission `6990000000000000001`):

```sh
curl -X POST -F formID=260115636145148 -F submissionID=6990000000000000001 -F rawRequest='{}' \
  "http://127.0.0.1:54321/functions/v1/recruiting-jotform-webhook?secret=local-test-secret"
```

Expect `{"status":"inserted",...}` the first time and `{"status":"exists",...}` on every
repeat; the row ("Test Webhook", Eugene/Springfield, Landscape Maintenance Crew Member) is on
the local tracker in Applied with `resume.pdf` attached, and its `answers` hold no `30`, `238`
or `324` key. Without `?secret=` the answer is 401; with `formID=123456` it is 400 "unknown
form". Checked this way on 2026-10-27.

### 15. Turn on the market check (Phase 9a)

The migration and the function are deployed like every other change; the schedule needs two
vault secrets and one function secret on top. Tracking is off for every position until HR
turns it on, so nothing runs (and nothing is spent) before step 4.

1. **Apply the migration and deploy the function** (Developer is enough; the CLI must be
   linked, step 3):

   ```sh
   npm run db:migrate
   ```

   ```sh
   npx supabase functions deploy recruiting-market-check --no-verify-jwt
   ```

   The function's URL is `https://hibjqcgitqtgmkurghlw.supabase.co/functions/v1/recruiting-market-check`.
   The migration enables `pg_cron` and `pg_net`; Dashboard → **Integrations** → **Cron** lists
   the job `recruiting-market-checks` once it has run, and **Database** → **Extensions** shows
   both enabled. No dashboard step is needed for either.
2. **Set the shared secret** (Administrator) in two places with the same value, any long random
   string (`openssl rand -hex 32`). As the function secret: Dashboard → **Edge Functions** →
   **Secrets** → `MARKET_CHECK_SECRET` (or `npx supabase secrets set` with the gitignored
   `supabase/functions/.env`). And in the vault, so Postgres can send it: Dashboard → **SQL
   Editor**, run (the two values are the only things to edit; the URL is not secret, it just
   lives beside the secret so one place holds both):

   ```sql
   select vault.create_secret('https://hibjqcgitqtgmkurghlw.supabase.co/functions/v1/recruiting-market-check', 'recruiting_market_check_url', 'Phase 9a: the market-check function');
   select vault.create_secret('<the same random string>', 'recruiting_market_check_secret', 'Phase 9a: value of the function secret MARKET_CHECK_SECRET');
   ```

   `ANTHROPIC_API_KEY_RECRUITING` is already set (step 8). Nothing is pasted into chat, a
   file in this repo, or a commit.
3. **Run one check by hand and read its cost.** Open the tracker → **Positions** → an open
   position → **Market check** → **Check now**. The section shows "Running…" and, after one to
   two minutes, the summary, the ranges found, the postings and the sources, with the usage line
   (searches, tokens, model, seconds) at the bottom. In the Claude Console
   (platform.claude.com) → **Usage**, filter by the `recruiting` workspace: the run appears
   as one request with the same token counts; **Cost** shows what it cost in dollars. If the
   row says "Anthropic rejected the API key", the secret is wrong or belongs to another
   workspace; "rate limit or spend cap reached" means the workspace cap is hit. The function's
   **Logs** carry the position and run IDs and the outcome, never the content.
4. **Turn tracking on** for the roles that are urgent: the same section → **Track on a schedule
   while open** → Weekly or Monthly. An open position is checked at once when tracking is turned
   on, then again each morning once its last successful run is older than the cadence. Closing
   the position stops the schedule; **Check now** keeps working on any position. A few roles
   weekly is under $10 a month; all open positions weekly would be about $35.
5. **Test the schedule without waiting**: SQL Editor → `select recruiting.run_due_market_checks();`
   returns how many checks it requested (0 when every tracked position was checked in the last
   day). Dashboard → **Integrations** → **Cron** → the job → **Logs** shows each daily run.

**Test it locally** (no real key), with the local stack running (step 9): copy
`supabase/functions/.env.example` to `supabase/functions/.env` (its dummy
`ANTHROPIC_API_KEY_RECRUITING` is the point), start `npx supabase functions serve --env-file
supabase/functions/.env`, sign in to the local tracker as `hr@local.test` and press **Check
now** on any position: the run ends within seconds with "Anthropic rejected the API key" stored
on the row and shown in the section, which is the error path end to end. From a shell, the
Postgres path:

```sh
curl -X POST http://127.0.0.1:54321/functions/v1/recruiting-market-check -H 'content-type: application/json' -H 'x-market-check-secret: local-market-secret' -d '{"position_id":"<an open position id>"}'
```

Expect `{"status":"started","check_id":...}`; without the header 401, with a closed position
`{"status":"skipped",...}`. Checked this way on 2026-10-30.

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

## Security: where applicant data is and who can reach it

Applicant records are personal information. This section is the standing answer to "can anyone
outside the app get at it?" and must be kept true as phases land. Checked against the hosted
project on 2026-10-26, when it held no applicant data at all; the backfilled data existed only
on the developer's machine.

### Layers on the hosted project

| Layer | What it guarantees | How it is enforced |
| --- | --- | --- |
| Public API key (`anon` / publishable) | Identifies the project; grants nothing | `anon` has no `usage` on schema `recruiting`, so every unauthenticated request fails at the schema before reaching a table. Verified with the curl check in step 5 |
| Sign-in | Accounts exist only when an admin creates or invites them, and a password alone reaches no data | Public signup is off (step 6). Email + password through Supabase Auth, confirmations on, then a code from an authenticator app on every sign-in: `recruiting.current_role()` is null unless the JWT says `aal2`, so a stolen or guessed password gets the "enter your code" screen and nothing else. Invite and reset links only return to addresses on the redirect allow list |
| Hosting | The published page holds no data and no secret | GitHub Pages serves static files from `web/`; the only project-specific values are the URL and publishable key, which grant nothing (row above). A Pages site is public, so the sign-in card is visible to anyone; nothing behind it is |
| Profile row | A login without a `recruiting.profiles` row sees nothing | Every policy calls `recruiting.current_role()`, which returns null without a profile. `scripts/test-policies.sql` checks this for every table and the curated view |
| Role | Managers never see notes, tags, raw answers, offers, referrals, contacts or history | Managers have no select policy on those tables; they read `applications_for_managers`, which does not contain those columns |
| Row-level security | Decides per row, on every query, for every table | Enabled in the same migration that creates each table; the test script asserts no table in `recruiting` has it off |
| Files | Resumes, portfolios, library documents and scanned paper applications are never public | Bucket `recruiting-files` is private. A file is reachable only through a signed URL that expires in minutes, issued only to a signed-in user a storage policy allows. Library documents (`documents/` prefix) are further gated by the document's `min_role`: the storage policy requires a `recruiting.documents` row the caller may read. Scans of paper applications typed in by staff live under the `manual/` prefix with the same read rule as resumes (any user with a profile); only admin and hr can upload there, and nothing can be replaced or deleted from the browser. A scan is stored as an image only, so anything on the paper that section 5 says is never stored (SSN, licence number, date of birth, signature) must be blacked out before upload; the form says so |
| Reports | Managers get no aggregate figures | Every `report_*` view filters on `recruiting.is_staff()` inside the view; the views carry counts, sums and dates only, never notes, answers, pay or contact details |
| Transport and storage | Encrypted in transit and at rest | TLS everywhere; Supabase encrypts database and storage volumes (AWS us-west-2) |
| Contact details and files | Email, phone, resumes, portfolios and scans are held for six months, then removed | A daily pg_cron job calls `recruiting.purge_contact_details()`, which nulls email, phone and their normalised forms and drops the alternate phone from `answers` on applications submitted more than six months ago that are in a terminal stage or have not changed stage in six months, stamping `contact_purged_at`. A trigger keeps a purged row purged through a `--refresh` backfill or a webhook redelivery. The same day the Edge Function `recruiting-retention` (called through pg_net with the market-check vault secret) deletes the application's files from Storage and their rows, and a trigger refuses new ones. Neither helper is callable by app users. Name, city, state, position, source, stage and history stay, so reports are unchanged; the drawer and PDF say "removed after six months" ("What the contact-retention change created") |
| Never stored | SSNs, bank details, dates of birth, government IDs, wages, signed offer letters, driver licence numbers and expiry dates, signatures, initials, street addresses | No column exists for them; the importer drops the licence number and expiry, signature, initials and street-address answers before writing `answers` (CLAUDE.md section 5); only the applicant's city and state are kept. The licence class or type is kept (since 2026-10-28; many roles need a CDL) and the importer drops it when it looks like a number. The test script and the backfill tests assert none of the rest remain. Offers (Phase 7) have no pay field; positions hold only the advertised range |

### Credentials that bypass all of the above

Two secrets give full read and write access to everything, ignoring every policy: the
**service-role key** (Project Settings → API Keys) and the **database password**. Rules:

- They are never committed, never pasted into chat, never put in `web/`. The frontend ships only
  the project URL and the publishable key, which are public by design.
- The service-role key is used only by the backfill script and Edge Functions. On a developer's
  machine it lives in the gitignored `.env`; on Supabase it is injected into Edge Functions.
- The webhook's shared secret (`JOTFORM_WEBHOOK_SECRET`) and the Jotform API key let a caller
  insert applications and read Jotform, not read the database. They live in Edge Function
  secrets and, the shared secret only, on the webhook URL inside Jotform's form settings. Rotate
  both by setting new values and updating the three webhook URLs (step 14).
- Rotate either one if a laptop holding `.env` is lost, or a person who had the key leaves.
  Rotating the service-role key does not affect the frontend.

### People with dashboard access

Anyone with a seat in the Rexius organization on Supabase can open the Table Editor and read
every row of every schema, and Owners and Administrators can copy the service-role key. This is
the widest exposure in the design and it is a people decision, not a code one.

**Decision (2026-10-26):** everyone with a seat in the Rexius Supabase organization is a Rexius
employee authorized to view application data, so organization-wide dashboard access is
acceptable. The conditions that keep it acceptable:

- Nothing in CLAUDE.md section 5's "never stored" list is ever imported or typed in (no SSNs,
  bank details, dates of birth, government IDs, wages, signed offer letters, licence numbers,
  signatures, initials). Every import path enforces this and the tests assert it.
- The organization's member list stays Rexius-only and is reviewed when someone joins or leaves
  (Organization → Team). A departing member's seat is removed the same day, and the
  service-role key is rotated if they were an Owner or Administrator.
- Multi-factor authentication is on for every dashboard member (Account → Security).

If any of those stop being true, the fallback is a Supabase project of its own for recruiting:
the migrations re-run there with `npm run db:migrate`, the frontend changes two lines in
`web/config.js`, and the "shared project" row in CLAUDE.md section 2 is updated.

### Development data on a developer's machine

During development the full applicant set is imported into the local Docker stack, not the
hosted project. That copy:

- listens on localhost only (`127.0.0.1:54321` API, `54322` database) with Docker's default
  local password, and disappears from memory with `npx supabase stop`; the data stays in a
  Docker volume until `npx supabase stop --no-backup`;
- sits beside a gitignored `.env` holding the Jotform API key and, when the hosted import is
  run, the service-role key.

So a developer's machine must have full-disk encryption (FileVault) and a locked screen, and
should run `npx supabase stop --no-backup` when the local data is no longer needed. Nothing
from the local stack is ever synced to the hosted project except by an explicit backfill run.

### Other places the data exists

- **Jotform** remains the source of record and holds the complete submissions, including the
  fields this app never imports. Its access is managed in Jotform, separately from this app.
- **GitHub**: the repository is private and holds no applicant data and no secrets. The
  `reference/` files have blanked values and the seed data is invented. Keep it that way: never
  commit an export, a log with applicant rows, or a screenshot with real names.
- **Browser downloads**: the CSV exports (applications, and each report) are plain files on
  whoever downloaded them. Treat the applications export like any spreadsheet of personal data;
  the report exports hold aggregates only.
- **Library documents**: job descriptions, interview guides and templates are Rexius documents,
  not applicant data. They live in the same private bucket under `documents/` and are reachable
  only by the roles their `min_role` allows. Do not upload anything containing an individual's
  pay or a signed offer letter.

### Checks to repeat

After any migration: `scripts/test-policies.sql` on the local stack, all `PASS`. After any
hosted settings change: the curl check in step 5 must still say `permission denied for schema
recruiting`. Before each phase ships: `git grep` the repo for email addresses and phone
numbers and confirm only the invented ones appear.

## Conventions

See `docs/database-conventions.md` for the rules every migration follows (schema, grants, RLS,
naming, personal-information handling). The phase plan and the Jotform field maps are in
`CLAUDE.md`.
