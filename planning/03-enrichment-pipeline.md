# 03 — Enrichment pipeline (overview)

> **This doc is the pipeline overview. The two deep specs that a builder must
> follow to the letter are [08-extraction-spec.md](08-extraction-spec.md)
> (vision/multi-media extraction) and
> [09-web-enrichment-spec.md](09-web-enrichment-spec.md) (online email
> enrichment). Those two stages are the whole ballgame — everything else in
> this pipeline is cheap deterministic support around them.**

## Governing principle: LOCAL-FIRST ENRICHMENT (user directive, 2026-07-13)

Before spending a single web-search dollar on any fact, exhaust our own
database. Two hard rules govern email enrichment (09 §0):

- **Direct first, infer last.** We only *guess* an email when the whole
  enrichment architecture has failed to find the person's **actual** address
  (in the upload, in our DB, or verbatim online). A found address is used
  as-is; guessing never overrides a real find.
- **Local format only when we already hold it.** We do NOT precompute formats
  from our whole contact list. A company's format is derived from our data
  **only when that company's domain is already in our database** (we have
  known emails at it, ≥2 samples; two-sample confidence is capped at medium).
  Otherwise we look online. Inference is a
  cheap best-effort "good shot" (2–3 candidates) — acceptable to miss
  sometimes; the point is cheap coverage, not guaranteed correctness.

Applied everywhere:

1. Existing nonblank lead fields are **never re-enriched or overwritten**.
   A prior lead is reused as-is except that a newly uploaded occurrence may
   selectively research whichever required fields are still blank. A job
   requests only those missing fields.
2. A company whose domain facts are already cached in `outreach.companies`
   are **never re-researched** (within the staleness window).
3. On-demand local format derivation (09 §2) fires only for companies whose
   domain we already have — new companies go straight to online research.
4. Fields provided by the input (email, title, company in a CSV or visible in
   a screenshot) are input truth — their find-it paths are skipped entirely.
5. Free MX verification (09 §7) trails the run off the critical path — it
   never slows throughput. (SMTP catch-all removed; deferred to paid API.)

Web enrichment is the *last* resort for direct discovery, and inference the
last resort after that — but genuinely new people at unknown companies are
exactly where the tool's core value lives, so that path gets the deepest
spec (09).

Directly modeled on the co-work prototype's 10-step pipeline (from "Claude's
Insights"), hardened for a real system. The four deliberate design choices we
replicate verbatim:

1. **Per-company research, not per-person** — email format is a company-level
   property; collapsing 137 people → 82 companies cut search volume ~40%.
2. **Parallel fan-out** for company research.
3. **Strict Direct vs Inferred labeling** — a masked/pattern-matched address
   is never presented as confirmed.
4. **Deterministic email construction** — pattern application is plain code,
   zero LLM calls, same inputs → same outputs.

## Stage A — Intake & storage

- Files land in Supabase Storage under `uploads/{campaign_id}/{run_id}/`.
- Accepted types v1: `png jpg jpeg webp heic heif tiff gif pdf csv tsv
  xlsx xls pptx docx txt md` (non-PNG/JPEG/WebP images transcoded to PNG at
  extraction — 08 §2.1). Intake is not limited to screenshots. (BMP excluded
  — no sharp decoder; 08 §1.)
- An `outreach.uploads` row per file; run status `uploading`.

## Stage B — Extraction (per file, parallelizable)

> Full specification with verbatim prompts, JSON schemas, edge-case matrix,
> and verification protocol: **[08-extraction-spec.md](08-extraction-spec.md)**.

Router by mime type:

| Input | Method |
|---|---|
| Images (screenshots) | Claude vision — image passed directly in a messages call with a strict JSON-schema extraction prompt (tool-forced output). This is the prototype's step 1 and its **weakest link**: no independent verification. Mitigations: per-image row-count echo ("I see N people"), a second cheap verification pass on low-confidence rows, and never silently dropping unparseable rows — they land in the run's `stats.extraction_warnings`. |
| PDF | Claude native PDF ingestion (≤100 pages); text-first, falls back to vision per page for scanned docs |
| CSV / XLSX | Deterministic parse (papaparse / SheetJS server-side), then ONE Claude call to map arbitrary source columns → our canonical fields (column-mapping, not row-by-row extraction — cheap and reliable) |
| PPTX / DOCX | Server-side text + embedded-image extraction, then same path as text/images |
| TXT / MD / pasted text | Straight to the extraction prompt |

Extraction output contract (per person) — full definition in 08 §0:
`{ full_name, title?, company?, location?, email?, phone?, linkedin_url?,
confidence, truncated, provenance }`. Connection degree (1st/2nd/3rd) is NOT
captured (it's rep-relative, not a lead property). Anything the input already
provides (email, title, company) is **treated as input truth and skips its
enrichment path** — the brief is explicit that this saves time and cost.

## Stage C — Normalization (deterministic, no LLM)

- Split full name → first/last and normalize per the **Name Standard
  (04 §Name Standard)** — that doc owns the exact casing/suffix/credential
  rules (`lib/name-standard.ts`).
- Canonicalize company names ("Planet DDS, Inc." ≡ "Planet DDS"; "A.C.T." ≡
  "ACT") — suffix/punctuation stripping + trgm similarity, with the person's
  title/location as disambiguation context carried alongside.
- Dedupe within the run (same person appearing in overlapping screenshots).

## Stage D — Identity resolution (Embark DB first)

For each normalized person, query `outreach.all_people` (contacts ∪ leads):

1. Candidate generation: trgm fuzzy match on name (threshold ~0.4), OR exact
   email match (email match alone is sufficient — it's inherently unique).
2. Confirmation: require **≥2 corroborating signals** among {company match,
   title similarity, location match, email match, LinkedIn URL match} before
   linking. One signal → treated as new, but the near-miss is recorded in
   `email_source_note` for auditability.
3. Matched to a Salesforce contact → adopt its data (email!, title, account
   id). Matched to a prior-run lead → reuse that lead row (and its already-
   enriched email), add it to this campaign via `campaign_leads`.
4. No match → insert new `outreach.leads` row (Outreach ID minted).

## Stage E — Selective web research (the fan-out)

> Full specification with the worker state machine, verbatim prompts, query
> templates, evidence-grading rules, failure taxonomy, rate-limit/resume
> behavior, and caching: **[09-web-enrichment-spec.md](09-web-enrichment-spec.md)**.

Select only people in the current upload whose email, company, title, or
location is missing, plus people whose current email is inferred or a
`format_guess` and can be upgraded. Known-company people collapse to one company job; a
person with no company gets a person-scoped job so current employer can be
researched without inventing a placeholder company. Filled fields are passed
as disambiguation context but are explicitly excluded from the requested-field
list and cannot be overwritten.

- Fan out N parallel research workers (Claude agent calls with web search),
  batched like the prototype (≈20 companies/batch, 4 concurrent).
- A person-scoped job requests **company only** and performs no email search,
  scraping, or inference. If the company passes the write gate, the system
  enqueues a company-scoped follow-up for the still-missing title, location,
  and/or email. If company remains blank, email remains blank.
- Before any cache-based inference or paid research, a bounded deterministic
  preflight crawls the known company domain. It uses generated nested/locale
  people/contact paths, navigation/application route clues, robots/sitemaps,
  retries, global/per-host backpressure, managed-browser recovery for JS
  shells, capped local image OCR, common obfuscation decoders, first-party
  PDFs, and alias-aware person binding. Every attempt is classified; no page,
  renderer, or OCR failure may terminate the enrichment run.
- Existing inferred emails are not treated as permanently solved. They receive
  the same free preflight and can be upgraded to direct during an already-needed
  profile research job, without creating an extra paid job solely for upgrades.
- A domain without usable format evidence is not promoted to normal inference.
  It remains `format_guess` and triggers company rescue shards of at most five
  unresolved people. One/two people receive five searches; three–five receive
  ten. Rescue starts from persisted deferred queries, rejected literals,
  uncited format claims, and failed high-value paths rather than restarting.
- Each worker receives the known company/person context and an explicit
  per-person `requested_fields` list. Known-company calls hunt for literal
  emails (only for people missing email) and direct evidence for only the
  missing `title` and/or `location` fields.
- Profile-field write gate: **no inference**; model confidence alone is not
  sufficient. Prefer two independent source families agreeing on the same
  value. One first-party/professional-profile source may pass only when at
  least two supplied identity attributes (title, location, known email)
  corroborate that exact person. Low-confidence, unauthoritative, conflicting,
  or generic evidence stays blank.
- Immediately after each first-pass job finishes, each row with a still-blank
  requested profile cell gets one **profile rescue** job. Rescue jobs are
  one-person shards on a separate concurrency lane, so they trail completed
  rows instead of waiting for the whole run or consuming first-pass worker
  slots. They use the refreshed accepted fields plus first-pass candidates,
  evidence, domain, and notes; at most two Haiku web searches may verify the
  strongest candidate and inspect one newly enabled source avenue.
- Rescue never relaxes the write gate and never performs email work. Prior
  evidence is merged only when person, field, and normalized value agree; the
  combined evidence must pass the same independent application gate. Filled
  cells are re-read immediately before enqueue and skipped. Rescue completion
  remains part of the row/run's enrichment work, but overlaps the remaining
  first-pass jobs.
- `location` means the named person's actual work location. Company HQ,
  billing/mailing addresses, generic office pages, event locations, hometowns,
  schools, and employer-derived guesses are categorically rejected.
- Search sources: Anthropic's `web_search` tool (primary) + a self-hosted
  SearXNG fallback (09 §3.4). Result snippets from RocketReach/ZoomInfo/
  SignalHire-type pages are treated as *format evidence*, never as verified
  addresses (masked `j***@co.com` ≠ confirmed). RocketReach/ZoomInfo receive
  purposeful late-stage percentage queries and must provide a structured URL.
- Worker output additionally includes `profile_findings[]`, each with person,
  requested field, value, confidence, reasoning, and two or more quoted source
  records (`url`, source type, person-specific flag, and location scope).
- Accepted profile writes store field-level provenance in
  `leads.profile_enrichment`; Review and XLSX use it to color only web-enriched
  company/title/location cells light blue. Email cells are never colored blue.
- A web-direct write first attempts an independent citation re-fetch. A
  confirmed exact person+company-domain email is accepted normally. If the
  model supplied a real URL and exact person+email quote but the attempted
  re-fetch is blocked, times out, moved, or no longer visible, it may enter a
  provisional Found state with AgentMail pending. Contradictory/missing
  evidence is rejected; a bounce removes the provisional address and resumes
  targeted rescue. URL, quote, hash/outcome, method, and time remain visible in
  `leads.direct_email_evidence`.
- Results are cached in `outreach.companies.email_formats` — cross-campaign,
  cross-user cache; the second campaign that hits "TA Associates" pays zero
  search cost.
- No usable domain found → lead's email fields stay blank,
  `email_status='not_found'`, flagged in output (prototype step 8: never
  guess without a domain).

## Stage F — Email assignment (deterministic, zero LLM)

Priority order per person:

1. **Found**: uploaded/Embark DB email or independently re-verified literal
   research result (internal statuses `direct` / `from_embark_db`).
2. **Evidence-based pattern inference** → `'inferred'`: apply only the
   company's known/cited format(s)
   to the person's name. Supported pattern codes: `first.last`, `flast`,
   `first`, `firstlast`, `first_last`, `firstl`, `f.last`, `last.first`.
   - One known format → primary = that pattern; alternates = next two most
     common global patterns.
   - Multiple known formats (the brief's multi-format rule) → generate a
     candidate from **each** format, up to 3 total (`email_primary`,
     `email_alt_1`, `email_alt_2`), ordered by format confidence. Future
     drafting module tries all three and watches bounces.
3. **Blind global-default candidates** → `'format_guess'`: visible for audit,
   but operationally unresolved and not send-ready.
4. Nothing/no domain → `'not_found'`, blank, flagged.

Same inputs always produce the same emails. Pattern application handles
hyphens, apostrophes, and unicode (José → jose) deterministically.

## Stage G — Prior-relationship derivation (SQL against the mirror)

Two distinct lookups (the brief correctly treats these as separate):

**G1. Contact-level last touch** — for leads matched to a Salesforce contact:
- `call_participants` where `participant_email` = contact email (or matched
  name + account): latest `meeting_date`, and the Embark-side participants of
  that meeting (`is_embark_employee = true` → `emp_name`, `participant_email`).
- Output: `Last Contacted (date)`, `Last Contacted By (Embark employee name)`.
- Unmatched leads: blank (no relationship).

**G2. Company-level relationship ("Past Work")** — via the matched account id
(or fuzzy account-name match for non-Salesforce companies):
- `opportunities` for that account: any `is_won=true` (or Closed Won stage) →
  **`Work done`**; else any opportunity history at all (regardless of stage —
  scoped-and-lost and still-open deals both count; this must NOT depend on
  `last_activity_date`, which is null on over half of opportunity rows) OR
  any contact-level touchpoint (meeting rows) → **`Previously connected`**;
  else blank (no relationship).
- **Binary by design (decided 2026-07-14, see 07-flags.md):** originally a
  three-tier split (`Work done` / `Pitched` / `Connected`), collapsed to two
  because the Pitched/Connected distinction wasn't reliable enough to be
  useful — both mean "not cold" to a BD rep.
- Classification is a fixed SQL decision tree — deliberately coarse, per the
  brief: the future email module should only signal an ambiguous level of
  familiarity, never guess details.
- Also derive `Prior Relationship Date` = most recent of (last opportunity
  activity, last meeting with anyone at the company) — see 07-flags.md #3 on
  the ambiguity here.

Results are frozen into `campaign_leads.relationship_snapshot` at enrichment
time (so a sheet reviewed today doesn't silently reshuffle colors when the
mirror refreshes; re-running enrichment refreshes the snapshot).

## Stage H — Verification & run completion

- Deterministic checks: row counts in == rows out + warned; email regex
  validity; no duplicate (campaign_id, lead_id).
- Run `stats` populated; run status → `complete`; uploads → `extracted`.
- Failures at any stage mark the run `failed` with a human-readable `error`
  and preserve partial progress (per-file granularity).

## Cost & latency posture

- LLM calls: 1 vision call/image, 1 mapping call/CSV, ~1–2 search-augmented
  calls/uncached company. Everything else is SQL + code.
- Model choice: extraction & research on Sonnet-class; the CSV column-mapping
  call on Haiku-class. (Exact models pinned at build time.)
- The company cache is the compounding cost saver — mature usage converges
  toward zero research calls for repeat firms (PE outreach hits the same
  firms constantly).
