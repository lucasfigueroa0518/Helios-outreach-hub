# 05 — UX flow

All UI built with the **embark-dashboard-design** skill
(`.agents/skills/embark-dashboard-design`): tokens from `app/globals.css`,
component grammar from `app/components.css`. No hardcoded colors/spacing/
radii/shadows; no new container shapes — check
`reference/component-recipes.md` before any new pattern. The segmented pill
control the brief describes matches the skill's existing segmented-control
recipe almost exactly — reuse it, don't rebuild it.

## Screen 0 — Login (passwordless, email-only)

First thing an unauthenticated visitor sees. Deliberately minimal:

- Embark-branded card, single **email input** ("Enter your Embark email"),
  one **Continue** button.
- On submit: validate the address ends in `@embarkwithus.com` (reject others
  with an inline message). If valid → find-or-create the `outreach.users`
  row, establish a session, land on the Outreach Hub. **No password, no
  verification email, no waiting** — enter email, you're in.
- Returning users: same box, same one step (it just recognizes the existing
  account).
- Security reality noted in 07-flags.md #6 — acceptable for an internal v1;
  hardening (magic-link verification / SSO) is a later, non-blocking upgrade.

## Screen 1 — Outreach Hub (dashboard)

- Title: **"Outreach Hub"**.
- Primary button: **"+ New Campaign"** → modal (card + overlay per drawer/
  modal recipe): name input prefilled `Campaign #N` (per-user ascending),
  **Create** button.
- Below: campaign list — drill-down list rows (existing recipe: full-width
  bars, hover state raises prominence). Each row: campaign name, lead count,
  last-run date, status. Right side, three icon+text actions:
  - **Merge** → picker modal: "Merge into…" listing the user's other active
    campaigns; confirm → target keeps its existing name and source archives
    into it (semantics in 02 and settled decision in 07).
  - **Rename** → inline or modal text edit.
  - **Archive** → row moves to a collapsed "Archived" section (recoverable;
    no hard delete in v1).
- Empty state: short explainer of what a campaign is + the New Campaign CTA.

## Screen 2 — Campaign view

- Campaign title at top (inline-renameable pencil affordance).
- Directly beneath: **segmented control** — pill container, light background,
  fully rounded; three tabs, each icon + short label, small font, small
  icon-label gap, horizontal padding per tab; active tab = white rounded-full
  chip with subtle shadow + dark text; inactive = transparent, muted gray,
  no shadow; ~150ms background/shadow transition:
  1. **Upload** (upload-cloud icon)
  2. **Review** (table icon)
  3. **Draft** (mail icon) — implemented by the separate drafting plan
- **Stage availability**: clicking Review before any completed run fires
  "Upload files and run enrichment before reviewing." Draft becomes available
  only for campaign leads from a completed enrichment run; its continuous,
  non-batch-gated behavior is specified in
  [`drafting/01-product-and-ux-spec.md`](drafting/01-product-and-ux-spec.md).
  Tabs stay visible (never hidden) so the journey is always legible.

### Upload tab — state 1: empty (upload-dominant)

- Edge-to-edge **dropzone** dominating the view: light blue tint
  (`--color-primary-soft` token — sits well on white), generous padding,
  upload icon + **Upload Files** button + accepted-types line
  ("Screenshots & photos (incl. iPhone HEIC), PDF, CSV, Excel, PowerPoint,
  Word, text").
- Entire zone is clickable and drag-and-droppable; hover state per tokens.
- Below the zone: plain-language explainer for a user who knows nothing:
  what this stage is (drop in anything containing leads), what happens next
  (we extract every person and enrich emails + relationship history), what
  they'll get (a reviewable sheet). Assume zero prior platform knowledge.

### Upload tab — state 2: files staged

- Files appear listed with type indicator + remove option — **no loading
  screen**; they're just staged.
- Primary action appears: **Enrich** button. Clicking creates a Run and
  starts the pipeline.

### Upload tab — state 3: run in progress / history (listed-uploads view)

- Layout shifts from upload-dominant to list view. Section titled
  **"Uploads"**; header row has two buttons (icon + text):
  **Upload More** and **Go to Review**.
- One bar per file (drill-down row recipe): file name + type icon, upload
  date/time, status chip — `Processing` (animated) or `Enriched`; `Failed`
  state with reason on hover/expand.
- A compact run-progress line (e.g. "Extracting people… 3/8 files") — honest
  progress, not a fake spinner. Live updates via Supabase Realtime or
  polling.
- Go to Review before the run finishes → allowed once ≥1 run has completed
  (sheet shows completed data; banner notes a run is still in progress).

### Review tab

- The enriched sheet in a read-only table (sticky-header data-table recipe,
  row fills per 04's tier colors, legend chip row above).
- Left buttons: **Export XLSX**, **Export CSV**, **Upload & Replace**
  (user's local version-control loop). **Replace = hard overwrite** (decided,
  07-flags.md #7): the uploaded file becomes the campaign's authoritative
  lead set. A confirm dialog warns it will overwrite current campaign data
  before it commits.
- Right button: **Go to Drafting** → explicit paid-work authorization and
  navigation per the drafting plan.
- Sheet accumulates across runs; latest-run additions get a subtle marker.

### Draft tab

- The complete research, missing-information, one-at-a-time review, retry, and
  export experience is specified under [`drafting/`](drafting/README.md).

## Notifications

- One toast pattern (design-skill recipe) for: stage gating, run completion
  ("Run finished — 42 leads added, 3 need attention"), failures, merge/
  rename/archive confirmations.

## Brief truncation note

The brief's sentence "there's three stages of the campaign that you can
toggle through in a" cuts off — resolved by the later description as the
segmented control. Also "date of prior relationship — This is" cuts off; our
interpretation is in 04 (#14) and flagged in 07-flags.md #3.
