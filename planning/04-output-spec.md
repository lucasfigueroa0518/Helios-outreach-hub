# 04 — Output spec (the enriched sheet)

## ⚠️ Format decision (see 07-flags.md #2)

The brief asks for "a CSV file" **and** row color-fills. CSV cannot carry
colors. Proposed resolution (needs your sign-off):

- **In-app Review viewer**: renders colors (this is where color coding
  actually earns its keep day-to-day).
- **Export**: two buttons — **Export XLSX** (colors, formatting, the real
  deliverable) and **Export CSV** (plain data + a `Relationship Tier` text
  column standing in for the color, so no information is lost).
- The drafting module reads from the database, not the file, so the export
  format doesn't constrain it; see [`drafting/`](drafting/README.md).

## Columns

"Mandatory" = always present as a column. "Conditional" = column appears only
when ≥1 row in the campaign has a value (per the brief). Within a row, a
mandatory *column* can still have an empty cell (e.g. email not found) — it's
flagged, not hidden.

⚠️ **Internal fields vs. displayed fields (decided 2026-07-14, see
07-flags.md round 10):** `ID` and `Company ID` are necessary for identity-
resolution/matching *logic* and are tracked internally on every lead, but are
**never shown** in any user-facing surface (Review tab, CSV, XLSX) — they're
Salesforce/Outreach primary keys, meaningless to a BD rep. Likewise, the exact
`Prior Relationship Date` is computed and used internally (it drives the
6-month tier calc), but what's actually **displayed** is a derived binary
field, `Prior Relationship Activity`, described below.

| # | Column | M/C | Content & format standard |
|---|---|---|---|
| 1 | `First Name` | M | Normalized per Name Standard (below) |
| 2 | `Last Name` | M | Normalized per Name Standard; credentials stripped |
| 3 | `Credentials` | C | `CPA`, `CFA, CPA` — only if any row has them |
| 4 | `Email` | M | Primary email. Blank = not found (flagged) |
| 5 | `Email Status` | M | `Found` / `Inferred` / `Format Guess` / `Not Found` — the honesty column; drafting reads this. `Found` combines uploaded, Embark-DB, and independently re-verified literal addresses; `Inferred` requires cited company-format evidence; `Format Guess` is a visible but unresolved blind heuristic and must not be treated as send-ready |
| 6 | `Email Alt 1` | C | 2nd-format / 2nd-pattern candidate |
| 7 | `Email Alt 2` | C | 3rd candidate |
| 8 | `Job Title` | M | As found; title-case preserved from source |
| 9 | `Company` | M | Canonical company name |
| 10 | `Location` | M | `City, ST` (US) / `City, Country` — normalized |
| 11 | `Past Work` | M | `Work done` / `Previously connected` / blank — company-level, from opportunities (03 §G2) |
| 12 | `Prior Relationship Activity` | M | `Within 6 months` / `Older than 6 months` / blank (no relationship) — derived from the internal `Prior Relationship Date` + the same 6-month cutoff that drives the color coding; never shows a raw date |
| 13 | `Last Contacted` | C | `YYYY-MM-DD` — contact-level last touchpoint (meetings data) |
| 14 | `Last Contacted By` | C | Embark employee name (+ email in parens) from that touchpoint — the "who last talked to this lead" the BD rep needs |
| 15 | `LinkedIn` | C | URL when the input provided it |
| 16 | `Notes / Flags` | C | Data-quality flags: `no domain found`, `extraction low-confidence`, `near-miss match: <name>` |

`ID` and `Company ID` are NOT in this table — they exist as internal fields on
`outreach.leads` (used for matching/identity logic per 02, 03 §D) but are
excluded from every displayed/exported column set by design.

Ordering rationale: identity → contactability → firmographics → relationship
context → audit. Columns the drafting module needs most (Email Status, Past
Work) are mandatory even when sparse.

## Name Standard (the "contact standards" referenced here and in 02)

Applied to DISPLAY names (the `First Name` / `Last Name` columns and
`leads.first_name/last_name/full_name`). This is separate from — and must NOT
be confused with — the email-construction name-prep in 09 §6 (which
lowercases and strips accents FOR building an email address only; display
names keep their real casing and accents).

Rules, in order, deterministic (`lib/name-standard.ts`):
1. **Trim** and collapse internal whitespace to single spaces.
2. **Strip credential/degree suffixes** into the separate `Credentials`
   column: `CPA, CFA, CA, MBA, PhD, JD, CMA, CIA, EA, MD, Esq` (and
   comma/space-delimited combos). Match case-insensitively as trailing
   tokens only; store them uppercased, comma-joined (`CFA, CPA`).
3. **Strip generational suffixes** (`Jr, Sr, II, III, IV`) — keep on the last
   name only if the source clearly attaches it (append back as ` Jr.`), else
   drop. Never treat these as credentials.
4. **Casing:** Title Case, but PRESERVE already-correct internal caps
   (`McKinsey`→`McKinsey`, `O'Brien`→`O'Brien`, `van der Berg`→`van der
   Berg`, `LaSalle`→`LaSalle`). Algorithm: if a token is ALL-CAPS or
   all-lowercase, title-case it; otherwise leave the source casing intact
   (it was deliberate). Lowercase particles `van der`, `de`, `von`, `la`
   when they sit between other name tokens.
5. **Accents/unicode preserved** (José stays José). NFC-normalize only.
6. `full_name` = `First Name` + space + `Last Name` after the above (does not
   include stripped credentials/suffixes).

If a source provides only a single `name` field, split on the last
whitespace into first/last before applying (a single token → first name,
empty last). These rules are the same whether the person came from a
screenshot, a CSV, or an existing `contacts` row.

## Formatting standards

- Dates: ISO `YYYY-MM-DD` everywhere. No times in the sheet (times live in
  the DB).
- Names: `First` `Last` capitalization normalized (handle `van der`, `McN`,
  all-caps sources).
- Company: canonical form without legal suffixes (`, Inc.`, `LLC`) unless the
  suffix is distinguishing.
- Empty = truly unknown. Never `N/A`, `-`, or `unknown` strings.
- One row per person per campaign. A person in 3 campaigns appears in each
  campaign's sheet; within a campaign, always exactly once.

## Color coding — DECIDED (two separate surfaces, no conflict)

The in-app viewer and the exported Excel use **different color systems on
purpose**, because the Excel file lives on the user's local machine and is
effectively separate from the app. (Decision: user, 2026-07-13.)

### Surface 1 — In-app Review viewer: field provenance + status colors

Color is applied only where it communicates a specific field/status:

| Signal | Meaning | Color |
|---|---|---|
| Non-email enrichment | Company, job title, or location was populated by accepted web research | light blue cell |
| Missing email | No usable email after the permitted waterfall | missing-data tint |
| Prior relationship | Legend key for either recency state | one pill split red/orange |
| Past lead | This campaign reused a person row created by an earlier enrichment run | teal row + explicit `Past lead` badge |

Relationship recency in-app is shown as a **small chip/badge per row**, never
a row fill. The legend combines the red and orange states into one
`Prior relationship` pill and does not show a `No prior relationship` pill.
Email enrichment never receives the light-blue provenance color.
Past-lead provenance is campaign-specific and UI-only: it remains visible as
a teal badge even when missing-email or field-level colors take precedence.

### Surface 2 — Exported Excel: RELATIONSHIP-RECENCY row fills

A single `relationship_tier` computed at enrichment time, applied as full-row
fill in the `.xlsx` export:

| Tier | Rule | Fill |
|---|---|---|
| `active` | Most recent Embark↔(lead OR their company) activity is within the last **6 months** | **Red** (recent = hot) |
| `dormant` | Prior activity exists but the most recent is **older than 6 months** | **Orange** (older = warm) |
| `cold` | No prior relationship found | No fill |

- Color mapping **decided (user 2026-07-13): red = recent, orange = older.**
- **"Most recent activity" = `max`(contact-level last touch, company-level
  last activity)** — i.e. whichever date is *closest to today*. Not `min()`;
  see 07-flags.md #3 for the worked example. Rule matches "active
  relationship of ANY kind within 6 months": if *either* the person or the
  company was touched recently, the row is `active`.
- The plain-CSV export carries a `Relationship Tier` text column
  (`active`/`dormant`/`cold`) in place of the fill, so no info is lost.

## Review-tab viewer requirements (consumes this spec)

- Sticky header row, horizontal scroll inside the card, ~50 rows/page.
- Field-level non-email enrichment color; missing-email row tint;
  relationship activity + Email Status rendered as subtle chips; past-lead
  reuse rendered as a teal row and explicit badge.
- Email-status chips: `Found` dark green; `Inferred` standard green;
  `Format Guess` light yellow; `Not Found` neutral gray.
- Read-only. Export XLSX / Export CSV / Upload & Replace buttons (left),
  Go to Drafting (right; behavior in the drafting plan).
- Campaign sheet = all runs' leads merged, newest additions indicated subtly
  (e.g. "added in latest run" dot) so incremental runs feel seamless.
