# recruiting-applicant-summary

Edge Function for Phase 9b: applicant summaries and the reply translator, both started from an
application's drawer by HR or an admin. `summarize` has Claude read one application against its
position and stores the result as a `recruiting.applicant_summaries` row (facts only: no score,
rank or recommendation; an English translation of every written answer not in English).
`translate` turns a message into Spanish or English for HR to copy, and logs only its usage in
`recruiting.message_translations`.

The header comment in `index.ts` is the reference for the requests, the responses, what is sent
to Claude and the environment. `docs/applicant-summary-rules.md` is the same contract written for
HR; change it and `SYSTEM_PROMPT` together. README.md "What Phase 9b created" explains the design
and step 16 the setup.

Deploy with the gateway's JWT check off, like the market check; the function checks its caller
itself (admin or hr with a two-factor session):

```sh
npx supabase functions deploy recruiting-applicant-summary --no-verify-jwt
```

Secrets it reads: `ANTHROPIC_API_KEY_RECRUITING` (never `ANTHROPIC_API_KEY`), optional
`APPLICANT_SUMMARY_MODEL`. Local testing: `APPLICANT_SUMMARY_API_BASE` pointing at
`scripts/summary-test/stub-anthropic.mjs` (`npm run summary:stub`), see
`supabase/functions/.env.example`.
