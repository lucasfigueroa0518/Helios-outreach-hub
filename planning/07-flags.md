# 07 — Flags: contradictions & decisions to revisit

Ranked by how much they'd hurt if unaddressed.

## Decision log (user, 2026-07-13)

| # | Topic | Decision |
|---|---|---|
| 1 | Leads in contacts table | ✅ Seeded tables are OUR data (writable, no live-sync worry, one-time load). Leads still get their own `outreach.leads` table for shape reasons only; `all_people` view unifies reads |
| 2 | CSV can't hold color | ✅ Dual export (XLSX with color + CSV with `Relationship Tier` text col) |
| 3 | 6-month clock | ✅ Most recent of person- & company-level dates (`max`, corrected from user's "min") |
| 4 | Colors | ✅ In-app = gold/yellow/pink (data-quality); Excel = **red(recent)/orange(older)** |
| 5 | Merge | ✅ Stack B onto A; A keeps name; conservative 2-of-3 fuzzy dedup on {name,company,title} |
| 6 | Auth | ✅ Passwordless email-only: enter `@embarkwithus.com` address → auto-create + instant sign-in. No password/verification in v1 |
| 7 | Upload & Replace | ✅ Option A — **hard overwrite**: uploaded file becomes the authoritative campaign lead set |

**All 7 resolved.** Full detail per flag below.

## Decision log — round 2 (senior-engineer audit, user rulings 2026-07-13)

| Audit item | Ruling | Landed in |
|---|---|---|
| 1. Extraction + web enrichment are the whole ballgame; plan was thin there | ✅ Expand exhaustively | **08** (extraction), **09** (web enrichment) — verbatim prompts, schemas, edge-case matrices, acceptance tests |
| 2. Non-idempotent load, no PKs | ✅ Fix | 02 §Idempotent bootstrap (`db/bootstrap.sql`, staged `ON CONFLICT` load) |
| 3. (reframed by user) Local-first enrichment as a system-wide principle | ✅ Adopt everywhere — **but the format-seeding mechanism was corrected in round 3 (see below): no bulk precompute; direct-first, infer-last** | 03 §Governing principle; 09 §1 waterfall; 08 §7 extraction cache |
| 4. Lead-insert race | ❌ Skip per user ("not a likely issue") | — |
| 5. Cost model | ❌ Skip per user ("okay right now") | Light observability only: 09 §8 per-run W-counts |
| 6. Rate limits | ✅ Fast by default; report every limit event; resumable/idempotent so work continues after | 09 §4; 10 §4 (org concurrency keys, backoff, circuit breaker, `rate_limit_events`, job-table resume) |
| 7. Cron worker → event-driven + real queue | ✅ Inngest | **10** (events, functions, concurrency budget); 06 marked superseded |
| 8. trgm can't index a view | ✅ Two separate indexed queries + app-side candidate merge | 02 §all_people |
| 9. Merge dedup too loose | ✅ 4 signals {name, company, title, email}, require ≥3, email counts at most ONCE (no email+email+name) | 02 §Merge dedup |
| 10–17 | ❌ Ignored entirely per user ruling | — |

## Decision log — round 3 (enrichment-architecture audit, user rulings 2026-07-13)

| Audit item | Ruling | Landed in |
|---|---|---|
| Premise "email format is a company-level property" is only ~60% true (empirical) | ✅ Accepted as a limitation — inference is explicit best-effort ("good shot, keep it cheap"), not a guarantee | 09 §0 Rule B |
| Inference ran before direct web discovery (wrong order) | ✅ **Direct first, infer last.** Guess only when no actual email is found anywhere (upload/DB/verbatim online) | 09 §1 (Phase 1 D1–D4 before Phase 2) |
| Bulk format-seeding from all 7,515 emails | ✅ Removed. Derive a company's format from our data ONLY when its domain is already ours; else find evidence online. On-demand, not precompute | 09 §2; 03 governing principle; M5/M6 |
| No email verification | ✅ Add free **MX-only** check, trailing/parallel, zero throughput cost. **SMTP catch-all removed (round 4)** — serverless blocks port 25; catch-all deferred to future paid API | 09 §7; 10 §3.5 `verifyDomain` |
| Critical #2 cache poisoning (fuzzy name key) | ✅ Fixed — domain-keyed `companies` + context-scoped `company_resolutions`, invalidatable | 02; 09 §3.5 |
| Count-pass economics / correlated errors | ⏳ Tabled — revisit during model testing | 08 §2.2 (unchanged for now) |
| DuckDuckGo-HTML fallback fragile | ✅ Replaced with self-hosted **SearXNG** (open-source) | 09 §3.4; `SEARXNG_URL` env |
| #9 `linkedin_level` as a lead property | ✅ Removed — rep-relative, not a lead field. Lead fields = original prompt's contact-field set | 08 §0; 02 leads; 03 |
| Other audit items (dedup exact-match, stale-email short-circuit, spend governor, retry layering) | ❌ Ignored for now per user | — |

## Decision log — round 4 (upload & enrichment re-audit, user rulings 2026-07-13)

| Audit item | Ruling | Landed in |
|---|---|---|
| A1. Intake rejected HEIC/photos; headline input shouldn't be just screenshots | ✅ Expand accepted media — add HEIC/HEIF/BMP/TIFF/GIF, transcode to PNG before vision | 08 §1, §2.1 step 0, §8 tests 13–14; 03; 05 |
| B1. SMTP catch-all probe undeliverable (serverless blocks port 25) | ✅ Remove catch-all probe; keep free MX DNS check; defer catch-all to future paid API | 09 §7; 10 §3.5; 02 |
| All other round-4 items (.eml/.msg, paste, size limits, hash timing, zip-bomb hardening, literal-email attribution, local-path poisoning, cross-campaign bleed, etc.) | ❌ Ignored per user ("address these two, ignore everything else") | — |

## Decision log — round 5 (breakage-only audit + fixes, 2026-07-13)

All seven were genuine build/runtime breaks (not opinions); all fixed:

| # | What would break | Fix | Landed in |
|---|---|---|---|
| 1 | Forcing `report_company` tool_choice disables `web_search` → research does zero searches | `tool_choice: auto` + prompt-to-finish + loop enforcement | 09 §3.2 |
| 2 | `sharp` prebuilt has no libheif → HEIC decode throws on Vercel | decode HEIC via `heic-convert` (WASM libheif) before sharp; BMP/TIFF/GIF stay on sharp | 08 §2.1 step 0 |
| 3 | SearXNG `format=json` 403s by default → fallback dead | require `json` in instance `search.formats`; treat non-200 as unavailable | 09 §3.4; 10 §6 |
| 4 | `FOR UPDATE SKIP LOCKED` not expressible in `supabase-js`; transaction-pool breaks prepared statements | claim/enqueue/complete as Postgres functions via `.rpc()`; session pooler or disable prepared stmts | 09 §3.1 |
| 5 | Non-atomic "last job fires complete" → runs hang in `enriching` | `finish_research_job()` flips status + counts remaining in ONE tx; + sweeper backstop | 09 §3.1b |
| 6 | `content_hash` "at intake" impossible (direct-to-storage upload) | hash in the extraction worker (which downloads bytes anyway), first step | 08 §7 |
| 7 | Inngest steps exceed Vercel `maxDuration` default → killed | `maxDuration = 300` + `runtime = 'nodejs'` on `/api/inngest`; per-company/file step granularity | 10 §1 |

## Decision log — round 6 (build-readiness audit fixes, 2026-07-13)

Cleanup so a builder isn't misled at M0–M1. All fixed:

| Item | Fix | Landed in |
|---|---|---|
| DB-setup files contradicted (bootstrap vs post_load vs outreach_schema) | Exactly two files: `bootstrap.sql` (seeded + PKs + load) and `outreach_schema.sql` (outreach.* + view + indexes + functions). `post_load.sql` deleted from plan | 02 §Canonical DB-setup files; 11 M0 |
| RLS "per authenticated user" incompatible with custom JWT + service-role | **Authz in app code** (scope every query by `owner_id`); RLS out of scope in v1 | 02 §Authorization model; 06; 11 M0/M1 |
| "Contact standards" for names undefined | Concrete **Name Standard** (casing/suffix/credential/accent rules, `lib/name-standard.ts`), distinct from email name-prep | 04 §Name Standard; 02 leads; 03 Stage C |
| Session signing secret missing from env | Added `SESSION_SECRET` | 06 §Environment; 10 §6; 11 M1 |
| Stale ref "03 §5" | → 03 Stage G/H | 02 |
| Index-type mismatch (trgm on email) | Email = btree `lower(email)`; trgm only on name/company | 02 §Postgres notes |
| "Sufficiently similar disambiguation context" undefined | Concrete: ≥1 exact person-name overlap OR context trigram ≥0.6 | 02, 09 §3.5 |
| M3 said "content-hash on intake" (impossible) | Corrected to worker-side per 08 §7 | 11 M3 |

## Decision log — round 7 (cynical breakage audit, 2026-07-13)

| Finding | Ruling | Landed in |
|---|---|---|
| `\copy` load needs psql, which wasn't installed | ✅ Fixed — PostgreSQL 16's psql was already present at `C:\Program Files\PostgreSQL\16\bin`; added to user PATH. `db:load` works in a fresh terminal | 11 M0 |
| `sharp` can't decode BMP → BMP upload throws | ✅ Removed BMP from accepted types | 08 §1/§2.1; 03 |
| "scope EVERY query by owner_id" breaks shared-table reads | ✅ Fixed — scope only user-owned entities (campaigns + children); leads/companies/contacts are global by design | 02 §Authorization model; 06; 11 M1 |
| RLS off → seeded public tables readable via browser anon key (PII) | ⏳ Deferred per user (valid v1 reason). **Noted as must-do-before-launch** with three fix options | 02 §Authorization model (⚠️ DEFERRED note) |

## Decision log — round 8 (cost guardrails + scope invariant, 2026-07-13)

| Item | Ruling | Landed in |
|---|---|---|
| Agent could autonomously incur large Claude/tool cost | ✅ **Hard rule: no more than ~$1.50 without direct user approval.** Stop + estimate before the M6 fan-out; tiny test fixtures only | **CLAUDE.md Rule 1**; 01 §Invariants; 09 header; 11 M6 |
| Fear the plan batch-enriches the whole DB | ✅ Confirmed it does NOT (bulk script removed round 3). Made it a **permanent invariant**: enrich ONLY user-uploaded new entries; DB is lookup-only; matches handled per-case; no DB-sweep job exists | **CLAUDE.md Rule 2**; 01 §Invariants; 09 header |

## Decision log — round 9 (testing approach, 2026-07-13)

| Item | Ruling | Landed in |
|---|---|---|
| Automated tests must not incur Claude API cost | ✅ Automated tests are light + offline: pure functions, SQL, plumbing; **stub the model** (canned tool outputs) where a step would call it. No live API / web_search in tests | 11 §Testing philosophy; CLAUDE.md §Testing; 08 §8, 09 §9 intros; M4/M6 accept |
| Real behavior verified how | ✅ **Manually by the user** running the built product (vision accuracy, live research) — not automated | same |

## Decision log — round 10 (Past Work re-audit, user ruling 2026-07-14)

| Item | Ruling | Landed in |
|---|---|---|
| `Past Work` "Pitched" was silently undercounted | Bug found: "Pitched" required a non-null `opportunities.last_activity_date`, which is null on >50% of rows (1,013/1,999) — scoped/lost/open deals without a logged activity date were invisible. Fixed to key off `count(*) > 0` directly, independent of any date field; `close_date` (100% populated) used as the date fallback | `lib/relationships.ts` |
| Three-tier `Past Work` split (`Work done`/`Pitched`/`Connected`) | ✅ **Collapsed to binary**: `Work done` (any won opportunity) vs `Previously connected` (any opportunity history at all, OR any contact-level touchpoint with zero opportunities) vs blank (no relationship). The Pitched/Connected distinction wasn't reliable enough to be worth a separate value — both mean "not cold" to a BD rep. Supersedes item #10's earlier "3-value enum" reading | `lib/relationships.ts`; 01 §5; 03 §G2; 04 #13 |
| `ID` / `Company ID` shown as columns | ✅ **Never displayed.** They're internal Salesforce/Outreach primary keys needed for identity-resolution matching logic (02, 03 §D), not information a BD rep needs. Removed from the Review tab and both CSV/XLSX exports; kept only as internal `outreach.leads` fields | `app/campaigns/[id]/review/review-table.tsx`; `app/api/campaigns/[id]/sheet/route.ts`; 04 §Columns |
| `Prior Relationship Date` as a displayed column | ✅ **Never shown as a raw date.** The exact date stays internal (drives the 6-month tier calc), but the displayed/exported column is a new binary field, `Prior Relationship Activity` — `Within 6 months` / `Older than 6 months` / blank — aligned with the same cutoff used for color coding. Replaces the old CSV/XLSX `Relationship Tier` text column (superseded, same underlying signal) | same files; 04 #12 |

## Decision log — round 11 (profile-field waterfall, user ruling 2026-07-14)

| Item | Ruling | Landed in |
|---|---|---|
| Missing company, title, and location | ✅ Use the existing web-research job path, but enqueue only leads with at least one missing required field and request only the exact missing field(s). Filled values are context only and can never be overwritten | `lib/enrichment.ts`; 01 §4; 03 §E; 09 Rule C |
| Accuracy threshold | ✅ **No profile inference.** A write requires high confidence plus two independent source families that explicitly name the person and agree on the same value; at least one must be first-party or a professional profile. Model confidence alone is insufficient. One-source/medium/low/conflicting findings remain blank | `lib/research-types.ts`; `lib/research-provider.ts`; 09 Rule C |
| Meaning of location | ✅ Person's actual work location only. Company HQ/billing/mailing address, generic office lists, event locations, hometowns, schools, or employer-derived guesses are rejected even if they are otherwise credible company facts | same |
| Company missing (so no company job key exists) | ✅ Use a person-scoped research key based on normalized person + lead ID/context. Do not create a fake company resolution; once a company is accepted, conservatively link it to an existing account if possible | `lib/research-types.ts`; `lib/enrichment.ts`; `lib/identity.ts` |

## Decision log — round 12 (company-first + enrichment provenance, user ruling 2026-07-14)

| Item | Ruling | Landed in |
|---|---|---|
| Email research when company is blank | ✅ Forbidden. The person-scoped first pass requests company only and cannot scrape, discover, or infer email. An accepted company creates a company-scoped follow-up; a rejected/unknown company leaves email blank | `lib/enrichment.ts`; `lib/research-provider.ts`; 03 §E; 09 Rule D |
| Semantically identical evidence wording | ✅ Harmless wording variants (`Miami`/`Miami, Florida`, `FP&A`/`Financial Planning & Analysis`) may agree. Invalid individual evidence is discarded; the finding still requires two independent valid source families and one authoritative source | `lib/research-types.ts` |
| Review legend | ✅ First key is light-blue `Non-email enrichment`; relationship recency is one half-red/half-orange `Prior relationship` pill; no `No prior relationship` key | Review table/CSS; 04 §Color coding |
| Enriched profile cells | ✅ Accepted company/title/location writes store field provenance and render light blue in Review/XLSX. Email cells never receive this color | `outreach.leads.profile_enrichment`; sheet API |

## Decision log — round 13 (confidence-gate calibration, user ruling 2026-07-14)

| Item | Ruling | Landed in |
|---|---|---|
| Correct one-source findings were omitted | ✅ Two independent sources remain preferred. One first-party/professional-profile source can pass only with at least two supplied identity attributes corroborating the same person. Medium confidence can pass this evidence gate; low confidence cannot | `lib/research-types.ts`; 03 §E; 09 Rule C |
| Company still unresolved | ✅ Active email discovery remains blocked. Blank/inferred email is normalized to `not_found` with `company must be confirmed first`, so Review applies the missing-email row color | `lib/enrichment.ts`; Review table |
| User-validated calibration set | ✅ Bruno Barros→AEG FUELS and Nada Yared→Miami-Fort Lauderdale Area are accepted examples. Iraq Pacheco→7Air remains rejected. Dan Maxwell→Fort Lauderdale is a human-confirmed override, not a general low-confidence acceptance rule | tests; latest-run provenance |

## Decision log — round 14 (direct-email architecture upgrade, user ruling 2026-07-14)

| Item | Ruling | Landed in |
|---|---|---|
| Cache/prior inferred email treated as solved | ✅ Rejected. Every known-domain inference path first receives a free deterministic direct-email preflight; an existing inferred email may be upgraded without launching a new paid-only upgrade job | `lib/enrichment.ts`; 03 §E; 09 §1 D3.5 |
| Deterministic crawl intelligence | ✅ Concurrent bounded crawl with homepage/sitemap discovery, cached winning paths, same-host first-party PDFs, entity/Cloudflare/`[at]` decoding, generic-inbox rejection, and strict person binding | `lib/site-scraper.ts` |
| Research cost and latency | ✅ No increase to model calls or `web_search max_uses`. Preflight can skip paid work; the prompt spends its existing search ceiling on exact literals before format evidence and receives a digest of already-checked paths | `lib/research-provider.ts` |
| Meaning of web-direct | ✅ Syntax/model output is insufficient. The application re-fetches the cited URL, confirms the exact company-domain address and named person, then stores URL/context/hash/method/time provenance | `leads.direct_email_evidence`; `lib/enrichment.ts` |
| Scrape cache | ✅ Cache successful paths only, not full HTML. It remains domain-scoped and is consulted reactively only for the current uploaded leads | `companies.scrape_paths`; `scrape_checked_at` |
| Telemetry | ✅ Split model vs preflight vs post-research scrape wins; record page attempts/fetches/errors; distinguish direct identity reuse from inferred reuse | run enrichment stats; `lib/identity.ts` |

## Decision log — round 15 (past-lead reuse visibility, user ruling 2026-07-15)

| Item | Ruling | Landed in |
|---|---|---|
| Reusing an existing `outreach.leads` row | ✅ Persist provenance on the campaign/lead association only when the matched lead predates the current run. Same-run duplicate extraction is not labeled as prior reuse | `campaign_leads.reused_from_prior_lead`; `lib/identity.ts` |
| BD-rep warning | ✅ In-app Review uses a distinct teal row tint and explicit `Past lead` badge. The badge remains visible when missing-email or field-level colors override the row tint | Review table; 04 Surface 1 |
| Export contract | ✅ This is a UI indicator, not a new CSV/XLSX column; internal IDs and provenance plumbing remain hidden from user exports | 04 output contract |

## Decision log — round 16 (lightweight profile rescue, user ruling 2026-07-15)

| Item | Ruling | Landed in |
|---|---|---|
| Scope | ✅ A second pass runs only for an originally requested company/title/location cell still blank after its primary job; one person per rescue shard | `lib/enrichment.ts`; 03 §E; 09 §3.2b |
| Intelligence | ✅ Rescue receives refreshed accepted fields and first-pass candidates/evidence, verifies the strongest lead, then follows one new avenue. Agreeing evidence may combine; conflicting values cannot | `research-types.ts`; `research-provider.ts` |
| Accuracy | ✅ No confidence-gate relaxation, inference, overwrite, or HQ-derived location. The same independent Rule C application gate controls writes | `isHighConfidenceProfileFinding` |
| Cost | ✅ Haiku, at most two web searches, small output, no SearXNG fallback or email work. Worst-case 25 rescued rows = 50 searches / $0.50 search fee plus Haiku tokens | `researchProfileRescueLive`; 09 §3.2b |
| Throughput | ✅ Rescue events emit as each parent row/job finishes and use a separate default-12 concurrency lane. Run completion waits for emitted rescue work, avoiding stale exports without a serial second-pass barrier | Inngest profile-rescue function; local dynamic worker queue |

## Decision log — round 17 (email evidence tiers + rescue, user ruling 2026-07-15)

| Item | Ruling | Landed in |
|---|---|---|
| Blind global defaults | ✅ `first.last` / `flast` / `first` without format evidence are no longer normal inference. They are `format_guess`: visible but unresolved and not send-ready | `assignInferredEmails`; 03 §F; 09 I3 |
| Email second pass | ✅ One per-row Haiku rescue trails a primary job with no literal/usable format, using current profile context and first-pass evidence; max three searches on a separate lane | `researchEmailRescueLive`; Inngest email-rescue function |
| Accuracy gate | ✅ Direct findings still require exact person+email re-fetch. Web format inference requires medium/high confidence plus a cited URL; low/uncited formats are ignored. Evidence-backed formats are never padded with blind defaults | `evidenceBackedFormats`; `email-patterns.ts` |
| Status UI | ✅ `Found` dark green; `Inferred` green; `Format Guess` light yellow; `Not Found` gray. `Found` combines direct/upload/Embark-DB addresses | Review and export status mapping |
| Cost/throughput | ✅ Worst-case 25 rescued rows allow 75 searches / $0.75 search fees plus Haiku tokens. Jobs trail rows and gate final completion, but do not consume primary research concurrency | 09 §3.2c |

## Decision log — round 18 (low-confidence format evidence, user ruling 2026-07-15)

A live probe of 7 real companies showed the model's self-reported `low` tier is
usually a genuine secondary/minority pattern (e.g. a company's dominant format
at 86% share, plus a `low` claim for a smaller alternate format), independently
repeated across 2+ unrelated aggregator sites — not baseless. Round 17's blanket
`medium`/`high`-only rule discarded that even when corroborated.

| Item | Ruling | Landed in |
|---|---|---|
| Low-confidence format evidence | ✅ A cited `low` confidence format can now produce an `inferred` (send-ready) email — but only when independently corroborated (2+ distinct-source-family citations) or backed by a strong majority share (≥70%). An uncorroborated single-source `low` claim with no share stat still doesn't qualify — same bar `medium` already had to clear | `evidenceBackedFormats` (`lib/research-types.ts`); `evidenceBackedCompanyFormats` (`lib/enrichment.ts`) |
| Rationale | A model's self-rated uncertainty on one pass is not the same as "unsupported." Independent corroboration is exactly how you distinguish a real weak signal from a fabricated one — the existing host/share gate already did this, it just wasn't being applied to the `low` tier | — |

## Decision log — round 19 (any cited evidence beats a blind guess, user ruling 2026-07-15)

Round 18 still required corroboration (2+ sources) or a strong share stat
before a `low` (or even a single-source `medium`) citation would count —
uncorroborated single-source claims still fell all the way through to the
zero-evidence 3-pattern blind guess. User ruling: that's backwards. The
model is instructed to never cite a URL it can't back up, so a single weak
citation is still categorically better evidence than nothing, and should
never produce the same output as a truly blank slate.

| Item | Ruling | Landed in |
|---|---|---|
| Corroboration requirement | ✅ Removed as an eligibility gate. Any cited (URL-backed), real-pattern (`!= 'other'`) format finding — high, medium, or low confidence, single-source or not — now qualifies as `inferred`. Only two things are still dropped: claims with no cited URL (a bare assertion, not evidence) and `pattern: 'other'` (not a usable pattern) | `evidenceBackedFormats` (`lib/research-types.ts`) |
| What corroboration still affects | Independent-source count and share stats are preserved as metadata and still shape candidate-count/confidence wording downstream (`email-patterns.ts`, `email-source-note.ts`) — they just no longer gate *whether* the evidence is usable at all | `lib/email-patterns.ts` |
| Blind guess (`format_guess`) | Now reserved for the narrower case where research genuinely returned zero citable format evidence of any kind, not merely "the evidence was thin" | `assignInferredEmails` |

## Decision log — round 20 (drafting plan finetuned against newest enrichment fixes, user ruling 2026-07-15)

The drafting plan (`planning/drafting/`) already had a "what to learn from
enrichment" section reflecting rounds 1–13. This round re-checked it against
the newest enrichment fixes (rounds 14–19, mostly about the direct-email
upgrade and evidence-tier calibration) and applied the lessons that
generalize beyond email discovery specifically.

| Item | Ruling | Landed in |
|---|---|---|
| Drafting research re-derived identity/freshness from zero even when the source enrichment run's own two-independent-source-gated profile facts already answered it | ✅ Structure `provenance.profileEnrichment`/`emailProvenance` into cited seed facts the researcher may reuse as a free preflight before spending new searches on already-solved identity/freshness — the "local-first" principle (round 3) and the direct-email upgrade's "preflight before paid work" principle (round 14), applied one layer up. A seed fact still must clear the same trust/family/freshness gates before it can anchor a draft; it never bypasses verification | drafting `02` §5.1, §20 |
| Same-company research-cache reuse (`03` §12) had no reviewer-visible flag, unlike the lead-level `reusedFromPriorLead` badge | ✅ Any company-context cache hit is recorded on the packet (`companyContextProvenance`) and shown in the research drawer as reused-within-workspace, never presented as fresh per-person research — the same discipline as round 15's past-lead-reuse badge | drafting `02` §6.4/§11; `03` §12; `01` §7.3 |
| Drafting's trust-tier/anchor evidence gates (`02` §7.2, §10) were fixed a priori, the same way enrichment's email-format confidence gates were before rounds 17–19's live-probe recalibration found them too strict | ✅ Documented as provisional, not settled: the required manual quality pass must specifically check whether the anchor gate is discarding legitimately usable single-source cited facts across a real sample, and any loosening is a user ruling logged here, never an agent self-adjustment | drafting `06` §9.1 |
| Everything else in enrichment rounds 14–19 (direct-email crawl intelligence, scrape-path caching, generic-inbox rejection, email-evidence tiers) | ❌ Does not generalize — drafting explicitly does not do email discovery (`02` §5: "Drafting research does not repeat enrichment's email-discovery waterfall") | — |

## 1. ✅ RESOLVED — seeded tables are ours; leads split for shape only

Original concern: the brief said "add leads to the `contacts` table," and
`db/schema.sql` begins `DROP TABLE IF EXISTS contacts`, so a re-run of the
destructive load would wipe accumulated leads.

**User's reframe (correct):** this is a satellite project; the seeded tables
are **our own writable database**, not a read-only mirror, and there is **no
continuous refresh** — a future larger system will handle live Salesforce
updates, and we don't design around that now. So the "leads get wiped"
scenario simply won't happen: we don't re-run destructive loads.

**Landed decision:** leads still get their own `outreach.leads` table — but
purely for **shape** reasons (146 Salesforce columns vs ~12 lead fields; no
SF id to use as PK), not refresh risk. The seeded tables (`contacts`, etc.)
are treated as first-class: we read, insert, and update them normally. The
`all_people` view unifies reads so identity resolution searches contacts +
leads together. Build task: make the load a one-time non-destructive
bootstrap and add PKs (06, step 1).

## 2. 🔴 A CSV cannot be color-coded

The brief specifies the output "is a CSV file" and that rows "should be
filled in traffic cone orange / warm sunshine yellow." CSV is plain text —
no fills, no formatting. Not a judgment call; it's a file-format fact. (The
co-work prototype quietly acknowledged this: it output `.xlsx` via openpyxl.)

**Proposal (04):** colors live in the in-app Review viewer + an **XLSX
export**; a plain **CSV export** carries a `Relationship Tier` text column
instead. Both exports offered.

## 3. 🟡 The 6-month color rule is ambiguous — and one spec sentence is cut off

- "If there has been an active relationship of any kind **between Embark and
  the lead** within the last 6 months…" — is the clock the *person's* last
  touchpoint, the *company's* last activity, or either? These diverge
  constantly (colleague met last month; this specific person never
  contacted).
- The "date of prior relationship" bullet literally ends mid-sentence
  ("This is"), so its definition is unspecified.

**DECIDED:** tier clock = **most recent** of (contact-level last touch,
company-level last activity) = the date closest to today. In code that's
`max()`, not `min()`. Worked example: today 2026-07-13, person touch
2026-06-01, company touch 2023-01-01 → closest-to-today is 2026-06-01 (the
bigger date = `max`) → `active`. `min()` would wrongly pick 2023 and mark it
cold. Matches "active relationship of any kind within 6 months" (either side
recent ⇒ hot). `Prior Relationship Date` col = company date; `Last Contacted`
col = person date; both shown so the rep sees which drove the color.

## 4. 🟡 Two conflicting color conventions in the same brief

Your spec: orange = active ≤6mo, yellow = dormant >6mo. Claude's Insights
(step 9): gold = CRM-needs-update, yellow = missing-critical-fields, pink =
data-quality — conventions from prior deliverables it was told to match.
Yellow can't mean both "dormant relationship" and "missing fields."

**DECIDED:** split across two surfaces so they can't conflict.
- In-app viewer keeps prototype **gold/yellow/pink = data-quality** (CRM
  needs update / missing critical field / data-quality note). Relationship
  recency shown as a chip in-app.
- Exported Excel uses **orange = active (≤6mo), red = dormant (>6mo)**, no
  fill = cold. Excel is on the user's machine, separate from the app, so no
  clash. ⏳ One confirm outstanding: red = older is the current reading of
  "orange/red"; flag if red should mean something else.

## 5. 🟠 Merge naming compounds; merge mechanics under-specified

`"{A} + {B}"` merged again with C → `"A + B + C"`… names grow unboundedly,
and the brief doesn't say whether merge creates a new campaign or folds one
into the other, nor what happens to duplicate leads across the two.

**DECIDED (simpler than my original proposal):** just **stack** — append
B's leads onto A, A keeps its own name, B is archived. No concatenated name.
Conservative dedup only: collapse two leads when ≥2 of {name, company, title}
fuzzy-match; entity-level (people) only. See 02 for the full write-up.
Survivor = the campaign Merge was clicked *from* (confirmed).

## 6. ✅ RESOLVED — passwordless email-only login

Runs must be tagged with the executing user, campaigns have owners, and
default campaign names are per-user — which requires the app to know who you
are (authentication). It currently has none.

**Landed decision:** the easiest possible signup. User enters their
`@embarkwithus.com` email → account is found-or-created and they're signed
in immediately. No password, no verification email in v1. Details in 02
(`outreach.users`), 05 (login screen), 06 (auth routes).

⚠️ **Security reality (accepted for v1):** with no verification, anyone who
can reach the app and knows/guesses a colleague's Embark email can sign in
*as* them. Fine for an internal tool behind the org's network, but this is
not real identity security — it's attribution, not protection. Non-blocking
upgrade path: magic-link email verification or org SSO, swappable behind the
same `login` route without changing callers.

## 7. ✅ RESOLVED — Upload & Replace = hard overwrite (Option A)

Original concern: the sheet is a projection of the database, so a re-uploaded
edited file's changes don't naturally flow back, and the next run could stomp
them.

**Landed decision:** hard overwrite. The uploaded file becomes the
campaign's authoritative lead set — known IDs update in place, new-ID rows
create leads, leads absent from the file are dropped from the campaign
(entity retained in the `outreach.leads` master). Mechanics in 06.

⚠️ **Remaining gotcha to communicate in-product:** relationship/color fields
are re-derived only on the next enrichment run, so a hard-overwritten sheet's
relationship columns are honored as-is until then, and a later run will
recompute them. Surfaced in the Replace confirm dialog.

## 8. 🟠 Inferred emails at scale carry deliverability risk (future-module interaction)

Up-to-3 guessed addresses per lead is fine to *generate*, but the stated
future plan — "all three will be used and we'll see which one bounces" —
means intentionally hard-bouncing ~2 of 3 sends per inferred lead. Sustained
bounce rates above ~2–5% get a sending domain flagged/blacklisted, which
would hurt all of Embark's outbound email.

**Not this module's problem to solve, but this module's data should make it
solvable:** we keep `Email Status` honest (Direct vs Inferred) and ordered
alternates so the drafting module can verify-before-send (paid verifier API
slot is designed in at 03 §F) instead of shotgun-sending. Flagging now so
the CSV contract doesn't bake in a bad assumption.

## 9. 🟡 Search-snippet "email formats" are heuristics, not data

The prototype (its own admission, step 5/10) reads whatever RocketReach/
ZoomInfo/etc. snippets happen to be indexed — unverified, sometimes stale,
occasionally wrong-company. We mitigate (multi-source corroboration in the
research contract, confidence field, company cache with 90-day staleness,
strict Inferred labeling) but accuracy has a ceiling without a paid
verification API. Budget expectation-setting: Inferred emails will be
~70–85% right at best, not 95%+.

## 10. ⚪ Minor spec inconsistencies (resolved, noting for the record)

- "This field should be **almost binary**. There are **three** possible
  things…" — originally treated as a 3-value enum + blank for none (04 #13).
  **Superseded 2026-07-14 (round 10):** actually made binary — `Work done` /
  `Previously connected` / blank. The brief's own wording ("almost binary")
  turned out to be the better read once Pitched vs. Connected proved not
  reliably distinguishable in practice.
- The email-source bullet list in the brief nests "open source web search"
  inside the Embark-DB bullet and then repeats it as its own bullet —
  treated as three sources: Embark DB → Claude web search → open web search
  (03 §E/F priority order).
- Two UX sentences truncate mid-thought ("toggle through in a", "This is") —
  interpretations documented in 05 and 04 respectively.
- The brief says users review output "of the campaign" then add more inputs
  — implies per-campaign accumulation, which matches the runs/campaigns
  model; no conflict, just confirming the reading.
- Historical enrichment-module decision: `Draft` was a UI stub in M0–M8.
  Drafting is now the separately specified next functionality under
  [`drafting/`](drafting/README.md); this line does not override that plan.

## Decision log — round 21 (AgentMail mailbox verification, 2026-07-16)

| Audit item | Ruling | Landed in |
|---|---|---|
| MX-only `email_verification` is insufficient for send-ready inferred/direct addresses | ✅ Add **AgentMail probe verification**: send subject `a` / body `f` from `lafwh@agentmail.to`, wait 30s, bounce in inbox ⇒ `invalid`, no bounce ⇒ `valid`. Runs as a **per-lead trailing tail** (`lead.email.verify`) with `ORG_MAILBOX_VERIFY_CONCURRENCY` default 12; `run.email.verify` sweeps any still-`pending` rows at finalize | `lib/agentmail.ts`, `lib/mailbox-verify.ts`, `lib/mailbox-verify-schedule.ts`, `lib/inngest/functions.ts` `verifyLeadEmail`; hooks in `assignInferredEmails` + `applyDirectEmailMatches` |
| Verification must not block enrichment throughput | ✅ Schedule immediately on assignment; 30s wait is isolated per shard (Inngest `step.sleep` or local queue). Enrichment continues while probes run in parallel | `mailbox-verify-schedule.ts` |
| `format_guess` addresses are not send-ready without verification | ✅ AgentMail verification is scheduled for `format_guess`; a `valid` result promotes it to `inferred`, while non-valid remains unresolved | `shouldScheduleMailboxVerification()`; `applyMailboxVerificationResult()` |

## Decision log — round 22 (mailbox-valid-only drafting UX, user ruling 2026-07-16)

| Item | Ruling | Landed in |
|---|---|---|
| Drafting eligibility | ✅ Only an exact current effective email with `email_verification='valid'` may enter research, writing, rewrite, or final export. Direct/inferred/manual origin does not bypass the mailbox gate | drafting `README` §5; `02` §§1/5/19; `03` §§1/7/14; `05` §3.7 |
| Drafting page structure | ✅ Top bar is latest drafts / all current mailbox-valid campaign leads and reads **All valid emails drafted** at 100%. Below it is a two-mode Email / Leads segmented control | drafting `01` §§3–4 |
| Email mode | ✅ Preserve one-at-a-time gamified Edit, Approve, Deny-and-rewrite, and the fourth action: permanently disabled Send | drafting `01` §§7–8 |
| Leads mode | ✅ Surface every non-draft-ready campaign lead. Users may edit any required cell, explicitly Approve for drafting, remove the campaign association, or download the unverified-leads CSV | drafting `01` §5; `04` §§8/11; `05` §4 |
| Manual approval semantics | ✅ Human approval never substitutes for verification. It saves the row and runs/reuses one AgentMail check; only `valid` automatically promotes and queues drafting. Invalid/unknown stays in Leads mode | drafting `01` §5.4; `03` §13; `04` §4.2/§8 |
| Remove semantics | ✅ Remove deletes only `campaign_leads`, cancels pending work, and keeps the shared lead entity. The old reversible drafting-only Ignore/Restore behavior is superseded | drafting `README` §6; `01` §5.5; `03` §§7/13/16 |
| Export semantics | ✅ Unresolved Leads do not block final export of the approved mailbox-valid subset, but remain visibly counted and downloadable in a separate CSV | drafting `README` Definition of complete; `01` §9; `05` §§1/4 |

## Decision log — round 23 (scraper and email-research reliability, 2026-07-16)

| Item | Ruling | Landed in |
|---|---|---|
| D3.5 reliability and coverage | ✅ Every page attempt is classified; temporary failures retry; global/per-host backpressure supports 3–4× load; nested/locale path families, robots/sitemaps, app routes, managed-browser recovery, and capped local OCR cover nonstandard/JS/image pages without allowing scraper failure to end enrichment | `lib/site-scraper.ts`; `site-browser-render.ts`; `site-image-ocr.ts`; 09 §D3.5 |
| Person matching | ✅ Formal/nickname pairs, preferred parenthetical names, accents, initials, suffixes, and unique local-parts share one deterministic ambiguity-safe matcher | `lib/person-name-aliases.ts` |
| D4 budget and targeting | ✅ Five searches per up to 2.5 unresolved people: 1–2→5, 3–5→10; max five people per shard. Actual assigned/used lifetime budget persists across retries. Queries are target-first, with purposeful RocketReach/ZoomInfo format searches late | `lib/research-budget.ts`; `research-provider.ts`; research-job columns |
| Blocked direct re-verification | ✅ A URL + exact person/email quote + actual blocked/timeout/moved/no-longer-visible re-fetch may enter provisional Found and immediately reach AgentMail. Contradictions remain rejected; a bounce removes/downgrades and queues targeted rescue | `site-scraper.ts`; `enrichment.ts`; `mailbox-verify.ts` |
| Local format threshold | ✅ Two matching local samples may derive a format but are capped at medium confidence; conflicting two-sample evidence retains alternatives; three+ samples keep the existing share calculation | `lib/derive-format.ts`; 09 §2 |
| Rescue continuation | ✅ Primary pass persists attempted/deferred queries, rejected literals, uncited formats, scrape outcomes, and failed high-value paths. Rescue starts there and only opens another bounded tranche when the frontier genuinely advances | `research-types.ts`; `enrichment.ts`; `research-provider.ts` |
