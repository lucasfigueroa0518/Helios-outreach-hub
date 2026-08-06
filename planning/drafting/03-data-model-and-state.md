# Data model and state machines

## 1. Data-model principles

1. The campaign is the authorization boundary.
2. The global `outreach.leads` row is input, not the mutable drafting record.
3. A drafting workspace is continuous per campaign; a drafting run records
   each user-authorized enqueue cohort.
4. Each workspace lead has one current input snapshot, one current research
   packet, and one current email draft.
5. Email content has no history table. Revision integers provide concurrency
   control, not content retention.
6. Jobs are durable Postgres state. Inngest events only wake workers.
7. Every paid result commits only if its expected input/job fingerprint is
   still current.
8. Counts derive from item/job state, not an independently mutable counter.
9. User ownership is checked through `campaigns.owner_id` on every app query.
10. Tables are indexed for the actual campaign/workspace/status access paths.
11. A current effective email bound to mailbox status `valid` is a hard
    prerequisite for every research/write/rewrite state.

The existing project uses `db/outreach_schema.sql` as its canonical,
idempotent app schema and direct `pg` queries. Drafting additions belong there
using `CREATE TABLE IF NOT EXISTS`, explicit constraints, and additive
`ALTER ... ADD COLUMN IF NOT EXISTS` only where needed. If the repository
adopts formal migrations before implementation, generate a clean migration
from the reviewed desired schema rather than hand-writing divergent copies.

## 2. Relationship diagram

```text
outreach.campaigns
  1 ── 0..1 outreach.drafting_workspaces
               1 ── * outreach.drafting_runs
               1 ── * outreach.drafting_items ── 1 outreach.leads
               * ── * through outreach.drafting_run_items
                            1 ── 0..1 outreach.draft_research_packets
                            1 ── 0..1 outreach.email_drafts
                            1 ── * outreach.drafting_jobs
                            1 ── * outreach.drafting_resolutions

outreach.users
  1 ── * outreach.sender_profiles

outreach.drafting_workspaces
  * ── 1 sender profile snapshot/version
  * ── 1 active skill/positioning asset version snapshot
```

## 3. `outreach.sender_profiles`

Purpose: approved, user-supplied sender facts required by the writing skill.

| Column | Type | Rules |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `user_id` | uuid FK users | owner |
| `display_name` | text | nonblank |
| `work_email` | text | normalized Embark business email |
| `title` | text | nonblank, supplied |
| `signature_mode` | text | `name` / `name_and_role` |
| `timezone` | text | optional IANA value |
| `voice_notes` | text | optional, bounded length |
| `professional_context` | jsonb | supplied tribes/history/topics/bans |
| `revision` | bigint | increment on update |
| `is_default` | boolean | one default per user |
| `created_at`, `updated_at` | timestamptz | |

Constraints/indexes:

- unique lowercased `work_email`;
- partial unique index `(user_id) WHERE is_default`;
- index `(user_id, updated_at DESC)`;
- check trimmed required text is nonempty;
- application validates JSON schema and size.

Profiles are user-owned. No sender fact is inferred from `outreach.users`.

## 4. `outreach.drafting_workspaces`

Purpose: one continuous drafting/review surface per campaign.

| Column | Type | Rules |
|---|---|---|
| `id` | uuid PK | |
| `campaign_id` | uuid FK campaigns | UNIQUE; one workspace/campaign |
| `created_by` | uuid FK users | |
| `sender_profile_id` | uuid FK sender_profiles | current default for new runs |
| `status` | text | `active`, `review_complete`, `cancelled` |
| `skill_version` | text | active snapshot |
| `skill_sha256` | text | 64-char lowercase hex |
| `positioning_version` | text | |
| `positioning_sha256` | text | |
| `capability_catalog_version` | text | |
| `capability_catalog_sha256` | text | |
| `last_started_at` | timestamptz | |
| `generation_completed_at` | timestamptz | nullable, recomputed; may clear when a new valid lead arrives |
| `review_completed_at` | timestamptz | nullable, recomputed |
| `created_at`, `updated_at` | timestamptz | |

Generation and review completion are cached transactionally from item/job
transitions, but the GET/export APIs also recompute/validate both so stale
cache cannot display 100% or enable export. Non-valid Leads rows do not block
either; a newly valid lead can reopen both.

Workspace cancellation stops new work but does not delete drafts.

## 5. `outreach.drafting_runs`

Purpose: audit each explicit user authorization and cohort/cost boundary. A
run is not a gated phase and does not block review.

| Column | Type | Rules |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` | uuid FK drafting_workspaces | |
| `triggered_by` | uuid FK users | |
| `trigger` | text | `go_to_drafting`, `lead_approval`, `verification_promoted`, `retry`, `rewrite`, `budget_continue` |
| `idempotency_key` | text | unique per user/action |
| `status` | text | `active`, `complete`, `partial`, `cancelled` |
| `target_count` | int | nonnegative snapshot |
| `projected_cost_low_usd` | numeric(10,4) | |
| `projected_cost_high_usd` | numeric(10,4) | |
| `budget_limit_usd` | numeric(10,4) | hard ceiling for this authorization |
| `reserved_cost_usd` | numeric(10,4) | atomic reservations |
| `actual_cost_usd` | numeric(10,4) | usage-derived |
| `usage` | jsonb | tokens, cache tokens, searches, calls by model |
| `started_at`, `finished_at` | timestamptz | |

Indexes:

- unique `(triggered_by, idempotency_key)`;
- `(workspace_id, started_at DESC)`;
- partial `(workspace_id) WHERE status = 'active'`.

Money uses numeric, never floating-point. Price snapshot/version belongs in
`usage` so historical estimates remain explainable after model pricing
changes.

## 6. `outreach.drafting_items`

Purpose: one current drafting record per campaign lead.

| Column | Type | Rules |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` | uuid FK | |
| `lead_id` | uuid FK leads | source identity |
| `source_campaign_lead_run_id` | uuid FK runs | source lineage |
| `ordinal` | bigint | stable navigation order |
| `state` | text | state machine below |
| `input_snapshot` | jsonb | normalized effective inputs |
| `input_overrides` | jsonb | campaign-scoped user values |
| `missing_fields` | text[] | deterministic required fields |
| `input_fingerprint` | text | SHA-256 of canonical effective input |
| `input_revision` | bigint | CAS for override edits |
| `delivery_snapshot` | jsonb | effective email, email fingerprint, AgentMail status/result source/verified-at |
| `research_revision` | int | starts 0 |
| `draft_revision` | int | latest generation request |
| `review_status` | text | `unreviewed`, `approved` |
| `reviewed_by` | uuid FK users | nullable |
| `reviewed_at` | timestamptz | nullable |
| `removed_at` | timestamptz | nullable; campaign association removed |
| `removed_by` | uuid FK users | nullable; audit only |
| `human_attention_code` | text | nullable |
| `last_error_code`, `last_error_message` | text | sanitized |
| `created_at`, `updated_at` | timestamptz | |

Unique:

- `(workspace_id, lead_id)`.

Indexes:

- `(workspace_id, ordinal)`;
- `(workspace_id, state, ordinal)`;
- `(workspace_id, review_status, ordinal)` with partial index for
  `review_status='unreviewed'`;
- partial `(workspace_id, state)` for active states;
- `(lead_id)` for invalidation lookup.

`input_snapshot` shape:

```ts
{
  schemaVersion: 1,
  lead: {
    fullName, firstName, lastName, email, company, title, workLocation,
    linkedinUrl, emailStatus, emailDecision
  },
  relationship: {
    pastWork, priorRelationshipActivity, lastContacted, lastContactedBy,
    relationshipTier, reusedFromPriorLead, capturedAt
  },
  connectingContext: {
    mode, introducerName, suppliedContext, linkedinConnectionDegree,
    rawCrmIndicator
  },
  provenance: {
    sourceRunId, profileEnrichment, emailProvenance
  },
  sender: {
    profileId, profileRevision, displayName, workEmail, title,
    signatureMode, voiceNotes, professionalContext
  },
  assets: {
    skillVersion, skillSha256, positioningVersion, positioningSha256
    capabilityCatalogVersion, capabilityCatalogSha256
  }
}
```

Canonical JSON serialization sorts keys and normalizes line endings before
hashing.

`delivery_snapshot` is always bound to the normalized effective email. A
global enrichment result may be copied only when its current
`outreach.leads.email_primary` equals the effective item email. A manually
overridden address stores its AgentMail result in the item snapshot rather
than mutating the shared lead row. Changing the effective email clears the
old result because verification never transfers between addresses.

`input_overrides` uses a typed schema, not arbitrary JSON. In addition to the
five editable required fields it may contain:

```ts
{
  connectingContext?: {
    introducerName?: string | null;
    suppliedContext?: string | null;
    linkedinConnectionDegree?: string | null;
    rawCrmIndicatorMeaning?: string | null;
  }
}
```

## 6.1 `outreach.drafting_run_items`

Purpose: immutable membership of the explicit lead cohort authorized by each
user action. This lets `run.finalized` promote only waiting leads the user
already authorized, while excluding leads added after the click.

| Column | Type | Rules |
|---|---|---|
| `drafting_run_id` | uuid FK drafting_runs | |
| `drafting_item_id` | uuid FK drafting_items | |
| `source_enrichment_run_id` | uuid FK runs | source present at authorization |
| `authorization_state` | text | `waiting`, `queued`, `budget_paused`, `terminal`, `cancelled` |
| `projected_cost_usd` | numeric(10,4) | |
| `reserved_cost_usd` | numeric(10,4) | |
| `created_at`, `updated_at` | timestamptz | |

Primary key `(drafting_run_id, drafting_item_id)`.

Indexes:

- `(source_enrichment_run_id, authorization_state)` for finalized promotion;
- `(drafting_item_id, created_at DESC)` for current authorization audit;
- `(drafting_run_id, authorization_state)` for run/budget counts.

This table contains authorization metadata only, not old input/draft content.

## 7. Item state machine

States:

- `waiting_for_enrichment`
- `needs_lead_review`
- `verifying_mailbox`
- `removed`
- `budget_paused`
- `queued_research`
- `researching`
- `needs_human`
- `queued_write`
- `writing`
- `repairing`
- `ready_for_review`
- `approved`
- `queued_rewrite`
- `rewriting`
- `failed_research`
- `failed_write`
- `failed_rewrite`
- `cancelled`

Allowed transitions:

```text
new → waiting_for_enrichment | needs_lead_review | verifying_mailbox | queued_research | budget_paused
waiting_for_enrichment → needs_lead_review | verifying_mailbox | queued_research | budget_paused | removed
needs_lead_review → verifying_mailbox | queued_research | budget_paused | removed
verifying_mailbox → needs_lead_review | queued_research | budget_paused | removed
budget_paused → queued_research | removed
queued_research → researching | removed | cancelled
researching → needs_human | queued_write | failed_research | removed | cancelled
needs_human → queued_research | queued_write | removed
queued_write → writing | removed | cancelled
writing → repairing | ready_for_review | failed_write | removed | cancelled
repairing → ready_for_review | failed_write | removed | cancelled
ready_for_review → approved | queued_rewrite | needs_lead_review | removed
approved → ready_for_review (manual edit/input staleness)
approved → queued_rewrite | needs_lead_review | removed
queued_rewrite → rewriting | removed | cancelled
rewriting → ready_for_review | failed_rewrite | removed | cancelled
failed_* → corresponding queued_* | needs_lead_review | removed
```

Illegal transitions return 409. State changes occur through a small
server-side transition module, not scattered SQL strings.

Every transition into `queued_research`, `researching`, `queued_write`,
`writing`, `repairing`, `ready_for_review`, `approved`, `queued_rewrite`, or
`rewriting` rechecks that the delivery snapshot is current for the effective
email and exactly `valid`.

### Review status

State and review status are redundant only for query ergonomics and must be
kept consistent:

- state `approved` ↔ `review_status='approved'`;
- all other states ↔ `unreviewed`;
- database check/transition code enforces this invariant.

### Input invalidation

On effective input change:

- recompute completeness and fingerprint under row lock;
- increment `input_revision`;
- if missing: state becomes `needs_lead_review`, pending job results cannot
  commit;
- if identity/research fields changed (`name`, `company`, `title`, `location`,
  relationship context, sender/assets): increment `research_revision`, clear
  current research eligibility, and wait in Leads mode until the user approves
  the complete row; queue only if mailbox-valid;
- if only email/delivery changed: preserve research packet where identity is
  unchanged, clear the old email-bound verification and approval, and require
  explicit Approve for drafting plus a new valid result;
- any approved content affected becomes unreviewed/stale;
- old job rows remain as terminal `superseded` metadata, not active work.

### Enrichment-settled predicate and resnapshot

A campaign lead is eligible to leave `waiting_for_enrichment` only when the
`campaign_leads.run_id` source run is `complete`. This prevents drafting from
capturing lead fields while enrichment still mutates them.

On every explicit start/resume:

1. insert newly added campaign leads;
2. compare each existing nonremoved item's canonical source fingerprint with
   the current completed-run lead/relationship/sender/asset source;
3. if unchanged, keep it current;
4. if changed and item unapproved, resnapshot and invalidate/requeue by the
   field-change rules;
5. if changed and approved, preserve current content but mark it stale/
   unreviewed and require an explicit `Refresh research and draft` or
   `Keep supplied context cautiously` decision;
6. never overwrite a dirty manual override with the source value;
7. never pull rows from an active source run into paid work.

`non-current` means exactly: no item exists, source fingerprint differs,
packet/draft fingerprint differs, failed item explicitly retried, or a
budget-resumed item is eligible. Removed items are no longer campaign members
and cannot resume.

## 8. `outreach.draft_research_packets`

Purpose: one current validated packet per item. No historical packet content.

| Column | Type | Rules |
|---|---|---|
| `drafting_item_id` | uuid PK/FK | one current packet |
| `input_fingerprint` | text | commit guard |
| `research_revision` | int | commit guard |
| `schema_version` | text | |
| `status` | text | `valid`, `needs_human`, `invalid`, `stale` |
| `identity_classification` | text | indexed filter |
| `resolution_level` | text | |
| `packet` | jsonb | validated contract |
| `source_count` | int | |
| `fresh_source_count` | int | |
| `packet_sha256` | text | canonical hash |
| `model_id`, `prompt_version` | text | |
| `provider_request_id` | text | |
| `usage` | jsonb | tokens/searches/cache/cost |
| `researched_at`, `valid_until` | timestamptz | |
| `updated_at` | timestamptz | |

Indexes:

- partial `(status, valid_until)` for stale detection;
- `(identity_classification)`;
- GIN on `packet` only if a demonstrated query needs it; do not add a broad
  JSON index speculatively.

On new valid research, hard-overwrite the packet row. Job metadata preserves
attempt/error counts without preserving old packet content.

## 9. `outreach.email_drafts`

Purpose: one current email per item.

| Column | Type | Rules |
|---|---|---|
| `drafting_item_id` | uuid PK/FK | |
| `input_fingerprint` | text | current input guard |
| `research_packet_sha256` | text | grounding guard |
| `generation_number` | int | increments on requested rewrite/regeneration |
| `content_revision` | bigint | increments every autosave/model overwrite |
| `subject` | text | plain text, no newline |
| `body_text` | text | plain text |
| `resolution_used` | text | |
| `used_fact_ids` | text[] | |
| `claim_ledger` | jsonb | exact spans + source fact IDs |
| `ask_form` | text | |
| `lint_result` | jsonb | codes/spans/version |
| `grounding_status` | text | `model_validated` / `manual_override` |
| `model_id`, `prompt_version` | text | |
| `provider_request_id` | text | latest generation only |
| `usage` | jsonb | latest generation usage/cost |
| `manually_edited` | boolean | |
| `edited_by`, `edited_at` | uuid/timestamptz | |
| `generated_at`, `updated_at` | timestamptz | |

No draft version/history table is created. On model rewrite, subject/body and
generation metadata update in one transaction. On manual edit, only current
subject/body, revision, edit metadata, matching claim-ledger spans,
`grounding_status=manual_override`, and recomputed lint update.

Limits:

- subject max configured code points (for example 200 storage ceiling, lower
  UX warning threshold);
- body max storage ceiling (for example 20,000);
- reject null bytes/control characters;
- normalize CRLF/CR to LF in storage; export chooses target line endings.

## 10. `outreach.drafting_jobs`

Purpose: durable idempotent paid-work queue.

| Column | Type | Rules |
|---|---|---|
| `id` | uuid PK | |
| `drafting_run_id` | uuid FK | cost/authorization cohort |
| `drafting_item_id` | uuid FK | |
| `kind` | text | `verify_mailbox`, `research`, `write`, `repair`, `rewrite` |
| `status` | text | `pending`, `in_flight`, `done`, `failed`, `superseded`, `cancelled` |
| `idempotency_key` | text UNIQUE | deterministic |
| `expected_input_fingerprint` | text | |
| `expected_research_revision` | int | |
| `expected_draft_revision` | int | |
| `attempt_count`, `max_attempts` | int | bounded |
| `claimed_at`, `heartbeat_at` | timestamptz | orphan recovery |
| `next_attempt_at` | timestamptz | backoff |
| `priority` | smallint | rewrite/user retry > background initial write |
| `reserved_cost_usd`, `actual_cost_usd` | numeric(10,4) | |
| `provider_request_id` | text | |
| `usage` | jsonb | |
| `last_error_code`, `last_error_message` | text | sanitized |
| `created_at`, `finished_at` | timestamptz | |

Idempotency-key examples:

```text
verify-mailbox:{item_id}:{effective_email_sha256}:{input_revision}
research:{item_id}:{input_fingerprint}:{research_revision}
write:{item_id}:{packet_sha256}:{draft_revision}
repair:{item_id}:{draft_revision}:{lint_hash}
rewrite:{item_id}:{packet_sha256}:{generation_number}
```

Indexes:

- `(status, next_attempt_at, priority DESC, created_at)` partial for pending;
- `(drafting_item_id, created_at DESC)`;
- `(drafting_run_id, status)`;
- partial orphan lookup `(claimed_at)` where `status='in_flight'`.

Claim uses `FOR UPDATE SKIP LOCKED` inside a Postgres function/direct session
transaction, following the proven enrichment pattern.

The `verify_mailbox` job reuses the AgentMail send/list/bounce-classification
provider but not enrichment's global-lead update helper. It commits only to
the drafting item's current `delivery_snapshot` after rechecking the expected
effective-email fingerprint. This prevents a campaign-scoped override from
changing shared lead truth.

A job that cannot reserve its bounded maximum is not left pending invisibly:
it remains/returns terminal for that authorization and its item transitions to
`budget_paused`. Resuming creates a new run/job idempotency scope in stable
item-ordinal order.

## 11. `outreach.drafting_resolutions`

Purpose: audit explicit human decisions that permit/reject uncertain research.
This is not an email-content version.

| Column | Type | Rules |
|---|---|---|
| `id` | uuid PK | |
| `drafting_item_id` | uuid FK | |
| `input_fingerprint` | text | resolution valid only for this input |
| `code` | text | identity/freshness/prior-contact/sender/true-zero |
| `choice` | text | cautious supplied, selected identity, corrected, removed |
| `selected_source_ids` | text[] | |
| `prohibited_fact_ids` | text[] | |
| `max_resolution` | text | |
| `notes` | text | short user note |
| `resolved_by` | uuid FK users | |
| `created_at` | timestamptz | |

Only the latest resolution matching current fingerprint is active. Historical
resolution metadata may remain because it is a user decision audit, not draft
content. It contains no old subject/body.

## 12. Optional company-context cache

If implementation demonstrates material duplicate company research within a
workspace, add `outreach.draft_company_context`:

- keyed `(workspace_id, resolved_domain, context_version)`;
- packet contains company/role facts only;
- short `valid_until`;
- no person facts;
- evidence sources/hash;
- never shared based only on company name.

Do not create this table before the base per-lead path is correct. A simple
in-workspace lookup on valid existing research packets may be enough.

Whichever storage is used, every consuming packet must set
`companyContextProvenance` (`02` §11) to `reused_within_workspace` with the
source item ID it borrowed from, so the research drawer never presents a
cache hit as fresh per-person research — the same reuse-must-stay-visible
discipline as `campaign_leads.reused_from_prior_lead` (§6 above).

## 13. Atomic database operations

Required transactional functions/helpers:

### `start_or_resume_drafting_workspace`

Under campaign ownership lock:

- upsert workspace;
- insert drafting run by idempotency key;
- select owned campaign leads and classify source-run completion;
- insert absent items and resnapshot stale completed-run items;
- insert `drafting_run_items` cohort membership for every item present in the
  explicit start response;
- create items with stable ordinal;
- classify waiting-for-enrichment, mailbox verification, completeness, and
  budget;
- copy a global `email_verification='valid'` result only when it belongs to
  the exact effective email;
- create pending research jobs only for affordable complete mailbox-valid
  items in ordinal order; place every other current campaign lead in Leads
  mode (or `verifying_mailbox` when its already-authorized enrichment probe is
  pending); mark remaining valid candidates `budget_paused`;
- reserve projected budget;
- return counts/run/workspace.

### `claim_drafting_job`

- select one eligible pending/orphaned row with `FOR UPDATE SKIP LOCKED`;
- verify run/workspace active and expected fingerprints current;
- mark superseded instead of executing stale work;
- mark in-flight, increment attempt, set heartbeat.

### `finish_drafting_job`

In one transaction:

- lock job and item;
- verify expected fingerprints/revisions;
- hard-overwrite current packet/draft if current;
- transition item;
- mark job terminal and actual usage;
- adjust run reservation/actual spend;
- create next dependent job exactly once when needed;
- recompute generation and review/export completion;
- return event(s) that need dispatch.

For `verify_mailbox`, finish additionally:

- verifies the expected effective-email fingerprint under the item lock;
- stores `valid`, `invalid`, or `unknown` plus provider/request timestamps in
  `delivery_snapshot`;
- on `valid`, creates exactly one dependent research job if the row is still
  complete and budget-authorized;
- on non-valid, returns the row to `needs_lead_review` with no model job;
- never updates `outreach.leads` for a drafting override.

### `update_drafting_input`

- owner-scoped item lock;
- expected input revision check;
- validate/normalize overrides;
- recompute effective snapshot/missing fields/fingerprint;
- invalidate according to changed field classes but never autoqueue a Leads
  row merely because the last field was typed;
- return new item/count impact.

### `approve_drafting_lead`

- owner-scope and lock item/campaign association;
- require expected input revision and five complete validly shaped fields;
- create a `lead_approval` drafting run/idempotency scope;
- if the exact effective email already has current status `valid`, reserve
  budget and create one research job;
- otherwise create one `verify_mailbox` job and move to
  `verifying_mailbox`;
- return committed verification/generation counts and dispatchable event.

### `remove_drafting_lead_from_campaign`

- owner-scope and lock the item plus `campaign_leads` association;
- delete only that association;
- set item `removed` with actor/timestamp;
- cancel/supersede all pending/in-flight item jobs;
- recompute counts/completion;
- never delete the shared `outreach.leads` row.

### `save_current_draft`

- owner-scoped item/draft lock;
- expected content revision and input fingerprint check;
- normalize/validate/lint plain text;
- hard-overwrite current fields;
- increment content revision;
- clear approval;
- return saved current content/revision.

### `approve_current_draft`

- verify exact content revision, input fingerprint, packet hash, lint pass;
- set approved state/reviewer/time;
- recompute generation and review/export completion.

## 14. Counter queries

Compute a single grouped snapshot to prevent counter drift:

```sql
SELECT
  count(*) FILTER (WHERE state = 'waiting_for_enrichment') AS waiting_for_enrichment,
  count(*) FILTER (WHERE state = 'needs_lead_review') AS leads_attention,
  count(*) FILTER (WHERE state = 'verifying_mailbox') AS verifying,
  count(*) FILTER (WHERE state = 'removed') AS removed,
  count(*) FILTER (WHERE state = 'budget_paused') AS budget_paused,
  count(*) FILTER (WHERE state IN (...active states...)) AS running,
  count(*) FILTER (WHERE state IN ('ready_for_review','approved')) AS generated,
  count(*) FILTER (WHERE state = 'approved') AS approved,
  count(*) FILTER (WHERE state = 'needs_human') AS needs_human,
  count(*) FILTER (WHERE state LIKE 'failed_%') AS failed
FROM outreach.drafting_items
WHERE workspace_id = $1;
```

Do not use `LIKE` in final typed policy code if enum/check lists are available;
enumerate states for compiler/test visibility.

Derived:

- `mailbox_valid_total = current campaign-associated items whose effective
  email-bound delivery snapshot is exactly valid`, regardless of profile/job
  state;
- `drafted = ready_for_review + approved`;
- `reviewed X = approved`;
- `generated Y = ready_for_review + approved`;
- `generation denominator = mailbox_valid_total`;
- `generation_complete = mailbox_valid_total > 0 AND
  drafted = mailbox_valid_total`;
- `leads_attention` and `verifying` never enter the denominator unless their
  current effective address becomes valid;
- review/export completion uses exact valid-item terminal rules, not just
  `approved=generated`.

## 15. Relationship-snapshot mapping

The DB stores snake_case internal values. Snapshot assembly maps:

```text
relationship_snapshot.past_work
  → relationship.pastWork

relationship_snapshot.relationship_tier = active
  → relationship.priorRelationshipActivity = "Within 6 months"

relationship_snapshot.relationship_tier = dormant
  → relationship.priorRelationshipActivity = "Older than 6 months"

relationship_snapshot.relationship_tier = cold / null
  → relationship.priorRelationshipActivity = null

relationship_snapshot.last_contacted
  → relationship.lastContacted

relationship_snapshot.last_contacted_by
  → relationship.lastContactedBy
```

`prior_relationship_date` may be retained internally for freshness comparison
but is not shown/exported. No mapping interprets `last_contacted_by` as an
introducer.

### Connecting-context assembly

Build one deterministic per-item value:

1. if both explicit `introducerName` and `suppliedContext` overrides exist,
   mode = `warm_introduction`;
2. else if `past_work='Previously connected'`, relationship tier is
   active/dormant, or `last_contacted` exists, mode =
   `previously_connected`;
3. else if an undefined/raw CRM indicator exists, mode = `unknown` and create
   `prior_contact_ambiguity` human attention until its meaning is supplied;
4. else mode = `cold`;
5. uploaded connection degree is copied as context only and cannot change the
   mode or imply relationship quality;
6. `last_contacted_by` is never used as `introducerName`;
7. changing any connecting-context value changes the input fingerprint and
   invalidates writing/research as specified.

## 16. Campaign lifecycle interactions

### Leads-mode removal

- Remove from campaign deletes the owned `campaign_leads` association in the
  same transaction that marks the drafting item `removed`.
- Pending AgentMail/model jobs cancel or become superseded and late results
  cannot commit.
- The shared lead row is retained.
- Re-adding that person later is a new campaign-membership/input event and
  requires an explicit Go to Drafting/Approve action.

### Upload & Replace

- The replace transaction identifies removed/changed campaign leads.
- Removed leads' drafting items transition `cancelled`; pending jobs
  supersede; their drafts are excluded from counters/exports but not
  immediately hard-deleted.
- Changed leads become stale under the resnapshot rules.
- New leads require an explicit Go to Drafting/start action after their source
  data is settled; Replace itself does not authorize paid drafting.
- An export is blocked while the workspace has stale lifecycle reconciliation.

### Campaign merge

- Do not silently merge two drafting workspaces or choose between two
  approved emails for one deduped lead.
- Campaign merge first completes the existing campaign-lead dedup.
- Target workspace absorbs source items only as `needs_human` metadata when a
  lead has draft state in both; source workspace becomes read-only/cancelled.
- Pending source jobs cancel/supersede.
- User explicitly resolves duplicate/current draft choices and starts any new
  paid work in the target.

### Archive

- Archiving a campaign cancels/pauses pending drafting jobs and prevents new
  starts/retries/rewrites.
- Existing drafts remain read-only for audit.
- Unarchive does not resume paid work automatically; Go to Drafting is
  required.

## 17. Authorization and security

The project currently uses app-code authorization, not RLS. Every drafting
query must join:

```text
drafting entity → workspace → campaign → campaigns.owner_id = session.userId
```

Never accept `user_id`, `owner_id`, `campaign_id`, workspace ownership, or
sender ownership from the request body as trusted.

Inngest workers do not have a browser session. They operate only on a signed
Inngest invocation and immutable job ID, then derive all scope from DB.

No drafting table is exposed through a public Supabase client. Service/direct
database credentials remain server-only. If the Data API exposes the schema,
revoke anon/authenticated access or apply the project's later RLS hardening;
do not assume a non-public UI means the tables are private.

## 18. Retention and PII

- Drafts contain business correspondence and PII; do not write body/subject to
  application logs, analytics events, or Inngest step names.
- Provider raw responses are not stored indefinitely. Persist validated
  packet/draft, provider request ID, citations, and usage; retain raw response
  only in a short-lived encrypted diagnostic path if explicitly implemented.
- Research quotes are bounded and source-linked.
- Deleting/archiving campaign behavior for drafts must be specified before a
  future delete feature; current campaigns archive rather than delete.
- Export endpoints are owner-scoped and set `Cache-Control: private,
  no-store`.

## 19. Database acceptance checks

1. Two concurrent start requests with one idempotency key create one run/job
   set.
2. Two workers cannot claim the same job.
3. Worker completion after an input edit becomes `superseded` and cannot
   overwrite the new item.
4. Typing the fifth field saves only; Approve for drafting creates exactly one
   mailbox-verification job unless the exact effective email is already
   `valid`.
5. A valid verification result creates exactly one current research job;
   invalid/unknown creates none and keeps the row in Leads mode.
6. Deny creates a rewrite job and no research or verification job.
7. Manual edit increments revision and leaves only one subject/body row.
8. Stale-tab save returns conflict and preserves newer current content.
9. Approve fails for stale input, stale packet, lint failure, or wrong content
   revision.
10. Remove deletes only the owned campaign association, marks the item
    removed, and leaves the shared lead entity intact.
11. A user cannot read or mutate another user's workspace through any item,
    draft, export, or sender-profile ID.
12. Generation cannot read 100% while any current mailbox-valid item lacks a
    current draft; non-valid Leads rows do not enter that denominator.
13. Review/export completion cannot become true while any mailbox-valid item
    is incomplete, active, attention, failed, unreviewed, or stale.
14. Schema setup reruns without losing rows or duplicating constraints.
