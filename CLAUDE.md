# CLAUDE.md — read every session, obey without exception

Project: **Outreach Hub** — a lead-enrichment engine for Embark. Full plan in
`planning/` (start at `planning/README.md`, then `planning/11-execution-checklist.md`).

## 🔴 TWO HARD RULES (permanent — these override convenience, speed, or any spec)

### Rule 1 — Human-led live enrichment; ~$1.50 autonomous spend ceiling
Automated tests and agent-driven development runs may NOT call the live Claude API or
`web_search`. Real model behavior is tested only when a human clicks **Enrich** in the
built app. That click authorizes the full live enrichment waterfall for only the newly
uploaded entries in that run; it does not authorize database sweeps, agent-started runs,
or unrelated batches.

You may NOT incur more than **~$1.50 USD** in Claude API + tool costs (input/output
tokens **plus** `web_search` per-search fees) in autonomous work **without the user's
direct, in-the-moment go-ahead.**
- Before ANY action that could plausibly exceed that — above all the web-research
  fan-out in milestone M6 / `planning/09-web-enrichment-spec.md` — **STOP and ask**,
  with a short cost estimate (how many companies × searches, roughly how many dollars).
- Acceptance-test fixtures must be **tiny** (1–2 items), never a full batch, so testing
  stays far under the ceiling.
- Never kick off a real end-to-end enrichment run yourself. A human-triggered app run is
  the approval boundary. When in doubt, keep tests stubbed and ask.

### Rule 2 — Enrich ONLY new, user-uploaded entries. NEVER sweep the database.
The engine's entire job is to enrich the **new things a user uploads**. It must NEVER
proactively enrich, backfill, batch-process, or "seed" anything already in the local
database — not `contacts`, not `accounts`, not `companies`, not `opportunities`, nothing.
- The local database is a **LOOKUP source only** (local-first: we check it to reuse data
  we already have and thereby AVOID paying for web enrichment).
- If an uploaded entry happens to match something already in the DB, reuse that record
  **on a per-case basis** for that one uploaded item. That is the only time DB data is
  "touched" by enrichment — reactively, one record at a time, never as a sweep.
- There is no job, script, or milestone that iterates the DB to enrich it. If you ever
  find yourself writing a loop over all contacts/companies to enrich them, STOP — that is
  forbidden and would be an expensive mistake.

## Testing
Automated tests are **light and never call the live Claude API or `web_search`**
— test pure functions + SQL + plumbing offline, stubbing the model with canned
tool responses where a step would call it (11 §Testing philosophy). Real model
behavior (vision accuracy, research results) is verified by the **user manually
running the built product**, not by automated tests or agent interpretation. Agents may
report objective telemetry and failures, but must not launch live runs or treat their own
qualitative reading of research output as acceptance.

## How to work here
- The `planning/` docs are the authoritative spec. Verbatim blocks (prompts, schemas, SQL
  patterns, thresholds, model IDs) are copied exactly. When docs conflict, the deeper spec
  wins (08/09/10 > 02–06). Settled decisions live in `planning/07-flags.md` — don't
  relitigate them.
- Build milestones strictly in order (M0→M8), one at a time, meeting each Accept criterion
  before moving on, and report at every milestone boundary.
- Environment: Next.js on Vercel; Supabase (keys in `.env.local`; tables not yet loaded —
  loading is M0); Inngest for jobs; psql 16 is installed (on user PATH; use a fresh
  terminal). Authz is app-code, not RLS (see `planning/02-data-model.md` §Authorization).
