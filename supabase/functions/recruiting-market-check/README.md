# recruiting-market-check

Edge Function for Phase 9a: one market check for one position (what others advertise for the
role in the area, who else is hiring), run through Claude with the server-side web search
tool and stored as a `recruiting.market_checks` row. The header comment in `index.ts` is the
reference for the request, the responses, the two callers (the tracker with the user's JWT;
pg_cron and the "became open" trigger with the `x-market-check-secret` header) and the
environment. README.md "What Phase 9a created" explains the design and step 15 the setup.

Deploy with the gateway's JWT check off, because pg_net cannot send a Supabase JWT and the
function checks its callers itself:

```sh
npx supabase functions deploy recruiting-market-check --no-verify-jwt
```

Secrets it reads: `ANTHROPIC_API_KEY_RECRUITING` (never `ANTHROPIC_API_KEY`),
`MARKET_CHECK_SECRET`, optional `MARKET_CHECK_MODEL` and `MARKET_CHECK_MAX_SEARCHES`.
Locally: `supabase/functions/.env.example`.
