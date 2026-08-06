# 11 — Execution checklist (build order for the implementing model)

Follow milestones IN ORDER. Do not start a milestone until the previous
one's acceptance criteria pass. When this doc conflicts with another doc,
the deeper spec wins (08/09/10 > 02–06). Never improvise on anything a spec
pins verbatim (prompts, schemas, thresholds, model IDs).

## Testing philosophy (light + offline; no live API calls)

Automated tests here are deliberately **light and must NOT call the live
Claude API** (keeps every acceptance check at ~$0 and honors CLAUDE.md
Rule 1). Two buckets:

- **Automated (offline, deterministic):** pure functions and SQL/plumbing —
  `applyPattern` + its matrix (09 §7), the Name Standard (04), company-name
  canonicalization, identity-resolution candidate merge, the job
  claim/`finish_research_job` SQL (idempotency/race), the load idempotency
  (M0), MX DNS lookup, type-sniffing/routing, image transcode+tiling
  geometry, and the extraction cache-hit logic. Where a step would call the
  model, **inject a stub model client that returns a canned tool response**
  (a recorded fixture) — this tests orchestration/plumbing without spending.
- **Manual (post-build, by the user):** anything that depends on real model
  judgment — vision extraction *accuracy*, and the web research worker's
  real output — is verified by the user running the actual product after the
  build, NOT by automated live-API tests. The 08 §8 / 09 §9 fixture lists are
  run against the stub for plumbing; their real-world quality is a manual pass.

So: build the deterministic tests, stub the model everywhere else, and hand
off to manual testing for live behavior. Do not write tests that hit the
Claude API or the `web_search` tool.

## M0 — Database bootstrap
Build the **two canonical DB files** (02 §Canonical DB-setup files):
`db/bootstrap.sql` (six seeded tables `CREATE IF NOT EXISTS` + PKs/uniques +
staged `\copy → ON CONFLICT DO NOTHING` load) and `db/outreach_schema.sql`
(all `outreach.*` tables incl. `company_research_jobs`, the `all_people`
view, `pg_trgm` + indexes per 02's index notes, and the SQL functions
`claim_research_jobs`/`enqueue`/`finish_research_job`). **No RLS** (authz is
app-code, 02 §Authorization model). Delete the old `schema.sql`/`load_data.sql`;
repoint npm scripts.
Load mechanism: `\copy` via **psql** (installed: PostgreSQL 16 at
`C:\Program Files\PostgreSQL\16\bin`, on the user PATH — run `db:load` in a
fresh terminal). `\copy` cannot run in the Supabase SQL editor; use psql
against `DIRECT_DATABASE_URL` (session pooler).
Accept: loader runs twice → row counts unchanged. All PKs exist.
`SELECT similarity('TA Associates','ta associates llc')` works.

## M1 — Auth (passwordless)
Build: `/api/auth/{login,logout,me}` per 06, login screen per 05 §Screen 0,
session = **signed JWT (`SESSION_SECRET`) in an httpOnly/Secure/SameSite=Lax
cookie**, domain check `@embarkwithus.com`, `outreach.users` upsert. Add a
shared helper that resolves the session and **scopes user-owned queries by
`owner_id`** (campaigns + their runs/uploads/campaign_leads). Shared
knowledge tables (leads/companies/contacts…) are NOT owner-scoped (02
§Authorization model). This is the authz layer — there is no RLS.
Accept: new email → account created + session. Wrong domain → inline error.
All other routes 401 without session. A user cannot read another user's
campaigns; but identity resolution still sees all leads (shared).

## M2 — Campaigns
Build: campaign CRUD routes + Outreach Hub screen per 05 (list, create
modal w/ `Campaign #N` default, rename, archive, merge picker). Merge =
stack + 3-of-4 dedup (email counts once) per 02.
Accept: two campaigns w/ overlapping leads merge → survivor keeps name,
duplicates collapse per rule, source archived w/ `merged_into_id`.

## M3 — Uploads
Build: storage bucket + signed-URL upload flow, `outreach.uploads` rows,
Upload tab states 1–2 per 05, type sniffing/rejection per 08 §1. (Content
hash is computed later, in the extraction worker per 08 §7 — NOT at intake;
the server never holds the bytes at upload time.)
Accept: drag-drop 5 mixed files → 5 rows w/ hashes; `.exe` rejected with
toast; same file twice → identical hashes.

## M4 — Extraction
Build: 08 end-to-end (router, image tiling + two-pass, PDF, tabular w/
mapping cache, office, text, extraction cache) as Inngest `processRun`
steps (10 §3.1); `lib/models.ts`; Upload tab state 3 (bars + statuses).
HEIC/HEIF decode via **`heic-convert` before sharp** (08 §2.1 step 0 — sharp
prebuilt has no libheif on Vercel). Content hash computed **in the worker**
on download, not at intake (08 §7). Set `maxDuration=300` +
`runtime='nodejs'` on `/api/inngest` (10 §1).
Accept (all offline, stubbed model — no live API; 11 §Testing philosophy):
14 fixtures in 08 §8 pass against a stubbed model client; transcode + tiling
geometry + type-sniffing verified with real files; cache-hit path makes zero
model calls. Real vision accuracy → deferred to your manual test post-build.

## M5 — Identity resolution + DIRECT local email (Phase 1, D1–D3)
Build: Stage C normalization, Stage D two-query candidate merge (02),
≥2-signal confirmation, lead upsert, waterfall **direct-discovery** stages
D1–D3 (09 §1). NO bulk format-derivation script (removed — Rule B). On-demand
`lib/derive-format.ts` stub in place but only invoked in Phase 2.
Accept: lead matching an existing contact adopts its email w/ status
`from_embark_db`, NO research job, NO inference. 09 test 1 passes.

## M6 — Web discovery + inference + verification (Phase 1 D4, Phase 2, §7)
Build: job table + claim/enqueue/**`finish_research_job`** as Postgres
functions invoked via `.rpc()` (09 §3.1/§3.1b — NOT supabase-js query
builder; `FOR UPDATE SKIP LOCKED` and the atomic completion count live in
SQL), `researchCompany` Inngest fn w/ global concurrency (10 §4), worker
call (09 §3.2 verbatim, **`tool_choice: auto` — never force
`report_company`**, literal-email-first), disambiguation (09 §3.3), SearXNG
fallback (09 §3.4 — instance needs `json` in `search.formats`), grading +
the two-layer domain/resolution cache (09 §3.5, §5), on-demand local format
derivation (09 §2, I1), `lib/email-patterns.ts` + unit matrix (09 §6/§7),
candidate assembly + collision rule, rate-limit backoff/breaker/reporting
(09 §4), selective missing-profile-field research + strict triangulation
write gate (09 Rule C), per-row two-search Haiku profile rescue on a separate
trailing concurrency lane (09 §3.2b), one company-coordinated email rescue
for all unresolved people (09 §3.2c), append-only evidence ledger + reducer,
separate email-domain scoring, exact-candidate checks, optional finder/verifier
adapters, reactive human feedback, `verifyDomain` trailing fn scoped to the
uploaded run (09 §7, 10 §3.5), finalize fn + a
completion sweeper backstop (09 §3.1b).
🔴 SPEND GATE (CLAUDE.md Rule 1): automated tests here make **no live API /
web_search calls** — the research worker is **stubbed** with canned
`report_company` fixtures, so they cost ~$0. A real enrichment run (live
web_search) happens only in your manual test post-build, and needs your
explicit go-ahead with a cost estimate.
Accept (offline, stubbed worker): 09 tests 2–11 pass. A found literal email →
`direct`, no inference (test 3). Same-name-different-company → no poisoning
(test 6). Domain with no MX → run `complete` with an Invalid verification
badge (test 11). Verification is MX plus an optional provider adapter;
automated tests inject canned provider responses and never call it live.
Profile fields: supplied values are never queried/overwritten; one-source,
medium/low, non-person-specific, same-source-family, and company/HQ location
evidence are rejected; two independent agreeing sources (including one
first-party/professional profile) may fill only the requested blank field.
Rescue targets only still-blank cells, carries forward only agreeing evidence,
and dispatches per row without a run-wide barrier or live calls in tests.
Email tiers distinguish re-verified `Found`, evidence-backed `Inferred`,
unresolved `Format Guess`, and blank `Not Found`; cited formats never receive
blind-default padding. Format guesses are non-send-ready and export in a
separate Candidate Guess column. Cohort evidence is shared consistently,
empty retries cannot erase stronger facts, professional-profile context is
carried into research, and every candidate decision is explainable.
`runs.stats.enrichment` populated. Live research quality → your manual test.

## M7 — Relationship + sheet
Build: Stage G SQL (03), snapshots, tier calc (`max()` rule), sheet route
(JSON/CSV/XLSX per 04 — exceljs for fills: red=active, orange=dormant),
Review tab viewer per 05 w/ gold/yellow/pink data-quality fills + tier chip.
Accept: known-won account lead → `Work done` + correct dates + red fill in
XLSX. CSV export carries `Relationship Tier` text column.

## M8 — Replace + polish
Build: Upload & Replace hard-overwrite (06) via `applyReplace` fn, confirm
dialog, stage-gating toasts, run-progress line, Draft tab stub.
Accept: export → delete a row + edit an email → replace → sheet reflects
both; absent lead removed from campaign but present in `outreach.leads`.

## Standing rules for the implementer
1. Local-first (03): never add a paid call where a DB lookup can answer.
2. Never invent data; blanks + warnings over guesses (08 §0).
3. All model IDs from `lib/models.ts`; all tunables from env.
4. Every stage idempotent — re-running any Inngest function must be safe.
5. UI only via embark-dashboard-design tokens/recipes; no new shapes.
6. Secrets never in client bundles; only `NEXT_PUBLIC_*` reaches the browser.
