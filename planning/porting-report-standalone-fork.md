# Standalone fork porting report — Outreach Hub upgrades

This file is a **porting delta / agent handoff** for a forked or re-skinned copy of `lucas-outreach-hub`.
Source of truth for behavior remains the numbered planning specs plus Eva module docs; this report does **not** replace them.
Cursor agents on the fork: implement only the phases below, preserve the fork’s UI skin, and never invent thresholds or weaken gates.

## Table of contents

1. [Coverage window & authority](#coverage-window--authority)
2. [Hard rules for the fork’s coding agents](#hard-rules-for-the-forks-coding-agents)
3. [Why these upgrades were made (overview)](#why-these-upgrades-were-made-overview)
4. [Chronological timeline](#chronological-timeline)
5. [Presence probes (run before every phase)](#presence-probes-run-before-every-phase)
6. [Upgrade catalog (what was built)](#upgrade-catalog-what-was-built)
7. [Phased implementation roadmap](#phased-implementation-roadmap)
8. [Env / concurrency constants](#env--concurrency-constants)
9. [Verification commands](#verification-commands)
10. [Do-not list (global)](#do-not-list-global)
11. [Cross-references](#cross-references)

---

## Coverage window & authority

| Constant | Value |
|----------|-------|
| Window start | `2026-07-24` |
| Window end | `2026-07-29` |
| Source branch | `lucas/outreach-hub` |
| Source HEAD at report time | `c2d4632eba823f98e95482cf3c668a354575701d` |
| Primary deliverable for this report | `lucas-outreach-hub/**` (standalone reference app) |
| Eva dual-port | Documented for completeness; **skip Eva paths** unless the fork also ports Eva |

| Authority | Role |
|-----------|------|
| `planning/01`–`12`, `planning/drafting/*` | Hub behavioral specs |
| `docs/modules/outreach-hub.md` | Eva + dual-port canonical module doc (see § Enrichment Cost Controls, § Drafting Cost Controls, § Campaign cost estimate, § Analytics Hub, § Hard Rules) |
| **This file** | Ordered delta of what landed in the window + exact port steps for a skinned fork |

If this file disagrees with `docs/modules/outreach-hub.md` or a numbered planning spec on a threshold, schema name, or metric definition: **stop and ask the human**. Do not silently pick.

---

## Hard rules for the fork’s coding agents

1. **Preserve the fork’s UI skin.** Port logic, schema, API contracts, tests, and *minimal* wiring into existing components (status chips, Resume CTA, Analytics route entry). Do **not** restyle pages, replace CSS systems, or “refresh” the visual language.
2. **No vague improvements.** Each phase has file paths, constants, schema identifiers, and acceptance tests. If a step cannot be verified by a presence probe or test, stop.
3. **Fail closed, never weaken.** Do not skip asset-hash checks, empty-brief quarantine, delivery-trust inventing `valid`, or advisory locks on claim.
4. **No live Anthropic / AgentMail spend** unless a human clicks Enrich / Go to Drafting and env is explicitly `live`. Keep `DRAFTING_MODE=stub` / `EXTRACTION_MODE=stub` for agent work.
5. **Detect before implement.** Run the presence probes for a phase. If the probe already passes, mark the phase done and move on — do not re-implement.
6. **One phase per PR/session** unless the human explicitly allows bundling. Do not jump to Phase 9 before Phases 1–2 schema/lanes exist.

---

## Why these upgrades were made (overview)

Over five days the reference hub was hardened for **real campaign throughput** (hundreds of leads), **cost control**, and **crash/sleep resilience**, then dual-ported into Eva. The work was driven by production scars, not speculative refactors:

| Driver | What broke / hurt | Upgrade response |
|--------|-------------------|------------------|
| Duplicate Sonnet research on siblings | Company research ran per lead; laptop sleep + silence-based job steal duplicated spend | Company research leases + park/wake; worker registry + steal-proof claim; adaptive Anthropic semaphore |
| Head-of-line blocking | Long research blocked short writes on one lane | Split `drafting` vs `drafting_write` lanes (8+8, worker 16) |
| AgentMail 429 storms | Verify loops stranded drafting | Persist `rate_limited`, workspace fail-open, still draftable |
| Empty research burning shards | Empty briefs retried forever via transport/reconcile | Durable empty-brief quarantine (2 auto attempts then human Retry only) |
| Cost lost on retry/lint throw | Provider spend vanished when later steps threw | Append-only cost events persisted **before** lint/repair |
| Writer stacking / judgment fails | Too many facts → overloaded sentences → wasted rewrite | Ranked/clipped writer brief (2/1/1 @ 120 chars) + writer v12 system block |
| Mispriced campaign estimates | Trailing ledger averages ignored reuse paths | Path-bucket composition estimator |
| No actuals dashboard | Could not see productivity/cost after runs | Analytics Hub + run exclusions |
| Windows CRLF blocked Go to Drafting | SHA pins mismatched on checkout | LF-normalize asset hashing + sync-manifest |
| Schema drift crashed Go to Drafting | Undeployed columns at runtime | Fail-closed `verify:drafting` / schema-contract |

---

## Chronological timeline

| Date | Commit | Summary |
|------|--------|---------|
| 2026-07-27 | `5b73ea1cf` | Track reference hub in Eva repo; company-research leases; enrichment hard/soft field helpers; drafting cost-control reuse |
| 2026-07-27 | `031d045d3` | Split research/write orch lanes; queue reconcile/verify/promote; AgentMail `rate_limited` fail-open; judgment-lint reviewable |
| 2026-07-28 | `d625f891f` | Analytics Hub; path-bucket cost; ranked writer brief; rescue/Resume; Anthropic semaphore; concurrency bundle |
| 2026-07-28 | `f6b5b1ce1` | **Eva-only** writer-brief test fixture fix (temporal-before-cap + 60% clip floor). Hub production code already matched; hub tests were not updated in this commit — when porting, prefer Eva fixture assertions if the fork’s tests are stale |
| 2026-07-28 | `5c7308857` | LF-stable drafting asset hashes; compact “Verification rate limited” chip |
| 2026-07-29 | `c2d4632eb` | Empty-brief quarantine; append-only cost events; orchestration worker registry + steal-proof claim; schema audit |

**Note on `5b73ea1cf`:** that commit *git-tracked* the whole `lucas-outreach-hub/` tree into the Eva monorepo. A fork copied ~2026-07-24 likely already contains large parts of the baseline app. Treat later commits as the real delta; use presence probes so you do not re-add what you already have.

---

## Presence probes (run before every phase)

Run from the fork root. A probe **passes** if the command exits 0 / prints FOUND.

```bash
# P1 — company research leases
rg -n "drafting_company_research_leases|resolveCompanyResearchKey|waiting_company_research" lib db || true

# P2 — mailbox rate_limited + draftable
rg -n "rate_limited|isMailboxDraftable|NON_AUTO_RETRY_ERROR_CODES|ORG_DRAFT_WRITE_CONCURRENCY" lib db || true

# P3 — ranked writer brief
rg -n "buildWriterResearchBrief|DRAFTING_WRITER_PROMPT_VERSION|CLAIM_CLIP_MIN_RATIO|WRITER_NO_STACKED_CLAUSES" lib || true

# P4 — path-bucket cost
rg -n "classifyCampaignCostPaths|estimateCampaignCostFromLeads|draft_sibling_skip" lib || true

# P5 — analytics
rg -n "analytics_run_exclusions|resolveAnalyticsWindow|cost_per_drafting" lib db app || true

# P6 — Anthropic semaphore
rg -n "withDraftingAnthropicSlot|DRAFTING_ANTHROPIC_MAX_INFLIGHT|shrinkDraftingAnthropicLimit" lib || true

# P7 — rescue
rg -n "assessDraftingRescue|rescueDraftingWorkspace|INTERRUPT_RESUME_COPY|incomplete_stalled" lib app || true

# P8 — LF asset hash
rg -n "normalizeDraftingTextBytes|hashDraftingTextAsset|drafting:sync-manifest" lib package.json || true

# P9 — empty brief + cost events + worker registry
rg -n "empty_brief_attempts|EMPTY_RESEARCH_BRIEF_ERROR_CODE|drafting_job_cost_events|orchestration_workers|record_drafting_job_cost_event" lib db || true
```

---

## Upgrade catalog (what was built)

### U1 — Enrichment hard/soft field gates + drafting company-research reuse

**Why:** Blank `location` was inflating search budgets and spawning useless `profile_rescue`. Sibling leads at the same company re-ran full Sonnet research.

**Behavioral contract (exact):**

| Concept | Exact rule |
|---------|------------|
| Hard profile fields | `company_name`, `title` |
| Soft profile field | `location` (opportunistic only; never alone drives budget or rescue) |
| Primary search floor | `max(emailBudget, needsHardProfile ? 5 : 0)` |
| `profile_rescue` searches | default/ceiling **1** (`ORG_PROFILE_RESCUE_SEARCH_USES`) |
| Company key | exact lowercased non-generic email domain via `resolveCompanyResearchKey`; generic/missing → `null` (**no company-name fallback**) |
| Generic domains | `gmail.com`, `googlemail.com`, `hotmail.com`, `icloud.com`, `live.com`, `outlook.com`, `proton.me`, `protonmail.com`, `yahoo.com` |
| Lease table | `outreach.drafting_company_research_leases` PK `(workspace_id, company_key)` |
| Lease statuses | `researching` \| `ready` \| `failed` |
| Lease expiry | `researching` expires **15 minutes** after heartbeats stop |
| Sibling park (hub) | non-owners → FSM `waiting_company_research` (no shard held); owner wake → `sibling_skip` |
| Positive company verdict reuse | ≤ **72h**; requires `truth=supported`, `bindsToLead=true`, `durationSupported=true`, `decision=keep` |
| Cache policy version | `COMPANY_VERDICT_CACHE_POLICY_VERSION = 'duration-aware-v2'` |
| Sibling skip | `canSkipSiblingResearch` + `assemblePacketFromReusableContext` when reusable company context valid **and** snapshot has name+email+company+title |
| Research prompt | slim system `DRAFTING_RESEARCH_SLIM_BRIEF` / version `drafting-research-v8-slim-skill`; writer still gets full skill |
| Auto-repair | mechanical codes only; judgment codes block Approve |

**Files to port / align:**

| Path | Role |
|------|------|
| `lib/enrichment-fields.ts` | `HARD_PROFILE_FIELDS`, `SOFT_PROFILE_FIELDS`, `personNeedsHardProfileResearch`, … |
| `lib/research-budget.ts` | `searchBudgetForJob`, `MAX_EMAIL_TARGETS_PER_JOB=5` |
| `lib/drafting/company-research-key.ts` | `resolveCompanyResearchKey` |
| `lib/drafting/lease-heartbeat.ts` | `runWithLeaseHeartbeat` |
| `lib/drafting/research-company-reuse.ts` | reuse / sibling skip |
| `lib/drafting/research-adversarial.ts` | `planAdversarialAudit`, verdict cache |
| `lib/drafting/research-prompt.ts` | slim brief |
| `db/drafting_schema.sql` | leases table DDL |
| `tests/enrichment-fields.test.ts`, `tests/drafting-cost-optimization.test.ts` | regression |

**Do NOT:** fall back to company-name keys; enqueue rescue for `location`; reuse person-bound evidence across siblings; auto-repair judgment lint codes.

---

### U2 — Throughput lanes, queue orchestration, AgentMail fail-open, judgment-lint reviewable

**Why:** One orch lane let long research block writes. AgentMail 429s stranded campaigns. Judgment lint left items stuck as `failed_write`.

**Behavioral contract (exact):**

| Concept | Exact rule |
|---------|------------|
| Research lane | kind `drafting.job.process` → lane `drafting`; `ORG_DRAFT_RESEARCH_CONCURRENCY` default **8** |
| Write lane | kind `drafting.job.write` → lane `drafting_write`; `ORG_DRAFT_WRITE_CONCURRENCY` default **8** |
| Worker max | `ORCHESTRATION_WORKER_MAX_CONCURRENCY` default **16** |
| Auto-queue idle states | `needs_lead_review`, `waiting_for_enrichment`, `budget_paused`, non-quarantined `failed_research` |
| Human-only retry | `failed_write`, `failed_rewrite`, and quarantined codes |
| Non-auto error codes | `empty_research_brief`, `research_provider_error`, `hard_lint_no_auto_repair`, `hard_lint_after_repair` |
| Mailbox `rate_limited` | persist on AgentMail 429; first hit cancels remaining probes for run/workspace and marks pending/unknown/NULL as `rate_limited` |
| Draftable | `isMailboxDraftable` = `valid` **OR** `rate_limited` |
| Delivery trust | `resolveDeliveryVerificationStatus` never invents `valid` from upload/inferred email_status |
| Judgment hard lint | land `ready_for_review`; Approve blocked |
| `OVERLOADED_SENTENCE` | fail-open (“Retry suggested”); detect via `STACK_MARKERS` not comma density |
| Complete-but-unverified | enqueue `verify_mailbox` on approve/reconcile |

**Files:**

| Path | Role |
|------|------|
| `lib/orchestration/config.ts` | `KIND_CONFIG`, lane limits |
| `lib/drafting/queue-orchestration.ts` | `resolveDraftingEnqueueAction`, `shouldAutoQueueDraftingItem`, … |
| `lib/drafting/eligibility.ts` | `isMailboxDraftable`, … |
| `lib/drafting/delivery-trust.ts` | never invent valid |
| `lib/drafting/lint.ts` | mechanical vs judgment sets; `STACK_MARKERS` |
| `lib/mailbox-verify.ts`, enrichment fail-open cancel | AgentMail path |
| `db/outreach_schema.sql` | CHECK includes `rate_limited` |
| UI (minimal): draft leads table / email review | compact rate-limited chip; judgment drafts visible |
| `tests/drafting-queue-orchestration.test.ts`, `tests/drafting-delivery-trust.test.ts` | regression |

**Do NOT:** auto-reconcile quarantined empty-brief / hard lint; treat `rate_limited` as fully verified; keep research+write on one lane; invent delivery `valid`.

---

### U3 — Ranked / clipped writer brief + writer prompt v12

**Why:** Writer stacked too many QA facts into one sentence → overload / judgment failures / wasted rewrite cost.

**Behavioral contract (exact):**

| Constant | Value |
|----------|-------|
| Writer company claims | ≤ **2** (1 `primary` + 1 `seasoning`) |
| Writer person claims | ≤ **1** |
| Writer role-segment claims | ≤ **1** |
| `MAX_CLAIM_CHARS` | **120** |
| `CLAIM_CLIP_MIN_RATIO` | **0.6** (sentence clip only if ≥60% of budget) |
| Clip marker | trailing `…`; never mid-word; preamble forbids inventing the cut tail |
| Rank order | `weight` → temporal disposition → `freshness` → packet order |
| Temporal blocked facts | dropped **before** cap |
| QA window (`selectWriterBoundResearch`) | **3 / 2 / 2** (do **not** lower to writer caps) |
| Writer prompt version | `drafting-writer-v12-ranked-brief` |
| System block | `WRITER_NO_STACKED_CLAUSES_SYSTEM_BLOCK` |
| Writer `checks.noStackedClauses` / `everySentenceParsesOnFirstRead` | recorded, **not** enforced as hard gates |

**Files:** `lib/drafting/writer-research-brief.ts`, `lib/drafting/writer-prompt.ts`, `resources/drafting/first-contact-outreach-v5.md`, `resources/drafting/manifest.json`, `tests/writer-research-brief.test.ts`.

**After any skill/text edit:** `npm run drafting:sync-manifest` (see U8).

---

### U4 — Path-bucket campaign cost estimate

**Why:** Trailing ledger averages (`COST_LEDGER_WINDOW=100`) mispriced campaigns with company reuse / sibling skip.

**Behavioral contract (exact):**

| Bucket id | Meaning |
|-----------|---------|
| `enrichment_skip` | prior/reuse skip near-zero |
| `enrichment_company_job` | unique company research amortized |
| `enrichment_hard_rescue` | hard-field rescue surcharge |
| `draft_fresh` | full research+write |
| `draft_company_reuse` | reuse company context |
| `draft_sibling_skip` | skip Sonnet research entirely |
| `flat_fallback` | **only** when no leads loaded |

Unit costs from `estimateEnrichmentJobCostUsd`, `estimateResearchCost`, `estimateWriteCost`. API returns USD totals + `buckets[]`.

**Files:** `lib/path-cost-estimate.ts`, `lib/cost-ledger-pricing.ts`, `lib/drafting/cost.ts`, `app/api/campaigns/[id]/cost-estimate/route.ts`, `tests/path-cost-estimate.test.ts`.

**Do NOT:** restore trailing-average as primary estimate; use company-name for drafting reuse buckets.

---

### U5 — Analytics Hub (actuals + run exclusions)

**Why:** Need post-run productivity/cost actuals, separate from pre-run path-bucket estimates.

**Behavioral contract (exact):**

| Control | Contract |
|---------|----------|
| Entry | Hub home → `/hub/analytics` |
| Periods | `week` (7d), `month` (30d), `custom` (`from`/`to`) |
| Views | aggregate + per-user |
| Exclusions table | `outreach.analytics_run_exclusions` (`run_id`, `excluded_by`, `reason` ≤500) |
| Metrics | `emails_sent`, `cost_per_email`, `cost_per_enrichment`, `cost_per_drafting`, `unattributed_cost_usd`, `retry_rate`, `approval_rate`, `edit_rate` |

Metric definitions: see `@docs/modules/outreach-hub.md` § Analytics Hub — copy those formulas; do not redefine.

**Files:** `lib/analytics.ts`, `db/analytics_schema.sql`, `scripts/apply_analytics_schema.js`, `app/hub/analytics-hub.tsx`, `app/hub/analytics/page.tsx`, `app/api/analytics/{summary,runs,runs/exclude,runs/include}/route.ts`, `tests/analytics-window.test.ts`.

**UI skin rule:** add a single nav/entry control in the fork’s existing hub chrome; do not redesign the analytics page styling beyond matching local tokens.

**Do NOT:** mix path-bucket estimates into Analytics actuals; count provider retries in drafting denominator (distinct leads only).

---

### U6 — Adaptive Anthropic semaphore

**Why:** Raising orch concurrency to 8/8 caused RPM/TPM 429 storms.

**Behavioral contract (exact):**

| Constant | Value |
|----------|-------|
| `DRAFTING_ANTHROPIC_MAX_INFLIGHT` default | **8** (clamp ceiling 12; rollback **4**) |
| Wrap | every drafting research / adversarial / write Anthropic call via `withDraftingAnthropicSlot` |
| On 429 | `shrinkDraftingAnthropicLimit` once per **30s** pressure window |
| Quiet restore clock | extend **30s** on pressure |
| Restore cadence | **+1 slot / 5s** after quiet |
| Waiters | FIFO; aborted waiter removed without consuming a slot |

**Files:** `lib/drafting/anthropic-semaphore.ts`, wire sites in research/adversarial/writer providers, `tests/drafting-anthropic-semaphore.test.ts`.

**Do NOT:** shrink more than once per 30s window; hold a DB client across Anthropic waits; raise Anthropic/research/write/worker independently of the rollback bundle.

---

### U7 — Run rescue / Resume drafting

**Why:** Laptop sleep / dead workers left mid-run jams; silence-based steal caused duplicate research and permanent Resume CTAs.

**Behavioral contract (exact):**

| Concept | Exact rule |
|---------|------------|
| Reasons | `worker_offline`, `stale_leases`, `stranded_items`, `missing_orch_jobs`, `incomplete_stalled` (**not** `failed_items`) |
| Auto-rescue | on snapshot/poll for `stale_leases` / `stranded_items` / `missing_orch_jobs` with **45s** cooldown |
| Resume CTA | `worker_offline` / `incomplete_stalled` / `stale_leases` / `stranded_items` / `missing_orch_jobs` |
| Copy | `INTERRUPT_RESUME_COPY` = `Drafting was interrupted (offline or sleep). Resume will reclaim jobs and continue remaining drafts.` |
| Resume actions | requeue interrupt failures; wake orphaned `waiting_company_research` siblings |
| Quarantine | **never** override `empty_research_brief` (needs explicit per-lead Retry) |
| API | `POST /api/campaigns/:id/drafting/rescue` (+ assess on GET if present) |

**Files:** `lib/drafting/rescue.ts`, `app/api/campaigns/[id]/drafting/rescue/route.ts`, minimal status-strip / leads-table Resume wiring, `tests/drafting-rescue.test.ts`.

**Do NOT:** steal jobs from `updated_at` silence while worker heartbeat is live; let Resume clear empty-brief quarantine.

---

### U8 — LF-stable drafting asset hashes + quieter rate-limit UI

**Why:** Windows CRLF made SHA-256 of skill/positioning diverge from `manifest.json` → blocked Go to Drafting. Full-page AgentMail banner was noisy.

**Behavioral contract (exact):**

1. Hash text assets only after CRLF→LF via `normalizeDraftingTextBytes` → `hashDraftingTextAsset`.
2. `.gitattributes` forces LF for drafting resources.
3. After editing skill/positioning text: `npm run drafting:sync-manifest` → `scripts/sync_drafting_manifests.mjs`.
4. UI: compact **Verification rate limited** chip (not a blocking banner).

**Files:** `lib/drafting/asset-hash.ts`, `lib/drafting/assets.ts`, `resources/drafting/manifest.json`, `.gitattributes`, `scripts/sync_drafting_manifests.mjs`, `package.json` script, `tests/drafting-asset-hash.test.ts`.

**Do NOT:** skip or weaken hash validation; edit skill text without syncing the manifest.

---

### U9 — Empty-brief quarantine, append-only cost events, worker registry, schema audit

**Why:** Empty research burned shards forever; cost disappeared on lint/retry throw; silence-steal duplicated Sonnet; schema drift crashed Go to Drafting.

#### U9a — Empty research brief quarantine

| Constant | Value |
|----------|-------|
| Error code | `EMPTY_RESEARCH_BRIEF_ERROR_CODE = 'empty_research_brief'` |
| Max automatic executions | `EMPTY_BRIEF_MAX_AUTOMATIC_EXECUTIONS = 2` |
| Retry delay | `EMPTY_BRIEF_RETRY_DELAY_MS = 5000` |
| Durable columns on drafting item | `empty_brief_attempts`, `empty_brief_input_fingerprint`, `empty_brief_last_at`, `last_error_code`, `retry_audit` (jsonb) |
| Auto policy | initial + one delayed fresh retry (`forceFreshResearch`); then quarantine |
| Manual Retry | appends structured `retry_audit` (`actorId`, `at`, fingerprints, attempts, reason, `surface='lead_approval'`) |
| Blocked overrides | bulk approve, Resume, `system.reconcile` cannot clear quarantine |
| Zero selected facts | `writeBlocked` / `failed_research` — **never** send empty packet to writer |

#### U9b — Append-only cost persistence

| Object | Contract |
|--------|----------|
| Table | `outreach.drafting_job_cost_events` UNIQUE `(drafting_job_id, event_key)` |
| Opening balances | `drafting_run_cost_opening_balances` with `source_kind='legacy_unattributed'` |
| Function | `public.record_drafting_job_cost_event(...)` |
| Persist timing | **before** lint / repair / later throws (`runProviderCallWithCostPersistence`) |
| Replay | same provider-result `event_key` → no-op; new request ID always adds spend |

#### U9c — Worker registry + steal-proof claim

| Concept | Exact rule |
|---------|------------|
| Table | `outreach.orchestration_workers` (`worker_id`, `started_at`, `heartbeat_at`, `metadata`) |
| Worker heartbeat | ~**10s** |
| Reclaim when | lease expired **OR** owner missing **OR** worker heartbeat older than **45s** |
| Delayed claims | `orchestration_jobs.next_attempt_at` + delayed claim index |
| Claim serialization | `claim_orchestration_job` uses `pg_advisory_xact_lock(hashtextextended('outreach-orchestration:' \|\| p_lane, 0))` so `p_limit` is **fleet-wide** |
| Hub lock file | token-fenced `.orchestration-worker.lock` (`lib/orchestration/worker-lock.ts`) |
| Empty research | business outcome — **not** transport retry |
| Hub finalize | `finalizeIdleDraftingRuns` closes idle runs |
| Enrichment finalize guard (hub) | `OPEN_ENRICHMENT_ORCH_KINDS` — never mark enrichment complete while open research/orch kinds remain |

#### U9d — Schema contract

| Object | Role |
|--------|------|
| `lib/drafting/schema-contract.ts` | required tables/columns/functions |
| `npm run verify:drafting` / `db:drafting` | fail-closed before Go to Drafting; error must name the exact fix command |

**Files:** `lib/drafting/empty-brief-policy.ts`, `lib/drafting/cost-events.ts`, `lib/drafting/schema-contract.ts`, `db/drafting_cost_persistence.sql`, updates to `db/drafting_schema.sql` + `db/orchestration_schema.sql`, `lib/orchestration/{worker.ts,worker-lock.ts,repository.ts,config.ts,handlers.ts}`, `scripts/verify_drafting_schema.ts`, tests listed in Phase 9 below.

**Do NOT:** infer empty-brief budget from disposable `attempt_count`; let transport/reconcile/Resume reset the counter; persist cost after lint; steal by `updated_at` silence; drop the advisory lock from `claim_orchestration_job`.

---

## Phased implementation roadmap

Implement in this order. Each phase ends with probes + named tests green. Preserve UI skin throughout.

### Phase 0 — Inventory (no code changes)

1. Copy this report into the fork (or point the agent at it).
2. Run **all** presence probes; record PASS/FAIL in a short checklist.
3. Diff fork vs source for these directories only: `lib/drafting/`, `lib/orchestration/`, `lib/enrichment-fields.ts`, `lib/research-budget.ts`, `lib/path-cost-estimate.ts`, `lib/analytics.ts`, `db/`, `tests/`, `app/api/`, `resources/drafting/`.
4. Confirm env defaults in `.env.example` / `.env.local` match the constants table below (do not raise concurrency yet if DB pool is tiny).
5. **Stop condition:** human approves which phases are already PASS vs need work.

### Phase 1 — Schema + enrichment/drafting cost-control core (U1)

**Depends on:** Phase 0  
**Skip if:** P1 probe already PASS and leases table exists in live DB.

1. Apply/merge `db/drafting_schema.sql` leases section (`outreach.drafting_company_research_leases`).
2. Port exact modules: `enrichment-fields.ts`, `research-budget.ts`, `company-research-key.ts`, `lease-heartbeat.ts`, `research-company-reuse.ts`, adversarial cache bits, slim research prompt.
3. Wire lease claim/renew/release around Sonnet research; park non-owners in `waiting_company_research`.
4. Run: `npx tsx --test tests/enrichment-fields.test.ts tests/drafting-cost-optimization.test.ts` (or the fork’s equivalent test runner).
5. **Acceptance:** sibling leads with same non-generic domain do not both own a `researching` lease; generic domains disable reuse.

### Phase 2 — Lanes, mailbox fail-open, queue orchestration (U2)

**Depends on:** Phase 1  
**Skip if:** P2 PASS.

1. Update `db/outreach_schema.sql` CHECKs to include `rate_limited` on verification result columns; migrate live DB.
2. Split lanes in `lib/orchestration/config.ts` (research 8 / write 8 / worker 16).
3. Port `queue-orchestration.ts` and call it from Go to Drafting, approve, and `system.reconcile`.
4. Port AgentMail fail-open + `isMailboxDraftable` + delivery-trust.
5. Port lint mechanical/judgment split; judgment → `ready_for_review` with Approve blocked.
6. Minimal UI: rate-limited chip only (no banner redesign).
7. Run queue-orchestration + delivery-trust + lint tests.
8. **Acceptance:** research and write claim on different lanes; first AgentMail 429 cancels remaining probes; judgment drafts appear in Email review.

### Phase 3 — Writer brief + prompt v12 (U3)

**Depends on:** Phase 2 lint codes present (can parallelize with Phase 4 after Phase 1).  
**Skip if:** P3 PASS.

1. Port `writer-research-brief.ts` constants, ranking, `clip()`, temporal-before-cap.
2. Port `writer-prompt.ts` version `drafting-writer-v12-ranked-brief` + `WRITER_NO_STACKED_CLAUSES_SYSTEM_BLOCK`.
3. Update skill text if needed; run `npm run drafting:sync-manifest`.
4. Port `tests/writer-research-brief.test.ts`. If the fork lacks temporal-before-cap / 60% clip assertions, copy those cases from Eva `backend/src/tests/services/outreach/writerResearchBrief.test.ts` (`f6b5b1ce1`) into the hub test file.
5. **Acceptance:** writer user prompt contains ≤2/1/1 claims each ≤120 chars; stale/blocked facts never consume slots; sentence clip below 60% of budget loses to a shorter boundary.

### Phase 4 — Path-bucket cost estimate (U4)

**Depends on:** Phase 1 (`resolveCompanyResearchKey` + identity completeness).  
**Skip if:** P4 PASS.

1. Port `lib/path-cost-estimate.ts` + pricing helpers.
2. Replace cost-estimate API response with totals + `buckets[]`.
3. Run `tests/path-cost-estimate.test.ts`.
4. **Acceptance:** same-domain complete siblings classify as `draft_sibling_skip` / `draft_company_reuse`, not all `draft_fresh`.

### Phase 5 — Anthropic semaphore (U6)

**Depends on:** Phase 2 lane concurrency raised.  
**Skip if:** P6 PASS.

1. Port `anthropic-semaphore.ts`.
2. Wrap every drafting Anthropic call; on transport 429 shrink + jittered backoff.
3. Include `draftingAnthropicSnapshot()` fields in worker saturation logs.
4. Run `tests/drafting-anthropic-semaphore.test.ts`.
5. **Acceptance:** two concurrent 429s in one pressure window shrink only once; aborted waiter does not consume a slot.

### Phase 6 — Rescue / Resume (U7)

**Depends on:** Phases 1–2; finalize with Phase 8 worker registry.  
**Skip if:** P7 PASS.

1. Port `lib/drafting/rescue.ts` reason sets + CTA/auto eligibility.
2. Wire `POST /api/campaigns/:id/drafting/rescue`.
3. Auto-rescue with 45s cooldown on drafting poll; Resume CTA with `INTERRUPT_RESUME_COPY`.
4. Ensure Resume cannot bypass empty-brief quarantine (even before Phase 8, stub the guard if columns missing — prefer landing Phase 8 soon after).
5. Run `tests/drafting-rescue.test.ts`.
6. **Acceptance:** dead-worker / stranded reasons trigger rescue; empty-brief items stay quarantined across Resume.

### Phase 7 — LF asset hashes (U8)

**Depends on:** none (can run anytime before live Go to Drafting on Windows).  
**Skip if:** P8 PASS.

1. Port `asset-hash.ts`; hash via normalized LF bytes only.
2. Add `.gitattributes` for drafting text assets.
3. Add `drafting:sync-manifest` script; regenerate manifests.
4. Replace noisy rate-limit banner with compact chip if not done in Phase 2.
5. Run `tests/drafting-asset-hash.test.ts` with CRLF fixtures.
6. **Acceptance:** CRLF-normalized file matches LF-pinned manifest hash; Go to Drafting no longer fails on Windows line endings.

### Phase 8 — Empty-brief, cost events, worker registry, schema audit (U9)

**Depends on:** Phases 1, 2, 6. **Do this last among core drafting hardenings.**  
**Skip if:** P9 PASS.

1. Apply `db/drafting_schema.sql` column adds + `db/drafting_cost_persistence.sql` + orchestration worker/claim updates (`db/orchestration_schema.sql`).
2. Port `empty-brief-policy.ts`; persist columns; wire into research completion + `NON_AUTO_RETRY_ERROR_CODES`.
3. Port `runProviderCallWithCostPersistence` / `cost-events.ts` — persist **before** lint.
4. Create `orchestration_workers`; rewrite `claim_orchestration_job` with advisory lock + 45s worker liveness; hub `worker-lock.ts` token fence.
5. Port `schema-contract.ts` + `npm run verify:drafting`; fail-closed message must cite the exact apply command.
6. Port enrichment finalize guard if enrichment runs exist in the fork.
7. Run tests:
   - `tests/empty-brief-policy.test.ts`
   - `tests/drafting-cost-accounting.test.ts`
   - `tests/drafting-cost-persistence.integration.ts` (if DB available)
   - `tests/drafting-schema-contract.test.ts`
   - `tests/drafting-item-execution-fence.test.ts`
   - `tests/orchestration-worker-lock.test.ts`
   - `tests/orchestration-worker-shutdown.test.ts`
   - `tests/drafting-state-integrity.test.ts`
   - `tests/drafting-rescue.test.ts` (re-run)
8. **Acceptance:** third empty brief quarantines; Resume cannot clear it; duplicate provider event_key does not double-count; reclaim requires dead worker/lease; `verify:drafting` fails loud on missing columns.

### Phase 9 — Analytics Hub (U5)

**Depends on:** Phase 8 cost event model preferred (actuals quality); can ship read-only earlier with a warning.  
**Skip if:** P5 PASS.

1. Apply `db/analytics_schema.sql` (`outreach.analytics_run_exclusions`).
2. Port `lib/analytics.ts` metric definitions **exactly** as in `@docs/modules/outreach-hub.md` § Analytics Hub.
3. Wire GET summary/runs + POST exclude/include.
4. Add Analytics entry to existing hub chrome (one button/link); page can reuse local table/stat primitives — **do not** import Eva React or restyle the whole hub.
5. Run `tests/analytics-window.test.ts`.
6. **Acceptance:** week/month/custom windows; excluding a run drops its leads from aggregates; path-bucket estimates are not shown as Analytics actuals.

### Phase 10 — Soak / ops checklist (human)

1. `npm run verify:drafting` (and analytics verify if present) against the fork’s Supabase.
2. Confirm `.env.local` matches safe defaults; rollback bundle documented: research/write/worker/Anthropic = `4/4/8/4`.
3. Stub-mode smoke: Go to Drafting → queue → stub drafts → Email review.
4. Only with human approval: `DRAFTING_MODE=live` on a **1–2 lead** campaign.
5. Confirm no UI skin regressions (visual diff of hub home, draft workspace, review).

---

## Env / concurrency constants

Copy these defaults unless the human overrides. Raise only as a bundle after watching pooler metrics.

| Knob | Safe default | Role |
|------|-------------:|------|
| `PG_POOL_MAX` | `4` | Per-process node-pg pool |
| `ORCHESTRATION_POLL_MS` | `400` | Hub worker poll |
| `ORCHESTRATION_LEASE_SECONDS` | `600` | Job lease |
| `ORCHESTRATION_WORKER_MAX_CONCURRENCY` | `16` | Total in-flight orch jobs |
| `ORG_DRAFT_RESEARCH_CONCURRENCY` | `8` | Research lane |
| `ORG_DRAFT_WRITE_CONCURRENCY` | `8` | Write lane |
| `DRAFTING_ANTHROPIC_MAX_INFLIGHT` | `8` | Adaptive Anthropic cap |
| `ORG_RESEARCH_CONCURRENCY` | `2` | Enrichment company research |
| `ORG_MAILBOX_VERIFY_CONCURRENCY` | `3` | AgentMail |
| `ORG_PRIMARY_SEARCH_USES` | `5` | Enrichment primary searches |
| `ORG_PROFILE_RESCUE_SEARCH_USES` | `1` | Hard-field rescue (ceiling 1) |
| `DRAFT_RESEARCH_MAX_CALLS` | `2` | Incl. forced report (ceiling 3) |
| `DRAFT_RESEARCH_MAX_SEARCHES` | `2` | Research web_search budget |
| `DRAFT_ADVERSARIAL_MAX_SEARCHES` | `1` | Haiku QA searches |
| `DRAFT_ADVERSARIAL_MAX_TURNS` | `4` | Haiku QA turns |
| `DRAFTING_PROMPT_CACHE_TTL` | `1h` | Prompt cache TTL |
| `DRAFTING_MODE` | `stub` | Live only after human gate |
| `EXTRACTION_MODE` | `stub` | Live only after human gate |
| `ORCHESTRATION_WORKER_REPLACE` | `1` | Hub lock replace |

**Rollback drafting bundle (together):** `ORG_DRAFT_RESEARCH_CONCURRENCY=4`, `ORG_DRAFT_WRITE_CONCURRENCY=4`, `ORCHESTRATION_WORKER_MAX_CONCURRENCY=8`, `DRAFTING_ANTHROPIC_MAX_INFLIGHT=4`.

---

## Verification commands

From `lucas-outreach-hub` (or the fork root if package scripts match):

```bash
# Schema
npm run db:drafting
npm run verify:drafting

# Focused unit tests (adjust runner if fork differs)
npx tsx --test tests/enrichment-fields.test.ts
npx tsx --test tests/drafting-cost-optimization.test.ts
npx tsx --test tests/drafting-queue-orchestration.test.ts
npx tsx --test tests/writer-research-brief.test.ts
npx tsx --test tests/path-cost-estimate.test.ts
npx tsx --test tests/drafting-anthropic-semaphore.test.ts
npx tsx --test tests/drafting-rescue.test.ts
npx tsx --test tests/drafting-asset-hash.test.ts
npx tsx --test tests/empty-brief-policy.test.ts
npx tsx --test tests/drafting-cost-accounting.test.ts
npx tsx --test tests/drafting-schema-contract.test.ts
npx tsx --test tests/orchestration-worker-lock.test.ts
npx tsx --test tests/analytics-window.test.ts
```

If the fork’s `package.json` test script differs, run the **same files** under whatever runner it uses — do not skip files because the script name differs.

---

## Do-not list (global)

1. Do not restyle the fork’s UI or replace its design system while porting.
2. Do not weaken asset-hash, empty-brief quarantine, delivery-trust, or claim advisory locks.
3. Do not auto-retry `empty_research_brief` via reconcile, Resume, or transport loops after quarantine.
4. Do not invent mailbox `valid` from upload/inferred status.
5. Do not fall back to company-name matching when the email domain is generic or missing.
6. Do not enqueue `profile_rescue` for `location`.
7. Do not lower the QA window (3/2/2) to match writer caps (2/1/1).
8. Do not persist provider cost after lint/repair throws — persist before.
9. Do not steal jobs based on `updated_at` silence while the worker heartbeat is live.
10. Do not raise research/write/worker/Anthropic concurrency independently of the documented rollback bundle.
11. Do not spend live Anthropic/AgentMail from agent sessions without an in-the-moment human Enrich / Go to Drafting click.
12. Do not redefine Analytics metric formulas differently from `@docs/modules/outreach-hub.md` § Analytics Hub.

---

## Cross-references

| Topic | Canonical location |
|-------|--------------------|
| Enrichment hard/soft + budgets | `@docs/modules/outreach-hub.md` § Enrichment Cost Controls; hub `lib/enrichment-fields.ts`, `lib/research-budget.ts` |
| Drafting leases, lanes, rescue, empty-brief, cost, semaphore | `@docs/modules/outreach-hub.md` § Drafting Cost Controls |
| Path-bucket estimates | `@docs/modules/outreach-hub.md` § Campaign cost estimate; hub `lib/path-cost-estimate.ts` |
| Analytics actuals | `@docs/modules/outreach-hub.md` § Analytics Hub; hub `lib/analytics.ts` |
| Hard rules (hashes, peer closes, etc.) | `@docs/modules/outreach-hub.md` § Hard Rules |
| Postgres orch baseline | `planning/12-postgres-orchestration.md` |
| Drafting product/runtime specs | `planning/drafting/README.md` and linked `01`–`07` |
| Eva migrations (if ever porting Eva) | 1129 leases → 1130 `rate_limited` → 1131 analytics → 1132 workers/empty-brief |

### U10 — Also landed in-window (do not skip if fork is behind)

These are easy to miss if an agent only ports U1–U9 by name. Port them when probes fail.

| Item | Exact contract / files |
|------|------------------------|
| Enrichment email cache short-circuit | Known-domain / format-cache skips and cached domain-none **must not** finalize while any lead in the batch still lacks an email. Use `peopleStillNeedEmailResearch`. Cached `confidence='none'` retries when emails still missing (`path_i4_retry_missing_email`). Files: `lib/enrichment-fields.ts`, `lib/enrichment.ts`. See `@docs/modules/outreach-hub.md` § Enrichment Cost Controls. |
| Approve-for-drafting UX | Single/bulk approve immediately removes lead from Leads table into Live drafting activity (`queued_research` or `verifying_mailbox`). API: `app/api/campaigns/[id]/drafting/approve-leads/route.ts`. Preserve fork skin; wire behavior only. |
| Pipeline insight telemetry | Enrich/draft write `*.usage.insight` counters; logs `[pipeline-insight:enrich\|draft\|write]`. Files: `lib/pipeline-telemetry.ts`, `scripts/campaign_pipeline_insight.ts`. |
| Drafting item execution fence | `withDraftingItemExecutionFence` / claim in `lib/drafting/jobs.ts` — renewable row fence before provider work so duplicate/reclaimed workers cannot overlap research; no pooled client held during Anthropic calls. Test: `tests/drafting-item-execution-fence.test.ts`. |
| Enrichment finalize guard | `lib/orchestration/enrichment-finalize-guard.ts` — `OPEN_ENRICHMENT_ORCH_KINDS`; never mark enrichment run complete while those kinds remain open. |

**Presence probes (add to Phase 0):**

```bash
rg -n "peopleStillNeedEmailResearch|path_i4_retry_missing_email" lib || true
rg -n "withDraftingItemExecutionFence|claimDraftingItemExecution" lib/drafting || true
rg -n "OPEN_ENRICHMENT_ORCH_KINDS|enrichment-finalize-guard" lib/orchestration || true
rg -n "approve-leads|Approve for drafting|Approve all eligible" app || true
rg -n "pipeline-insight|pipeline-telemetry" lib scripts || true
```

### Eva-only / hub-only labels (do not confuse the fork)

| Concern | Hub | Eva |
|---------|-----|-----|
| Sibling park | FSM `waiting_company_research` | `CompanyResearchDeferredError` + notes + 15s requeue |
| Cost events | `drafting_job_cost_events` + `record_drafting_job_cost_event` | `lead_cost_events` `source_kind='drafting_provider_result'` |
| Worker process | `scripts/orchestration_worker.ts` + lock file | `outreachOrchestrationJob.ts` (tick 2s, heartbeat 10s, drain 7s) |
| Enrichment finalize guard | `enrichment-finalize-guard.ts` | Coarser — treat as **hub-only** unless Eva gains the same invariant |
| Live Enrich person research | Live in hub | Helpers ready; Enrich pipeline still stub |

---

## Suggested agent prompt (paste into the fork)

```text
Read planning/porting-report-standalone-fork.md end-to-end.

Hard constraints:
- Preserve this fork’s existing UI skin. Port behavior/schema/API/tests only.
- Run Phase 0 presence probes first. Skip phases that already PASS.
- Implement one phase at a time in the order given. Do not invent thresholds.
- If a constant/schema name disagrees with docs/modules/outreach-hub.md or planning/*, STOP and ask.
- Keep DRAFTING_MODE=stub and EXTRACTION_MODE=stub. No live spend.
- End each phase with the named tests green and the phase acceptance checks.

Start with Phase 0 inventory and report PASS/FAIL for probes P1–P9 before writing code.
```
