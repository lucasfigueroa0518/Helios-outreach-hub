# 02 — Data model

## Existing tables — these are OUR data (decided, user 2026-07-13)

`accounts`, `contacts`, `opportunities`, `call_participants`,
`pitchbook_firms`, `pitchbook_sister_cos` — see [db/schema.sql](../db/schema.sql).

These were **seeded once** from a Salesforce/BigQuery export, but going
forward we treat them as **first-class, owned, writable tables** in our
Supabase database — not a read-only mirror. Concretely:

- **We read, insert, and update rows** in these tables normally (e.g.
  `contacts`), the same as any table we own.
- **No continuous refresh in this project.** This is a satellite build. A
  future larger system will handle live Salesforce → DB updates and refactor
  how these get populated; we don't design around live syncs now.
- **The load is one-time, not destructive-on-repeat.** The current
  `db/schema.sql` uses `DROP TABLE IF EXISTS` — a build task (see 06) is to
  make loading a one-time bootstrap so we never re-run a destructive load
  against accumulated data, and to add real primary keys.

## Idempotent bootstrap & primary keys (DECIDED — audit round, 2026-07-13)

The current `load_data.sql` **appends** on every execution and no table has a
PK — a double-load silently duplicates every row. Fix, implemented as
`db/bootstrap.sql` (replaces direct use of schema.sql + load_data.sql):

1. `CREATE TABLE IF NOT EXISTS ...` (never `DROP`).
2. Primary keys / uniques added after create:
   - `contacts (id)`, `accounts (id)`, `opportunities (id)` — PK.
   - `call_participants` — `GENERATED ALWAYS AS IDENTITY` surrogate PK +
     `UNIQUE (meeting_id, participant_seq)`.
   - `pitchbook_firms` — surrogate PK + unique on `(company_id, row_id)`.
   - `pitchbook_sister_cos` — surrogate PK + unique on
     `(company_id, investor_id, row_id)`.
3. Loading path: `\copy` into a `TEMP` staging table with the same shape,
   then `INSERT INTO <table> SELECT ... FROM staging ON CONFLICT DO NOTHING`.
   Running the loader twice is a no-op, not a duplication.
4. `npm run db:schema` / `db:load` scripts repointed at the bootstrap flow.

## Why leads still get their own table (user-approved)

Even though `contacts` is now writable, new leads go in a **separate
`outreach.leads` table** — purely because of shape, not refresh risk:

- `contacts` has **146 Salesforce-shaped columns**; a lead has ~12 meaningful
  fields. Writing leads into `contacts` means null-flooding 130+ columns per
  row and bending lead data into a Salesforce schema it doesn't fit.
- `contacts.id` is a Salesforce 18-char id; leads have no Salesforce id and
  need their own Outreach ID as primary key.

The brief's real requirement — "future runs can reference prior runs'
contacts" — is preserved by the `all_people` union view (below): identity
resolution searches `contacts` **and** `outreach.leads` together. Reads span
both; new people are written to `outreach.leads`; a lead that later gets a
real Salesforce id can be promoted/linked via `sf_contact_id`.

## New tables

All new tables live in the `outreach` schema (namespacing only — keeps our
app tables grouped and lets RLS/permissions differ from the seeded tables).

### `outreach.users`
Passwordless email-only auth (decided, user 2026-07-13). Flow: user types
their `@embarkwithus.com` email → account is found or created and they're
immediately signed in. No password, no email-verification step in v1. See
05 for the login screen and 07-flags.md #6 for the security caveat.

| column | type | notes |
|---|---|---|
| id | uuid PK | user id |
| email | text unique | must end in `@embarkwithus.com` (validated at signup) |
| display_name | text | derived from email local-part on creation; editable |
| created_at | timestamptz default now() | account auto-created on first login |
| last_login_at | timestamptz | |

### `outreach.campaigns`

| column | type | notes |
|---|---|---|
| id | uuid PK default gen_random_uuid() | |
| name | text not null | default "Campaign #N" — N is per-user ascending (compute as count of user's campaigns + 1 at creation; user-renameable) |
| owner_id | uuid FK → users | |
| status | text check in ('active','archived') | Archive button in list UI |
| merged_into_id | uuid FK → campaigns, null | set when this campaign is merged away; see merge semantics below |
| created_at / updated_at | timestamptz | |

**Merge semantics — DECIDED (user, 2026-07-13):** merging B into A creates
*no new campaign* and does *no* name concatenation. **A is the survivor and
keeps its own name**; all of B's `campaign_leads` are appended (stacked) onto
A; B gets `status='archived', merged_into_id=A.id`. The point of merge is
purely "bring two campaigns under one umbrella."

**Merge dedup — conservative, entity-level only (UPDATED, audit round
2026-07-13):** after stacking, dedupe *people* (not arbitrary rows) using
**four signals: {name, company, job title, email}** and collapse only when
**≥3 of the 4** fuzzy-match. Constraint: **email may contribute at most ONE
signal** — matching multiple email columns (primary + alternates) still
counts as a single signal, because inferred alternates are pattern-generated
and would trivially self-match (name + company + email is valid;
email + email + name is NOT). Fuzzy = `pg_trgm` similarity ≥ 0.55 for name/
company/title; email compares case-insensitive exact across each side's
{primary, alt_1, alt_2} sets. Two leads that survive as distinct are kept;
only high-confidence exact-person duplicates are merged (into a single
`campaign_leads` entry pointing at one `leads` row). This is a safety net for
cases where per-run identity resolution (Stage D) didn't already link them.

Survivor (A) = the campaign the user clicked **Merge from** (confirmed,
user 2026-07-13).

### `outreach.runs`
One per "user clicked Enrich on a batch of uploads."

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| campaign_id | uuid FK → campaigns | |
| user_id | uuid FK → users | who executed the run |
| status | text | 'uploading' → 'extracting' → 'enriching' → 'complete' / 'failed' |
| stats | jsonb | counts: files, people extracted, matched existing, new leads, emails found direct / inferred / missing |
| error | text null | |
| started_at / finished_at | timestamptz | |

### `outreach.uploads`
One per file, belongs to a run.

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| run_id | uuid FK → runs | |
| file_name / mime_type / byte_size | | shown in the Uploads list UI |
| storage_path | text | Supabase Storage object path |
| content_hash | text | sha256 of bytes; index — powers extraction cache (08 §7) |
| status | text | 'uploaded' → 'processing' → 'extracted' / 'failed' / 'failed_quality' |
| extraction_summary | jsonb | e.g. { people_found: 37, pages: 4, warnings: [...] } |
| created_at | timestamptz | |

### `outreach.leads`
The lead master — one row per unique *person* we've ever extracted.
Accumulates across all campaigns (the brief's "add to contacts table as
leads" intent).

| column | type | notes |
|---|---|---|
| id | uuid PK | this IS the "Outreach ID" for people not in Salesforce |
| sf_contact_id | text null FK-ish → contacts.id | set when identity resolution matched an Embark contact |
| first_name / last_name / full_name | text | normalized per the Name Standard (04 §Name Standard); credential suffixes stripped to `credentials` field |
| credentials | text null | CPA, CFA… |
| title | text null | |
| company_name | text null | |
| company_id | text null | Salesforce account id if matched |
| outreach_company_id | uuid null FK → outreach.companies | when company is not in Salesforce |
| location | text null | |
| email_primary | text null | |
| email_alt_1 / email_alt_2 | text null | pattern-inferred candidates |
| email_status | text | 'direct' / 'inferred' / 'not_found' / 'from_embark_db' |
| email_source_note | text | audit: where it came from |
| email_verification | text null | trailing MX result: 'ok' / 'no_mx' / 'unknown' / null=pending (09 §7). Catch-all detection deferred to future paid API |
| direct_email_evidence | jsonb | for web-direct results: source URL, nearby source quote, page hash, extraction method, and independent validation timestamp |
| profile_enrichment | jsonb | field-level provenance for accepted company/title/location web enrichment |
| linkedin_url | text null | optional; captured only if present in input. NOTE: connection *degree* (1st/2nd/3rd) is NOT stored — it's relative to the screenshotting rep, not a property of the lead (audit round #9) |
| source_run_id | uuid FK → runs | run that first created this lead |
| created_at / updated_at | timestamptz | |

Lead properties map to the contact-field set defined in the original build
prompt. No rep-relative fields (see `linkedin_url` note).

### `outreach.companies` — DOMAIN-keyed domain facts (cache-poisoning fix, #2)
Keyed by **`domain`**, not by company name. A domain is unambiguous, so this
layer can never be poisoned by two same-named companies. Holds only
domain-level facts.

| column | type | notes |
|---|---|---|
| id | uuid PK | the company "Outreach ID" (for lead FK) |
| domain | text UNIQUE NOT NULL | the hard cache key |
| email_formats | jsonb | ordered [{ pattern, confidence, share_pct, source: 'embark_data'|'web_research' }] |
| mx_status | text null | 'ok' / 'no_mx' / 'unknown' (09 §7). Catch-all detection deferred to future paid API |
| verified_at | timestamptz null | MX-check freshness |
| researched_at | timestamptz null | format-research freshness |
| scrape_paths | jsonb | up to 12 previously successful first-party paths, reused as the next run's free crawl priority |
| scrape_checked_at | timestamptz null | last reactive deterministic crawl; no full HTML is retained |
| source | text | 'embark_data' / 'web_research' — embark_data outranks web |

### `outreach.company_resolutions` — name-in-context → domain (invalidatable)
Separates the *ambiguous* mapping (name → domain) from the unambiguous
domain facts above. This is where collision safety lives.

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| normalized_name | text | Stage C canonical company name |
| disambiguation_hash | text | stable hash of sorted {person names, titles, location} that scoped the research |
| resolved_domain | text null | FK-ish → companies.domain; null = none found |
| confidence | text | 'confirmed'/'likely'/'ambiguous'/'none' |
| evidence | text | URL + why |
| created_at | timestamptz | |
| UNIQUE(normalized_name, disambiguation_hash) | | two same-named firms in different contexts resolve independently |

Reuse a resolution only when normalized_name matches AND the disambiguation
context is sufficiently similar AND `confidence >= 'likely'`; else
re-research. **"Sufficiently similar" (concrete rule):** reuse iff at least
one person full-name from the new context exactly matches one in the stored
context, OR trigram similarity of the two sorted-context strings ≥ 0.6.
Rows are deletable to force re-research (e.g. after bounces).
`sf_account_id` linkage for a known company lives on a resolution row whose
domain matches the account's contact-email domain.

### `outreach.campaign_leads`
Join table — the campaign's cumulative sheet is `campaign_leads ⋈ leads`.

| column | type | notes |
|---|---|---|
| campaign_id | uuid FK | |
| lead_id | uuid FK | |
| run_id | uuid FK | which run added this lead to this campaign |
| relationship_snapshot | jsonb | computed prior-relationship fields frozen at enrichment time (last touch date, last touch embarker, past_work class, company last activity) — see 03 Stage G/H for how these are derived and frozen |
| PK (campaign_id, lead_id) | | same person added twice to one campaign = one row (dedup) |

## Views

### `outreach.all_people`
Union view over `contacts` (id, name, email, title, account) ∪
`outreach.leads` — kept for convenience reads and ad-hoc queries only.

**Identity-resolution queries do NOT use the view (DECIDED — audit round
2026-07-13).** `pg_trgm` GIN indexes cannot exist on a view, and
similarity-ordered queries across a `UNION ALL` often fail to push down.
Instead, Stage D issues **two separate indexed queries** — one against
`contacts` (trgm GIN on `name`, btree on `lower(email)`), one against
`outreach.leads` (trgm GIN on `full_name`, `company_name`; btree on
`lower(email_primary)`) — and **merges the candidate lists in app code**
(normalize both shapes to `{source, id, name, email, title, company,
location, similarity}`, sort by similarity, take top 10). Writes of new
people go only to `outreach.leads`.

## ID strategy (answers the brief's nuance directly)

- Person in Salesforce → **ID = Salesforce contact id** (18-char text) in the
  output sheet; internally the lead row still exists with its uuid +
  `sf_contact_id` link.
- Person not in Salesforce → **ID = Outreach ID** (`leads.id` uuid, rendered
  with an `OR-` prefix + short form in the sheet for readability, e.g.
  `OR-7f3a2c1d`).
- Same rule for Company ID: Salesforce account id, else `outreach.companies.id`
  rendered `ORC-xxxxxxxx`.

## Authorization model (DECIDED — build-readiness audit, 2026-07-13)

We use **custom passwordless JWT sessions, not Supabase Auth** (05, 06), and
the app reaches Postgres via the **service-role key** (`supabaseAdmin`),
which **bypasses RLS**. Two consequences a builder must honor:

- **Authorization is enforced in app code, not RLS** — but only on
  **user-owned** entities. Two distinct tiers:
  - **Owned (scope by `owner_id`):** `campaigns` (`.eq('owner_id',
    session.userId)`), and `runs` / `uploads` / `campaign_leads` which
    inherit scope via their campaign. A handler must verify the campaign
    belongs to the session user before touching anything under it.
  - **Shared knowledge tables — DO NOT scope by owner:** `outreach.leads`,
    `outreach.companies`, `outreach.company_resolutions`, and the seeded
    `contacts` / `accounts` / `opportunities` / `call_participants` are
    **global by design**. Identity resolution must search **all** leads
    regardless of who created them (that's the whole "future runs reference
    prior leads" premise), and the company cache is deliberately cross-user.
    Adding an `owner_id` filter here would break dedup and the cache. These
    have no `owner_id` column; they are read/written unscoped by server code.
  - There is no `auth.uid()` to key RLS on — Postgres never sees the custom
    session — so RLS policies would either never match or be bypassed by the
    service role.
- **RLS is NOT a security layer in v1.** Do not write `auth.uid()` policies.
  RLS becomes real defense-in-depth only if we later adopt Supabase Auth;
  until then it is out of scope. (The `outreach-uploads` storage bucket stays
  private and is reached only via server-minted signed URLs — same app-code
  scoping.)

> ⚠️ **DEFERRED — must be turned on before any real launch (tracked, not
> done).** With RLS off, the seeded tables in the `public` schema
> (`contacts`, `accounts`, `opportunities`, `call_participants`) are
> reachable through PostgREST with the public `anon` key that ships in the
> browser bundle — i.e. anyone with the app URL could read that data
> (names, emails, phones). We are intentionally deferring the fix for now
> (there's a valid v1 reason), but before this is exposed to real users we
> MUST do one of: (a) enable RLS + policies (likely alongside adopting
> Supabase Auth), or (b) `REVOKE` `anon`/`authenticated` grants on those
> tables so only the service role reads them, or (c) move them to a
> non-exposed schema. Do not ship to production without closing this.

## Postgres notes (from supabase-postgres-best-practices)
- `pg_trgm` extension for fuzzy matching; **GIN trgm** indexes on the
  fuzzy-searched columns: `leads(full_name)`, `leads(company_name)`,
  `contacts(name)`, `accounts(name)`. Email is matched **exact, not fuzzy**,
  so it gets **btree** indexes on `lower(email)` (contacts) and
  `lower(email_primary)` (leads) — NOT trgm.
- FK columns get btree indexes (Postgres does not auto-index FKs).
- The seeded tables get real PKs **as part of `db/bootstrap.sql`** (the
  §Idempotent bootstrap section above) — NOT a separate `post_load.sql`.
  There is no `post_load.sql`.

## Canonical DB-setup files (single source of truth)

To avoid ambiguity, exactly two SQL files set up the database — nothing else:

| File | Contents | Run when |
|---|---|---|
| `db/bootstrap.sql` | The six **seeded** tables (`CREATE TABLE IF NOT EXISTS`, full 146-col shape reused from the original generated DDL), their PKs/uniques, and the idempotent staged `\copy → INSERT … ON CONFLICT DO NOTHING` load. | Once at project setup; safe to re-run (no-op). |
| `db/outreach_schema.sql` | Everything in the `outreach.*` schema: all app tables, the `all_people` view, `pg_trgm` + all indexes, the Postgres **functions** (`claim_research_jobs`, `enqueue`, `finish_research_job`), and — if adopted — RLS. | Once at project setup; idempotent (`IF NOT EXISTS` / `CREATE OR REPLACE`). |

The original `db/schema.sql` + `db/load_data.sql` (destructive, no PKs) are
**superseded** by `bootstrap.sql` and should be deleted when it lands.
