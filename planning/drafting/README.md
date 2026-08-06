# Drafting system plan

This directory is the build specification for the drafting functionality that
follows lead enrichment. It extends the original enrichment plan without
changing the two permanent safety rules:

1. paid work is human-triggered and scoped to the campaign leads the user is
   actively handling; and
2. the local contact/company database remains a reactive lookup source, never
   a population to sweep, backfill, or draft against.

The implementation target is a continuous drafting workspace, not a sequence
of gated product phases. Clicking **Go to Drafting** is the authorization
boundary for campaign leads present in that returned cohort. Only leads whose
current effective address has `email_verification='valid'` may enter research
and drafting. Every other lead stays in the adjacent **Leads** mode for
correction, AgentMail verification, CSV download, or removal from the
campaign. A pending verification that becomes valid may enter drafting under
the existing visible authorization/budget; a manually corrected row uses its
own explicit **Approve for drafting** action. Finished drafts become
reviewable as soon as each one lands. Leads added after the click require
another explicit start action. The user never waits for an entire batch
barrier.

## Authoritative inputs

The drafting behavior is controlled by two seeded source assets:

- `outreach brain/first-contact-outreach-v5.md`: the verbatim writing skill.
  This is the writing authority. Its five readings, sender-fact rules,
  resolution discipline, vendor-pattern bans, prose bans, and strip pass are
  not to be paraphrased away.
- `outreach brain/EmbarkOverview_Detailed (5).pdf`: the sender-side source of
  truth for Embark's positioning, capabilities, supported offices/industries,
  differentiators, and nationwide footprint.

Both files are currently untracked and have fragile names. Implementation must
copy them into a committed, build-safe asset location with normalized names,
record SHA-256 hashes in a manifest, preserve the originals, and fail closed if
the bytes/text no longer match the approved manifest. See
[02-research-and-writing-architecture.md](02-research-and-writing-architecture.md).
That asset set also includes a versioned capability catalog whose IDs and
allowed summaries map one-to-one to exact PDF lines; implementers do not
invent capability IDs or marketing claims.

## Product outcome

For each campaign lead, the system will:

1. determine whether `email`, `name`, `company`, `title`, and `location` are
   populated and whether the current effective email has a mailbox
   verification result of exactly `valid`;
2. surface every non-draft-ready campaign lead in Leads mode for
   campaign-scoped inline correction, explicit AgentMail verification,
   unverified-leads CSV download, or removal from the campaign;
3. assemble a cited, freshness-aware research packet about the correct person,
   their company, their professional world, and the honest reason Embark might
   contact them;
4. pause for a human when identity, freshness, prior-contact context, or
   sender-side facts materially conflict;
5. write one subject and one plain-text email from the immutable skill,
   positioning source, sender profile, lead snapshot, relationship context,
   and approved research packet;
6. deterministically lint the result against the skill's hard bans and repair
   once without repeating web research;
7. show generation progress as current latest drafts divided by all
   mailbox-valid campaign leads and say **All valid emails drafted** at 100%;
8. make the current draft available in Email mode's one-at-a-time review
   experience as soon as it is ready;
9. support browse, explicit edit mode, hard-overwrite autosave, approve, and
   deny-and-rewrite while keeping only the current email content;
10. keep the fourth email action, **Send**, visibly disabled and provide no
    sending endpoint;
11. export all approved, mailbox-valid drafts as a mail-ready CSV and as a
    Claude Cowork draft-creation prompt.

## Non-goals

- Sending email from the application.
- Automatically approving research quality or email quality.
- Drafting against stored contacts that were not brought into the campaign by
  the user's upload/review workflow.
- Re-running lead enrichment as part of drafting.
- Researching or drafting an address whose current mailbox verification is
  pending, invalid, risky, accept-all, unknown, absent, or anything other than
  exactly `valid`.
- Treating an email-format guess as deliverable.
- Inferring sender facts from a user's email, title, geography, or campaign.
- Preserving historical copies of email bodies or subjects.
- Producing multiple stylistic variants per lead.
- Building a generic autonomous-agent platform.
- Adding a paid third-party enrichment provider in this release.
- Letting a full batch barrier delay the first available draft.

## Decisions made by this plan

### 1. Preserve the successful Cowork shape, add production safeguards

The core remains one capable model with general web search and inline
judgment. It is not decomposed into many specialized agents. Production adds
only the safeguards that Cowork performed informally:

- identity resolution and freshness classification;
- source-family independence and conflict detection;
- a durable, cited research packet;
- explicit human-pause states;
- a separate no-search writing call so rewrites reuse research;
- deterministic post-generation validation;
- idempotent jobs, owner scoping, and cost accounting.

### 2. Separate research from writing

The first model call researches and reports a strict packet. A second model
call writes from that packet without web tools. This is required because
**Deny and try again** must rewrite the email without paying for or changing
the underlying research. The split also makes factual grounding inspectable.

### 3. Use Claude Sonnet for both judgment-heavy calls

Research identity/freshness judgment and final prose both use the pinned
Sonnet-class model that matches the successful Cowork behavior. Haiku is not
used for first-pass research, writing, or quality approval. Model IDs live in
`lib/models.ts` and must be pinned to an immutable ID available at build time,
not silently drift through an alias.

### 4. Do not mutate shared lead truth from Drafting

Inline fixes on the Drafting page are campaign/drafting-workspace overrides.
They update the current drafting input and export, but they do not silently
change the global `outreach.leads` record used by other campaigns. This avoids
cross-campaign corruption and race conditions with enrichment. A future
explicit “promote correction to lead record” action can be designed
separately.

### 5. Mailbox-valid is the drafting gate

The five required fields still decide whether the writer has enough context,
but mailbox verification is now an earlier hard gate for research, drafting,
and export.

- Only an effective email bound to `email_verification='valid'` may queue
  research or writing, regardless of whether its origin is direct, inferred,
  uploaded, database-reused, or manually entered.
- `pending`, `invalid`, `accept_all`, `risky`, `unknown`, null, malformed, and
  missing addresses stay in Leads mode and never enter the drafting
  denominator until they become `valid`.
- A manually entered address records human provenance. **Approve for
  drafting** runs one AgentMail probe; the row moves automatically only if the
  result is `valid`.
- The current AgentMail implementation calls no bounce inside its bounded
  observation window `valid`. Drafting uses that persisted product status
  exactly; it does not claim this guarantees zero future bounces.

### 6. “Remove” removes the campaign association

Leads mode uses **Remove from campaign**, not the old reversible drafting-only
Ignore. After confirmation, one transaction deletes the
`outreach.campaign_leads` association, cancels/supersedes that item's pending
drafting/verification jobs, and excludes it from all workspace counts and
exports. The shared `outreach.leads` entity remains available for reactive
identity lookup and future uploads; removal never deletes or enriches the
global person row.

### 7. The review counter is made unambiguous

The prompt's proposed `x out of n` definition contradicts itself. The product
will show:

- **Reviewed X of Y generated** on the email card, where `X` is the number of
  latest drafts currently approved and `Y` is the number of latest drafts
  currently available (`ready_for_review + approved`);
- a top generation bar of **drafted / mailbox-valid campaign leads**, with
  **All valid emails drafted** when those values match;
- separate workspace counts for mailbox-valid, queued/running, generated,
  approved, verifying, needing lead attention, needing human research
  resolution, and failed.

A denied draft immediately enters `rewriting`, is no longer counted as
reviewed, and re-enters the generated denominator only when its replacement is
ready. Browsing never changes review status.

To preserve the brief's sense that denial is still productive review work, a
separate session-local **Decisions made** pulse increments for Approve and
Deny. It is motivational feedback only and never drives completion/export.

### 8. Cowork export recreates approved drafts verbatim

The markdown export does not invite Cowork to independently research or
rewrite already approved content. It instructs Cowork to create one mail
draft per record with the exact recipient, subject, and body, never to send.
This prevents a second model from silently undoing the user's review. A future
“research packet for independent redrafting” export is outside this release.

### 9. Poll database state; do not expose queue internals

The current app already polls Postgres-backed APIs. Drafting follows the same
reliable pattern at two seconds while active, slows when idle, and refreshes
immediately after local actions. Inngest transports work; Postgres remains the
state authority.

### 10. No release-stage gates

The work is organized into parallel workstreams with explicit dependencies,
not milestone gates. The implementation must deliver the complete target
described here. Offline tests and acceptance criteria verify behavior, but
they do not define partial product phases or require the user to wait through
serial product stages.

## Read order

1. [01-product-and-ux-spec.md](01-product-and-ux-spec.md) — exact user journey,
   review behavior, counters, actions, accessibility, and edge states.
2. [02-research-and-writing-architecture.md](02-research-and-writing-architecture.md)
   — source assets, research policy, packet schema, Claude calls, grounding,
   prompts, rewrites, and deterministic linting.
3. [03-data-model-and-state.md](03-data-model-and-state.md) — tables,
   constraints, snapshots, state machines, indexes, and concurrency rules.
4. [04-jobs-api-and-runtime.md](04-jobs-api-and-runtime.md) — Inngest events,
   functions, idempotency, routes, authorization, polling, and failure
   recovery.
5. [05-export-contracts.md](05-export-contracts.md) — mail-ready CSV,
   unverified-leads CSV, and Claude Cowork markdown contracts with exact
   inclusion and formatting rules.
6. [06-quality-reliability-cost.md](06-quality-reliability-cost.md) — offline
   tests, manual evaluation, observability, security, cost model, budgets, and
   launch checks.
7. [07-implementation-workstreams.md](07-implementation-workstreams.md) —
   file-level implementation map, dependency graph, and complete build
   checklist without gated phases.

When these drafting docs conflict with the original enrichment docs, these
docs govern drafting only. The enrichment deep specs remain authoritative for
extraction, identity enrichment, email discovery, and verification. Existing
settled enrichment decisions must not be reopened accidentally.

## Runtime safety boundary

No live Claude or web-search call is authorized by opening or refreshing a
page. Paid drafting work begins only from an explicit user action:

- **Go to Drafting** / the Draft tab action starts or resumes work for the
  explicit owned campaign cohort returned by that action, but queues only
  mailbox-valid, complete rows;
- a trailing enrichment verification that becomes valid may queue a
  previously authorized cohort item under that run's existing budget;
- **Approve for drafting** on a Leads row saves its fields, authorizes one
  AgentMail probe when needed, and authorizes drafting that row only after a
  valid result;
- **Deny and try again** explicitly authorizes one no-search rewrite;
- a visible Retry action explicitly requeues a failed job.

GET requests, polling, browsing, export previews, page restoration, test runs,
and agent-driven development never start paid work.

## Definition of complete

Generation is complete when every current, campaign-associated
mailbox-valid lead has a current latest draft. At that point the page says
**All valid emails drafted**, even if Leads mode still contains invalid,
unknown, pending, or missing-email rows.

Review/export is complete when all of the following are true:

- no mailbox-valid campaign lead remains incomplete, budget-paused, queued,
  researching, writing, repairing, rewriting, failed, or in a human-conflict
  state;
- every mailbox-valid campaign lead has a current latest draft and that draft
  is approved;
- no approved draft is stale relative to its current input fingerprint;
- export preflight passes for every included mailbox-valid recipient.

Non-valid Leads rows do not block export of the approved valid subset; they
remain explicitly visible behind the Leads indicator and in the unresolved-
leads CSV until corrected or removed. Only when review/export completion
passes are final draft exports promoted as the primary action. Editing an
approved draft returns it to unreviewed and removes review-complete status
until it is approved again.
