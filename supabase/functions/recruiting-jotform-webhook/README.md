# recruiting-jotform-webhook

Supabase Edge Function that receives Jotform's webhook for the three employment application
forms and inserts each new submission into `recruiting.applications` with the same rules as the
backfill. Setup, deployment and the local test are README step 14 at the repo root; the rules
themselves are in `../_shared/clean.mjs`, shared with `scripts/backfill/`.

## Request

Jotform posts `multipart/form-data` with `formID`, `submissionID`, `rawRequest` (the answers as
a JSON string keyed `q<ID>_<name>`), `formTitle`, `ip` and a few more parts. Only `formID` and
`submissionID` are read; the submission itself is fetched from `GET /submission/{id}` on
Jotform's REST API with the `JOTFORM_API_KEY` secret. JSON and urlencoded bodies with the same
two fields are accepted too (handy for curl).

Authentication is the shared secret, `?secret=<JOTFORM_WEBHOOK_SECRET>` on the URL (or an
`x-webhook-secret` header), compared in constant time before anything else happens. The
gateway's JWT check is off for this function (`config.toml`, `--no-verify-jwt`) because Jotform
cannot send a Supabase JWT.

## Responses (always JSON)

| Status | Body | When |
| --- | --- | --- |
| 200 | `{"status":"inserted","application_id":…,"files":n}` | New row written; files copy in the background |
| 200 | `{"status":"exists","application_id":…}` | Submission already imported (retry, duplicate delivery, or backfilled) |
| 200 | `{"status":"skipped","reason":"deleted in Jotform"}` | Submission is in Jotform's trash |
| 200 | `{"ok":true,…}` | `GET` with a valid secret: a deployment check |
| 400 | `{"error":…}` | Unknown or inactive form ID, missing or non-numeric IDs, submission belongs to another form |
| 401 | `{"error":"unauthorised"}` | Secret missing or wrong |
| 405 | | Method other than GET or POST |
| 502 | `{"error":…}` | Jotform's API did not return the submission |
| 503 | `{"error":"function not configured","missing":[…]}` | A secret is not set yet |
| 500 | `{"error":"import failed; see function logs"}` | Database error |

## Environment

| Variable | Required | Source |
| --- | --- | --- |
| `JOTFORM_WEBHOOK_SECRET` | yes | Edge Function secret; the same value goes on the webhook URL in Jotform |
| `JOTFORM_API_KEY` | yes | Edge Function secret; read-only Jotform key |
| `JOTFORM_API_BASE` | no | Default `https://api.jotform.com`; EU accounts `https://eu-api.jotform.com`; the local stub for tests |
| `JOTFORM_TIMEZONE` | no | Default `America/Los_Angeles`, the zone Jotform's `created_at` is expressed in |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | injected | Set by Supabase on deploy and by `functions serve` locally |

Secrets are created by an organization Administrator (Dashboard → Edge Functions → Secrets, or
`npx supabase secrets set --env-file supabase/functions/.env`); never in code, config or a
commit. Locally, copy `../.env.example` to `../.env` (gitignored).

## Files

| File | Purpose |
| --- | --- |
| `index.ts` | The function: secret check, form lookup, idempotency check, Jotform fetch, insert, background file copy |
| `../_shared/clean.mjs` | Cleanup rules (field map, never-import list, Spanish values, normalisation). Canonical; the backfill re-exports it. Tests: `npm run backfill:test` |
| `../.env.example` | Variable names for the local run |
| `../../../scripts/webhook-test/stub-jotform.mjs` | Fake api.jotform.com for the local test (`npm run webhook:stub`) |

Logs carry form and submission IDs and outcomes only, never answers, names or secrets.
