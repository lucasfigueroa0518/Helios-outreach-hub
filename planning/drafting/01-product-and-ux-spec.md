# Drafting product and UX specification

## 1. Experience principles

The Drafting page is an internal production workspace. It should feel fast,
calm, and legible while many independent jobs finish out of order.

1. **Useful immediately.** The first completed email appears for review without
   waiting for the last lead.
2. **Truthful progress.** Every count has one definition. The UI never presents
   an indeterminate spinner as batch progress and never counts an old draft
   while a replacement is being written.
3. **Compact by default, depth on demand.** The email is dominant. Needs-input,
   source, failure, and technical detail live in collapsible sections or a
   shared slide-over.
4. **Every count drills down.** Clicking a status count filters/navigates to
   the leads behind it.
5. **No accidental review actions.** Browsing does not approve. Typing is
   impossible until Edit is explicitly activated. Send is impossible at both
   UI and server layers.
6. **No lost work.** Manual changes persist as a hard overwrite with visible
   save state, retry safely on transient failure, flush before navigation, and
   reject stale-tab overwrites.
7. **Blanks and conflicts are first-class states.** The page asks for human
   input rather than filling uncertainty with a plausible guess.
8. **Keyboard and assistive technology are supported.** Icon-only controls
   remain fully labeled, focusable, and understandable without hover.

All visual values use the existing token system in `app/globals.css` and
component grammar in `app/components.css`. Reuse the shared card, stat tile,
data table, segmented control, drill-down row, status chip, tooltip, and
slide-over shapes. Do not introduce hardcoded colors, spacing, shadows,
radii, or animation timing.

## 2. Entry behavior and paid-work authorization

### 2.1 Review-page action

Add a primary **Go to Drafting** button on the right side of the Review
toolbar. The click:

1. disables itself and shows a compact inline pending state;
2. verifies the initial page has a complete default sender profile; when
   absent, opens the setup in §2.2 and resumes after save;
3. `POST`s the owned campaign to the drafting start/resume endpoint with an
   idempotency key;
4. creates/resumes the campaign drafting workspace;
5. snapshots/upserts the explicit campaign-lead cohort, including rows whose
   AgentMail verification is still pending;
6. queues only complete, non-current items whose effective email has
   `email_verification='valid'`; every other row enters Leads mode;
7. returns workspace ID and classification counts;
8. navigates to `/campaigns/[id]/draft`.

Double click, network retry, browser back/forward, and two tabs using the same
idempotency key must not create duplicate work.

### 2.2 First-run sender setup

If the user has no complete default sender profile, the first Go to Drafting
click opens one compact modal before paid work:

- Sender name (prefilled from the authenticated display name but editable and
  explicitly confirmed);
- Embark work email;
- Current title/role;
- Minimal signature: name only or name + role;
- Optional natural voice/professional context.

The modal explains that these are sender facts the system is not allowed to
guess. Save validates ownership/domain/required values, creates the profile,
and continues the original idempotent start automatically. The profile can be
edited later from Drafting settings; each run retains its prior snapshot.

### 2.3 Draft tab

Replace the disabled Draft span with an actionable control once a campaign
has at least one `campaign_leads` row whose source enrichment run is complete.
Extraction-only/pre-enrichment rows do not satisfy this predicate.

- If a workspace already exists and no new eligible input is present, the tab
  is a normal link and does not authorize new paid work.
- If new campaign leads exist, clicking Draft uses the same start/resume POST
  before navigating.
- A direct page GET or browser refresh only reads state. It never queues work.
- A campaign with no reviewable leads keeps Draft visibly disabled with an
  accessible explanation.

### 2.4 Cost preview

Show a projected range beside Go to Drafting before the click, based on newly
eligible leads. The start endpoint returns the authoritative recalculation.
The user is not forced through a second confirmation modal when the projection
fits the configured batch ceiling; the click itself is the human authorization
boundary. The page shows estimate and actual spend in the status details.

If projected work exceeds a configured hard batch ceiling, the endpoint
queues the affordable subset in stable ordinal order and marks the remainder
**Paused for budget**. The status strip gives that count and a **Review cost
and continue** action showing the additional maximum before authorization.
Raising/approving the ceiling creates a new explicit run and resumes those
items; it never happens automatically.

## 3. Page anatomy

Inside the existing campaign card:

1. campaign header and segmented Upload / Review / Draft navigation;
2. sticky valid-email drafting status strip and generation progress bar;
3. a two-option segmented control:
   - **Email** — the one-at-a-time gamified draft review;
   - **Leads** — every campaign lead not currently draft-ready;
4. a count badge/attention dot beside **Leads** whenever one or more rows need
   verification or profile correction; adjacent helper text in Email mode
   says `Leads require mailbox verification before drafting`;
5. the active mode's dominant surface;
6. completion/export card in Email mode when review/export rules pass.

On narrow screens, the status tiles horizontally scroll, the Leads table
becomes a stacked row editor, the Email/Leads control remains visible,
and the email card remains the first Email-mode surface. The application
remains desktop-first but must not lose controls at browser zoom up to 200%.

## 4. Sticky status strip

### 4.1 Primary status sentence

During work:

> Drafting 4 valid emails · 18 of 24 drafted

When all currently valid addresses have a current draft:

> All valid emails drafted

When review is also complete:

> All 24 valid-email drafts are approved

The sentence is backed by server-derived counts, not optimistic arithmetic.

### 4.2 Progress bar

The primary bar is **generation progress**, not review progress:

```text
current latest drafts / current campaign-associated leads whose effective
email_verification is exactly valid
```

- `generated` includes `ready_for_review` and `approved`.
- It excludes `rewriting` because the latest requested draft does not exist
  yet.
- The denominator includes every mailbox-valid lead, including a valid lead
  still missing another required profile field, failed, paused, or needing a
  research decision. Those states explain why the bar is below 100%.
- Pending, invalid, unknown, risky, accept-all, missing, and malformed emails
  are excluded until the effective address becomes `valid`.
- Removing a lead from the campaign removes it from the denominator.
- When a Leads-mode approval produces a valid result, the denominator may
  increase. The bar updates without moving the user's current email card.

The bar includes text (`18 of 24 valid emails drafted`) so color is never the
only signal. If the denominator is zero, render an empty bar with `No mailbox-
verified valid emails yet`; never display `100%` for `0 / 0`.

### 4.3 Drill-down counts

Compact clickable tiles/chips:

- Draftable now
- Mailbox valid
- Queued / running
- Generated
- Approved
- Still enriching
- Verifying
- Leads requiring attention
- Needs your decision
- Failed
- Paused for budget

Clicking a tile opens the underlying list in the existing shared slide-over or
focuses the corresponding inline section. Tile values and the list come from
the same response snapshot.

### 4.4 Polling

- Poll every 2 seconds while any server job is nonterminal.
- Poll every 10 seconds when idle but incomplete.
- Stop background polling when the tab is hidden; refresh immediately when it
  becomes visible.
- After a successful local mutation, update the affected item optimistically
  only when the transition is deterministic, then immediately revalidate from
  the server.
- Keep the last good snapshot on transient polling failure and show a subtle
  “Updates paused — retrying” message; do not blank the page.
- After repeated failures, show a Retry status control.

## 5. Leads mode

### 5.1 Membership and eligibility rule

A current campaign lead appears in Leads mode when either condition is true:

1. its effective email mailbox-verification status is anything other than
   exactly `valid`; or
2. one of the other normalized required drafting fields is missing/invalid.

Required fields remain:

- email address;
- full name (and a usable first name for greeting/export);
- company;
- title;
- work location.

Whitespace-only strings count as missing. Placeholder values (`N/A`, `-`,
`unknown`, `none`) count as missing. Email completeness requires valid syntax,
but syntax is never enough to leave Leads mode. Direct, inferred, uploaded,
database-reused, and human-entered addresses all require the same current
`valid` mailbox result.

Leads whose source enrichment run is still active are not mislabeled
invalid. They appear with `Still enriching`; when enrichment settles, the row
shows `Verifying`, `Invalid`, `Unknown`, `Missing email`, or leaves Leads mode
if it is both valid and otherwise complete. Existing settled valid leads
remain usable while a newer campaign enrichment run continues.

### 5.2 Layout

Use a compact sticky-header table:

| Name | Email | Company | Title | Location | Verification | Actions |
|---|---|---|---|---|---|---|

- Every data cell uses a real inline input; users may overwrite populated or
  blank values.
- Missing cells use the existing missing-data tint.
- Each cell has a visible label in responsive mode.
- A row-level status names exactly what remains, for example `Mailbox invalid`
  or `Mailbox valid · missing title and location`.
- The section header states `6 leads require verification or correction`.
- Header actions include **Download unverified leads CSV**. It exports every
  current Leads-mode row whose mailbox result is not `valid` in the same
  transaction snapshot, including pending, invalid, unknown, risky,
  accept-all, and missing-email rows with an exact reason/status column.
  Mailbox-valid rows that only lack another profile field remain editable in
  Leads mode but are not mislabeled unverified in this file. Download never
  starts verification or drafting.

Do not render a spreadsheet-like contenteditable grid. Use real inputs with
predictable keyboard behavior and validation.

### 5.3 Inline persistence

Edits write to campaign-scoped `input_overrides`, hard-overwriting that field's
current override. They do not create content-history rows.

- Debounce an individual field by 400–600 ms.
- Save immediately on blur, Enter, Approve/Remove, or page navigation.
- Show `Saving…`, `Saved`, or `Couldn't save` at row level.
- Retain dirty local text and retry after a network failure.
- Send `expected_revision`; a stale tab receives 409 and cannot overwrite a
  newer edit.
- Escape renders and store plain text only.

### 5.4 Approve for drafting

Each row has an **Approve for drafting** control. It is enabled only when all
five effective fields pass deterministic input validation. Activation:

1. flush all row edits;
2. recompute the effective input and bind verification to the normalized email
   fingerprint;
3. if that exact email already has a current `valid` result, queue one
   research job immediately;
4. otherwise transition to `verifying_mailbox` and enqueue exactly one
   AgentMail probe;
5. on `valid`, atomically move the row out of Leads mode, add it to the valid
   denominator, and queue research under this same user authorization/budget;
6. on `invalid` or `unknown`, keep it in Leads mode with the exact result and
   allow correction plus another explicit approval;
7. update the Leads badge and progress counts from the committed server
   snapshot.

The row never moves merely because a human clicked Approve. It moves only
after the effective address is mailbox `valid`. While the probe runs, disable
duplicate approval and show `Verifying mailbox…`.

If name, company, title, or location changes after research has started, the
old job result is rejected by input fingerprint. A fresh research job is
queued only after the row is still complete and mailbox-valid. If email
changes, preserve reusable research only where its identity fingerprint is
unchanged, clear approval, invalidate the old email-bound verification, and
require a new Approve/AgentMail result.

### 5.5 Remove from campaign

Each row has an icon-only **Remove from campaign** control with tooltip and
accessible label. Because this changes campaign membership, confirm with the
lead name/email and consequence:

> Remove this lead from the campaign? It will no longer appear in Review,
> Drafting, or campaign exports. The shared person record is not deleted.

On confirmation, one transaction deletes the `campaign_leads` association,
marks the drafting item removed for audit, and cancels/supersedes pending
verification/research/write jobs. The row leaves Leads mode and all campaign
counts. There is no drafting-local Restore; the lead can return only through
the existing campaign upload/replace workflow.

Do not delete the global `outreach.leads` row.

## 6. Needs-your-decision section

This is an Email-mode attention panel for mailbox-valid rows whose research
cannot safely continue. It contains situations where model guessing would be
unsafe:

- two plausible people share the name and available context;
- current employer/title/location conflicts across strong sources;
- a fresh source contradicts the uploaded lead;
- prior CRM/relationship context implies this may not be first contact;
- a meaningful sender-side fact is missing and cannot be inferred;
- a true-zero situation provides no honest reason, structure, or timing;
- selected high-trust sources materially disagree;
- research is too stale to support the proposed reason.

Each row shows:

- lead identity and conflicting field;
- short plain-language explanation;
- source chips with title, domain, date, and external-link affordance;
- the supplied value versus researched value where applicable;
- three actions:
  - **Use supplied context cautiously**: write at one lower resolution and
    prohibit the conflicted fact;
  - **Correct information**: open the same inline field editor, then requeue
    research;
  - **Remove from campaign**.

An identity collision does not offer “pick the majority.” If the user chooses
a candidate, that choice must be explicit and the selected source identity is
stored in the resolution metadata.

The app never displays hidden chain-of-thought. It displays concise conflict
facts, source evidence, and the operational consequence.

When prior-contact context is present, the row/drawer also offers optional
per-lead **Connecting context** fields: explicit introducer name, what the
introducer said connected the parties, uploaded LinkedIn connection degree,
and clarification of a raw CRM indicator. These are campaign-scoped item
overrides, not sender-profile defaults. Warm-introduction writing is enabled
only when introducer name and context are explicitly supplied.

## 7. Email mode: Draft review card

### 7.1 Card header

The card header contains:

- left edge: previous arrow icon;
- center:
  - recipient name, title, and company;
  - `Reviewed X of Y generated`;
  - compact status chip (`Ready`, `Approved`, `Rewriting`, `Needs decision`,
    `Failed`);
- right edge: next arrow icon.

Previous/next browse through a stable workspace ordinal. Browsing:

- never changes approval state;
- skips removed and Leads-mode rows by default;
- may include non-ready placeholders when the user chooses “All leads” in the
  review filter;
- wraps only if the UI clearly communicates wrap behavior; default is disabled
  at each end.

If new drafts land while the user is reviewing, they append according to the
stable ordering and do not move the current card.

### 7.2 Email preview

Display a realistic plain-email surface:

- `From`: sender display name and email;
- `To`: recipient display name and address, with email confidence chip;
- `Subject`: separate single-line field/display;
- body: plain text with preserved blank lines and `white-space: pre-wrap`;
- minimal signature exactly as generated/edited.

Do not render generated content as Markdown or `dangerouslySetInnerHTML`.
Links inside the body remain plain text in this release. Email formatting is
stored as normalized plain text; no invisible rich-text markup enters CSV or
Cowork output.

### 7.3 Research transparency

A compact **Why this email** control opens the shared slide-over with:

- resolution level (`person`, `company`, `role/segment`, `moment`,
  `structure`);
- selected anchor and why it was load-bearing;
- facts used in the draft with source links;
- freshness labels;
- facts deliberately discarded as decorative/uncertain;
- relationship snapshot used;
- skill and positioning asset versions;
- research timestamp;
- when company facts were reused from another lead already processed in this
  workspace rather than freshly researched for this person, a distinct
  **Company context reused** note naming which lead it came from — mirroring
  the review row's `Past lead` badge, so reuse is never mistaken for fresh
  per-person research.

When the skill identifies one obtainable fact that would meaningfully raise
resolution, show a nonblocking **Could make this stronger** note at the bottom
of the drawer/card. It names the fact and why it matters, but never delays the
current draft and never invents the answer.

This is evidence and concise rationale, not internal reasoning traces.

### 7.4 Icon-only actions

Actions appear in one row under the preview:

1. **Edit** — neutral/ghost icon;
2. **Approve** — positive, visually prominent icon;
3. **Deny and try again** — warning/negative, visually prominent icon;
4. **Send email** — neutral icon, permanently disabled.

The fourth function the original product discussion referred to is **Send
email**. It remains intentionally visible but permanently disabled in this
release.

All icon-only controls require:

- `aria-label`;
- visible keyboard focus;
- tooltip on hover and focus;
- minimum 44×44 CSS-pixel hit target;
- no color-only meaning;
- disabled reason exposed through `aria-describedby`.

Edit and Send are less colorful than Approve and Deny as requested.

### 7.5 Edit mode

Edit is explicit. Outside edit mode, subject/body cannot receive a text caret.
Clicking Edit:

- changes the icon to an active state;
- replaces subject display with an `<input>`;
- replaces body display with a plain `<textarea>` sized to content;
- puts focus at the start of the subject on first activation;
- shows a compact save-state label;
- changes Edit tooltip to `Finish editing`.

Autosave semantics:

- each change updates only the current `email_drafts` row;
- no prior body/subject is retained;
- debounce 500 ms;
- immediate flush on blur, card navigation, Approve, Deny, Escape from edit
  mode, page visibility change, and `beforeunload` where supported;
- actions that depend on content wait for the save request to finish;
- transient failures retain the local edit and retry;
- a revision conflict never silently chooses last-write-wins.

Editing an approved draft changes it to `ready_for_review`; the user must
approve the edited current content again. This prevents exports from containing
text that was never approved.

The research drawer labels changed/new manual wording as user-supplied and not
automatically source-checked. Existing generated claim links are retained only
where their exact text remains. This warning does not block editing; the
subsequent Approve action is the human attestation for the current text.

### 7.6 Approve

Approve:

1. flushes pending edits;
2. verifies current content revision and input fingerprint;
3. changes only the latest current draft to `approved`;
4. records reviewer and timestamp (metadata, not a content version);
5. advances to the next ready, unreviewed email;
6. updates completion/export state.

Double clicks and network retries are idempotent. Approving a stale or
superseded revision returns 409 and reloads the current content.

### 7.7 Deny and try again

Deny:

1. flushes pending edits;
2. captures the current subject/body in the rewrite job input only;
3. transitions the item to `rewriting`;
4. clears approval for the current requested revision;
5. queues one writing call with the existing research packet;
6. advances immediately to the next ready email.

The rewrite call receives the old current draft as content to avoid, plus
attempt number and any optional short feedback. It receives no web tool and
cannot re-run research.

Default click immediately retries with no extra form. A small secondary
`Add direction` affordance in the tooltip/popover allows an optional
plain-text note (bounded to 300 characters) before confirming Deny. This is
never required and cannot override factual, security, or skill rules.

On successful rewrite, one transaction hard-overwrites subject/body and
returns the item to `ready_for_review`. The prior text is not stored as a
version. On rewrite failure, the previous current text may remain in the row
for recovery, but the item stays `failed_rewrite` and cannot be exported until
retry or removal from the campaign.

The control is disabled while an identical rewrite action is pending. User-
initiated retries may continue within the workspace budget; there is no hidden
automatic infinite rewrite loop.

### 7.8 Send

Send is intentionally nonfunctional:

- rendered disabled;
- tooltip: `Sending is not available yet`;
- no click handler;
- no keyboard activation;
- no API route, server action, provider credential, or background event for
  sending exists;
- tests assert no send endpoint is registered.

This prevents a CSS/JavaScript regression from turning a placeholder into a
real side effect.

## 8. Review selection and queue behavior

Default card selection priority:

1. the current card if it still exists;
2. next ready/unreviewed item after the last ordinal;
3. first ready/unreviewed item;
4. first approved item for browsing;
5. an honest waiting/attention empty state.

Filters:

- To review
- Approved
- All generated
- Needs attention

Exact sets:

- `To review`: `ready_for_review`;
- `Approved`: `approved`;
- `All generated`: `ready_for_review + approved`;
- `Needs attention`: mailbox-valid items in `needs_lead_review + needs_human
  + budget_paused + failed_*`;
- active queued/research/write/rewrite rows are visible from the Running tile,
  not treated as attention failures.
- `waiting_for_enrichment` rows are visible from the Still enriching tile and
  are not mislabeled as user-attention failures.
- mailbox-nonvalid rows are managed in Leads mode, not mixed into this Email
  filter.

Filters use the same segmented/pill grammar as the rest of the app. They do
not alter server state.

When no draft is ready but work runs, show the next expected useful state:

> Researching 4 leads. The first draft will appear here as soon as it is ready.

When some drafts are ready, never replace the email card with a full-page
loading screen.

## 8.1 Restrained gamification

Gamification rewards making careful decisions, not approving quickly:

- a session-local **Decisions made** pulse increments on Approve and Deny;
- progress milestones at 25%, 50%, 75%, and 100% use a brief tokenized
  animation and encouraging status copy;
- auto-advance and keyboard shortcuts preserve a satisfying review rhythm;
- completion gets one restrained success moment and immediate export actions;
- Deny counts as a valid decision pulse, so users are never rewarded for
  rubber-stamping;
- no countdowns, speed scores, leaderboards, approval-rate targets, random
  rewards, or streak-loss pressure;
- motion is suppressed by `prefers-reduced-motion`.

The persisted source of truth remains approval/current-draft state. Session
gamification may reset on reload without affecting review completion.

Milestone percentage uses `approved / all current campaign-associated
mailbox-valid items`. Each threshold fires at most once for a workspace
revision and never moves review state. A newly valid lead may increase the
denominator and reopen later milestones only for the new workspace revision;
previous celebration events are not replayed. Non-valid Leads rows do not
inflate the review denominator.

## 9. Completion and export experience

Generation and review/export completion use the separate definitions in
`README.md`. Both are derived server-side on every relevant transition.

The completion card contains:

- clear success statement and approved count;
- unresolved Leads count with a link to Leads mode;
- mailbox-valid final-export preflight result;
- **Export mail-ready CSV** primary action;
- **Export Claude Cowork prompt** secondary action;
- timestamp of the latest approval/input change.

Only mailbox-valid recipients can reach Email mode, so a stale/non-valid
verification on any drafted item invalidates that item, clears approval, and
moves it back to Leads mode before export. Non-valid campaign leads that never
entered drafting do not block export of the approved valid subset; they are
not silently hidden because the Leads badge, completion card, and unresolved-
leads CSV all retain their count.

Editing or rewriting after completion immediately removes completion status
and disables final export until the latest content is reapproved.

## 10. Empty, error, and recovery states

### No campaign leads

> There are no reviewed leads to draft yet.

Provide **Back to Review**.

### No mailbox-valid leads

Open Leads mode by default and explain:

> No mailbox-verified valid emails are ready to draft. Correct a lead and
> approve it for verification, or download the unverified leads CSV.

### All leads removed

> No leads remain in this campaign.

Offer Back to Review/Upload. Do not show export success.

### Provider rate limit

Keep ready drafts usable. Status strip:

> Drafting is temporarily slowed by the research provider. Completed work is
> safe and retries are scheduled.

Show next retry time in details, not a fake countdown if unknown.

### Failed research/write

Show a concise categorized reason and Retry / Remove from campaign. Hide raw
stack traces and provider response bodies from the user. Retry is an explicit
paid action.

### Page reload mid-edit

Server current content loads first. If a local dirty recovery buffer exists
and is newer, prompt:

> An unsaved local edit is available. Restore it or keep the saved draft.

This buffer is short-lived browser storage for crash recovery, not version
history, and is deleted after successful save or explicit discard.

### Multi-tab conflict

The later save with an old revision is rejected. Show both saved/current
content only long enough for the user to choose; never merge prose
automatically.

## 11. Keyboard behavior

- Left/Right arrows browse only when focus is not in an input/textarea.
- `E` toggles edit mode when the card has a ready draft.
- `A` approves after a small shortcut hint is learned/visible.
- `R` requests rewrite.
- Escape exits edit mode after flushing.
- Tab order follows previous → header/details → email → actions → next.
- Remove from campaign requires normal button activation and confirmation; no
  single-letter shortcut.

Shortcuts must not fire while modifiers are pressed or while typing. Display
them in tooltips and the page help affordance.

## 12. Accessibility and visual acceptance

- WCAG AA contrast for text, focus indicators, status chips, and progress.
- Status changes announced through a polite live region, with batching to
  avoid a notification on every two-second poll.
- Progress bar uses native/ARIA progress semantics with current/max text.
- Tooltips do not contain information unavailable elsewhere to touch users.
- Disabled Send reason is visible on focus/tap through adjacent help text.
- Motion obeys `prefers-reduced-motion`.
- Email body line breaks, apostrophes, Unicode names, accents, and RTL text
  display without corruption.
- Zoom at 200% retains all actions and does not overlap sticky regions.
- Loading skeletons preserve layout but never imitate finished content.

## 13. UX acceptance scenarios

1. Enter Drafting with 10 mailbox-valid complete leads and 3 non-valid leads:
   ten jobs start once, the three rows appear in Leads mode, and the first
   draft appears independently.
2. Correct an invalid email and click Approve for drafting: one AgentMail probe
   runs; the row stays visible while pending and leaves only after `valid`,
   increasing the valid denominator and queuing exactly one research job.
3. Change a title on a mailbox-valid but incomplete row and approve: no new
   mailbox probe runs for the unchanged valid email; one research job queues.
4. Remove a lead: its campaign association disappears, pending work cancels,
   and the shared lead row remains.
5. Open two tabs and edit one draft: stale tab receives a conflict and cannot
   erase the newer text.
6. Deny a draft: review advances immediately; research call count stays
   unchanged; rewritten content later returns unreviewed.
7. Browse back and forward through five drafts: review count does not change.
8. Edit an approved draft: approval is removed and export disables until
   reapproval.
9. Refresh during active jobs: no work duplicates and current progress
   reconstructs from Postgres.
10. Disable JavaScript/send handler inspection: no server send route exists.
11. Finish all valid-email drafts: header says `All valid emails drafted`;
    unresolved Leads remain counted, and non-valid rows remain downloadable,
    without blocking export of the approved valid subset.
