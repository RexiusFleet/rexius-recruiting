# Rexius Recruiter — Claude Code handoff

This file is the brief for building the Rexius Recruiter app. Commit it as `CLAUDE.md` in the root of the `rexius-recruiting` repository so Claude Code reads it at the start of every session. The `reference/` folder beside it holds the question maps for the three Jotform forms, the shape of a Jotform submission, and the working prototype of the tracker frontend.

Last updated: 2026-10-27 (Phase 5). Planning history lives in the claude.ai Project "Job Application Tracker" (spec document: https://claude.ai/artifact/JHd1gSvT6ULe6QDPKNtSM1).

## 1. What we are building

A standalone web app for Rexius' recruiting lead, HR team, and hiring managers that:

1. Logs every job application from three Jotform forms automatically, with status tracking, notes, hand-off to managers, resume access, duplicate detection, candidate contact logging, and CSV export.
2. Tracks open positions, where each was posted (rexius.com, Indeed, Craigslist, Google Ads), what each channel cost, and which applicants each channel produced.
3. Keeps a library of job descriptions, interview guides, and templates.
4. Reports on recruiting: time to fill, time in stage, applicants per posting, cost per applicant and per hire by channel, source quality (what share of each source reached interview, offer, hire), offer acceptance, seasonality.

Later releases add Claude-generated role overviews, salary reference research, and applicant summaries. Claude summarizes and surfaces; it never scores or ranks applicants.

Rexius context: landscape and forest-products company in Oregon; locations Eugene/Springfield, Central Oregon (Bend), and Lake Oswego; seasonal hiring with spring as the peak; many Spanish-speaking applicants; recruiting runs mainly through Indeed, plus Craigslist, Google Ads, referrals (there is a referral bonus), and a careers page at https://rexius.com/blogs/careers. Posting tone is plain and concrete, never grandiose.

## 2. Decisions already made

| Decision | Why |
| --- | --- |
| Standalone app on Supabase + GitHub, not a Claude artifact | Managers and HR need their own logins and roles |
| Three roles: Admin, HR, Manager (view only); managers see all locations for now | Simple to reason about; location scoping is a later column + policy |
| Email + password sign-in via Supabase Auth | May move to Google sign-in restricted to Rexius accounts later |
| One Supabase project is shared with a second, unrelated app (apparel inventory tracker and department invoicer). It is currently named `Apparel` in the dashboard (ref `hibjqcgitqtgmkurghlw`, Rexius organization) and will be renamed `am-projects` once the user has the Administrator role; the name is only a dashboard label and nothing in either repo depends on it | Separate by schema (`recruiting`, `inventory`), bucket, and function name; shared `auth.users`, one `profiles` table per app |
| Jotform intake by webhook (Edge Function) plus a one-time backfill via Jotform's REST API | Live data, no refresh button |
| Driver licence numbers, signature images, and initials fields are never imported | Personal-information rules, section 5 |
| Resumes are copied into Supabase Storage with signed URLs | Managers must not need Jotform logins |
| Static HTML/JS frontend; run locally during development; GitHub Pages when others need it | No build server required |
| Status, notes, offers, positions etc. live only in Supabase; Jotform stays the source of record for the raw submission | One place to change things |
| Paper applications that arrive outside Jotform are typed into the tracker by admin or hr (`applications.origin = 'manual'`) with a scan attached under `manual/<application id>/` in the bucket; they are not re-entered into Jotform | The occasional walk-in or mailed form should sit in the same pipeline, duplicate check and reports as everything else; a Jotform re-entry would forge a submission |

## 3. Working conventions

- Repo `rexius-recruiting` in Rexius' GitHub organization (not the user's personal GitHub account). Supabase project ref `hibjqcgitqtgmkurghlw`, currently named `Apparel` in the dashboard (to be renamed `am-projects`; this file says `am-projects` to mean that project). The user is a Developer, not an Administrator, in the Rexius Supabase organization until that is changed, so project settings (exposed schemas, auth URLs, secrets, database password) need an admin; the user has done no configuration beyond creating the project, so every dashboard step must be spelled out. Layout: `supabase/migrations/`, `supabase/functions/recruiting-jotform-webhook/`, `scripts/backfill/`, `web/` (frontend), `docs/`, `reference/`.
- One pull request per phase (section 8). Each PR description says what the user must do manually afterwards (paste a secret, add a webhook URL, run a script).
- Everything in the database lives in schema `recruiting`. Never create tables in `public`. The schema must be added to the exposed schemas in Supabase API settings; include that in the Phase 2 instructions.
- The inventory app shares the Supabase project from a completely separate repository and never needs to know this one exists. Migrations are applied to the hosted project with `npm run db:migrate` (own history table `recruiting.schema_migrations`), never with `supabase db push` or `supabase config push`; the README explains why.
- Row-level security on every table, enabled in the same migration that creates it. Policies use a helper `recruiting.current_role()` that reads `recruiting.profiles` for `auth.uid()`.
- Secrets: never ask the user to paste an API key, service-role key, or password into the chat, a file, or a commit. The user sets them with `supabase secrets set` or in the dashboard. The frontend uses only the project URL and anon key, which are public.
- Frontend: plain HTML, CSS, and JavaScript, loading `@supabase/supabase-js` from a pinned CDN URL. No framework unless a later phase decides otherwise. Keep the prototype's behaviour (see `reference/prototype-tracker.html`): pipeline strip with clickable stage chips, left filter rail, dense table, right-hand detail drawer, status change inline, "Show more" paging at 250 rows.
- Local dev: `npx serve web` (or `python -m http.server` in `web/`). Register `http://localhost:3000` (or whatever port) as an allowed redirect URL in Supabase Auth.
- Verify third-party API details (Jotform REST and webhook payloads, supabase-js version) against current documentation before relying on them; the notes in section 4 come from observed data and memory, not from a doc check.

## 4. Jotform sources

Three forms feed the app. Counts are as of 2026-10-23.

| Form | Jotform form ID | Submissions | Notes |
| --- | --- | --- | --- |
| Employment Application 2026 (English) | `260115636145148` | 1,319 | Primary form; three position dropdowns, one per location |
| Employment Application-ESP 2025 (Spanish) | `232824275836160` | 228 | Bilingual labels and values ("Yes/Si", "Indeed.com/"); no resume upload field |
| CAS Employment Application 2026 | `232764918957171` | 55 | Free-text position; no location question (store location as "CAS") |

Other forms exist in the account (Internal Employment Application 2026, Employment Application: QR Card, Employment Application 2025, Referral Application) and are out of scope unless the user says otherwise.

### Observed submission shape

`reference/submission-shape.json` shows one submission with values blanked. Key points:

- `id` (string, 19 digits), `title` (applicant name), `url` (link into the Jotform inbox), `subtitle` (submitted time as `"Oct 23, 2026 12:56 AM"`).
- `submission_answers` is an object keyed by question ID; each value is `{ "answer": ... }`. Answer shapes by question type: full name `{first, middle, last}`; phone `{full}`; address `{addr_line1, addr_line2, city, state, postal}`; date `{month, day, year, datetime}`; checkbox/multi-select = array of strings; file upload = array of URLs (or a string); signature = a PNG URL containing `_signature_`; everything else a string.
- Question definitions (label, type, order, dropdown options) for each form are in `reference/jotform-forms.json`. Store the current question map per form in the database rather than hardcoding labels; IDs are stable for a form but differ between forms.
- The Jotform REST API returns the same answers under `GET /form/{formID}/submissions` with `apiKey`, `limit` (max 1000), and `offset`; the webhook POST is multipart with `formID`, `submissionID`, and a `rawRequest` JSON field whose keys are `q{ID}_{name}`. Confirm both against current Jotform docs before writing the backfill and webhook.

### Field map (question IDs)

| Field | English | Spanish | CAS |
| --- | --- | --- | --- |
| Name | 9 | 9 | 9 |
| Email | 22 | 22 | 22 |
| Phone / alternate phone | 264 / 265 | 264 / 265 | 264 / 265 |
| Phone type | 266 | 266 | 266 |
| Address | 263 | 263 | 263 |
| Preferred contact method | 21 | 21 | 21 |
| Location | 342 | 342 | — (use "CAS") |
| Position | 340 Eugene/Springfield, 341 Central Oregon, 343 Lake Oswego | 340, 341, 343 | 375 (free text) |
| How did you learn about the job | 268 (+ 384 free text "other") | 268 | 376 |
| Referred by | 355 | 355 | 377 |
| Available start date | 261 | 261 | 261 |
| Highest education | 344 | 344 | 344 |
| Resume upload | 387 | — | 381 |
| Portfolio upload / link | 393 / 394 | — | — |
| Worked at Rexius before / applied before | 272 / 274 | 272 / 274 | 272 / 274 |
| Currently a student (checkbox) | 385 | — | — |
| Forklift experience / herbicide licence | 386 / 395 | — | — |
| Relevant skills | 372 | 372 | 372 |
| Employer 1: name / location / title / start / end / reason | 72 / 280 / 76 / 348 / 377 / 352 | 72 / 280 / 76 / 348 / 375 / 352 | 72 / 280 / 76 / 348 / 378 / 352 |
| Employer 2 | 83 / 85 / 87 / 349 / 378 / 94 | 83 / 85 / 87 / 349 / 376 / 94 | 83 / 85 / 87 / 349 / 379 / 94 |
| Employer 3 | 95 / 287 / 99 / 350 / 379 / 107 | 95 / 287 / 99 / 350 / 377 / 107 | 95 / 287 / 99 / 350 / 380 / 107 |
| Driver licence number / expiry / class — NEVER IMPORT | 30 / 31 / 35 | 30 / 31 / 35 | 30 / 31 / 35 |
| Signatures — NEVER IMPORT | 238, 333, 369 | 238, 333, 369 | 238, 333, 369 |
| Initials — NEVER IMPORT | 324–332 | 324–332 | 324–332 |

Treat the employer-column IDs as "verify against `reference/jotform-forms.json`" — the contact, position, source, resume, and never-import rows were confirmed against real submissions; the employer rows were read from question order.

### Value cleanup

- Spanish form: for location, source, contact method, yes/no, and education answers take the text before the first "/" (so "Yes/Si" → "Yes", "Indeed.com/" → "Indeed.com", "Email/ Correo electrónico" → "Email"). For position names strip only a trailing "/" because some real titles contain a slash ("Retail Yard Associate / Delivery Driver"). Map "Eugene-Springfield" → "Eugene/Springfield".
- English and CAS forms: strip only a trailing "/".
- Normalize email to lower case and phone to digits (compare on the last 10) for duplicate detection; keep the originals too.
- Parse `subtitle` with the pattern `Mon D, YYYY H:MM AM/PM`; do not rely on `Date.parse`.
- Treat any `https://…/uploads/…` URL that is not a `_signature_` PNG as a file to copy, whatever question it came from.

The English form's three position dropdowns are what applicants choose from. The Positions feature should compare open positions against those options and flag drift in both directions ("dropdown still lists a closed role", "open role not on the form").

## 5. Personal-information rules

These apply to the webhook, the backfill, and every later import.

- **Never stored anywhere:** Social Security numbers, bank details, dates of birth, government ID numbers, offered or agreed wages, signed offer letters.
- **Dropped at import:** driver licence number/expiry/class (30, 31, 35), signature images (238, 333, 369), initials (324–332). Anyone who needs them opens the submission in Jotform via the stored `jotform_url`.
- **Role-restricted:** offers and offer history, notes, and the raw cleaned `answers` JSON are HR and Admin only. Managers see a curated summary (contact, position, availability, experience, resume).
- **Resumes:** copied into the `recruiting-files` bucket; served to signed-in users through short-lived signed URLs; never public.
- **Scans of paper applications:** stored under `manual/<application id>/` in the same bucket as images only (nothing is read out of them into a column), with the same read rule as resumes (any user with a profile, via signed URL); only admin and hr can upload, and nothing under `manual/` can be replaced or deleted from the browser. A paper form may show an SSN, licence number, date of birth or signature, so staff black those out before uploading; the form and the README say so. The typed fields are the same ones the import keeps, plus one free-text `answers.manual_notes` that managers see.
- **Retention:** the tracker holds applications from 2026 on. Everything submitted before 2026-01-01 (Oregon time) was deleted on 2026-10-28 and the backfill's default `--since` cutoff keeps it out; Jotform remains the archive, and candidates re-apply after a year anyway. A rolling purge rule for older not-selected applications is still an open question for HR.

## 6. Data model (schema `recruiting`)

| Table | Purpose | Key columns |
| --- | --- | --- |
| `profiles` | One row per app user | `user_id` (FK auth.users), `role` enum (admin, hr, manager), `name`, `location` (nullable), `created_at` |
| `forms` | The Jotform forms and their question maps | `id`, `jotform_form_id`, `label`, `language`, `questions` jsonb, `field_map` jsonb, `updated_at` |
| `applications` | One row per application: a Jotform submission, or a paper application typed in by staff | `id`, `origin` (jotform, manual; default jotform), `jotform_submission_id` (nullable, unique where not null; required for jotform rows, forbidden for manual), `form_id` (nullable; same rule), `submitted_at` (for manual rows: the date the paper was received), `name`, `email`, `email_norm`, `phone`, `phone_norm`, `location`, `position_text`, `position_id` (nullable FK), `source`, `source_detail`, `referred_by`, `available_start`, `answers` jsonb (cleaned; manual rows hold only `manual_notes`), `jotform_url` (null for manual), `entered_by`, `entered_at` (manual rows; stamped by trigger from the session), `imported_at` |
| `application_files` | Resumes, portfolios and scans of paper applications | `id`, `application_id`, `storage_path`, `original_name`, `kind` (resume, portfolio, scan, other), `jotform_url` |
| `application_status` | Current review state, one per application | `application_id` (PK), `stage_id`, `assigned_to` (text), `notes`, `tags` text[], `updated_by`, `updated_at` |
| `status_history` | Every stage change | `id`, `application_id`, `from_stage_id`, `to_stage_id`, `changed_by`, `changed_at` |
| `stages` | Pipeline, admin-editable | `id`, `name`, `sort_order`, `is_terminal`, `is_hired`, `is_archive` (the one "set aside without an outcome" stage; `archive_before(date)` fills it) |
| `contacts` | Candidate communication log | `id`, `application_id`, `kind` (email, call, text, in_person), `direction`, `template_key` (nullable), `summary`, `by`, `at` |
| `manager_feedback` | Manager response on a hand-off | `id`, `application_id`, `manager_user_id`, `verdict` (interested, pass, undecided), `note`, `at` |
| `position_aliases` | Other texts that mean a position at a location (Spanish labels, old labels, CAS free text); `match_position()` and the insert trigger use them | `id`, `position_id`, `alias`, `location`, `note`, `created_by`, `created_at`; unique on lower(alias)+location |
| `positions` | Open and past roles | `id`, `title`, `location`, `department`, `hiring_manager`, `pay_min`, `pay_max`, `pay_unit`, `status` (draft, open, closed), `opened_at`, `closed_at`, `filled_by_application_id` (nullable), `description_doc_id` (nullable), `jotform_option_label` |
| `postings` | Where a position was advertised | `id`, `position_id`, `channel` (rexius_com, indeed, craigslist, google_ads, referral, other), `url`, `utm_source`, `utm_campaign`, `posted_at`, `ended_at` |
| `channel_spend` | Hand-entered figures per period | `id`, `posting_id`, `period_start`, `period_end`, `spend`, `views`, `applies`, `notes` |
| `offers` | Offer history, no wages | `id`, `application_id`, `position_id`, `offered_at`, `outcome` (pending, accepted, declined, withdrawn), `responded_at`, `notes` |
| `referrals` | Referral bonus tracking | `id`, `application_id`, `referrer_name`, `referrer_employee` (text), `hired`, `bonus_paid_at` |
| `documents` | Descriptions, guides, templates | `id`, `title`, `kind`, `position_id` (nullable), `storage_path`, `version`, `min_role`, `updated_at` |

Reporting views (create in Phase 7, but design the columns above so they are possible): applications by source and stage; time in stage; spend by channel by month; position funnel (applied → reviewed → sent → interview → offer → hired) by position and by source; time to fill per position.

## 7. Roles and policies

| Role | Applications and status | Notes, offers, raw answers | Positions, postings, spend | Documents | Users |
| --- | --- | --- | --- | --- | --- |
| admin | read, write | read, write | read, write | read, write (all kinds) | invite, remove, change roles |
| hr | read, write | read, write | read, write | read, write | — |
| manager | read (curated columns) | no | read | read where `min_role` allows | — |

No profile row = no access. Implement the curated manager view as a database view that omits restricted columns, and grant managers select only on that view.

## 8. Phases

Each phase is one session and one pull request.

| Phase | Delivers | User must do first | Status |
| --- | --- | --- | --- |
| 0 Prototype | Artifact tracker proving data and mappings (`reference/prototype-tracker.html`) | — | done |
| 1 Spec | Planning document in the claude.ai Project | — | done |
| 2 Repo and Supabase setup | Repo layout, `supabase/config.toml`, migration creating schema `recruiting`, README with the manual steps (expose schema, link CLI) | Create empty repo; have project URL and anon key; confirm the Supabase plan is paid (free projects pause after 7 idle days and drop webhooks) | done (hosted settings pending an org admin, see README) |
| 3 Schema and roles | Migrations for every table, enums, RLS, helper functions, stages seeded, positions seeded from `docs/positions-seed.csv`, SQL to make the first admin | Fill `docs/positions-seed.csv` (title, location, department, hiring manager, pay range, posting URLs) | done |
| 4 Backfill | `scripts/backfill/` importing all existing submissions with cleanup rules and resume copy to storage; idempotent on `jotform_submission_id`; migration for the private `recruiting-files` bucket | Put `JOTFORM_API_KEY`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the gitignored `.env` (README step 10); never paste them in chat | done |
| 5 Webhook | Edge Function `recruiting-jotform-webhook` with a shared-secret check (`?secret=` on the URL), submission fetched from Jotform's API, same cleaning as the backfill through the shared module `supabase/functions/_shared/clean.mjs`; local test with `scripts/webhook-test/stub-jotform.mjs` | An org Administrator sets `JOTFORM_API_KEY` and `JOTFORM_WEBHOOK_SECRET` as Edge Function secrets; deploy with `--no-verify-jwt`; add the function URL with the secret to each of the three forms (Jotform settings → Integrations → Webhooks); README step 14 | in review (tested on the local stack 2026-10-27; secrets and the Jotform webhook URLs remain README step 14) |
| 6 Frontend and login | `web/` tracker with login, roles, pipeline, filters, drawer, contact log, CSV export; migration adding `files` to the manager view | — | done (hosted cutover in Phase 8) |
| 7 Positions, channels, documents, reports | Positions UI, postings and spend entry, dropdown-drift check, position aliases and re-link, offers, referrals, document library, Reports page over the `report_*` views | Channel spend figures; documents to upload | in review (verified against the local stack; hosted cutover in Phase 8) |
| 8 Hosting and invites | GitHub Pages workflow, invite and password-reset flow in `web/`, `scripts/make-profile.sql`, README step 13 (Pages source, repo variables, auth URLs, SMTP, invites) | Decide who gets which role; set Pages source and the two repo variables | done (site live 2026-10-27; Supabase auth URLs, the three `20261030` migrations, the hosted backfill and invites remain README step 13) |
| 9 Claude features (later) | Edge Function calling the Anthropic API: role overviews with sources, salary reference research, applicant summaries, posting drafts | Set `ANTHROPIC_API_KEY` as a Supabase secret | later |

Outside the phase table: **manual application entry** (PR 8, branch `claude/manual-applications`, 2026-10-26) adds the "Add application" form for paper applications with scans, migrations `20261030000100` to `20261030000300`, and 21 policy checks. Its view migration appends after Phase 7's `furthest_stage_id`, so on the hosted project Phase 7's migrations go first. README "What the manual-entry change created" has the details.

## 9. Open questions (ask only when a phase needs the answer)

- Rolling retention / purge rule for not-selected applications (everything before 2026 is already gone; see section 5).
- Whether managers should eventually leave feedback (table exists; UI can wait).
- Department and hiring manager per location, for the positions seed.
- Whether the inventory app needs anything beyond the shared user convention.

## 10. Kickoff prompt for the first Claude Code session

Paste this to start Phase 2:

> Read CLAUDE.md and the reference folder. We are starting Phase 2 of the Rexius Recruiter build. Set up the repo layout described in section 3, initialise the Supabase project config for schema `recruiting`, write the first migration that creates the schema and the `profiles` table with RLS, and write a README that lists exactly what I need to do by hand in the Supabase dashboard (expose the schema, link the CLI, set redirect URLs). Do not ask me for any secrets; tell me where to set them. Open a pull request when done.
