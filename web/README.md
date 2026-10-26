# web

The tracker frontend (Phase 6). Plain HTML, CSS and JavaScript; no build step.

| File | What it is |
| --- | --- |
| `index.html` | Sign-in, no-access and tracker views; loads `@supabase/supabase-js` 2.118.0 from a pinned jsDelivr URL |
| `styles.css` | Tokens and layout from `reference/prototype-tracker.html`, light and dark |
| `app.js` | Auth, role gate, data loading, pipeline, filters, table, drawer, writes, CSV export, and the Add application form (admin and hr) for paper applications, which uploads scans to `manual/<application id>/` in the bucket |
| `config.js` | Supabase URL and publishable key. Committed with the local stack's values; the comment says how to swap in the hosted project's |

Run from the repo root with `npx serve web` and open http://localhost:3000. The README at the root
lists the local test users. Only the project URL and the public key belong in this folder.
