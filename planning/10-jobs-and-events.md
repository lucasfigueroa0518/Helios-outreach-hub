# 10 — Jobs & events (event-driven queue; supersedes 06's cron-tick option)

> Superseded on 2026-07-20 by
> [`12-postgres-orchestration.md`](12-postgres-orchestration.md). This file is
> retained only as the historical Inngest contract inventory.

DECIDED (audit round, 2026-07-13): **event-driven triggers + a real queue**,
not cron polling, and the pipeline worker moves **off raw Vercel functions**.

## 1. Queue choice: Inngest

Chosen because it fits this exact stack with the least new machinery:
- Functions deploy INSIDE the Next.js app (one `/api/inngest` route) —
  no separate worker infra, still Vercel-hosted, but Inngest handles
  orchestration: durable steps, automatic retries with backoff, per-step
  timeouts, and **concurrency keys** (our org-wide budget) natively.
- Event-driven: work starts the instant an event fires — zero cron latency,
  which is what "seamless" requires.
- Each `step.run` is a separate invocation → no single long function fighting
  Vercel duration limits; a step that dies retries alone.

**Required Vercel config — or steps time out.** The `/api/inngest` route is a
normal Vercel function with a low default `maxDuration` (10s hobby / 60s pro
default). A single research or extraction step runs 30–90s and **will be
killed mid-flight** unless the route sets the ceiling:
`export const maxDuration = 300` in the route file (and the plan/tier must
allow 300s), plus `export const runtime = 'nodejs'` (NOT edge — the worker
uses `node:dns`, `node:crypto` sha256, `heic-convert`, and `pg`, none of
which exist on the edge runtime). Each individual `step.run` must also fit
inside that ceiling; the per-company/per-file granularity (one company, one
file per step) keeps them well under 300s.

Fallback if Inngest is vetoed at build time: Upstash QStash with the same
event names and the job-claim pattern from 09 §3.1 doing the heavy lifting.
The Postgres job table is the source of truth either way — the queue is
transport, never state.

## 2. Events

| Event | Fired by | Payload |
|---|---|---|
| `run.created` | POST /api/campaigns/[id]/runs (the Enrich click) | { runId } |
| `run.file.extracted` | extraction step, per file | { runId, uploadId } |
| `run.extraction.complete` | when all files done | { runId } |
| `company.research.requested` | Stage E enqueue | { jobId } |
| `domain.verify` | a domain becomes known (D2/D4/I1) | { domain } |
| `run.enrichment.complete` | last job for the run resolved | { runId } |
| `campaign.replace.uploaded` | Upload & Replace | { campaignId, uploadId } |

## 3. Functions (all in `lib/inngest/functions.ts`)

1. **`processRun`** — trigger `run.created`. Steps: mark run `extracting` →
   fan out one step per upload (extraction per 08; each step ≤1 file so
   duration stays minutes-safe) → normalization + identity resolution +
   Phase-1 direct-discovery D1–D3 (pure SQL/code, one step) → enqueue
   research jobs for people still without a direct email (09 §3.1) → if zero
   jobs, jump straight to finalize.
2. **`researchCompany`** — trigger `company.research.requested`.
   Concurrency: `{ limit: ORG_RESEARCH_CONCURRENCY (8), key: 'global' }`.
   Claims the job row (SKIP LOCKED), runs the worker (09 §3.2–3.4), grades +
   caches (09 §5), marks job done/failed, then checks: was this the last
   outstanding job for any requesting run? → fire `run.enrichment.complete`.
   Retries: Inngest default 3 with backoff; 429s use the backoff schedule in
   09 §4 via `RetryAfterError`.
3. **`finalizeRun`** — trigger `run.enrichment.complete`. Email assignment
   (09 §6) → relationship derivation (03 §G) → snapshots → verification
   (03 §H) → run `complete` → stats written.
4. **`applyReplace`** — trigger `campaign.replace.uploaded`. Hard-overwrite
   semantics from 06.
5. **`verifyDomain`** — trigger `domain.verify`. **Off the critical path**
   (09 §7): **MX DNS lookup only** (the SMTP catch-all probe was removed —
   serverless blocks outbound port 25; catch-all deferred to the future paid
   API). Writes `mx_status` to `outreach.companies` (by domain) and annotates
   affected leads. Concurrency key `ORG_VERIFY_CONCURRENCY` (default 6),
   **separate** from research/extraction so it never competes with or delays
   them. A run reaches `complete` without waiting on any `verifyDomain` —
   badges stream in afterward via the UI's Realtime/poll. De-duped: skip if
   the domain was verified <30 days ago. This is why "verify emails" costs
   zero run throughput (user directive).

## 4. Org-wide concurrency budget

One constant, `ORG_RESEARCH_CONCURRENCY = 8`, enforced by Inngest's global
concurrency key — N users' simultaneous runs share the same budget, so org
rate limits are respected structurally (not by per-run guesswork), while
each run still progresses (FIFO across the shared job queue). Extraction
calls get their own key (`ORG_EXTRACTION_CONCURRENCY = 10`). Both are env
vars; raising them is a config change, not a code change. This is the
"fast by default, never fear-throttled" posture: full speed until the API
actually pushes back, then 09 §4's backoff + reporting + resume takes over.

## 5. Progress & UX wiring

- Every step writes its checkpoint to `runs.status` / `runs.stats` — the UI
  reads Postgres (poll 2s or Supabase Realtime), never queue internals.
- Rate-limit banner state comes from `runs.stats.rate_limit_events` (09 §4).
- A run is resumable by construction: re-firing `run.created` for a
  half-finished run is safe end-to-end (extraction cache hits by content
  hash, identity resolution upserts, job table dedupes by company_key,
  finalize is a pure recompute).

## 6. Env additions (goes into .env.example at build)

```
SESSION_SECRET=        # signs the passwordless session JWT (06); long random string, server-only
INNGEST_EVENT_KEY=
INNGEST_SIGNING_KEY=
ORG_RESEARCH_CONCURRENCY=8
ORG_EXTRACTION_CONCURRENCY=10
ORG_VERIFY_CONCURRENCY=6
SEARXNG_URL=            # self-hosted SearXNG for the search fallback (09 §3.4); instance MUST have json in search.formats or it 403s; blank = fallback disabled
```
