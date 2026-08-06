# Quality, reliability, security, observability, and cost

## 1. Quality ownership

The system enforces objective safety and formatting rules. A human judges the
actual research and email quality.

Automated checks may assert:

- correct person/source binding rules;
- freshness/date rules;
- citations exist and are internally consistent;
- no unsupported fact IDs enter the writer;
- no hard banned pattern appears;
- the right prompt/assets/input were used;
- state, retries, autosave, and exports are correct;
- cost/search/token limits were honored.

Automated checks and agents must not declare a live email “good” based on
their own qualitative reading. After implementation, the user manually tests
one or two leads in the built app and applies the skill rubric.

No test or agent-driven development run calls live Claude or `web_search`.

## 2. Test architecture

### 2.1 Provider dependency injection

Interfaces:

```ts
interface DraftResearchProvider {
  research(input: DraftingResearchInput): Promise<ResearchProviderResult>;
}

interface DraftWriterProvider {
  write(input: WriterInput): Promise<WriterProviderResult>;
  repair(input: RepairInput): Promise<WriterProviderResult>;
  rewrite(input: RewriteInput): Promise<WriterProviderResult>;
}

interface DraftMailboxVerifier {
  verify(input: {
    itemId: string;
    email: string;
    emailFingerprint: string;
  }): Promise<{ status: 'valid' | 'invalid' | 'unknown'; providerRequestId?: string }>;
}
```

Test providers:

- canned success;
- identity collision;
- stale role conflict;
- true zero;
- malformed report;
- hard-lint writer result then repaired result;
- rate limit with Retry-After;
- timeout;
- definitive auth/quota denial;
- usage/caching/search counters;
- spy provider that throws if research is called during rewrite.
- AgentMail valid, invalid/bounce, unknown/provider-error, delayed result, and
  stale-email-fingerprint fixtures.

The live provider factory asserts `DRAFTING_MODE=live`. Test bootstrap asserts
mode is stub and deletes/poisons both `ANTHROPIC_API_KEY` and
`AGENT_MAIL_API` so accidental model, web-search, or mailbox-probe calls fail
before network.

### 2.2 Test database

Use an isolated schema/database fixture with:

- one owner user/campaign;
- one foreign user/campaign;
- 1–2 leads per test;
- transaction rollback or deterministic cleanup;
- stubbed Inngest dispatch.

Never load or iterate the real seeded contacts as drafting targets.

## 3. Pure unit tests

### Eligibility and normalization

- each required field missing independently;
- whitespace/placeholders count missing;
- Unicode names and normalization;
- work location versus company HQ text;
- email syntax/free-domain/personal-domain rules;
- exact mailbox `valid` gate for research/write/rewrite/export;
- pending/invalid/unknown/risky/accept-all/null remain in Leads mode;
- verification result is bound to normalized email fingerprint;
- source value + override precedence;
- deterministic cold/previously-connected/warm-introduction/unknown
  connecting-context assembly;
- undefined CRM indicator requires human resolution;
- connection degree cannot manufacture warm context;
- clearing override falls back correctly;
- canonical JSON/input fingerprint stable across key order and line endings;
- identity field change versus email-only change invalidation.

### State transitions

- every allowed transition;
- every illegal transition returns conflict;
- Leads correction → verifying → valid promotion / non-valid return;
- removal cancels work and excludes campaign membership;
- approved edit returns unreviewed;
- denied draft enters rewrite and leaves reviewed count;
- stale results cannot transition current item;
- completion predicate across every blocking state.

### Counters

- `Reviewed X of Y generated` definitions;
- denominator grows when drafts land;
- rewriting removed until new current generation;
- browse does not increment;
- non-valid Leads rows excluded from valid generation/review denominators;
- mailbox-valid but incomplete rows remain in the generation denominator;
- Leads attention, verifying, and needs-human remain explicit.

### Research validation

- source IDs must exist;
- two mirrors are one family;
- person fact rejected without verified identity;
- low-only anchor rejected;
- stale/undated why-now rejected;
- future/invalid publication dates rejected;
- unsupported quote/fact token mismatch;
- unknown Embark capability ID rejected;
- web instruction/prompt injection never becomes policy;
- human pause required on material conflict;
- lower-resolution packet permitted for sparse footprint.

### Writer validation/lint

- every explicit banned phrase/code;
- em dash and entity variants;
- Markdown/HTML/bullets/numbered value propositions;
- multiple asks;
- calendar/marketing links;
- prohibited `people` usage;
- claim span must be exact substring;
- unknown fact ID;
- resolution exceeds packet;
- sender claim outside provided source;
- subject newline/control characters;
- uneven sentence warning is not false hard failure;
- plain text with normal punctuation survives unchanged.

### Export

All fixtures in `05-export-contracts.md`, including parse/render round trips,
formula-prefix blocking, duplicate recipients, Unicode, line endings, fences,
checksums, and the independently available unverified-leads CSV.

### Cost

- official price snapshot selection by date/model;
- web-search count cost (`searches × $0.01` at current price);
- input/output/cache token arithmetic;
- decimal precision;
- worst-case reservation;
- actual release;
- concurrent reservations cannot exceed run/org ceiling;
- superseded-before-call releases reservation;
- failed billable call records usage when present.

## 4. Database/integration tests

1. Start scopes only campaign leads and never global leads/contacts.
2. Two starts/double clicks are idempotent.
3. Two workers cannot claim one job.
4. Orphan lease reclaims after threshold, not before.
5. Dropped event leaves pending job recoverable.
6. `run.finalized` promotes only previously authorized waiting items; a
   dropped finalized event is recovered by reconciler.
7. `lead.email.verification.completed` promotes only an authorized exact-email
   item; a dropped event is recovered by reconciler.
8. Approve for drafting creates one AgentMail job unless the exact email is
   already valid; invalid/unknown creates no model job.
9. Input/email edit during verification or research supersedes stale result.
10. Research success creates one dependent write job.
11. Needs-human creates no write until explicit resolution.
12. Write hard-overwrites one draft row.
13. Deny creates writer-only rewrite job.
14. Automatic repair maximum is one.
15. Repeated provider malformed output becomes terminal.
16. Autosave CAS prevents stale-tab overwrite.
17. Approve transaction validates revision/fingerprint/hash/lint.
18. Editing approved draft clears approval and completion.
19. Remove deletes only campaign membership and cancels/supersedes work.
20. Budget reservation and usage update atomically; paused continuation is
    explicit and ordinal-stable.
21. Last job completion/reconciler computes generation/review state correctly.
22. Replace/merge/archive lifecycle reconciliation blocks stale export.
23. Export transaction cannot mix rows from before/after a concurrent edit.
24. Unresolved-leads CSV remains available while final drafts are incomplete.
25. Cross-owner IDs fail for every route/repository helper.
26. Canonical schema rerun is idempotent.

## 5. API contract tests

For every route:

- 401 no session;
- 404 foreign/missing owned resource;
- 400 malformed JSON;
- 409 stale revision/idempotency/state;
- 422 semantic validation;
- correct cache/security headers;
- bounded body/feedback lengths;
- unknown fields rejected;
- no stack/provider secret in error;
- content type and filename correct for exports.

Specific:

- GET/refresh performs zero mutations/provider calls;
- Start returns same run for same idempotency key;
- field completion saves but creates no job;
- approve-lead returns one verification or research job, never both
  redundantly;
- remove deletes the owned campaign association only;
- unverified-leads CSV works before review completion;
- rewrite spy proves no research call/job;
- send endpoint returns 404 because none exists;
- late export blocker returns JSON 409, not partial file.

## 6. Component and browser tests

Add Playwright (current version via package manager at implementation time) or
the repository's chosen browser test runner. Stub APIs/providers.

### Core journey

1. Review → Go to Drafting.
2. Ten mailbox-valid complete rows begin; three unresolved rows render in
   Leads mode with a toggle badge.
3. First draft appears while jobs remain.
4. Edit any Leads cell; row saves without queueing.
5. Approve corrected email; see verifying state; canned valid result moves it
   to Email mode and queues once.
6. Canned invalid result keeps a row in Leads; download unresolved CSV.
7. Remove one lead; it disappears from the campaign while shared lead remains.
8. Browse without changing review counts.
9. Activate Edit; type; observe save state; navigate safely.
10. Approve; auto-advance.
11. Deny; auto-advance; replacement later appears.
12. Generate/review all valid emails; final exports become available while
    unresolved Leads remain visible.
13. Parse all three downloads: unresolved CSV, draft CSV, and Cowork file.

### Failure/recovery

- polling 500 then recovery retains last good content;
- autosave network failure retains local text/retries;
- reload with local dirty recovery;
- two-tab 409 conflict;
- dropped event recovered by reconciler test hook;
- provider rate limit banner/next retry;
- failed rewrite leaves item nonexportable;
- session expiry redirects/recovers without losing server edits;
- page hidden stops polling and visibility refreshes.

### Accessibility

- axe scan (or equivalent) on all major states;
- keyboard-only actions;
- tooltips available on focus;
- icon `aria-label`s;
- live-region announcements not noisy;
- 200% zoom;
- reduced motion;
- mobile/narrow layout;
- disabled Send cannot focus/activate incorrectly while reason remains
  discoverable.

## 7. Chaos and concurrency tests

Simulate:

- crash after DB job insert but before event send;
- duplicate event delivery;
- crash after provider response before commit;
- crash after packet commit before dependent write dispatch;
- stale provider response after user correction;
- two simultaneous field edits;
- approve racing autosave;
- approve racing input change;
- remove racing AgentMail/model worker claim;
- AgentMail result racing an email correction;
- budget reservation racing across 10 jobs;
- rate-limit circuit opening while jobs claim;
- asset hash change mid-run;
- sender profile edit mid-run;
- new campaign lead while workspace open;
- export racing final approval/edit.

Expected pattern: DB state/fingerprints decide truth; retries either no-op,
supersede, or continue from durable terminal output. No duplicate paid call can
be fully prevented if a process dies after provider billing but before commit;
record this distributed-systems limit, use provider request IDs/idempotency
when supported, and keep the window as small as possible.

## 8. Research acceptance fixtures

Keep fixtures small and synthetic/recorded:

1. **Common-name collision**: two matching names at different companies →
   `needs_human`, no person fact selected.
2. **Stale professional profile**: old company versus fresh official
   appointment → conflict/freshness pause.
3. **Sparse executive**: one reliable source, no conflict → lower-resolution
   draft allowed, no fake person anchor.
4. **Same company, two leads**: company context may reuse, person identities
   remain isolated.
5. **Syndicated press release**: three copies count one source family.
6. **Decorative recent post**: accurate but `seasoning/discard`, not anchor.
7. **Meaningful filing/transition**: dated authoritative source may anchor.
8. **Undated event snippet**: cannot support “recent/now.”
9. **Prompt-injection source**: instruction text remains quoted data and
   cannot alter output/tool rules.
10. **True zero**: no plausible structure/timing → pause, no filler draft.
11. **Prior relationship ambiguity**: possible existing outreach → human
   decision before first-contact claim.
12. **Sender fact gap**: model asks/omits rather than infers.

Fixtures store sanitized canned tool content and expected objective packet
classification, not a claim that generated prose is qualitatively excellent.

## 9. Manual quality rubric

The user runs one or two live leads through the UI after the offline suite
passes. For each, inspect:

### Research

- correct person, company, role, and current status;
- two independent sources where identity requires it;
- dates make freshness clear;
- selected anchor matters in the recipient's world;
- decorative facts are not over-weighted;
- structural relation to Embark is plausible and source-faithful;
- conflict/uncertainty was surfaced rather than guessed.

### Email

- sorted as person/insider rather than campaign/vendor;
- reason clear in first two or three sentences;
- register calibrated to sender/recipient;
- no invented/implied knowledge;
- one idea, one reason, one ask;
- commercial motive honest;
- subject plain/colleague-like;
- no vendor-pattern or machine-text tells;
- no em dash;
- minimal signature;
- a decline costs nothing;
- one obtainable fact note, if shown, is useful and nonblocking.

The user records pass/fail and concrete feedback. Prompt/model changes require
repeating this manual sample; agents may report telemetry/failures but cannot
approve quality.

### 9.1 Evidence-gate recalibration

The trust-tier and anchor rules in `02` §7.2/§10 (what counts as strong enough
to select a fact, and what counts as strong enough to be the anchor) are
written from first principles, before any real draft exists. Treat that the
same way enrichment's email-format confidence rules were treated: the a
priori version is a hypothesis, not a settled conclusion. Round 17's
medium/high-only, corroboration-required rule looked reasonable on paper and
was still measurably too strict once checked against real companies (rounds
18–19), discarding genuinely usable single-source cited signal.

During the same manual sample above, in addition to judging the prose, the
user specifically checks whether the anchor gate is doing this in practice —
for example, a lead where research plainly found one clean, cited,
person-binding fact but the draft still landed at `role_segment` or
`structure` resolution because that single source was below the anchor bar.
One or two anecdotal cases are not evidence of a systematic problem; a real
pattern across the small sample is.

If a real pattern appears, the fix is a **user ruling**, not an agent
self-adjustment — exactly the discipline `planning/07-flags.md` already uses
for enrichment (see rounds 17–19 there for the precedent and reasoning
pattern to follow). Log the ruling and its landing spot the same way before
loosening `02` §7.2/§10, and re-run the fixtures in §8 above to confirm the
change didn't also let through decorative or fabricated anchors.

## 10. Observability

### 10.1 Per job

- job ID/kind/state/attempt/latency;
- input fingerprint/revisions (hash only);
- exact model/prompt/schema/asset versions;
- provider request ID;
- web search requests;
- input/output/cache-create/cache-read tokens;
- reserved/actual USD;
- retry/error category;
- packet validation/lint codes;
- source/fresh-source counts;
- identity/resolution classification.

Never log names, email addresses, subject/body, full prompts, raw source
quotes, or API keys.

### 10.2 Per workspace/run

- total/classification counts;
- time to first draft;
- time to 50%/100% generated;
- research/write/rewrite latency distributions;
- retries/rate-limit events;
- needs-human reasons;
- mailbox valid/pending/invalid/unknown counts and Leads-mode promotions;
- AgentMail verification latency/provider errors;
- unverified-leads CSV downloads;
- failed reasons;
- approval/edit/rewrite counts;
- average rewrite count;
- export blockers;
- searches/tokens/cache-hit rate/cost;
- company-context reuse count;
- stale/superseded job count.

### 10.3 Quality-adjacent objective metrics

- selected facts with valid citations: target 100%;
- model jobs started for non-mailbox-valid email: target 0%;
- stale email-verification result committed after address edit: target 0%;
- person facts with verified identity: target 100%;
- why-now facts with acceptable date/freshness: target 100%;
- hard-lint failure reaching ready state: target 0%;
- rewrite causing research call: target 0%;
- approved stale content: target 0%;
- duplicate recipient export: target 0%;
- lost autosave under tested failures: target 0%;

Do not optimize proxy metrics such as person-level resolution rate at the cost
of honesty. More low-resolution drafts can be correct.

### 10.4 Operational dashboard

Use existing dashboard grammar:

- compact stat tiles for active jobs, failure rate, time to first draft, spend;
- drill-down rows for failures/attention;
- separate semantic colors for success/warning/error;
- no static count without detail;
- PII redacted.

## 11. Cost model

Current official pricing reviewed 2026-07-15:

- Claude Sonnet 5 through 2026-08-31: `$2 / MTok` base input,
  `$10 / MTok` output;
- starting 2026-09-01: `$3 / MTok` input, `$15 / MTok` output;
- web search: `$10 / 1,000` = `$0.01` per successful search;
- cache read: 0.1× base input;
- 5-minute cache write: 1.25×;
- 1-hour cache write: 2×;
- current Sonnet tokenizer may produce roughly more tokens than prior models,
  so estimates must be calibrated from actual usage rather than old token
  assumptions.

Illustrative per-lead planning range (not a guarantee):

### Research

- 2–3 searches: `$0.02–$0.03`;
- approximately 8k–15k billed input/search-result tokens;
- approximately 1k–2.5k output/report tokens;
- rough current total: `$0.05–$0.09`.

### Initial writing

- cached static skill/positioning plus dynamic sender/packet;
- approximately 6k–12k effective input and 400–1,200 output;
- rough current total: `$0.01–$0.04`, depending on cache hit.

### Total

- typical initial lead: roughly `$0.06–$0.13` before September pricing;
- use `$0.08–$0.16` as a conservative UI planning band until telemetry
  replaces assumptions;
- 25 leads: roughly `$2.00–$4.00`, plus user-requested rewrites/rare repairs.

Every start response must compute from current configured pricing and measured
rolling token distributions, with a conservative cold-cache first item.

## 12. Cost controls

Hard:

- max three research searches per initial lead;
- zero searches on write/repair/rewrite;
- bounded output tokens per call;
- one automatic repair maximum;
- bounded provider retries;
- atomic per-run and org-daily budget reservation;
- stop claims when ceiling is reached;
- explicit user action for retry/rewrite;
- exact usage accounting from provider response.

Efficiency without quality loss:

- prompt-cache immutable skill/positioning prefix;
- reuse exact same-domain company facts inside workspace;
- no re-research on rewrite;
- no web search for email discovery;
- no model call for eligibility, state, counters, exports, or lint;
- do not pass discarded/raw source content to writer;
- keep strict packet concise.

Implemented bounded-reuse constants:

| Control | Constant / contract |
|---|---|
| Company singleflight | Exact lowercased non-generic email domain within one workspace; never company-name-only. Postgres owner heartbeats run during provider calls, with takeover 15 minutes after heartbeats stop. |
| Company QA verdict cache | Positive verdicts only; original per-claim QA timestamp propagates across reuse and expires after 72 hours. Exact evidence, temporal metadata, adversarial model, prompt version, or cache-policy changes cause a miss. Person/identity verdicts never reuse. |
| Pre-QA filtering | Deterministically unwritable claims are removed before adversarial QA; temporal disputes remain so QA can establish duration support. |
| Reused research protocol | At most 2 provider calls; automatic search turn uses `max_tokens=4096`; the reserved forced report uses `max_tokens=8192`. |

Do not:

- downgrade first-pass judgment/writing to a cheaper model without user-
  validated quality evidence;
- reduce source requirements to hit a cost target;
- silently stop at one search when identity remains ambiguous;
- batch unrelated people into one research prompt;
- use the Batch API for interactive drafting because first-draft latency and
  progressive review matter more than a discount.

## 13. Security threat model

### Prompt injection

- web content explicitly untrusted;
- search tool only in researcher;
- researcher can only report strict data;
- writer receives validated packet, not raw web pages;
- no tool can send/write files/email;
- application validates facts/sources independently.

### Broken object authorization

- every app request scopes through campaign owner;
- item/draft/profile UUID alone never authorizes;
- foreign resources return not found;
- integration tests cover all routes.

### Secret leakage

- provider/database/Inngest keys server-only;
- prompts/assets never in client bundle;
- errors/logs redact headers/provider responses;
- no `NEXT_PUBLIC_*` drafting secret.

### XSS/content injection

- generated/user email is plain text;
- React text rendering only;
- no `dangerouslySetInnerHTML`;
- source URLs validate HTTP(S), render with safe external link attributes;
- CSV/Markdown escaping and formula preflight.

### SSRF

- prefer Anthropic server web search; no arbitrary application fetch.
- If citation re-fetch is added, reuse existing SSRF protections: public DNS
  only, protocol allowlist, redirect revalidation, response size/time limits,
  no credentials.

### Accidental sending

- no endpoint/provider/credential;
- disabled UI control;
- Cowork export says create drafts, never send;
- test route map for absence.

### Privacy/data minimization

- provider receives only one lead's necessary business context;
- no full campaign sheet in a model call;
- no unrelated CRM/contact rows;
- no draft bodies in logs/analytics;
- owner-scoped exports with no-store.

## 14. Reliability service objectives

Initial measurable targets:

- start API p95 < 1.5 seconds excluding event transport;
- time to first draft reported, target established after manual telemetry;
- 99.9% no-lost-job under duplicate/drop/retry integration scenarios;
- 100% state reconstructable after page refresh;
- 0 duplicate current jobs for one idempotency key;
- 0 stale provider result commits;
- 0 approved hard-lint failures;
- 0 export rows with unapproved/non-mailbox-valid content;
- autosave acknowledgement p95 < 1 second under normal network;
- all transient failures visible and retryable without losing completed work.

Do not promise live provider latency; report it honestly.

## 15. Launch checks

Before enabling `DRAFTING_MODE=live`:

1. canonical assets committed, hashes verified, extract human-reviewed;
2. sender profile flow complete;
3. all schema/state/API/unit/integration/browser tests pass offline;
4. provider stub proves exact search/write/rewrite call counts;
5. AgentMail stub proves exact verify/promote/non-promote call counts and test
   bootstrap cannot instantiate the live client;
6. owner-scope security tests pass;
7. Send endpoint absence verified;
8. Vercel/Inngest duration and signing configuration verified;
9. concurrency/budget env values set;
10. current model/tool IDs verified against official docs and SDK types;
11. current price table updated;
12. prompt caching usage visible;
13. reconciler tested with dropped verification/model events;
14. operational telemetry/redaction reviewed;
15. manual user test plan limited to 1–2 newly uploaded campaign leads;
16. user, not agent, clicks Go to Drafting/Approve for drafting for that live
    sample;
17. user evaluates research/email with rubric and decides whether to expand.

## 16. Rollback

Feature flag the Draft tab/server start:

- turning off prevents new drafting runs/provider claims;
- existing drafts remain readable/exportable only if policy allows;
- pending jobs become paused/cancelled, not deleted;
- no schema destructive rollback;
- assets/models remain versioned for audit;
- rollback cannot expose Send.

Provider/model prompt changes deploy behind version selection for new jobs.
If a regression appears, pin new runs back to the prior approved prompt/model
while preserving current user edits and approvals.
