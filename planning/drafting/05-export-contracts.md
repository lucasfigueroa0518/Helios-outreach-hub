# Export contracts

## 1. Shared export preflight

Both final-draft exports use the exact same ordered row set and preflight
transaction.
Final-draft export is allowed only when:

- review/export completion for the current mailbox-valid subset is current;
- no Replace/merge/archive lifecycle reconciliation is pending or stale;
- every included item is in `approved`;
- current draft input fingerprint matches current effective input;
- current draft research packet hash matches;
- hard lint passes;
- grounding is either model-validated or a manual override explicitly
  approved after its latest edit;
- no mailbox-valid item has an open human-resolution or failure state;
- recipient's exact effective email is bound to a current
  `email_verification='valid'` result;
- sender profile snapshot is complete;
- no duplicate recipient address exists among included rows;
- no duplicate `(recipient, subject, body)` entry exists;
- at least one row is included.

Non-valid Leads-mode rows are intentionally excluded from final-draft formats
and do not block the approved valid subset. They are not silently hidden: the
response/UI reports their count and the separate unverified-leads CSV exports
the non-valid rows. A mailbox-valid incomplete/failed/unreviewed item does block final-draft
export because it belongs in the valid denominator.

Before bytes are generated, return/include:

```json
{
  "included": 18,
  "unresolved_leads": 2,
  "blocked": 0,
  "sender": "Name <email>",
  "generated_at": "ISO timestamp"
}
```

If blocked, endpoint returns 409 JSON:

```json
{
  "error": "Draft export is not ready",
  "blockers": [
    {
      "item_id": "uuid",
      "recipient": "Name",
      "code": "email_not_mailbox_valid",
      "message": "Current recipient address is no longer mailbox verified valid"
    }
  ]
}
```

No export endpoint triggers research, verification, writing, or retry.

## 2. Stable ordering

Rows sort by drafting-item ordinal, the order frozen when the item entered the
workspace. Do not resort by approval time or asynchronous completion time.
Both formats use identical ordering so users can compare them.

## 3. Mail-ready CSV

### 3.1 Purpose and dialect

The v1 format is a generic mail-merge CSV, not a vendor-specific API import.

- UTF-8 with BOM for broad spreadsheet/import compatibility;
- RFC 4180-style comma delimiter and double-quote escaping;
- CRLF row endings;
- body paragraph breaks normalized to CRLF inside a quoted field;
- header row always present;
- no extra metadata/comment rows before the header;
- MIME `text/csv; charset=utf-8`;
- filename:
  `{sanitized-campaign-name}-approved-drafts-YYYY-MM-DD.csv`.

The endpoint emits through a tested CSV serializer/renderer, not ad-hoc string
concatenation.

### 3.2 Exact columns

| Order | Header | Value |
|---|---|---|
| 1 | `To Email` | current approved mailbox-valid address |
| 2 | `To First Name` | normalized first name |
| 3 | `To Last Name` | normalized last name |
| 4 | `To Full Name` | current effective full name |
| 5 | `Company` | current effective company |
| 6 | `Job Title` | current effective title |
| 7 | `Location` | current effective work location |
| 8 | `Subject` | approved current subject |
| 9 | `Body` | approved current plain-text body |
| 10 | `From Name` | sender snapshot display name |
| 11 | `From Email` | sender snapshot work email |

Do not include internal lead/workspace/draft UUIDs in the mailer file. Do not
include research rationale, source URLs, relationship status, email confidence
labels, or model metadata; those are not mail content and may leak internal
context.

### 3.3 Plain-text body rules

- Store LF; export CRLF.
- Preserve intentional blank lines.
- No Markdown conversion.
- No `<br>` or HTML wrapping.
- No smart-quote normalization that changes approved text.
- No auto-added signature; exported body is exactly approved body after line-
  ending normalization.
- Reject null/control characters other than tab/newline policy.

### 3.4 Quoting examples

Approved body:

```text
Lucas,

The planning cycle at Acme is the reason I'm writing.

Would a short call next week be useful?

Alex
```

CSV body cell contains the same paragraph breaks inside one double-quoted
field. A body quote becomes doubled (`"` → `""`). A comma does not split a
column.

Tests must parse the emitted CSV back and compare all values byte-for-byte
after the documented line-ending normalization.

### 3.5 Spreadsheet formula injection

Quoting alone does not prevent spreadsheet formula interpretation. Do not
silently prefix the approved Subject/Body with an apostrophe because a mailer
could send that modified character.

Policy:

- If Subject or Body begins, after leading whitespace, with `=`, `+`, `-`, or
  `@` in a form spreadsheet software may execute, export preflight blocks and
  asks the user to edit/reapprove.
- For metadata fields where a safe prefix can alter only spreadsheet display,
  use a documented formula-neutralization helper; test the target mailer does
  not preserve the prefix.
- Header names are constants.
- CR/LF in single-line metadata is rejected/normalized before storage.

### 3.6 Duplicate recipients

If two current approved mailbox-valid items share the same normalized To
Email:

- block the primary mail-ready export;
- show both leads/subjects;
- require the user to remove one from the campaign or explicitly resolve the
  duplicate;
- never send two “first” emails to the same inbox by default.

A future explicit multi-message override is outside this release.

### 3.7 Deliverability

Use the existing AgentMail result on `outreach.leads.email_verification` for
an unchanged source address, or the item-scoped result for a drafting
override. The exact normalized email and verification result must be bound in
the delivery snapshot.

Exact v1 matrix:

- `email_verification='valid'` plus normal syntax/business-domain policy may
  enter drafting/export regardless of whether origin is direct, inferred,
  uploaded, Embark DB, public literal, or human-entered;
- `pending`, `invalid`, `risky`, `unknown`, `accept_all`, null, malformed,
  personal/free-domain, and missing addresses never enter drafting/export;
- a format guess that AgentMail marks `valid` may be promoted by the existing
  enrichment policy before drafting; drafting never independently relabels
  origin/status;
- a previously valid result for a different email never transfers.

A manual email entered on Drafting:

1. is normalized/validated and stored only in the item override;
2. records `human_feedback`-equivalent drafting provenance;
3. on explicit Approve for drafting, requests one existing AgentMail probe for
   that one campaign item;
4. remains in Leads mode until the item-scoped result is exactly `valid`;
5. does not trigger email discovery or write the override back to the shared
   lead row.

Do not substitute email alternates automatically during export. The approved
To address shown during review must equal the exported address.

## 4. Unverified-leads CSV

### 4.1 Scope and availability

**Download unverified leads CSV** is available whenever Leads mode has at
least one non-valid row. It does not require generation/review completion and
includes every current campaign-associated Leads-mode row whose exact
effective mailbox result is not `valid` at one transaction snapshot:

- mailbox pending, invalid, unknown, risky, accept-all, null, or missing;
- malformed/nonbusiness email;
- still-enriching rows already in the authorized cohort.

Mailbox-valid rows that remain in Leads mode only because another required
profile field is missing are not included; they are not unverified.

Removed campaign associations are excluded. The endpoint is read-only and
never starts AgentMail, Claude, web search, or drafting work.

### 4.2 Exact columns

| Order | Header | Value |
|---|---|---|
| 1 | `Full Name` | current effective name |
| 2 | `Email` | current effective email |
| 3 | `Company` | current effective company |
| 4 | `Job Title` | current effective title |
| 5 | `Location` | current effective work location |
| 6 | `Mailbox Verification` | `Pending`, `Invalid`, `Unknown`, `Risky`, `Accept-all`, or `Missing` |
| 7 | `Drafting Blocker` | deterministic, human-readable blocker list |
| 8 | `Email Origin` | current provenance/status label |
| 9 | `Verified At` | ISO timestamp or blank |

Use UTF-8 with BOM, RFC 4180 quoting, CRLF rows, constant headers, formula-
neutralization for metadata cells, no internal IDs, and filename
`{sanitized-campaign-name}-unverified-leads-YYYY-MM-DD.csv`.

The CSV is an intervention handoff, not an import contract. Editing the file
does not mutate the campaign; users make corrections in Leads mode or the
existing campaign replace flow.

## 5. Claude Cowork draft-creation prompt

### 5.1 Purpose

The markdown file is an operational prompt for Claude Cowork to create
mail-client drafts from the user's already approved content. It is not a
second drafting or research pass.

This decision protects the user's review:

- Cowork receives exact final content;
- it may populate draft fields;
- it may not rewrite, research, infer, or send;
- the user retains the final click-to-send control in their mail system.

### 5.2 Filename/MIME

- UTF-8 Markdown;
- LF line endings;
- MIME `text/markdown; charset=utf-8`;
- filename:
  `{sanitized-campaign-name}-cowork-draft-prompt-YYYY-MM-DD.md`.

### 5.3 Document structure

```markdown
# Create approved outreach drafts

## Instructions

You are creating email drafts from approved final content.

Rules:
1. Create exactly N drafts, one for each record below.
2. Use the exact From, To, Subject, and Body values. Do not rewrite, shorten,
   expand, personalize, research, or correct them.
3. Preserve paragraph breaks in Body.
4. Do not add a signature, links, formatting, tracking, attachments, CC, or
   BCC.
5. Do not send any email. Save each as a draft for the user to review and send.
6. If a required field cannot be placed exactly, stop on that record and
   report its Ref plus the problem. Do not guess.
7. At the end, report how many drafts were created and list any failed Refs.

## Batch

- Campaign: ...
- Expected drafts: N
- Sender: Name <email>
- Exported at: ...
- Payload SHA-256: ...

## Records

```json
[
  {
    "ref": "draft-001",
    "from_name": "...",
    "from_email": "...",
    "to_name": "...",
    "to_email": "...",
    "subject": "...",
    "body_text": "..."
  }
]
```
```

The actual document must use a fence strategy that cannot be broken by
approved body content. Safe choices:

- JSON fenced block with a dynamically selected fence length longer than any
  backtick run in content; or
- JSON encoded as an indented/code block after escaping; or
- one Base64 payload plus a human-readable checksum only if Cowork reliably
  decodes it (not preferred without testing).

Prefer readable JSON and test fence selection.

### 5.4 Reference IDs

`ref` is export-local (`draft-001`, `draft-002`, ...), not a database UUID.
It allows Cowork to report failures without leaking internal identifiers.

### 5.5 Payload checksum

Canonicalize the JSON payload:

- stable key order;
- UTF-8;
- LF line endings within `body_text`;
- no insignificant whitespace for hash input.

Include SHA-256. This gives the user/support team an integrity check without
exposing content-history versions.

### 5.6 Exactness

Cowork instructions repeat “exact” because any rewrite could:

- reintroduce vendor patterns removed during review;
- invent a fact;
- change the approved ask;
- change line breaks/signature;
- create divergence between CSV and mail drafts.

If Cowork cannot create mail-client drafts in the user's environment, it
should report that limitation and not simulate success.

### 5.7 No send

The prompt explicitly says not to send. This is consistent with the app's
disabled Send control and ensures the user remains the send boundary.

## 6. Export UI behavior

Buttons are enabled only after server preflight says available. Clicking:

1. requests export;
2. handles a late 409 (state changed in another tab) by refreshing blockers;
3. downloads bytes;
4. shows a confirmation with format/count;
5. does not change item review state.

The UI displays:

> 18 approved valid-email drafts will be exported. 2 unresolved leads remain
> available in Leads mode.

No modal asks the user to re-select rows after completion.

## 7. Future vendor-specific adapters

If a mailer later requires different headers, add a named export adapter:

```ts
interface DraftExportAdapter {
  id: string;
  headers: readonly string[];
  preflight(rows: ApprovedDraft[]): ExportIssue[];
  render(rows: ApprovedDraft[]): Uint8Array;
}
```

Do not alter the generic contract in place. Add adapter contract tests using
the vendor's documented import format. Email sending remains a separate,
explicit future capability.

## 8. Export acceptance fixtures

Use offline fixtures covering:

1. commas in company/subject/body;
2. double quotes in body;
3. multiline body and blank paragraphs;
4. accented/Unicode names;
5. apostrophes;
6. CRLF/LF input normalization;
7. subject/body formula-prefix blocker;
8. duplicate normalized recipient;
9. unresolved non-valid item omitted from final drafts but included in the
   unverified-leads CSV with exact blocker;
10. one mailbox-valid stale/unapproved item blocks final-draft export;
11. pending/invalid/risky/unknown/accept-all address cannot enter final-draft
    export;
12. JSON payload containing backticks/fences;
13. payload checksum round trip;
14. Cowork record count exactly equals CSV row count;
15. CSV parsed values exactly equal Cowork JSON values for recipient, subject,
    body, and sender.
16. unverified-leads CSV is available before review completion and triggers
    zero provider calls.
