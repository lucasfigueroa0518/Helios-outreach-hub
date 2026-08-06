# Jobs, API, and runtime architecture

## 1. Runtime boundaries

- Next.js App Router serves pages and authenticated JSON/export routes.
- Supabase Postgres is the durable source of workspace, item, job, and usage
  state.
- Inngest transports events and supplies retries/concurrency.
- Anthropic Messages API performs bounded research and no-search writing.
- No browser code receives Anthropic keys, database credentials, raw prompts,
  positioning assets, or queue credentials.
- No request/GET route runs long model work inline.

Continue using `runtime='nodejs'` and `maxDuration=300` on `/api/inngest`.
Each research/write invocation handles one lead/job and must fit inside that
ceiling.

## 2. Module boundaries

Avoid another monolithic `lib/enrichment.ts`. Suggested server modules:

```text
lib/drafting/
  assets.ts                  load/hash canonical skill + positioning
  types.ts                   shared domain types
  normalize.ts               required-field normalization/fingerprint
  eligibility.ts             completeness + delivery policy
  state.ts                   allowed item transitions
  repository.ts              owner-scoped queries/transactions
  jobs.ts                    enqueue/claim/finish/idempotency
  cost.ts                    estimates, reservation, usage pricing
  research-prompt.ts         research prompt + strict report schema
  research-provider.ts       Anthropic web-search call
  research-validate.ts       source/identity/freshness gates
  writer-prompt.ts           skill/positioning/sender assembly
  writer-provider.ts         no-search structured writer/repair
  lint.ts                    deterministic skill checks
  exports.ts                 inclusion/preflight helpers
  cowork-export.ts           markdown manifest renderer
```

UI:

```text
app/campaigns/[id]/draft/page.tsx
app/campaigns/[id]/draft/drafting-workspace.tsx
app/campaigns/[id]/draft/drafting-status.tsx
app/campaigns/[id]/draft/drafting-mode-toggle.tsx
app/campaigns/[id]/draft/leads-mode.tsx
app/campaigns/[id]/draft/needs-decision.tsx
app/campaigns/[id]/draft/draft-review-card.tsx
app/campaigns/[id]/draft/research-drawer.tsx
app/campaigns/[id]/draft/export-card.tsx
```

Keep provider interfaces injectable so tests use canned responses and count
calls without live APIs.

## 3. Inngest events

| Event | Fired by | Payload |
|---|---|---|
| `drafting.run.started` | start/resume API | `{ draftingRunId }` |
| `drafting.job.requested` | DB transition/API/sweeper | `{ jobId }` |
| `drafting.lead.approved` | Approve-for-drafting transaction | `{ draftingRunId, itemId, jobId }` |
| `drafting.job.retry.requested` | explicit retry API | `{ jobId }` |
| `drafting.workspace.reconcile` | scheduled sweeper/manual repair | `{ workspaceId? }` |
| `run.finalized` | enrichment `finalizeRun`, after DB run is complete | `{ runId }` |
| `lead.email.verification.completed` | AgentMail verification, after result commit | `{ leadId, emailSha256, status, runId }` |

One generic `drafting.job.requested` event can dispatch by DB `kind`; separate
Inngest functions still provide distinct concurrency lanes, including
`verify_mailbox`.

Use deterministic event IDs where supported:

```text
draft-job:{job_id}:{attempt_count}
```

Event payloads contain IDs only. Never include lead names, email addresses,
subjects, bodies, prompts, or source quotes in event metadata.

## 4. Inngest functions

### 4.1 `startDraftingRun`

Trigger: `drafting.run.started`.

Steps:

1. load run and verify active/budget state;
2. query pending jobs created by the start transaction;
3. emit one `drafting.job.requested` per job with stable step IDs;
4. mark run dispatch checkpoint.

This function does not fan out database leads itself. The start API's atomic
DB function has already scoped and created exact jobs.

### 4.2 `verifyDraftingMailbox`

Trigger filter: requested job kind `verify_mailbox`.

Concurrency uses the existing AgentMail org lane
`ORG_MAILBOX_VERIFY_CONCURRENCY` rather than a Claude-research lane. Steps:

1. claim and verify the expected effective-email fingerprint;
2. reuse AgentMail's bounded send/wait/bounce-classification provider;
3. commit the result to the item-scoped delivery snapshot;
4. on `valid`, atomically reserve budget/create one dependent research job;
5. on `invalid`/`unknown`, return the row to Leads mode;
6. dispatch the returned research event, if any.

Refactor the current enrichment helper so the network probe/classifier can
return a result without writing `outreach.leads`. Drafting overrides must not
call `applyMailboxVerificationResult`, which is global-lead-specific.

### 4.3 `researchDraftingLead`

Trigger filter: requested job kind `research`.

Concurrency:

```ts
{
  limit: Number(process.env.ORG_DRAFT_RESEARCH_CONCURRENCY ?? 4),
  key: '"global"'
}
```

Steps:

1. claim job; return cleanly if done/superseded/cancelled/not due or if the
   effective email is no longer mailbox `valid`;
2. reserve/confirm cost ceiling;
3. load immutable input/assets/sender snapshots;
4. run research provider with hard three-search limit;
5. validate packet and citations deterministically;
6. finish job atomically:
   - `needs_human`, or
   - packet current + create dependent write job;
7. dispatch returned write job event.

Retries: provider/network/rate-limit errors only. Invalid research packet gets
one report-enforcement turn inside the provider call; repeated invalid output
is terminal/visible rather than an unbounded retry.

### 4.4 `writeDraftingEmail`

Trigger filter: kind `write`.

Concurrency:

```ts
{
  limit: Number(process.env.ORG_DRAFT_WRITE_CONCURRENCY ?? 8),
  key: '"global"'
}
```

Steps:

1. claim and verify packet/input/current mailbox-valid result;
2. run writer provider without web tools;
3. schema/grounding/lint validation;
4. if hard failure, create/execute one repair job/step (see below);
5. finish current draft and item state atomically.

An automatic repair can be a separate durable `repair` job so a crash between
initial failure and repair does not lose state. It runs on the write lane and
has max one attempt.

### 4.5 `rewriteDraftingEmail`

Trigger filter: kind `rewrite`.

Concurrency:

```ts
{
  limit: Number(process.env.ORG_DRAFT_REWRITE_CONCURRENCY ?? 4),
  key: '"global"'
}
```

Use a separate lane so a user's direct review action does not wait behind a
large initial generation fan-out. It loads the same packet, receives previous
current text as avoid-context, never receives web search, validates, and
hard-overwrites on success.

### 4.6 `draftingReconciler`

Schedule: every 2–5 minutes.

It finds:

- pending jobs with no dispatched event;
- orphaned in-flight jobs past lease/heartbeat;
- active runs whose jobs are all terminal;
- workspaces with stale cached generation/review completion;
- items whose state and current pending job disagree;
- reserved cost left on terminal/superseded jobs;
- previously authorized pending-verification items whose global AgentMail
  result is now `valid`, `invalid`, or `unknown` but whose completion event
  was dropped.

It re-emits safe events, releases reservations, and recomputes state. It never
creates leads/items outside a user-authorized run and never starts fresh paid
work for stored database rows.

### 4.7 `promoteSettledDraftingItems`

Trigger: `run.finalized`.

The enrichment `finalizeRun` function emits this event only after
`finalizeRunEnrichment` has committed the source run as complete. The drafting
function:

1. finds only `waiting_for_enrichment` items already included in a prior
   explicit drafting-run cohort for that exact source run;
2. snapshots the now-settled lead/relationship values;
3. classifies missing fields and exact effective-email verification;
4. queues research only when the row is complete, mailbox `valid`, and the
   prior authorization has reserved budget;
5. otherwise transitions to `needs_lead_review`, `verifying_mailbox`, or
   `budget_paused`;
6. dispatches newly created jobs after commit.

The scheduled reconciler performs the same idempotent promotion if the event
is dropped. Leads created after the prior drafting start are not in its cohort
and require another explicit Go to Drafting action.

### 4.8 `promoteMailboxValidDraftingItems`

Trigger: `lead.email.verification.completed`.

This handles the fact that AgentMail verification is a trailing tail and may
finish after the enrichment run is already `complete`:

1. find only drafting items already included in an explicit drafting-run
   cohort for the exact source lead/run;
2. compare the event email hash to the item's current effective email;
3. copy the committed global result only when there is no different manual
   override;
4. on `valid` plus complete fields, queue/reserve research under the prior
   authorization or set `budget_paused`;
5. on non-valid, keep the item in Leads mode;
6. no-op for removed, stale, newly added, or unowned cohort rows.

The reconciler implements the same idempotent promotion when the event is
dropped.

## 5. Claim, lease, retries, and circuit breaker

### Claim

- `FOR UPDATE SKIP LOCKED`;
- pending and `next_attempt_at <= now()`;
- or in-flight lease older than configured threshold;
- max attempts enforced in SQL/transition logic;
- stale fingerprint becomes `superseded` before any provider call.

### Heartbeat

Research calls can run long. Update heartbeat around provider boundaries. The
orphan threshold must exceed expected max provider duration plus margin (for
example 10 minutes, aligned with enrichment) so a valid long call is not
duplicated.

### Retry classes

Retryable:

- HTTP 429;
- provider 5xx/unavailable;
- network timeout/reset;
- Inngest transient execution failure;
- database serialization/deadlock;

Terminal:

- invalid/unsupported input;
- missing asset/hash mismatch;
- auth/quota/account denial;
- malformed result after bounded enforcement/repair;
- budget exhausted;
- identity conflict/true zero (human state, not failure);
- prompt too large after deterministic bounds;
- stale/superseded input.

### Backoff

Honor provider retry-after. Otherwise use exponential backoff with jitter and
bounded maximum. Record next retry time. Do not retry terminal auth/quota
errors under a generic network category.

### Circuit breaker

Maintain process/DB-visible org telemetry similar to enrichment:

- repeated 429s within a short window pause new provider claims;
- existing ready drafts/review remain available;
- breaker applies independently to draft research and writing lanes;
- status API surfaces slowed/paused category;
- automatic resume occurs at known retry time; no duplicate calls.

## 6. Start/resume API

### `POST /api/campaigns/[id]/drafting`

Purpose: explicit Go to Drafting authorization.

Request:

```json
{
  "sender_profile_id": "uuid",
  "idempotency_key": "client-generated uuid"
}
```

Server:

1. require session;
2. assert campaign owner and active campaign;
3. validate sender profile belongs to user and is complete;
4. load/validate canonical assets;
5. call start/resume transaction, selecting the explicit campaign cohort,
   resnapshotting settled source data, and queuing only complete items whose
   exact effective email is already mailbox `valid` per `03`;
6. after commit, send `drafting.run.started`;
7. return 202.

Response:

```json
{
  "workspace_id": "uuid",
  "drafting_run_id": "uuid",
  "created_items": 13,
  "mailbox_valid_total": 8,
  "queued_items": 8,
  "waiting_for_enrichment": 0,
  "verifying_mailbox": 2,
  "leads_attention": 3,
  "already_current": 0,
  "projected_cost": { "low_usd": "0.60", "high_usd": "1.10" },
  "budget": { "limit_usd": "5.00", "paused_items": 0 },
  "href": "/campaigns/{id}/draft"
}
```

If sending the Inngest event fails after commit, return a recoverable accepted
response and let reconciler dispatch pending DB jobs; do not roll back the
valid workspace.

Errors:

- 401 unauthenticated;
- 404 campaign/profile not owned (avoid resource enumeration);
- 409 idempotency collision with materially different request;
- 422 sender/assets/campaign data invalid;
- 503 job transport unavailable only if no reconciler recovery exists.

## 7. Workspace snapshot API

### `GET /api/campaigns/[id]/drafting`

Query params:

- `item_id` optional current item;
- `filter=to_review|approved|all_generated|needs_attention`;
- `after`/`before` optional ordinal cursor;
- `include=leads,needs_human` to bound payload.

Response:

```json
{
  "workspace": {
    "id": "uuid",
    "status": "active",
    "updated_at": "ISO timestamp",
    "generation_complete": false,
    "review_complete": false
  },
  "counts": {
    "total": 13,
    "mailbox_valid_total": 8,
    "running": 4,
    "generated": 6,
    "approved": 2,
    "waiting_for_enrichment": 0,
    "verifying_mailbox": 2,
    "leads_attention": 3,
    "needs_human": 0,
    "budget_paused": 0,
    "failed": 0
  },
  "progress": {
    "generated": 6,
    "mailbox_valid_total": 8,
    "reviewed": 2,
    "generated_for_review": 6
  },
  "current_item": {},
  "neighbors": {
    "previous_item_id": null,
    "next_item_id": "uuid"
  },
  "leads_rows": [],
  "attention_rows": [],
  "exports": {
    "available": false,
    "blocking_reasons": ["8 latest drafts are not approved"]
  }
}
```

Payload should not return all research packets/bodies for a large workspace.
Return one current full draft, compact lists, and fetch drawer details on
demand.

Headers:

- `Cache-Control: private, no-store`;
- no ETag/304 while any workspace job is active; every poll returns the
  current transaction-consistent counts.

## 8. Item input APIs

### `PATCH /api/drafting/items/[itemId]/input`

Request:

```json
{
  "expected_revision": 4,
  "fields": {
    "title": "Chief Financial Officer",
    "location": "Dallas, TX"
  }
}
```

- allowlist five required fields plus tightly defined optional drafting input;
- partial update;
- trim/normalize/validate;
- null/empty removes override and falls back to source snapshot when present;
- transaction returns new effective input, revision, missing fields, state;
- saving never auto-approves or auto-verifies a Leads row; it returns whether
  **Approve for drafting** is now enabled.

Status:

- 200 saved;
- 409 revision conflict;
- 422 field errors.

### `POST /api/drafting/items/[itemId]/approve-lead`

Request:

```json
{
  "expected_revision": 4,
  "idempotency_key": "uuid"
}
```

Flushes/saves fields first, requires all five effective fields, and then:

- returns 202 with `verification_state: "pending"` when it creates one
  `verify_mailbox` job;
- returns 202 with `verification_state: "valid"` when the exact email already
  has a valid result and one research job is queued;
- never treats a human click as a substitute for mailbox validity.

### `POST /api/drafting/items/[itemId]/remove`

Request includes expected revision and explicit confirmation. Deletes the
owned `campaign_leads` association, marks the item removed, and
cancels/supersedes pending work in one transaction. Idempotent for an already
removed association. It never deletes `outreach.leads`.

### `GET /api/campaigns/[id]/drafting/export?format=unverified-leads-csv`

Read-only export of the current Leads-mode snapshot. It is available before
draft review completion, includes exact verification/profile blocker columns,
and never creates an AgentMail/model job.

### `POST /api/campaigns/[id]/drafting/continue-budget`

Request:

```json
{
  "additional_budget_usd": "2.00",
  "idempotency_key": "uuid"
}
```

The response shows the maximum additional authorization and count before the
user confirms. The confirmed request creates a new drafting run with trigger
`budget_continue`, selects `budget_paused` items in stable ordinal order,
reserves budget, and queues exactly that affordable set. It never resumes on
poll/GET.

## 9. Human-resolution API

### `GET /api/drafting/items/[itemId]/research`

Returns safe research drawer data:

- concise resolution/freshness/identity fields;
- sources and quotes;
- used/discarded facts;
- relationship snapshot;
- asset versions.

No hidden reasoning/provider raw response.

### `POST /api/drafting/items/[itemId]/resolve`

Request:

```json
{
  "expected_input_fingerprint": "sha256",
  "code": "identity_collision",
  "choice": "use_supplied_cautiously",
  "selected_source_ids": [],
  "prohibited_fact_ids": ["fact-2"],
  "max_resolution": "role_segment",
  "notes": ""
}
```

Server validates option was offered/current. It may:

- queue no-search write with capped packet;
- accept corrected fields, then require the same current mailbox-valid
  approve-lead gate before any fresh research;
- remove the lead from the campaign.

## 10. Draft APIs

### `PATCH /api/drafts/[itemId]`

Uses item ID because draft is 1:1.

Request:

```json
{
  "expected_content_revision": 12,
  "expected_input_fingerprint": "sha256",
  "subject": "Dallas planning",
  "body_text": "Hi ...\n\n..."
}
```

Hard-overwrite current draft, lint, increment revision, clear approval.
Return current revision/lint/save timestamp. 409 on stale edit.

### `POST /api/drafts/[itemId]/approve`

Request includes expected content revision, input fingerprint, and packet
hash. Transition only if current and lint-valid. For
`grounding_status=manual_override`, record that this exact current revision
received explicit human approval. Return next recommended item and updated
counts.

### `POST /api/drafts/[itemId]/rewrite`

Request:

```json
{
  "expected_content_revision": 12,
  "idempotency_key": "uuid",
  "feedback": "Optional short plain-text direction"
}
```

Feedback length is bounded and treated as data beneath the writing skill. The
transaction creates one rewrite job in a new drafting run whose trigger is
`rewrite`; the Deny click itself is the explicit per-action cost
authorization, so there is no second modal unless the rewrite would exceed the
visible configured per-action ceiling. It returns 202 and cannot create a
research job.

### `POST /api/drafting/items/[itemId]/retry`

Only for failed current states. Server chooses corresponding job kind,
preserves input/packet rules, and returns a new job. It never turns a failed
write into research unless research itself is absent/stale.

## 11. Export APIs

### `GET /api/campaigns/[id]/drafting/export?format=mailer-csv`

### `GET /api/campaigns/[id]/drafting/export?format=cowork-md`

Both final-draft formats:

- session + campaign owner check;
- recompute review/export completion and preflight in the same transaction snapshot used to
  select rows;
- return 409 JSON with blockers if not exportable;
- no provider/API calls;
- `Cache-Control: private, no-store`;
- safe Content-Disposition filename;
- format details in `05-export-contracts.md`.

The `unverified-leads-csv` format from §8 is intentionally different: it
requires ownership and a transaction-consistent Leads-mode snapshot, but not
drafting completion. It is always read-only and its contract is also in `05`.

## 12. Sender profile APIs

- `GET /api/sender-profiles`
- `POST /api/sender-profiles`
- `PATCH /api/sender-profiles/[id]`

All user-owned. Start Drafting returns 422 with a structured
`sender_profile_required` response when absent. The Review entry action checks
the initial sender-profile summary before POST and normally opens the compact
setup modal first; the 422 is the race/direct-client fallback and causes that
same modal to open in place. Saving profile continues the original idempotent
start request, then navigates. The Draft page never needs to exist before this
setup and no paid work starts before the successful POST.

## 13. Page server component

`app/campaigns/[id]/draft/page.tsx`:

- `getSession()` then redirect;
- `getCampaign(session.userId, id)` then notFound;
- check campaign reviewable data/workspace;
- load initial workspace snapshot only;
- render CampaignTabs active Draft;
- pass safe serialized initial data to client workspace.

Never import provider/assets into a client component. Use server-only module
markers where supported.

## 14. Polling and consistency

Polling endpoint reads one transaction-consistent snapshot. Use cursor/stable
ordinal for navigation. Client actions include revisions/fingerprints.

Race examples:

- Draft lands while user polls: server generated count and item become visible
  together after finish transaction.
- Input changes while research runs: finish sees fingerprint mismatch and
  supersedes result.
- Email changes while AgentMail/research runs: both late results fail the
  effective-email fingerprint guard.
- Source AgentMail result lands after enrichment completion: the authorized
  item promotes exactly once; an invalid/unknown item stays in Leads mode.
- User denies twice: idempotency key/active rewrite uniqueness creates one
  rewrite.
- User approves while autosave pending: client flushes; server expected
  revision prevents approving old content.
- New campaign lead appears: not included until explicit Go/Draft action
  authorizes it.

## 15. Cost reservations

Before a provider claim:

1. estimate worst-case call/search cost from bounded max tokens/searches;
2. atomically reserve against drafting run budget;
3. if unavailable, mark `budget_paused`, do not call provider;
4. on response, compute actual from usage and price snapshot;
5. release difference;
6. on error with billable usage, account actual if available;
7. on superseded-before-call, release all.

In-flight calls may cause slight ceiling overrun if provider output reaches the
reserved maximum only if reservation calculation is wrong; reserve worst-case
to prevent that. Do not reserve an unbounded `max_tokens`.

## 16. Environment configuration

```dotenv
DRAFTING_MODE=stub
DRAFT_RESEARCH_MODEL=
DRAFT_WRITER_MODEL=
ORG_DRAFT_RESEARCH_CONCURRENCY=4
ORG_DRAFT_WRITE_CONCURRENCY=8
ORG_DRAFT_REWRITE_CONCURRENCY=4
DRAFT_RESEARCH_MAX_SEARCHES=3
DRAFT_RESEARCH_MAX_TOKENS=
DRAFT_WRITER_MAX_TOKENS=
DRAFTING_DEFAULT_BATCH_BUDGET_USD=
DRAFTING_REWRITE_BUDGET_USD=
DRAFTING_ORG_DAILY_BUDGET_USD=
DRAFTING_PROMPT_CACHE_TTL=1h
```

- `DRAFTING_MODE` defaults `stub` in development/test.
- Live provider functions assert `DRAFTING_MODE=live`.
- Values have hard code ceilings; env cannot set unbounded searches/tokens.
- Model defaults live in `lib/models.ts`, not only env.
- Never expose any as `NEXT_PUBLIC_*`.

## 17. Dev and test mode

Unlike the current enrichment dev fallback, Drafting must not quietly call the
live provider when Inngest keys are missing.

- Stub mode uses deterministic canned research/writer provider interfaces.
- Local development can run DB/job orchestration inline only with stubs.
- Live mode requires explicit env configuration and a human UI action.
- Automated tests assert the live provider factory was never instantiated.

## 18. API/runtime acceptance scenarios

1. GET/refresh cannot create jobs or provider calls.
2. Start/resume creates work only for owned campaign leads and is idempotent.
3. Dropped Inngest event is recovered from pending DB job by reconciler.
4. Duplicate events/worker retries do not duplicate provider calls after a job
   commits.
5. Rate-limit error records retry time and leaves UI/read/export of completed
   work available.
6. Definitive auth/quota error stops and surfaces once; no retry loop.
7. Stale result after input edit is superseded.
8. Non-valid effective email cannot claim research/write/rewrite.
9. Rewrite lane calls writer only, never research/web search.
10. Final-draft export runs from one consistent DB snapshot and rejects
   incomplete/stale valid-email work; unverified-leads CSV remains available
   independently.
11. All route IDs are owner-scoped through campaign; cross-user UUIDs return
    not found.
