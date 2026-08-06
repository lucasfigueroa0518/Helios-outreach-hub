# Planning — Lead Enrichment CSV Generator ("Outreach Hub")

Planning docs for the Outreach system: multi-media lead intake → extraction →
enrichment → reviewable enriched output per campaign, followed by the new
research-backed email-drafting workspace.

**Scope boundary:** Docs 01–11 remain the authoritative specification for the
original enrichment module and still treat Draft as a stub within that module.
Drafting is now specified separately under
[`drafting/`](drafting/README.md). The drafting plan consumes enrichment
outputs without reopening enrichment decisions or permitting database sweeps.

## Read in this order

| Doc | Contents |
|---|---|
| [01-scope.md](01-scope.md) | What we're building, what we're not, success criteria |
| [02-data-model.md](02-data-model.md) | Tables, ID strategy, idempotent bootstrap + PKs, merge dedup rule |
| [03-enrichment-pipeline.md](03-enrichment-pipeline.md) | Pipeline overview + the LOCAL-FIRST governing principle |
| [04-output-spec.md](04-output-spec.md) | Column-by-column output contract, formatting & color standards |
| [05-ux-flow.md](05-ux-flow.md) | Login, Outreach Hub, campaign screens, segmented control, upload/review states |
| [06-api-architecture.md](06-api-architecture.md) | Routes, auth, storage, Replace semantics (job model superseded by 10) |
| [07-flags.md](07-flags.md) | Decision log (2 rounds) + resolved contradictions |
| [08-extraction-spec.md](08-extraction-spec.md) | **DEEP SPEC** — vision/multi-media extraction: verbatim prompts, schemas, edge-case matrix, fixtures |
| [09-web-enrichment-spec.md](09-web-enrichment-spec.md) | **DEEP SPEC** — online email enrichment: waterfall, research worker, caching, rate-limit/resume |
| [10-jobs-and-events.md](10-jobs-and-events.md) | Historical Inngest contract inventory (superseded by 12) |
| [11-execution-checklist.md](11-execution-checklist.md) | **START HERE TO BUILD** — milestone order M0–M8 with acceptance criteria |
| [12-postgres-orchestration.md](12-postgres-orchestration.md) | Durable Postgres queue, worker, leases, lanes, reconciliation, operations |
| [drafting/README.md](drafting/README.md) | **NEXT FUNCTIONALITY** — mailbox-valid-only cited research/drafting, Email/Leads review modes, retries, and exports |
| [porting-report-standalone-fork.md](porting-report-standalone-fork.md) | **FORK HANDOFF** — upgrades from 2026-07-24→2026-07-29 with presence probes + phased port steps for a re-skinned standalone copy (delta only; does not replace 01–12 or drafting specs) |

**For enrichment implementation:** read 11 first, then the deep spec for the
milestone you're on. Verbatim blocks (prompts, schemas, SQL patterns,
thresholds) are non-negotiable; when docs conflict, deeper spec wins
(08/09/10 > 02–06).

**For drafting implementation:** read `drafting/README.md`, then its seven
linked specs in order. Those docs govern drafting only; 08/09/10 continue to
govern the enrichment behavior drafting consumes.

## One-paragraph summary of the build

A user opens Outreach Hub, creates/opens a Campaign, and uploads any mix of
screenshots, PDFs, CSVs, decks, or docs containing leads. Each upload batch is
a **Run** (tagged with run ID + user ID) inside that campaign. The pipeline
extracts every person into rows, dedupes against the Embark contact database
(fuzzy match, ≥2 corroborating signals), enriches missing emails via
Embark-DB-first → web search → company-email-format inference (up to 3
candidate emails), derives prior-relationship columns from opportunities +
call-participant history, and appends the enriched rows to the campaign's
cumulative lead sheet. The Review tab shows the sheet in-app with
relationship color coding; Export produces the deliverable file.
