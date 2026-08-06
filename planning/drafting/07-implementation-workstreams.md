# Implementation workstreams

## 1. Delivery model

This is one complete product target delivered through coordinated
workstreams, not gated phases. Work can proceed in parallel where dependencies
allow. A dependency means code cannot compile or behave correctly without
another contract; it is not a partial-release gate.

Do not enable live provider mode until the complete offline system, safety
controls, and user-driven manual test path exist.

## 2. Dependency graph

```text
Asset manifest + domain contracts
        ├───────────────┬──────────────────┐
        v               v                  v
Database/state      Research/writer    UX shell/components
        │               │                  │
        ├──────┬────────┘                  │
        v      v                           │
Jobs/Inngest  APIs/repository ─────────────┘
        │      │
        └──┬───┘
           v
      Exports + counters
           │
           v
 Offline integration/browser/chaos suite
           │
           v
 User-triggered 1–2 lead live manual evaluation
```

Schema/type/prompt contracts should be written first enough that each
workstream targets the same states and payloads. UI, pure policy, canned
provider, and many tests can then proceed concurrently.

## 3. Workstream A — canonical assets and model configuration

Files:

- add `resources/drafting/*`;
- add `lib/drafting/assets.ts`;
- update `lib/models.ts`;
- update `.env.example`;
- add asset manifest tests.

Tasks:

- [ ] Copy the exact seeded skill and PDF into normalized committed paths.
- [ ] Create reviewed positioning text preserving every PDF fact and no new
      fact.
- [ ] Create the closed `embark-capabilities-v1.json` catalog from exact PDF
      solution lines and supported outcomes.
- [ ] Generate SHA-256 manifest with source names/versions/sizes/hashes.
- [ ] Add parity tests proving every PDF fact/catalog entry appears in the
      reviewed extract with no unsupported claim.
- [ ] Add server-only loader with process memoization.
- [ ] Verify hash/required sections at build/test startup.
- [ ] Add explicit research and writer model constants.
- [ ] Verify an immutable current Sonnet model ID with official docs/SDK.
- [ ] Upgrade `@anthropic-ai/sdk` through npm to current release if needed;
      commit lockfile; never invent a version.
- [ ] Confirm strict structured output/tool and chosen web-search type compile.
- [ ] Add `assertLiveDraftingAllowed()` independent from extraction mode.
- [ ] Add hard code ceilings for searches/output tokens.
- [ ] Add prompt/schema/price version constants.
- [ ] Ensure assets are bundled in Vercel server output and absent from client
      bundles.

Output contract: `loadDraftingAssets()` returns immutable typed
skill/positioning text plus versions/hashes.

## 4. Workstream B — pure drafting domain/policy

Files:

- `lib/drafting/types.ts`
- `lib/drafting/normalize.ts`
- `lib/drafting/eligibility.ts`
- `lib/drafting/state.ts`
- `lib/drafting/research-validate.ts`
- `lib/drafting/lint.ts`
- `lib/drafting/cost.ts`

Tasks:

- [ ] Define all enum/string unions once; DB checks mirror them.
- [ ] Normalize required fields and placeholder values.
- [ ] Compute canonical effective input and SHA-256 fingerprint.
- [ ] Distinguish identity/research changes from delivery-only changes.
- [ ] Encode exact `email_verification='valid'` gate for every research,
      write, rewrite, and final-export transition.
- [ ] Bind each verification result to the normalized effective-email
      fingerprint; invalidate it on email change.
- [ ] Encode exact state transition map and completion predicate.
- [ ] Include `waiting_for_enrichment`, `needs_lead_review`,
      `verifying_mailbox`, `removed`, and `budget_paused` policies.
- [ ] Encode counter selectors used by API/UI.
- [ ] Define source families/trust/freshness/significance gates.
- [ ] Validate packet references, citations, independence, resolution.
- [ ] Implement skill linter with codes/spans and hard/warning categories.
- [ ] Implement price snapshots, estimates, reservations, actual calculation.
- [ ] Unit-test every pure rule before wiring provider/UI.

Do not copy mutable business rules into React components or route handlers.

## 5. Workstream C — Postgres schema and repository

Files:

- extend `db/outreach_schema.sql`;
- add `lib/drafting/repository.ts`;
- add `lib/drafting/jobs.ts`;
- add DB integration tests/scripts.

Tasks:

- [ ] Add all tables/constraints/indexes from `03`.
- [ ] Add idempotent additive schema setup.
- [ ] Add SQL claim/finish helpers or direct session-pool transactions.
- [ ] Implement start/resume transaction.
- [ ] Persist immutable `drafting_run_items` cohort membership so later
      enrichment completion cannot authorize newly appeared leads.
- [ ] Gate each item on completed source enrichment run and resnapshot stale
      source fingerprints without overwriting manual overrides.
- [ ] Implement stable ordinal allocation under workspace lock.
- [ ] Snapshot campaign lead/relationship/sender/assets.
- [ ] Implement input edit/invalidation transaction without autoqueue.
- [ ] Implement Approve-for-drafting transaction: reuse exact valid result or
      create one item-scoped AgentMail job.
- [ ] Implement remove-from-campaign transaction that deletes only
      `campaign_leads`, marks item removed, and cancels pending work.
- [ ] Implement budget continue in stable ordinal order.
- [ ] Implement job reservation/claim/heartbeat/finish/supersede.
- [ ] Implement one-current-packet hard overwrite.
- [ ] Implement one-current-draft hard overwrite + CAS.
- [ ] Implement approve/rewrite transitions.
- [ ] Implement grouped count/completion query.
- [ ] Make generation denominator all current mailbox-valid campaign items;
      keep unresolved Leads out until they become valid.
- [ ] Implement export snapshot/preflight transaction.
- [ ] Reconcile Replace, merge, archive, and unarchive effects on workspaces,
      jobs, stale items, and exports.
- [ ] Add owner-scoped repository helpers and foreign-user tests.
- [ ] Run query plans for workspace/status/pending-job paths and confirm
      indexes are used with representative fixture counts.
- [ ] Re-run schema setup and verify no row/constraint/index duplication.

Database code must not scan `outreach.leads` or seeded contacts to find
drafting targets. The start transaction begins from owned
`campaign_leads`.

Drafting mailbox verification for a manual override must not call the current
global-lead result writer. Refactor/reuse AgentMail's probe and bounce
classifier behind an item-scoped commit guard.

## 6. Workstream D — research provider and orchestration policy

Files:

- `lib/drafting/research-prompt.ts`
- `lib/drafting/research-provider.ts`
- provider fixtures/tests.

Tasks:

- [ ] Build strict `report_drafting_research` schema.
- [ ] Build research prompt from the skill readings/capability catalog.
- [ ] Include exact lead/relationship/sender snapshot boundaries.
- [ ] Configure web search max 3, direct callers, full citations.
- [ ] Keep `tool_choice:auto` on search turn.
- [ ] Implement one no-search strict report-enforcement turn.
- [ ] Parse/store citation blocks and provider usage/request ID.
- [ ] Validate URLs/source families/dates/quotes after response.
- [ ] Classify identity/freshness/resolution/human pause.
- [ ] Strip rejected facts before writer input.
- [ ] Add exact-domain same-workspace company context reuse only if tests show
      benefit without person leakage.
- [ ] Categorize retryable/terminal errors.
- [ ] Redact provider errors.
- [ ] Canned fixtures cover all research acceptance cases.

No email-discovery search belongs here.

## 7. Workstream E — writer, repair, and rewrite

Files:

- `lib/drafting/writer-prompt.ts`
- `lib/drafting/writer-provider.ts`
- writer fixtures/tests.

Tasks:

- [ ] Assemble static cached prefix: security → verbatim skill → positioning.
- [ ] Put dynamic sender/lead/relationship/packet after cache boundary.
- [ ] Build strict writer output schema.
- [ ] Ensure no web/client tools are present.
- [ ] Enforce sender facts only from approved sources.
- [ ] Enforce permitted resolution/fact IDs/prohibited assumptions.
- [ ] Parse usage/cache/request ID.
- [ ] Run schema, claim-ledger, resolution, and deterministic lint validation.
- [ ] Create one bounded automatic repair on hard failure.
- [ ] Implement rewrite input with previous current content as avoid-context.
- [ ] Prove rewrite provider has no research method/tool.
- [ ] Hard-overwrite current content only after complete valid replacement.
- [ ] Preserve previous current content on failed rewrite only as recovery
      current row, never a second version.
- [ ] Add provider spies asserting exact call counts.

## 8. Workstream F — Inngest and reconciliation

Files:

- extend `lib/inngest/functions.ts` or split drafting functions into
  `lib/inngest/drafting-functions.ts` and register them;
- update `app/api/inngest/route.ts` registration;
- add reconciler tests.

Tasks:

- [ ] Add start dispatcher.
- [ ] Add AgentMail verify function on the existing mailbox concurrency lane.
- [ ] Add research function/concurrency lane.
- [ ] Add write/repair lane.
- [ ] Add user rewrite priority lane.
- [ ] Use stable event/step IDs without PII.
- [ ] Claim DB job before provider call.
- [ ] Handle RetryAfter/backoff and definitive errors.
- [ ] Add heartbeat/lease semantics.
- [ ] Dispatch dependent jobs returned by finish transaction.
- [ ] Add scheduled reconciler for dropped events/orphans/reservations.
- [ ] Emit `run.finalized` after enrichment finalize commits and add the
      idempotent waiting-item promotion handler/reconciler path.
- [ ] Emit/consume `lead.email.verification.completed` after AgentMail result
      commit so previously authorized pending rows promote after enrichment
      completion; reconciler covers dropped events.
- [ ] Add circuit-breaker telemetry.
- [ ] Register all functions.
- [ ] Verify node runtime/300s.
- [ ] Ensure missing Inngest keys in dev cannot fall through to live provider.
- [ ] Chaos-test each crash window.

## 9. Workstream G — authenticated APIs

Files:

```text
app/api/campaigns/[id]/drafting/route.ts
app/api/campaigns/[id]/drafting/export/route.ts
app/api/drafting/items/[itemId]/input/route.ts
app/api/drafting/items/[itemId]/approve-lead/route.ts
app/api/drafting/items/[itemId]/remove/route.ts
app/api/drafting/items/[itemId]/research/route.ts
app/api/drafting/items/[itemId]/resolve/route.ts
app/api/drafting/items/[itemId]/retry/route.ts
app/api/drafts/[itemId]/route.ts
app/api/drafts/[itemId]/approve/route.ts
app/api/drafts/[itemId]/rewrite/route.ts
app/api/sender-profiles/route.ts
app/api/sender-profiles/[id]/route.ts
```

Tasks:

- [ ] Implement contracts/status codes from `04`.
- [ ] Session and campaign-owner scope every request.
- [ ] Reject unknown request fields and oversized content.
- [ ] Use revision/fingerprint/idempotency preconditions.
- [ ] Dispatch events only after commit.
- [ ] Return safe errors and retry hints.
- [ ] Add no-store/private headers.
- [ ] Ensure GET routes are mutation/provider-call free.
- [ ] Confirm no send route/action exists.
- [ ] Contract-test every auth/error/success response.

## 10. Workstream H — page shell and entry points

Files:

- update `app/campaigns/[id]/campaign-tabs.tsx`;
- update `app/campaigns/[id]/review/page.tsx`;
- add Draft page/components;
- extend tokenized styles in `app/components.css` only when existing recipes
  cannot compose the behavior.

Tasks:

- [ ] Add Go to Drafting action on Review.
- [ ] Make Draft tab start/resume-aware without mutating on GET.
- [ ] Add sender-profile setup/resume flow.
- [ ] Show the pre-click projected cost and budget-continue control.
- [ ] Add authenticated Draft server page.
- [ ] Render sticky status sentence/bar/clickable counts.
- [ ] Add Email / Leads segmented control below the bar.
- [ ] Add Leads attention badge and visible helper that mailbox verification
      is required before drafting.
- [ ] Add 2s active/10s idle visibility-aware polling.
- [ ] Preserve last good snapshot on polling error.
- [ ] Add status detail drawer with objective usage/cost.
- [ ] Add restrained decision pulse/milestone/completion feedback without
      rewarding approval speed.
- [ ] Add honest empty/waiting/failure states.
- [ ] Use tokens/recipes; no hardcoded visual values.

## 11. Workstream I — Leads mode and human-resolution UX

Tasks:

- [ ] Build real-input editable table with responsive stacked layout.
- [ ] Row save state and debounced/blur flush.
- [ ] CAS conflict UI and local dirty recovery.
- [ ] Approve-for-drafting action with deterministic completeness check.
- [ ] Pending AgentMail state; valid auto-promotes/queues, non-valid remains.
- [ ] Remove from campaign confirmation and campaign-association deletion.
- [ ] Download unverified leads CSV with exact status/blocker.
- [ ] Build needs-decision evidence rows.
- [ ] Build source chips and shared research drawer.
- [ ] Show the optional nonblocking resolution-upgrade/obtainable-fact note.
- [ ] Implement cautious/correct/remove-from-campaign resolution actions.
- [ ] Ensure no hidden reasoning is displayed.
- [ ] Keyboard/focus/live-region/accessibility tests.

## 12. Workstream J — one-at-a-time review UX

Tasks:

- [ ] Stable current/previous/next navigation.
- [ ] Reviewed/generated counters from server definitions.
- [ ] Top drafted/mailbox-valid progress and exact `All valid emails drafted`
      completion copy.
- [ ] Realistic plain-text From/To/Subject/Body preview.
- [ ] Explicit Edit mode only.
- [ ] Textarea autosize without contenteditable.
- [ ] Hard-overwrite autosave/CAS/retry/flush.
- [ ] Approve and deterministic auto-advance.
- [ ] Deny/rewrite and immediate auto-advance.
- [ ] Add optional bounded Deny direction affordance.
- [ ] Browse never changes state.
- [ ] Edit approved clears approval.
- [ ] Permanent disabled Send with no handler/endpoint.
- [ ] Icon-only controls with labels/tooltips/focus/hit targets.
- [ ] Filters and new-draft arrival without moving current card.
- [ ] Research rationale/source drawer.

## 13. Workstream K — exports

Files:

- `lib/drafting/exports.ts`
- `lib/drafting/cowork-export.ts`
- export route/tests.

Tasks:

- [ ] Implement atomic shared preflight.
- [ ] Implement independent unverified-leads CSV available before completion.
- [ ] Generic CSV exact columns/order/UTF-8 BOM/CRLF/quoting.
- [ ] Parse-back round-trip tests.
- [ ] Formula-prefix blockers without silent body mutation.
- [ ] Duplicate recipient block.
- [ ] Require exact current mailbox `valid` result on every final-draft row.
- [ ] Cowork instructions emphasizing exact/no send.
- [ ] JSON payload, safe fence selection, export-local refs, SHA-256.
- [ ] Cross-format recipient/subject/body equality tests.
- [ ] Safe filenames/content types/no-store.
- [ ] Completion export card and late-409 refresh UX.

## 14. Workstream L — tests, telemetry, operations

Tasks:

- [ ] Add all pure unit suites.
- [ ] Add isolated DB integration suite.
- [ ] Add API contract suite.
- [ ] Add Playwright/browser suite.
- [ ] Add chaos/concurrency cases.
- [ ] Assert no live Claude, web-search, or AgentMail network in test process.
- [ ] Add objective run/job/workspace telemetry.
- [ ] Redact PII/body/prompts from logs/events.
- [ ] Add operational status drill-down.
- [ ] Add price/prompt/model/asset version telemetry.
- [ ] Add budget/circuit-breaker alerts.
- [ ] Add feature flag and rollback behavior.
- [ ] Document manual 1–2 lead user test and rubric.

## 15. Existing files intentionally reused

- `lib/db.ts` — pooled DB/transaction conventions.
- `lib/session.ts`, `lib/auth.ts` — session and owner-scope patterns.
- `lib/agentmail.ts`, `lib/mailbox-verify.ts`, and
  `lib/mailbox-verify-schedule.ts` — reuse/refactor the probe and bounce
  classifier behind an item-scoped result writer; never use the shared-lead
  update helper for drafting overrides.
- `lib/inngest/client.ts` and `/api/inngest`.
- `CampaignTabs`, shared cards, segmented controls, data tables, status chips,
  tooltips/drawer patterns.
- `app/globals.css` and `app/components.css` design tokens.
- existing CSV safety/normalization ideas, replaced by a tested serializer for
  multiline mail content.

## 16. Existing code not to overload

- Do not add drafting states to enrichment `outreach.runs`.
- Do not put drafting jobs in `company_research_jobs`.
- Do not append drafting provider logic to `lib/enrichment.ts`.
- Do not use Review sheet exports as machine input.
- Do not mutate global lead fields from Drafting overrides.
- Do not reuse enrichment `EXTRACTION_MODE` as the drafting live switch.
- Do not make Drafting page poll Inngest APIs.

## 17. Full-system acceptance checklist

### Data/scope

- [ ] Only owned campaign leads become drafting items.
- [ ] No stored contact/company sweep exists.
- [ ] Required fields and overrides are campaign-scoped.
- [ ] Global lead data remains unchanged by Drafting edits.
- [ ] Manual-email AgentMail results are item-scoped and email-fingerprint
      bound.
- [ ] Remove deletes campaign membership, never shared lead truth.
- [ ] Sender/assets/input are snapshotted/versioned.

### Research

- [ ] No research starts unless current effective email is mailbox `valid`.
- [ ] Maximum three searches.
- [ ] Correct source/citation/freshness/identity gates.
- [ ] Common-name conflict pauses.
- [ ] Sparse context lowers resolution without invention.
- [ ] No email rediscovery.
- [ ] Packet strict and application validated.

### Writing

- [ ] Verbatim skill and positioning source injected/cached.
- [ ] One email only, plain text.
- [ ] No search tool in writer/repair/rewrite.
- [ ] Claim/fact grounding passes.
- [ ] Hard skill lint passes.
- [ ] One automatic repair max.

### Jobs/reliability

- [ ] DB source of truth.
- [ ] Idempotent starts/actions/jobs.
- [ ] Stale results supersede.
- [ ] Dropped events/orphans recover.
- [ ] Retries bounded/categorized.
- [ ] Budget reserved/accounted.
- [ ] Ready drafts remain usable during failures.

### UX

- [ ] Work starts from explicit human action, never GET.
- [ ] Only complete mailbox-valid leads start; every other row appears in
      Leads mode.
- [ ] First draft appears without batch barrier.
- [ ] Honest drafted / all mailbox-valid progress and `All valid emails
      drafted` completion.
- [ ] Email / Leads toggle, Leads attention indicator, editable cells,
      Approve-for-drafting, Remove, and unresolved CSV.
- [ ] Inline save cannot lose/stale-overwrite.
- [ ] Browse, Edit, Approve, Deny/rewrite exact.
- [ ] Send permanently disabled and absent server-side.
- [ ] Accessible keyboard/focus/tooltip/live state.

### Export

- [ ] Only current approved mailbox-valid drafts.
- [ ] Non-valid Leads do not block valid-subset export and remain visibly
      counted/downloadable.
- [ ] Generic CSV round trips exact content.
- [ ] Cowork creates exact drafts and says never send.
- [ ] Duplicate recipient/formula/stale state blocked.

### Testing/launch

- [ ] All automated tests offline/stubbed.
- [ ] No live API/web search in agent runs.
- [ ] PII/secrets redacted.
- [ ] Feature flag/rollback ready.
- [ ] User manually tests 1–2 newly uploaded leads.
- [ ] User, not agent, judges live quality.

## 18. Decisions that should not block implementation

The plan chooses defaults so work does not stall:

- generic mail-merge CSV rather than waiting for a named mailer;
- unverified-leads CSV as a separate always-read-only intervention export;
- Cowork exact-draft recreation rather than independent redrafting;
- campaign-scoped overrides rather than global lead mutation;
- separate sender profile with one default;
- Sonnet for both quality-critical calls;
- direct bounded web search with full citations;
- polling over adding Realtime complexity;
- one continuous workspace per campaign plus authorization runs;
- no content version history;
- no sending.

If the user later names a mailer or changes an explicit product rule, add a
versioned adapter/policy rather than weakening the base contracts.
