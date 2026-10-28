# web

The frontend (Phases 6 and 7). Plain HTML, CSS and JavaScript; no build step. Pages are picked by the URL hash: `#/applications`, `#/positions`, `#/documents`, `#/reports`.

| File | What it is |
| --- | --- |
| `index.html` | Sign-in, no-access and tracker views; loads `@supabase/supabase-js` 2.118.0 and jsPDF 3.0.3 from pinned jsDelivr URLs |
| `styles.css` | Tokens and layout from `reference/prototype-tracker.html`, light and dark |
| `app.js` | Auth (sign-in, invite and password-reset links, forgot-password), role gate, hash routing between pages, data loading, pipeline, filters, table, drawer (with offers and referrals for staff), writes, CSV export, and the Add application form (admin and hr) for paper applications, which uploads scans to `manual/<application id>/` in the bucket; exposes `window.RR` for the page scripts |
| `application-pdf.js` | Lays out the "Download application (PDF)" document from the model `app.js` builds for the signed-in role, with jsPDF; the file is named `<Last>-<First>-application.pdf` and nothing is stored |
| `positions.js` | Positions page: list, funnel, drift check against the English form's dropdowns, aliases and unmatched texts, postings and channel spend (Phase 7) |
| `documents.js` | Document library: uploads under `documents/` in the private bucket, inline text templates, `min_role` (Phase 7) |
| `reports.js` | Reports page over the `report_*` views with CSV export (Phase 7) |
| `assets/` | Approved Rexius logo files: `rexius-mark.png` (green square mark, header and favicon sizes), `rexius-logo.webp` (dark wordmark, light mode) and `rexius-logo-white.webp` (white wordmark, dark mode) |
| `config.js` | Supabase URL and publishable key. Committed with the local stack's values; `.github/workflows/pages.yml` overwrites it with the hosted project's at deploy time (README step 13) |

Run from the repo root with `npx serve web` and open http://localhost:3000. The README at the root
lists the local test users. Only the project URL and the public key belong in this folder.
