# Backfill: Jotform submissions into `recruiting.applications`

One-time import of every existing submission from the three Jotform forms (CLAUDE.md section 4)
into `recruiting.applications`, with resumes and portfolios copied into the private Storage
bucket `recruiting-files` and recorded in `recruiting.application_files`. After this runs once,
the Phase 5 webhook (README step 14) keeps the table current; the script stays useful for re-syncing (it is
idempotent) and for re-cleaning after a rule change (`--refresh`).

## Files

| File | Purpose |
| --- | --- |
| `backfill.mjs` | The command. Reads forms, field maps and positions from the database, pages through Jotform's REST API, writes rows and files |
| `lib/clean.mjs` | Re-exports `supabase/functions/_shared/clean.mjs`, the pure functions that turn one submission into one `applications` row plus a list of files. Every cleanup and never-import rule lives there, shared with the Phase 5 webhook (the Supabase CLI only bundles files under `supabase/functions`) |
| `lib/jotform.mjs` | Small Jotform REST client: paged `GET /form/{id}/submissions` (`APIKEY` header, `limit` max 1000, `offset`) and authenticated file download with retry |
| `clean.test.mjs` | Unit tests for the rules, using the real field maps and question lists. `npm run backfill:test`, no network or database needed |

## What it needs

Node 22 or newer and `npm install` once. Three variables, in your shell or in the gitignored
`.env` at the repo root (shell values win). Never put them in chat, in a tracked file, or in a
commit.

| Variable | Value |
| --- | --- |
| `JOTFORM_API_KEY` | Jotform → account settings → **API** → create a key (read-only is enough) |
| `SUPABASE_URL` | Local stack: `http://127.0.0.1:54321`. Hosted: `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Local: `npx supabase status` prints it. Hosted: Dashboard → **Project Settings** → **API Keys** → `service_role` (Legacy tab) or an `sb_secret_…` key. It bypasses RLS; it is for this script and Edge Functions only, never the browser |
| `JOTFORM_TIMEZONE` (optional) | IANA zone the Jotform account is set to; default `America/Los_Angeles`. Jotform's `created_at` is wall-clock time in that zone |
| `JOTFORM_API_BASE` (optional) | Default `https://api.jotform.com`; EU accounts use `https://eu-api.jotform.com` |

The database must already have the Phase 3 schema and seed (forms with their field maps,
positions, stages) and the Phase 4 bucket migration, and schema `recruiting` must be exposed in
the Data API (README step 5; the local stack exposes it through `config.toml`).

## Running it

```sh
npm run backfill -- --dry-run                       # clean everything, write nothing, show counts
npm run backfill -- --form 232764918957171 --limit 25
npm run backfill                                    # all three forms, every submission
npm run backfill -- --refresh                       # re-clean rows already imported, re-copy files
```

| Option | Effect |
| --- | --- |
| `--dry-run` | No writes to the database or Storage, no downloads |
| `--form <id>` | Only this Jotform form ID (repeat for several). Default: every active row in `recruiting.forms` |
| `--limit <n>` | At most n submissions per form, newest first (the order Jotform lists them) |
| `--refresh` | Update rows that already exist and re-upload their files. Status, notes and history are untouched |
| `--skip-files` | Rows only; no file downloads or uploads |
| `--sample` | Print one cleaned row per form and stop (implies `--dry-run`); useful for checking a form's mapping |
| `--since <YYYY-MM-DD>` | Import only submissions made on or after this date, by the calendar date in the Jotform account's time zone. Default `2026-01-01`; older submissions are counted under "old" in the report and never written, with or without `--refresh` |

Re-running without `--refresh` changes nothing already imported: submissions are matched on
`jotform_submission_id` and files on their object key, and both are skipped when present. A run
that is interrupted can simply be started again. Submissions in Jotform's trash (`status`
`DELETED`) are skipped and counted, and so are submissions from before the `--since` date.

The tracker holds nothing from before 2026. On 2026-10-28 the 207 applications submitted before
2026 (Oregon time) were deleted from the hosted project and the local stack; they had no files,
notes, contacts or offers. Candidates re-apply after a year, and Jotform still has every
original submission. The default cutoff keeps a re-run from importing them again; pass
`--since 2023-01-01` if they are ever wanted back.

The report at the end lists, per form: fetched, inserted, updated, already present, deleted,
old (before `--since`), failed, how many linked to a position, how many had a resume, and files found, copied, skipped
and failed; then how many email addresses and phone numbers appear on more than one
application (repeat applicants, which matter in a seasonal business). Any warning (a file that
could not be downloaded, a submission without a parseable time) is printed with its submission
ID. The exit code is 1 if anything failed, so a wrapper notices.

## What it writes, and what it never writes

`applications`: one row per submission with the cleaned columns from CLAUDE.md section 6
(`name`, `first_name`, `last_name`, `email`, `email_norm`, `phone`, `phone_norm`, `city`,
`state`, `location`, `position_text`, `position_id`, `source`, `source_detail`, `referred_by`,
`available_start`, `has_resume`, `language`, `answers`, `jotform_url`). Inserting a row fires
the trigger that creates `application_status` (stage "Applied", `stage_since` = submission
time) and the first `status_history` row; the script never touches those tables.

`application_files` and bucket `recruiting-files`: one object per approved upload URL in a
mapped resume or portfolio file-upload question, under
`applications/<form id>/<submission id>/<safe file name>`, with the original name, kind
(`resume` for the form's resume question, `portfolio` for its portfolio question, otherwise
`other`), content type and size recorded. Objects are private; the frontend asks for signed
URLs.

Never stored (CLAUDE.md section 5): driver licence number, expiry and class (questions 30, 31,
35), signature images (238, 333, 369, and any `_signature_` URL wherever it appears), initials
(324 to 332). The list comes from each form's `field_map.never_import` in `recruiting.forms`,
so a change there applies without a code change. `clean.test.mjs` asserts none of these survive.

## Cleanup rules (CLAUDE.md section 4), as implemented

- Option answers (dropdown, radio, checkbox) on the Spanish form keep the text before the first
  slash ("Yes/Si" → "Yes", "Indeed.com/" → "Indeed.com", "High School Diploma/ Diploma de
  secundaria" → "High School Diploma"), except positions, which only lose a trailing slash
  ("Retail Yard Associate / Delivery Driver/" keeps its inner slash). English and CAS option
  answers only lose a trailing slash ("Any/" → "Any"). Free text is never touched, so dates
  like "03/2023" survive.
- Location: "Eugene-Springfield" → "Eugene/Springfield". When the location dropdown is empty
  but one of the three position dropdowns was answered, the location is inferred from it. The
  CAS form has no location question and stores `CAS`.
- Position: the dropdown for the chosen location (English and Spanish) or the free-text
  answer (CAS). `position_id` is set when the text equals a `positions.jotform_option_label`
  for the same location, case-insensitively. "Any", retired dropdown options and free text stay
  unlinked; the Phase 7 drift check reports them.
- Source: the first box ticked becomes `source`; the free-text "other" answer and any further
  boxes go to `source_detail`. When the "Other" box was filled in, Jotform returns the checkbox
  as an object (`{"0": "Indeed.com", "other": "text"}`) instead of an array; both shapes are
  handled, and a submission with only the "Other" text gets `source` = `Other`.
- `email_norm` is lower-cased and trimmed; `phone_norm` is the last ten digits (null when fewer
  than ten). The originals are kept.
- `submitted_at`: Jotform's `created_at` ("YYYY-MM-DD HH:MM:SS", account time zone) or the inbox
  `subtitle` ("Oct 23, 2026 12:56 AM") is parsed by pattern and converted with the IANA zone;
  `Date.parse` is never used. Date answers become `YYYY-MM-DD` after a validity check.
- Any `https://…/uploads/…` URL in any answer that is not a `_signature_` image is a file to
  copy. Jotform returns these with spaces unencoded; downloads percent-encode them.

## Checked against the local stack (2026-10-25)

Unit tests green; a `--limit 25` pull per form, then the full pull (1,321 English, 228 Spanish,
55 CAS applications; 13 trashed English submissions skipped; 1,068 files), then the same commands
again (nothing inserted the second time), then `--refresh --skip-files` (every row updated, no
status or history row touched). Files downloaded back from Storage matched their
recorded size and magic bytes, and `createSignedUrl` worked. `scripts/test-policies.sql` was all
PASS after `db reset` (its row counts assume the seed, so run it before the backfill, not after).
