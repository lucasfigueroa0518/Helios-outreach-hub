# Research and writing architecture

> **What this file is:** Behavioral architecture for Outreach Hub research, evidence validation, and email writing.
> **Source of truth:** The tracked Eva implementation and `@docs/modules/outreach-hub.md` win when this local reference differs.
> **How Cursor should use it:** Read before changing Outreach research packets, temporal policy, writer grounding, or lint.

## Table of Contents

- [1. Architectural position](#1-architectural-position)
- [2. Source assets and prompt integrity](#2-source-assets-and-prompt-integrity)
- [3. Sender packet](#3-sender-packet)
- [4. Research objective](#4-research-objective)
- [5. Research input](#5-research-input)
- [6. Search plan](#6-search-plan)
- [7. Source policy](#7-source-policy)
- [8. Identity resolution](#8-identity-resolution)
- [9. Temporal relevance and lifecycle policy](#9-temporal-relevance-and-lifecycle-policy)
- [10. Significance and resolution](#10-significance-and-resolution)
- [11. Research packet contract](#11-research-packet-contract)
- [12. Application-side packet validation](#12-application-side-packet-validation)
- [13. Human resolution](#13-human-resolution)
- [14. Writer input and prompt](#14-writer-input-and-prompt)
- [15. Writer output contract](#15-writer-output-contract)
- [16. Deterministic skill lint](#16-deterministic-skill-lint)
- [17. Automatic repair](#17-automatic-repair)
- [18. User-requested rewrite](#18-user-requested-rewrite)
- [19. Accuracy invariants](#19-accuracy-invariants)
- [20. What to learn from the enrichment architecture](#20-what-to-learn-from-the-enrichment-architecture)

## 1. Architectural position

The successful Cowork behavior should be preserved:

- one capable model understands the whole situation;
- it can use general web search;
- it decides what is load-bearing versus decorative;
- it writes from a deep sociology-first skill rather than a sales template.

Production should not replace that with a brittle chain of tiny agents.
Production should make its implicit safeguards explicit and durable.

The per-lead pipeline is therefore:

```text
campaign-scoped input snapshot
  → deterministic required-field + mailbox-valid eligibility gate
  → one Sonnet research call with ≤3 web searches
  → strict, cited research packet
  → deterministic evidence/identity/freshness gates
  → human resolution only when materially ambiguous
  → one Sonnet writing call without web tools
  → deterministic skill lint
  → at most one automatic no-search repair
  → current draft persisted for human review
```

Research and writing are separate calls because a denied draft must be
rewritten without changing or repurchasing research.

## 2. Source assets and prompt integrity

### 2.1 Canonical asset layout

Implementation creates a committed build-safe directory:

```text
resources/drafting/
  first-contact-outreach-v8.md
  embark-positioning-v1.pdf
  embark-positioning-v1.txt
  embark-capabilities-v1.json
  manifest.json
```

- Copy, do not silently move/delete, the seeded originals.
- `first-contact-outreach-v8.md` is byte-for-byte the approved skill.
- `embark-positioning-v1.pdf` is byte-for-byte the approved two-page PDF.
- `embark-positioning-v1.txt` is a human-reviewed transcription/extract of the
  PDF used for deterministic prompt injection.
- `embark-capabilities-v1.json` is the closed capability/outcome catalog used
  by research packet validation. Every entry points to exact source text/page
  in the PDF.
- `manifest.json` records version, SHA-256, byte size, source filename,
  approved timestamp, and the SHA-256 of normalized extracted text.

The app reads these through a server-only asset loader. A build test verifies
the files exist and hashes match. A mismatch is a deployment error, not a
reason to fall back to an old prompt.

### 2.2 Why use reviewed text rather than re-read the binary every time

The PDF is visually heavy (about 1.7 MB for two pages) but its usable sender
facts are compact. Sending the binary on every call adds latency, visual token
cost, bundling risk, and extraction variance. The PDF remains canonical
evidence, while its reviewed text extract is the runtime representation.

The extract must preserve, without embellishment:

- Embark is not a CPA firm;
- strategic finance and business transformation positioning;
- Big 4 alumni and seasoned industry leaders;
- NPS claim exactly as written;
- audit/IPO, finance operations, technology/data, and scale outcomes;
- all listed solution families and items;
- all listed executive audiences and industries;
- nationwide/hybrid/on-site footprint;
- each stated differentiator.

No client example, customer count, engagement result, local-office claim,
named reference, or sender biography may be added unless supplied through a
separate approved sender asset.

Extract acceptance is deterministic and human-reviewed:

1. a test enumerates every positioning paragraph, differentiator, solution,
   executive audience, industry, outcome, and geography statement from PDF
   pages 1–2;
2. every item must have an exact normalized text match in the `.txt` extract;
3. every capability catalog entry must map to an exact matched source item;
4. no catalog `allowed_summary` may introduce a noun, geography, client type,
   result, or claim absent from that source item;
5. a human approves the first extract/catalog diff before live mode;
6. PDF/text/catalog hashes are all recorded in the manifest.

### 2.3 Capability catalog

Schema:

```ts
type EmbarkCapability = {
  id: string;
  category:
    | 'strategic_finance_advisory'
    | 'operations_transformation'
    | 'technology_innovation'
    | 'internal_controls_risk';
  label: string;
  exactSourceText: string;
  sourcePage: 1 | 2;
  allowedSummary: string;
};
```

Closed v1 IDs:

```text
financial_reporting_advisory
pe_vc_portfolio_company_advisory
office_of_the_cfo
valuation
capital_markets
esg_sustainability
deal_advisory
interim_finance_leadership
m_and_a_activity
digital_transformation
human_capital_transformation
supply_chain_operations
project_change_management
outsourcing
team_continuity
embedded_project_execution_support
data_analytics_automation
generative_ai
technology_enablement
internal_controls_risk_management
```

The catalog may also list the four PDF outcomes (`prepare_for_audits_and_ipos`,
`optimize_financial_operations`, `modernize_tech_and_data`,
`scale_with_confidence`) as `supportedOutcomes`, separate from capabilities.
Research maps recipient context to IDs; it never writes a new Embark claim.

### 2.4 Asset version snapshots

Every drafting run records:

- `skill_version` and `skill_sha256`;
- `positioning_version`, PDF hash, and text hash;
- sender profile revision/hash;
- research prompt version;
- research packet schema version;
- writer prompt version;
- writer output schema version;
- exact model IDs.

Changing any source asset does not silently mutate existing approved drafts.
New work uses the new active version. Existing unapproved work becomes stale
only if the change is explicitly marked breaking by the asset manifest.

### 2.5 Skill hierarchy

Prompt hierarchy:

1. security and factual-grounding rules;
2. the verbatim first-contact skill;
3. the Embark positioning source;
4. approved sender profile;
5. lead/relationship input snapshot;
6. cited research packet;
7. task-specific output schema.

Web content is always data, never instructions. A source that says “ignore
previous instructions” is treated as hostile text and cannot alter this
hierarchy.

## 3. Sender packet

The skill requires a sender, not only a firm. A durable sender profile is
therefore mandatory before the first email can be produced.

Required:

- display name;
- work email;
- current title/role at Embark;
- minimal signature choice (`name` or `name + orienting role`);
- timezone/market only for scheduling/contact-form calibration, never as a
  claim about Embark's footprint.

The ask in each email is chosen from research (recipient contact norms) and
the writing skill, not from a sender-profile preference list.

Optional, user-supplied:

- natural voice notes;
- former firm, school, or professional tribe that may be used when true;
- seniority/status context;
- topics the sender can personally stand behind;
- prohibited claims or sensitivities.

The system never infers these from email local-part, user geography, campaign
name, or Embark's firm PDF. The profile is reviewed once, stored server-side,
and copied into the run snapshot so later profile edits cannot alter an
in-flight prompt.

A warm-introduction posture is permitted only when the per-lead item contains
an explicit supplied introducer and connecting context. `Last Contacted By`,
connection degree, or `Previously connected` alone never manufactures an
introduction.

## 4. Research objective

Research is not “find a recent fact.” It must answer the skill's five readings
at the highest honest resolution the evidence supports:

1. **Prospect's world** — pressures, constraints, register, contact norms, and
   the vendor mail against which this note will be sorted.
2. **Sender's position** — supplied, not researched.
3. **Status geometry** — peer/junior/senior/unknown relation between this
   sender and recipient.
4. **Structural relation** — the plausible relationship between the
   recipient's world and one supported Embark capability.
5. **Reason and resolution** — why this recipient, now, from this sender;
   person > company > role/segment > moment > structure only when honestly
   supported and significant.

Research should be deep enough to prevent generic outreach, but small enough
to avoid accumulating decorative facts. Two or three well-directed searches
are the default.

## 5. Research input

Each job receives an immutable `DraftingResearchInput`:

```ts
type DraftingResearchInput = {
  draftingItemId: string;
  inputFingerprint: string;
  lead: {
    fullName: string;
    firstName: string;
    title: string;
    company: string;
    workLocation: string;
    email: string;
    linkedinUrl: string | null;
    emailStatus: string;
    emailDecisionReason: string;
  };
  relationship: {
    pastWork: string | null;
    priorRelationshipActivity: string | null;
    lastContacted: string | null;
    lastContactedBy: string | null;
    reusedFromPriorLead: boolean;
  };
  connectingContext: {
    mode: 'cold' | 'previously_connected' | 'warm_introduction' | 'unknown';
    introducerName: string | null;
    suppliedContext: string | null;
    linkedinConnectionDegree: string | null;
    rawCrmIndicator: string | null;
  };
  provenance: {
    profileEnrichment: Record<string, unknown>;
    emailProvenance: Record<string, unknown>;
    sourceRunId: string | null;
  };
  senderSnapshot: SenderSnapshot;
  capabilityCatalog: EmbarkCapability[];
  priorHumanResolution: HumanResolution | null;
};
```

Email address is context/export data, not a search target. Drafting research
does not repeat enrichment's email-discovery waterfall. The provider cannot be
called unless the effective address in this snapshot is bound to a current
`email_verification='valid'` result. Pending, invalid, unknown, risky,
accept-all, missing, and malformed addresses stay in Leads mode.

### 5.1 Enrichment-sourced preflight evidence

`provenance.profileEnrichment` and `provenance.emailProvenance` are not opaque
blobs the researcher merely glances at. Where the source enrichment run
already passed its own two-independent-source triangulation gate for a field
and that finding is still active under
[Temporal relevance and lifecycle policy](#9-temporal-relevance-and-lifecycle-policy),
structure it into one or more pre-formed `ResearchFact` entries — with the
same source IDs, quotes, and family metadata enrichment recorded — and hand
them to the researcher as already-corroborated seed evidence rather than
nothing.

This is the same "local-first" principle (round 3) applied one layer up, and
the direct-email upgrade's "preflight before paid work" principle (round 14):
never make a new paid search rediscover a fact this system already paid for
and verified. Concretely:

- a seed fact still needs to clear the exact same trust-tier/family/freshness
  rules as a freshly researched one before it can become an `anchor`;
- the researcher may spend its search budget on what is still open (the
  reason-for-contact and status-geometry readings, which enrichment never
  attempted) instead of re-confirming a still-fresh title/company/location;
- a seed fact that is stale, was rejected/blank in enrichment, or conflicts
  with a fresh search result is discarded, not preferred by default;
- seeding never raises `leadIdentity.classification` by itself; it only
  removes duplicate work when the classification would have been reached
  anyway.

Relationship data is point-in-time context. The model must not embellish
`Previously connected` or `Work done` into a named engagement without
specific supplied evidence.

Deterministic caution mapping:

| Input signal | Drafting consequence |
|---|---|
| `email_verification != valid` | research/writing prohibited; Leads mode only |
| `email_status=inferred/format_guess` with mailbox `valid` | no prose implication; origin remains provenance only |
| relationship within six months | never call the note cold; surface prior-contact context |
| `Previously connected` / last contacted by known colleague | lower warmth assumptions; do not claim an introduction |
| explicit introducer + context | warm-introduction reading required |
| connection degree, if uploaded | context only; never infer relationship quality |
| undefined raw CRM flag such as `In CRM: Yes` | human pause until meaning is supplied |
| past-lead reuse | freshness caution; verify current role/company |

## 6. Search plan

### 6.1 Default searches

The research prompt instructs Claude to use two searches and a third only when
needed:

1. **Identity and freshness**
   - exact person name + company + title/location;
   - supplied professional-profile URL when present;
   - current employer/title evidence;
   - detect same-name collisions.
2. **Company/role/world and current reason**
   - company + recipient function + a recent transition, filing, initiative,
     transaction, planning pressure, or structural constraint relevant to an
     approved Embark capability;
   - prefer significance over novelty.
3. **Resolution/verification follow-up**
   - resolve identity/date/source conflict;
   - corroborate the best potential anchor;
   - chase a meaningful source, not another generic result.

The model may change the literal query because search quality depends on what
the first results reveal, but it may not exceed the tool's hard `max_uses`.

### 6.2 Claude web-search configuration

At implementation time, upgrade `@anthropic-ai/sdk` to the current compatible
release and type-check the chosen server tool. Current official documentation
reviewed for this plan (2026-07-15) lists:

- `web_search_20260318` as GA;
- `max_uses` as the hard search cap;
- `allowed_callers: ["direct"]` for direct search rather than programmatic
  code-filtering;
- `response_inclusion: "full"` to retain raw search result/citation blocks;
- citations always enabled for web search;
- `$10 / 1,000` searches plus token cost.

Proposed tool:

```ts
{
  type: 'web_search_20260318',
  name: 'web_search',
  max_uses: 3,
  allowed_callers: ['direct'],
  response_inclusion: 'full'
}
```

Use direct search because only two or three results-driven searches are
needed, and full citation retention is more valuable than dynamic filtering.
If SDK/model compatibility makes the newer version unsafe, retain the current
`web_search_20250305` basic tool until a tested upgrade; do not cast away type
errors or silently change behavior.

Do not use `allowed_domains` globally. The relevant authoritative domains vary
by person/company. Use source-ranking and post-validation instead. Block known
malicious/irrelevant hosts only after observing concrete abuse, because
professional-profile snippets can be useful disambiguation leads even when
not final evidence.

### 6.3 Parallelism

Parallelism occurs at the job level: many independent leads research
concurrently under an org-wide limit. Within one lead, the server tool manages
its own search sequence. Do not build a client-side fan-out that sends three
blind queries and then asks another model to reconcile; the adaptive second
and third query are part of the quality seen in Cowork.

### 6.4 Same-company reuse

Within one drafting workspace, a completed company-context packet may be
provided as prior evidence to later leads at the exact same resolved company
domain. It can save duplicate company searching, but:

- it is supplemental, not authoritative identity evidence;
- each person still gets a person/freshness search;
- the packet is keyed by resolved domain and research date, never fuzzy name;
- person facts are never shared;
- why-now anchors older than the freshness window are not reused;
- conflicts force fresh research;
- usage accounting records cache reuse;
- a hit is recorded on the consuming packet's `companyContextProvenance`
  (§11) and surfaced in the research drawer as reused-within-workspace —
  never rendered as if this person's company facts were freshly researched.
  Reused evidence must stay visibly labeled as reused, never disguised as
  freshly researched.

No cross-database sweep is performed. Reuse occurs only while processing a
specific uploaded campaign lead.

## 7. Source policy

### 7.1 Source families

Treat mirrored/syndicated copies as one source family. Families:

- first-party company site;
- first-party personal/professional site;
- regulator/government/filing;
- professional profile;
- professional association/conference;
- company press release/newsroom;
- reputable independent news;
- portfolio/investor/parent-company page;
- data broker/aggregator;
- social post;
- other.

Two pages copying the same press release are not independent corroboration.

### 7.2 Trust tiers

High:

- official company leadership/team page;
- regulator or filing;
- direct company/person announcement;
- current professional profile clearly belonging to the person.

Medium:

- professional association or conference bio;
- reputable news;
- investor/portfolio page;
- credible trade publication.

Low/lead-only:

- data brokers;
- scraped directory pages;
- undated snippets;
- unverified social reposts;
- search-result claims with no accessible source context.

Low sources may suggest a query. They cannot alone establish identity,
current employment, or the anchor used in prose.

### 7.3 Required evidence

Every factual research item must include:

- stable fact ID;
- normalized claim;
- source IDs;
- short quote/snippet;
- source family;
- URL and title;
- published/updated date when available;
- accessed timestamp;
- whether the quote names/binds the person;
- confidence (`supported`, `tentative`, `conflicted`);
- freshness (`current`, `recent`, `undated`, `stale`, `conflicted`);
- intended weight (`anchor`, `seasoning`, `discard`);
- concise reason for its weight in the recipient's world.

The model cannot select a fact as `anchor` unless it is supported and passes
freshness/significance gates.

## 8. Identity resolution

Identity resolution answers a narrow question: do the search results refer to
the supplied person at the supplied company now?

### 8.1 Signals

- exact normalized name;
- supplied professional-profile URL;
- employer/domain;
- title/function;
- explicit work location;
- career chronology;
- first-party bio or press release;
- matching distinctive credentials.

### 8.2 Classifications

`verified`

- at least two independent source families bind the person to the current
  company, with one high-trust/person-specific source; or
- an exact supplied professional-profile URL binds current company/title and
  a second independent source corroborates the employer.

`usable_at_lower_resolution`

- only one high-trust exact identity source exists;
- no competing person or fresh contradiction exists;
- person-specific facts are prohibited;
- writing may use company/role/segment/structure resolution.

`ambiguous`

- multiple plausible people remain;
- source result cannot be bound strongly enough;
- user resolution required before drafting.

`conflicted`

- strong sources disagree about current employer, title, or location;
- a fresh source contradicts the uploaded lead;
- user resolution required.

`not_found`

- little public footprint and no collision/conflict;
- writing may proceed only at role/company/structure resolution if the lead
  input itself is complete and an honest reason exists.

The app, not the model, enforces which fact types each classification permits.

## 9. Temporal relevance and lifecycle policy

Source publication age never determines event relevance by itself. The system
tracks the underlying event window and computes lifecycle against the server
clock.

| Policy constant | Value |
|-----------------|-------|
| Policy version | `outreach-timeliness-v2` |
| Research packet schema | `2` |
| Research packet lifetime | 72 hours from `asOf` |
| Allowed clock skew | 1 hour |
| Current-state source age | 365 days maximum |

| Event class | Active days | Post-event days |
|-------------|------------:|----------------:|
| `appointment` | 45 | 0 |
| `short_lived` | 7 | 0 |
| `project` | 180 | 30 |
| `transaction` | 180 | 30 |
| `deadline` | 30 | 0 |
| `conference` | 7 | 7 |
| `announcement` | 90 | 0 |
| `structural` | 365 | 0 |
| `generic` | 30 | 0 |

An explicitly sourced `relevanceEnd` requires bound `durationSourceIds` and
exact `durationEvidence` copied from a bound source quote. An
explicit event end derives relevance through the event-class post-event
allowance. A start-only event may use the bounded class default only with
`durationBasis=policy_default`. Unknown or contradictory windows are blocked.

Lifecycle controls discourse:

- `upcoming` permits `anticipatory`;
- `ongoing` permits `active`, except start-only appointments use
  `retrospective`;
- `recently_completed` permits `retrospective`;
- `structural` permits `current_context`;
- dated `evergreen` permits `current_context` or `timeless`;
- undated `evergreen` permits `timeless`;
- `expired` is omitted.

The packet records `asOf` and relevance windows. Research expires 72 hours
after `asOf`; generation, approval, export, and send re-evaluate against the
server clock. Migration 1127 marks non-v2 packets stale and blocks dependent
drafts until regeneration.

Each email draft durably records `generation_mode` as `live`, `stub`, or
`legacy`. Writer generation, repair, and rewrite store the mode actually used;
manual edits preserve that provenance. Stub drafts may proceed through local
review and approval, but every final draft export rejects `stub` and `legacy`
rows with `NON_LIVE_DRAFT_DELIVERY_BLOCKED`. Only a current live v2 draft is
delivery-eligible.

## 10. Significance and resolution

The model classifies each supported fact:

- `anchor`: a sensible reason for this person to be contacted now;
- `seasoning`: accurate and reader-relevant, but too small to carry the email;
- `discard`: decorative, invasive, stale, generic, or unsupported.

The post-processor rejects:

- an anchor from low-trust-only sources;
- an undated “recent” anchor;
- a personal post/award/biographical detail with no structural relevance;
- a fact whose significance explanation merely says it is personalized;
- a fact that overstates the selected Embark capability.

Resolution output:

```ts
type Resolution =
  | 'person'
  | 'company'
  | 'role_segment'
  | 'moment'
  | 'structure'
  | 'true_zero';
```

Person resolution requires verified identity and a meaningful person anchor.
Company resolution requires a supported company event/transition. Lower
resolutions are not failures; they constrain warmth and implied knowledge.

## 11. Research packet contract

The model finishes by calling strict client tool
`report_drafting_research`. `tool_choice` remains `auto` during the search
turn so forcing the report tool cannot suppress web search. If no report is
returned, a second no-search turn includes the first response and explicitly
requests the strict report tool. If still absent/invalid, the job fails.

Use `strict: true` when supported by the pinned model/SDK. Keep
`additionalProperties: false` throughout. Application validation remains
mandatory even with strict generation.

Conceptual schema:

```ts
type ResearchFact = {
  // Existing identity, claim, source, confidence, freshness, and weight fields.
  temporal: {
    kind: 'event' | 'current_state' | 'evergreen';
    eventClass:
      | 'appointment' | 'short_lived' | 'project' | 'transaction'
      | 'deadline' | 'conference' | 'announcement' | 'structural'
      | 'generic';
    eventStart: string | null;
    eventEnd: string | null;
    relevanceEnd: string | null;
    durationBasis:
      | 'explicit_source' | 'derived_from_event' | 'policy_default' | 'unknown';
    durationSourceIds: string[];
    durationEvidence: string | null;
    discourse: 'current_trigger' | 'ongoing' | 'historical_context' | 'timeless';
  };
};

type DraftingResearchPacket = {
  schemaVersion: '2';
  asOf: string;
  leadIdentity: {
    classification:
      | 'verified'
      | 'usable_at_lower_resolution'
      | 'ambiguous'
      | 'conflicted'
      | 'not_found';
    suppliedSummary: string;
    currentSummary: string | null;
    conflictSummary: string | null;
    supportingSourceIds: string[];
  };
  freshness: {
    employer: FreshnessFinding;
    title: FreshnessFinding;
    location: FreshnessFinding;
  };
  prospectWorld: {
    roleReality: string;
    pressures: EvidenceBackedStatement[];
    contactNorm: {
      form: 'call' | 'meal' | 'reply' | 'introduction_only' | 'unknown';
      statement: string;
      sourceIds: string[];
      confidence: 'supported' | 'tentative';
    };
    registerNotes: string[];
    commonVendorPatterns: string[];
  };
  personFacts: ResearchFact[];
  companyFacts: ResearchFact[];
  roleSegmentFacts: ResearchFact[];
  structuralRelation: {
    relation: 'complementary' | 'adjacent' | 'potential_tension' | 'unclear';
    recipientConstraint: string | null;
    embarkCapabilityId: string | null;
    supportedReason: string | null;
    tensionToName: string | null;
    sourceIds: string[];
  };
  statusGeometry: {
    classification:
      | 'peer'
      | 'sender_junior'
      | 'sender_senior'
      | 'unknown_to_established'
      | 'adjacent_principals'
      | 'uncertain';
    safePosture: string;
    basis: string;
  };
  resolution: {
    level: Resolution;
    selectedFactIds: string[];
    reasonForWriting: string | null;
    whyNow: string | null;
    prohibitedAssumptions: string[];
  };
  resolutionUpgrade: {
    obtainableFact: string | null;
    whyItWouldRaiseResolution: string | null;
    howToObtainWithoutGuessing: string | null;
  };
  companyContextProvenance: {
    origin: 'fresh' | 'reused_within_workspace';
    sourceDraftingItemId: string | null;
    resolvedDomain: string | null;
    validUntil: string | null;
  };
  sources: ResearchSource[];
  humanPause: {
    required: boolean;
    code:
      | 'identity_collision'
      | 'freshness_conflict'
      | 'prior_contact_ambiguity'
      | 'sender_fact_missing'
      | 'source_conflict'
      | 'true_zero'
      | null;
    prompt: string | null;
    options: HumanResolutionOption[];
  };
};
```

No free-form “confidence score” decides safety. Named classifications and
deterministic gates decide it.

## 12. Application-side packet validation

Reject or downgrade packet data when:

- a referenced source ID does not exist;
- a selected fact has no sources;
- a quote is empty or does not support key claim tokens;
- URL is not HTTP(S);
- two sources belong to the same normalized family when independence is
  required;
- a person fact is selected without verified identity;
- a fresh role claim has no fresh/current evidence;
- a why-now claim has no usable date;
- an event has no defensible relevance window or contradictory start/end dates;
- `durationBasis=explicit_source` lacks bound `durationSourceIds`;
- model discourse disagrees with the server-computed lifecycle;
- an Embark capability ID is not in the canonical catalog;
- sender facts appear in web-research claims;
- a source's content attempts to instruct the model/application;
- selected fact count exceeds the small context allowance;
- resolution violates identity/freshness classification;
- a material conflict is summarized but `humanPause.required` is false.

Persist rejected fact metadata for objective telemetry, but never send it to
the writer as usable evidence.

## 13. Human resolution

A human choice creates a small immutable resolution record for the current
input fingerprint:

- chosen supplied/researched identity;
- source IDs explicitly selected;
- fields corrected;
- facts prohibited;
- maximum permitted resolution;
- user ID and timestamp.

“Use supplied context cautiously” allows a no-search writer call only after
the application removes conflicted person facts and caps resolution. Changing
identity fields invalidates the packet and runs fresh research.

Human resolution does not train or globally update the model. Cross-campaign
reuse requires a separately designed evidence policy.

## 14. Writer input and prompt

The writer receives:

- verbatim skill;
- canonical Embark positioning text;
- sender snapshot;
- complete lead snapshot;
- relationship snapshot;
- validated research packet stripped to usable facts;
- explicit prohibited assumptions/facts;
- output schema and hard formatting rules;
- rewrite context when applicable.

The writer has no web tool, database tool, file tool, or sending tool.

Prompt obligations:

1. Perform the skill's five readings using the supplied packet.
2. Write at exactly the permitted resolution.
3. Treat only the positioning/sender blocks as sender facts.
4. Use only selected supported fact IDs for prospect-specific claims.
5. Do not make a fact carry more weight than packet classification allows.
6. Own the commercial reason without a vendor posture.
7. Produce one email, not variants.
8. Use short plain paragraphs and one concrete ask.
9. Apply the complete vendor-pattern and prose strip pass.
10. Output no Markdown, bullets, HTML, calendar link, attachment, or
    unsubscribe apparatus.

### Prompt caching

Place static content first:

1. tool/output schema definitions;
2. security/factual rules;
3. verbatim skill;
4. positioning text.

Use explicit prompt-cache control on the final static block. For a multi-lead
interactive run, use the current supported 1-hour ephemeral TTL when expected
batch duration justifies it. Implementation helpers and the call-site map live
in `docs/prompt-caching.md`. Current official docs state:

- 5-minute writes cost 1.25× base input;
- 1-hour writes cost 2×;
- cache hits cost 0.1×;
- prefix changes invalidate following blocks.

Log cache creation/read tokens. Put dynamic sender/lead/research content after
the cache boundary so it cannot invalidate the shared prefix.

## 15. Writer output contract

Use structured JSON output when supported:

```ts
type DraftOutput = {
  schemaVersion: '1';
  subject: string;
  bodyText: string;
  resolutionUsed: Exclude<Resolution, 'true_zero'>;
  usedFactIds: string[];
  claimLedger: Array<{
    exactText: string;
    factIds: string[];
    claimType: 'prospect_fact' | 'sender_fact' | 'relationship_fact';
    temporalFraming:
      | 'none' | 'anticipatory' | 'active' | 'retrospective'
      | 'current_context' | 'historical_context' | 'timeless';
  }>;
  askForm: 'call' | 'meal' | 'reply';
  checks: {
    reasonClearInFirstThreeSentences: boolean;
    oneIdea: boolean;
    oneReason: boolean;
    oneAsk: boolean;
    noInventedSpecifics: boolean;
    noVendorPattern: boolean;
    noEmDash: boolean;
    noMarketingFormatting: boolean;
    senderFactsFromProvidedSourcesOnly: boolean;
  };
};
```

The UI's optional post-delivery/strengthening note comes only from the
validated research packet's `resolutionUpgrade`. The writer does not generate
a second competing note and cannot invent a proposed fact to obtain.

Do not request hidden chain-of-thought. `resolutionUsed`, fact IDs, exact claim
spans, and check results are concise operational metadata.

Post-validation requires:

- nonempty subject/body;
- subject contains no line break/control characters;
- body is plain text and within configured length ceiling;
- every prose sentence before the signoff has one claim-ledger entry, and each
  `exactText` is the complete verbatim body sentence;
- every fact ID exists and is writer-eligible;
- every prospect sentence framing is permitted by every attached fact's
  server-computed lifecycle;
- resolution matches/cannot exceed packet;
- all hard checks are true;
- ask form is one of `call` / `meal` / `reply` and consistent with the
  packet's contact-norm guidance when that guidance is supported;
- no unknown fields.

These grounding checks apply to model-generated/repaired/re-written output.
After a human manually edits current content, preserve only claim-ledger
entries whose complete `exactText` sentence is unchanged, preserve
`prospectTerms`, and mark the draft `manual_override`. Deterministically add
`temporalFraming: none` entries for benign new or changed sender,
relationship, and ask sentences. Any changed sentence that names or references
the prospect or uses lifecycle language stays ungrounded, so approval and
export fail closed until model rewrite or regeneration. `manual_override`
does not bypass sentence-level temporal or lifecycle validation. Hard
skill/security lint and
input/delivery freshness still apply.

## 16. Deterministic skill lint

Create `lib/drafting/lint.ts` as a pure function. Hard failures include:

- Unicode em dash (`—`) and em-dash HTML/entity equivalents;
- Markdown bullets, numbered value-proposition layout, bold markers, headings;
- HTML tags;
- calendar links;
- testimonial counts and proof links;
- unsubscribe language/apparatus;
- announcing brevity (`I'll keep this brief`, `quick note`, and equivalents);
- long sales-title/signature blocks beyond the sender signature policy;
- multiple subject lines/variant labels;
- banned/giveaway phrases such as:
  - `hope this finds you well`;
  - `hope you're having`;
  - `quick question`;
  - `leading provider/platform`;
  - `I've noticed many companies`;
  - `compare notes`;
  - `happy to share our perspective`;
  - `walk you through`;
  - `is this something you handle`;
  - `who should I speak with`;
  - `let me know what time works best`;
  - `no ask here`;
  - `just wanted to introduce myself`;
  - `exchange notes`;
  - `if you could let me know either way`;
- calling Embark's team `people` in the prohibited sense;
- malformed control characters or null bytes;
- more than one obvious meeting ask/CTA;
- subject benefit language/title-case heuristic severe enough to indicate a
  campaign pattern;
- body/subject fact IDs that fail grounding checks.

Warnings, not automatic failures:

- greeting-card filler variants not caught exactly;
- suspiciously uniform sentence lengths;
- rule-of-three cadence;
- balanced antithesis;
- overlong body/subject;
- excessive intensifiers;
- a signature longer than sender policy;
- first-name personalization unsupported by expected register.

The linter returns codes and matched spans. It never silently edits prose.

## 17. Automatic repair

If writer schema validation or hard lint fails:

1. run at most one automatic no-search repair with the same packet;
2. provide only the draft, named lint failures, permitted facts, and original
   writing sources;
3. require a complete replacement, not patch fragments;
4. validate again;
5. if still failing, mark `failed_write` with lint codes and an explicit
   Retry/Remove-from-campaign action. `needs_human` remains reserved for factual/identity/
   sender-context decisions, not prose-validator failure.

No extra research occurs. There is no recursive repair loop. Warnings remain
visible in telemetry but do not auto-reject unless promoted by policy.

## 18. User-requested rewrite

`Deny and try again` uses the same writing architecture with:

- same exact input fingerprint;
- same research packet/hash;
- same asset/sender versions;
- previous current subject/body as a negative example;
- monotonically increasing generation attempt number;
- optional short user feedback;
- instruction to produce a materially different opening/shape while obeying
  the same facts and skill.

It never calls web search. On success it hard-overwrites the current draft.
Only attempt count, request ID, usage, timestamps, and failure codes persist;
prior email content does not.

## 19. Accuracy invariants

1. No person-specific claim without verified identity.
2. No “recent/current” claim without appropriate freshness evidence.
3. No sender/company claim outside approved sender/positioning sources.
4. No selected prospect fact without source IDs and supporting quote.
5. No source-family duplication masquerading as corroboration.
6. No conflicted identity automatically decided by majority.
7. No research result may overwrite supplied/global lead data.
8. No stale result may commit against a changed input fingerprint.
9. No rewrite may create a research job.
10. No draft with a hard skill-lint failure becomes review-ready.
11. Sparse context may lower resolution; it does not justify invention.
12. At true zero, pause for a human decision or remove from the campaign
    rather than generate filler.
13. No research, writing, repair, or rewrite call may start unless the current
    effective recipient address is still mailbox `valid`.

## 20. What to learn from the enrichment architecture

Reuse:

- Postgres as job truth and Inngest as transport;
- `tool_choice:auto` during search, then a report-enforcement turn;
- strict tool schema plus independent application validation;
- source-family reasoning and append-only evidence metadata;
- input/context hashes preventing cache poisoning;
- org-wide concurrency lanes;
- atomic completion checks and a sweeper;
- bounded search uses and actual usage telemetry;
- rate-limit circuit breaking;
- null/conflict over guess;
- offline canned model responses.

Newest lessons (enrichment rounds 14–19, applied above):

- **preflight before paid work**: the direct-email upgrade's core insight —
  never make a new paid call rediscover a fact the system already paid for
  and verified — applies to drafting research too (§5.1), not only to email
  discovery;
- **never disguise reused evidence as fresh**: the past-lead-reuse badge
  exists precisely so a human reviewer isn't misled about what was actually
  re-verified for this specific person; the same discipline now applies to
  in-workspace company-context reuse (§6.4, §11);
- **evidence-gate thresholds are hypotheses, not laws**: enrichment's
  confidence/trust rules for email-format evidence were fixed a priori after
  round 17, then had to be loosened twice (rounds 18–19) once a small live
  probe of real companies showed the a priori rule was discarding genuinely
  usable signal. Drafting's own trust-tier/anchor rules (§7.2, §10) are
  written with the same first-principles confidence and deserve the same
  skepticism — treat them as provisional pending a real-sample check, not as
  settled physics (`06` §9.1).

Do not copy:

- company-level grouping as the only research unit; drafting needs a person-
  specific judgment;
- profile enrichment's write-to-empty global lead behavior; Drafting uses
  scoped snapshots/overrides;
- format-guess semantics as drafting/export eligibility;
- one giant enrichment module; drafting should split pure policy, provider,
  persistence, and orchestration modules;
- qualitative agent self-approval of live output.
