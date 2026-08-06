# 01 — Scope

## 🔴 Core invariants (permanent — see CLAUDE.md)

1. **Enrich ONLY new, user-uploaded entries. NEVER sweep the database.** The
   engine enriches what a user uploads — nothing else. It must never
   proactively enrich, backfill, or batch-process anything already in the
   local DB (`contacts`/`accounts`/`companies`/`opportunities`). The local DB
   is a **lookup source only** (local-first, to *avoid* paying for web
   enrichment). If an uploaded entry matches an existing DB record, that one
   record is reused **per-case** for that upload — never as a sweep. There is
   no DB-iterating enrichment job anywhere in this plan, by design.
2. **Spend ceiling ~$1.50 without explicit user approval** (CLAUDE.md Rule 1).
   The paid path is the M6 web research; it runs only on upload-derived new
   companies, and a real batch needs the user's go-ahead.

## What we are building (this module only)

An enriched lead-sheet generator:

1. **Intake**: user uploads multi-media inputs into a campaign — screenshots
   (PNG/JPG), PDFs, CSVs, Excel, PowerPoint, Word docs, plain text.
2. **Extraction**: the system extracts every identifiable *person* from those
   inputs into structured rows (name, title, company, location, plus anything
   else present).
3. **Identity resolution**: each extracted person is checked against the
   Embark contact database (fuzzy match; require ≥2 corroborating signals
   before linking). Matched → reuse existing record + Salesforce ID. New →
   mint an Outreach ID and persist as a lead so future runs can reference it.
4. **Enrichment**: fill required fields that are missing — above all *email*
   (Embark DB → web search → firm email-format inference with up to 3
   candidate guesses), plus high-confidence job title / company / person-work-
   location triangulation when absent. Unlike email, these profile fields are
   **never inferred**: only directly sourced findings supported by two
   independent, person-specific sources may be written; otherwise they remain
   blank. Only the missing field(s) are researched.
5. **Relationship context**: derive Embark's prior relationship with the
   person (last touchpoint: who at Embark + when, from call-participant data)
   and with the company (Past Work: `Work done` / `Previously connected`,
   from opportunities history — binary, decided 2026-07-14, see 07-flags.md).
6. **Output**: a clean, user-friendly enriched sheet per campaign that
   accumulates across runs, viewable in-app with color coding, exportable.

## Explicit non-goals (do not build)

- **Email drafting / outreach generation within this enrichment module.**
  Drafting is now planned as the separate next functionality under
  [`planning/drafting/`](drafting/README.md); docs 01–11 do not define its
  implementation.
- **Salesforce writeback** — leads are NOT pushed into Salesforce; they live
  in our database with Outreach IDs.
- **Paid enrichment APIs** (Hunter.io, Prospeo, NeverBounce, Apollo) — v1
  uses Embark DB + web search only. The pipeline is designed so a paid
  verification API can be slotted in later as an additional email source /
  verifier without restructuring (see 03).
- **Editing the sheet in-app** — the Review viewer is read-only; users export,
  edit locally, and re-upload (Upload & Replace).

## Primary user & usage pattern

BD reps at Embark. Typical flow: drop a LinkedIn Sales Navigator screenshot
set (or a conference attendee PDF, or a CSV export) into a campaign, wait for
enrichment, review, export. Campaigns accumulate leads asynchronously across
many runs, potentially over weeks. Runs are self-contained and auditable
(who ran it, when, from which files, producing which rows).

## Success criteria

- Any reasonable multi-media input yields correctly extracted people rows
  with no manual re-keying.
- ≥ the current co-work prototype's email hit-rate, with honest
  Direct/Inferred/Not-found labeling (never present a guess as a fact).
- Prior-relationship columns are accurate against the Salesforce data we
  mirror, and the 6-month color coding is trustworthy at a glance.
- A second run into the same campaign merges seamlessly: no duplicate rows
  for the same person, cumulative sheet just grows.
- Deterministic where possible: the same inputs re-run should produce the
  same emails (pattern application is code, not model output — see 03).
