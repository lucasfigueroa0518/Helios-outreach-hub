# 06 — API & architecture

## Stack (already in place)

- Next.js App Router (Vercel) · Supabase Postgres + Storage (+ Auth, + 
  Realtime for run progress) · Anthropic API (`lib/anthropic.ts`) ·
  `lib/supabase.ts` (anon client + service-role admin).

## The long-running-job problem (the key architectural decision)

Enrichment runs take minutes (vision extraction + fanned-out web research).
Vercel serverless functions cap out (10s–800s depending on plan/config) and
give no durability if a function dies mid-run. Options:

| Option | Verdict |
|---|---|
| A. Vercel function with `maxDuration` + fire-and-forget | Simplest; fragile for 100+ lead runs; no resume |
| B. **DB-queue worker model** — runs land in `outreach.runs` as `queued`; a worker loop processes stage-by-stage, checkpointing status to the DB after each stage | **Recommended.** Durable (crash = resume from last checkpoint), observable (UI reads status straight from the tables), portable (worker can be a Vercel cron-triggered function per stage in v1, a dedicated worker later) |
| C. External queue (Inngest/Trigger.dev/QStash) | Better ergonomics than B but a new vendor dependency; defer until B hurts |

~~v1 = Option B with stage-granular checkpoints~~ **SUPERSEDED (audit round,
2026-07-13): Option C chosen — event-driven triggers + a real queue
(Inngest), workers off raw Vercel-function ticks. Full design in
[10-jobs-and-events.md](10-jobs-and-events.md).** The DB remains the source
of truth for run state (that part of Option B survives); the queue is
transport + retry + concurrency control only. Cron polling is dead: latency
per stage was up-to-a-minute, which contradicts the seamless-UX requirement,
and big research fan-outs risked function-duration ceilings.

## Routes (App Router `app/api/...`)

| Route | Method | Does |
|---|---|---|
| `/api/campaigns` | GET, POST | list (with lead counts), create (default name logic) |
| `/api/campaigns/[id]` | GET, PATCH | detail; rename / archive |
| `/api/campaigns/[id]/merge` | POST | body: `source_campaign_id` — merge semantics per 02 |
| `/api/campaigns/[id]/uploads` | POST | signed-URL flow: client uploads direct to Supabase Storage, then registers metadata |
| `/api/campaigns/[id]/runs` | POST | create run from staged uploads → status `queued` (the Enrich button) |
| `/api/runs/[id]` | GET | status + stats (poll target if not using Realtime) |
| `/api/runs/[id]/process` | POST (internal) | worker tick: advance the run one stage; invoked by queue/cron, guarded by service key |
| `/api/campaigns/[id]/sheet` | GET | the merged campaign sheet (JSON for viewer; `?format=csv|xlsx` for exports) |
| `/api/campaigns/[id]/sheet/replace` | POST | **Upload & Replace = hard overwrite** (see below + 07-flags.md #7) |
| `/api/auth/login` | POST | body: `{ email }`; validate `@embarkwithus.com`, find-or-create user, set session. No password |
| `/api/auth/logout` | POST | clear session |
| `/api/auth/me` | GET | current user (drives the login gate) |

All app routes require a session. **Authorization is enforced in app code**
— NOT by RLS (service-role key + custom sessions bypass RLS; see 02
§Authorization model). Scope **user-owned** entities by `owner_id`
(`campaigns`, and `runs`/`uploads`/`campaign_leads` via their campaign); the
**shared knowledge tables** (`leads`, `companies`, `company_resolutions`,
`contacts`, `accounts`, …) are global by design and are NOT owner-scoped.
RLS is not a security layer in v1.

### Auth (passwordless, email-only — v1)

- `login` validates the domain, upserts `outreach.users` by email, issues a
  session cookie. No password, no verification email.
- Implementation: a custom session — a **signed JWT in an httpOnly, Secure,
  SameSite=Lax cookie**, signed with **`SESSION_SECRET`** (env var; a long
  random string, rotated by re-issuing). Not Supabase Auth. If we later want
  magic-link verification or SSO, swap the `login` internals without touching
  callers. Every run/campaign stamps `user_id` from the verified session.
- Every handler resolves the session, then scopes DB access to that
  `user_id`/`owner_id`. A request without a valid session cookie → 401.

### Upload & Replace = hard overwrite

The uploaded file becomes the campaign's authoritative lead set, wholesale:

1. Parse the uploaded CSV/XLSX (must carry the `ID` column from an export).
2. For each row with a **known ID** (SF or Outreach) → update that lead's
   editable fields (email, title, etc.) and keep it in the campaign.
3. Rows with a **blank/new ID** → create a new `outreach.leads` row + add to
   the campaign.
4. Any lead currently in the campaign but **absent from the file** → removed
   from `campaign_leads` (dropped from this campaign; the lead entity stays
   in the `outreach.leads` master, not hard-deleted).
5. The file's data columns are taken as truth on replace; we do **not**
   re-derive relationship/color fields here — those refresh only on the next
   enrichment run. Gotcha surfaced to the user in the confirm dialog and in
   07-flags.md #7.

Guarded by a confirm step client-side; server validates schema and reports
any unparseable rows rather than partially applying.

## Pipeline implementation notes

- **Extraction** (per file): Anthropic messages call, tool-forced JSON schema
  (`extract_people` tool) so output is structured, not prose. Images base64;
  PDFs via native document support; CSV/XLSX parsed deterministically
  server-side with one Haiku-class column-mapping call.
- **Company research fan-out**: N parallel Anthropic calls with the
  `web_search` server tool, each returning the worker output contract
  (03 §E). Concurrency capped (~4, like the prototype); batch results
  upserted into `outreach.companies` as each batch lands.
- **Everything else is SQL/TypeScript**: normalization, identity resolution
  (`pg_trgm` queries), email pattern application, relationship derivation,
  XLSX generation (SheetJS or exceljs — needs the row-fill support: exceljs).
- **Idempotency**: every stage keyed by run_id + stable input hash; re-ticks
  are no-ops on completed work (safe retries).

## Storage layout

```
supabase storage bucket: outreach-uploads (private)
  {campaign_id}/{run_id}/{upload_id}-{original_name}
```
Signed URLs for client upload/download; nothing public.

## Security

- **Authorization in app code, not RLS** — owned entities scoped by
  `owner_id`; shared knowledge tables intentionally global (02 §Authorization
  model). RLS is out of scope in v1 (service role bypasses it; custom session
  gives no `auth.uid()`) — see the RLS re-enable note in 02 before launch.
- Service-role key only in server routes (already the repo convention); never
  in any `NEXT_PUBLIC_*` var / client bundle.
- Inngest endpoint (`/api/inngest`) is verified by Inngest's signing key
  (`INNGEST_SIGNING_KEY`), not user auth, since the queue invokes it.
- `SESSION_SECRET` signs the session JWT; keep server-only.
- Web-search results are third-party content: treat as data, never as
  instructions (prompt-injection hygiene in research worker prompts —
  extraction contract only, no tool access beyond search).

## Environment additions

`.env.example` gains: **`SESSION_SECRET`** (signs the session JWT — long
random string), plus the queue + concurrency vars (10 §6): `INNGEST_EVENT_KEY`,
`INNGEST_SIGNING_KEY`, `ORG_RESEARCH_CONCURRENCY`, `ORG_EXTRACTION_CONCURRENCY`,
`ORG_VERIFY_CONCURRENCY`, `SEARXNG_URL`. Vercel envs mirror `.env.local` via
dashboard/CLI at deploy time.

## Build order (when we do build)

1. `db/outreach_schema.sql` (tables, view, indexes, RLS) + add primary keys
   to the seeded tables and make the initial load a one-time non-destructive
   bootstrap (no `DROP TABLE` on re-run).
2. Passwordless email login (login/logout/me routes + login screen + session
   cookie + `outreach.users` upsert).
3. Campaign CRUD + Outreach Hub screen (list, create, rename, archive,
   merge).
4. Upload flow (storage + staged list UI).
5. Pipeline stages B→H behind the runs worker, one stage at a time, with the
   run-status UI reading checkpoints.
6. Review viewer + exports.
7. Hardening: retries, extraction-verification pass, cost telemetry
   (tokens/run logged into `runs.stats`).
