# 08 — Extraction spec (vision & multi-media → people rows)

This is a build-to-the-letter spec. Where a prompt or schema appears in a
code block, use it **verbatim** (placeholders in `{braces}`). Model IDs are
pinned in one place: `lib/models.ts` — `EXTRACTION_MODEL = 'claude-sonnet-5'`,
`MAPPING_MODEL = 'claude-haiku-4-5-20251001'`. Never hardcode model strings
elsewhere.

## 0. Contract (what every extractor must emit)

Every extractor, regardless of input type, returns:

```ts
type ExtractedPerson = {
  full_name: string;            // required; the ONLY required field
  title?: string;
  company?: string;
  location?: string;
  email?: string;               // only if literally present in the source
  phone?: string;
  linkedin_url?: string;        // captured only if present; maps to lead.linkedin_url
  confidence: 'high'|'low';     // low = extractor was unsure of ANY field
  truncated: boolean;           // true = row was visually cut off / partial
  provenance: {
    upload_id: string;
    locator: string;            // 'image:2/tile:1/row:14' | 'pdf:p3' | 'csv:row:88' | 'pptx:slide:5'
  };
};
// NOTE: LinkedIn connection DEGREE (1st/2nd/3rd) is deliberately NOT captured.
// It is relative to whichever rep took the screenshot — a property of
// (lead, rep), not of the lead — so it is not a lead field (audit round #9).
// Lead properties are the contact-field set from the original build prompt.

type ExtractionResult = {
  people: ExtractedPerson[];
  counted: number | null;       // pre-count from the count pass (images only)
  warnings: string[];           // human-readable; stored in uploads.extraction_summary
};
```

Rules that apply to **every** path:
- **Never invent.** A field not visible/present in the source is omitted, not
  guessed. An unreadable value is omitted and a warning is recorded.
- **Never silently drop.** A row that can't be fully parsed still emits
  (with `confidence:'low'`, `truncated` as appropriate) or produces a
  warning naming what was skipped and why.
- Emails found in the source are **input truth** (`email_status` will become
  `'direct'` with source note `'present in upload'`) and skip web enrichment
  entirely (local-first principle, 03).
- Rows where `full_name` is empty/unreadable are warnings, never people.

## 1. Router

By sniffed content type (magic bytes first, extension fallback — do not
trust the client's MIME string):

| Type | Path |
|---|---|
| png/jpg/jpeg/webp/**heic/heif/tiff/gif** | §2 Images (non-PNG/JPEG/WebP transcoded to PNG first — §2.1 step 0) |
| pdf | §3 PDF |
| csv/tsv | §4 Tabular |
| xlsx/xls | §4 Tabular (SheetJS → per-sheet CSV) |
| docx | §5 Office (mammoth → text + media/*.png) |
| pptx | §5 Office (jszip → slide XML text + media images) |
| txt/md | §6 Plain text |
| anything else | reject at upload time with a toast listing accepted types |

Media versatility (user directive, 2026-07-13): intake is NOT limited to
screenshots. In particular **HEIC/HEIF** (default iPhone photo format — e.g.
business-card photos, which the brief names as an input), **TIFF** (scans),
and **animated GIF** (first frame only) are accepted and normalized to PNG
before the vision path, so the extractor only ever sees PNG/JPEG/WebP.
(**BMP is NOT accepted** — `sharp`/libvips has no BMP input decoder, so it
would throw; excluded rather than pull in a separate decoder for a format
modern capture tools rarely emit.)

## 2. Images (screenshots) — the highest-risk path

### 2.1 Pre-processing (deterministic, sharp library)

0. **Transcode to PNG.** If the sniffed format is not PNG/JPEG/WebP, convert
   to PNG before anything else. Two decoders by format:
   - **HEIC/HEIF → `heic-convert` FIRST, then sharp.** `sharp`'s prebuilt
     npm binary ships libvips **without** HEIF (omitted for HEVC licensing),
     and Vercel won't let you swap libvips — so `sharp(heicBuf)` **throws at
     runtime**. Decode HEIC with `heic-convert` (bundles libheif compiled to
     WASM, works anywhere including serverless) → JPEG buffer → then
     `sharp(jpegBuf).png()` for the downscale/tile steps.
   - **TIFF/GIF → `sharp` directly** (these ARE in the prebuilt libvips; BMP
     is NOT and is rejected at the router). Animated GIF / multi-page TIFF →
     take the **first frame/page only** (`sharp(buf, { page: 0 })`).
   If decode fails (corrupt/unsupported codec) → upload `failed_quality`,
   message "couldn't read this image format — re-save as PNG or JPEG." All
   later steps operate on the PNG. (`heic-convert` is a pure-dependency npm
   package — no system libs, no deploy-image changes.)
1. Read dimensions. If height > 7500px OR file > 4.5MB → **slice into
   vertical tiles** of 1500px height with **250px overlap** between
   consecutive tiles (overlap prevents losing a row cut at a tile boundary;
   Stage C dedupe removes the resulting duplicates). Downscale width to max
   1568px before slicing (Anthropic vision sweet spot; larger adds tokens,
   not accuracy).
2. Reject (warning, not run failure) images smaller than 200×200 or that
   decode to <10KB — too small to contain a legible list.

### 2.2 Two-pass protocol per image/tile (count → extract → reconcile)

**Pass 1 — COUNT (cheap, forces honest reading):**

```
You are counting people entries in a screenshot. Look at the image and count
how many distinct person entries (rows/cards/list items showing an
individual person) are FULLY or PARTIALLY visible. Do not list them. Reply
with a tool call only.
```
Tool: `report_count` — `{ "count": integer, "layout": "list|grid|table|profile|other|none" }`.
`layout:"none"` (no people) → skip Pass 2, emit zero people, no warning
(images with no people are valid inputs).

**Pass 2 — EXTRACT:**

```
Transcribe every person entry visible in this screenshot into structured
rows. Rules:
- One entry per distinct person, top to bottom (left-to-right first if grid).
- Copy text EXACTLY as written. Do not expand abbreviations, do not fix
  typos, do not translate. If a field is not visible for a person, omit it.
- A row cut off at the image edge: transcribe what is visible and set
  truncated=true.
- If any text is too blurry/small to read with certainty, omit that field
  and set confidence="low" for that person.
- Include a LinkedIn profile URL only if visible. Do NOT record connection
  degree (1st/2nd/3rd) — we do not store it.
- Expected entry count from a prior pass: {count}. If you see a different
  number, extract what you actually see — do not pad or trim to match.
```
Tool: `extract_people` — JSON schema mirroring `ExtractedPerson[]` (all
fields; `full_name` required; `additionalProperties: false`). Tool choice
forced. `max_tokens` sized to `count × 120 + 500`.

**Reconcile:**
- `|people.length - count| == 0` → accept.
- Mismatch of 1–2 → accept, warning `count mismatch (saw {count}, extracted {n})`.
- Mismatch ≥3 or >20% → **one retry** of Pass 2 (temperature 0, same
  prompt). Take the attempt whose length is closer to `count`; warning
  either way. Never a third attempt (cost guard).

### 2.3 Image edge-case matrix (each row = required handling, test fixture)

| Scenario | Handling |
|---|---|
| LinkedIn Sales Navigator list (primary case) | Pass 2 captures name/title/company/location per row (connection degree ignored) |
| Consecutive scrolling screenshots with overlapping rows | Extract normally; Stage C dedupe (name+company exact after normalization) collapses |
| Row cut at top/bottom edge | `truncated:true`; if the *name* is what's cut → warning, no person emitted |
| Grid/card layout (conference speakers page) | `layout:"grid"`; read left-to-right, top-to-bottom |
| Single profile screenshot (one person, rich detail) | `layout:"profile"`; one person with all visible fields |
| Email signature screenshot | One person; email/phone are literal finds |
| Business card photo | One person; treat like signature |
| Org chart | Extract every named box; title from box label |
| Dark mode / low contrast | No special handling — if unreadable, per-field omission + `confidence:'low'` |
| Blurry/zoomed-out beyond legibility | Pass 1 returns count but Pass 2 yields mostly-empty rows → if >50% of rows have only a name with `confidence:'low'`, mark upload `failed_quality` with message "image too low-resolution to transcribe reliably — re-screenshot at higher zoom" |
| Non-Latin / accented names | Transcribe exactly (unicode preserved); normalization happens later, never at extraction |
| Duplicated person across two images with different data | Stage C keeps the union of fields (richest wins per-field) |
| Screenshot containing the user's own CRM/table UI | Same as any table — transcribe rows |
| Image with zero people (chart, logo, meme) | `layout:"none"`, zero people, no warning |

### 2.4 Batching & parallelism

One API call per image/tile (do NOT pack multiple screenshots into one call —
per-image reconcile is the accuracy backbone). Tiles/images run in parallel,
capped by the org concurrency budget (10 §4). Per-call retry on 5xx/timeout:
2 attempts, exponential backoff 2s/8s. 429 → the rate-limit protocol (09 §8
applies globally).

## 3. PDF

1. Page count via pdf-lib. >90 pages → split into 90-page chunks (Anthropic
   ingestion cap is 100).
2. Send the PDF (or chunk) as a document block with the Pass-2 prompt (§2.2)
   adapted: "this document" instead of "this screenshot"; no count pass
   (PDFs are cheap to re-read; instead the extractor must also return
   `pages_with_people: int[]` inside the tool result for spot-checking).
3. Scanned (image-only) PDFs need no special path — native ingestion OCRs.
4. Typical inputs to test: conference attendee lists, PitchBook exports,
   fund LP lists, event brochures (mixed prose + people = extract only
   actual people entries, not authors/bylines mentioned in passing —
   prompt already restricts to "person entries").
5. Locator: `pdf:p{n}`.

## 4. Tabular (CSV/TSV/XLSX)

Deterministic parse; the ONLY model call is column mapping.

1. Parse: papaparse with delimiter sniffing (`,` `;` `\t` `|`), encoding
   detection (UTF-8 default; UTF-16 LE/BE by BOM; fall back latin1),
   header row detection: if row 0 values look like data (contains `@` or
   >40% numeric), treat as headerless → synthetic headers `col_1..n`.
   XLSX: SheetJS; iterate **every** sheet; skip sheets with <2 rows.
2. Column mapping — one `MAPPING_MODEL` call per distinct header set:

```
Map these spreadsheet columns to our canonical lead fields. Headers and
three sample rows follow. Reply via tool call only.
Canonical fields: full_name, first_name, last_name, title, company,
location, email, phone, linkedin_url. Map a column ONLY if you are
confident; otherwise put it in "unmapped". If first/last name are separate
columns, map both instead of full_name.

HEADERS: {headers_json}
SAMPLES: {three_rows_json}
```
Tool `map_columns`: `{ mapping: {<header>: <canonical>}, unmapped: string[] }`.
Cache the mapping by hash of the header set (same export format re-uploaded
→ zero model calls).
3. Apply mapping in code. Rows lacking any name → warning with row number.
   `first_name`+`last_name` → synthesize `full_name`. Emails validated by
   regex; invalid → move to warnings, leave field empty.
4. Locator: `csv:row:{n}` / `xlsx:{sheet}:row:{n}`.

## 5. Office (DOCX / PPTX)

1. DOCX: mammoth → raw text + extract embedded images from `word/media/`.
   PPTX: jszip → concatenate `ppt/slides/slide*.xml` text runs (in slide
   order) + images from `ppt/media/`.
2. Text (if ≥200 chars) → §6 plain-text path, locator `docx:body` /
   `pptx:slide:{n}`.
3. Embedded images → §2 image path, but ONLY images ≥600px wide (icons and
   logos are noise) and max 20 images per file (warning if more).
4. Dedupe across the two channels (a slide's speaker grid may yield people
   from both its text runs and its image) — Stage C handles it.

## 6. Plain text

- Pre-scan in code: regex-harvest emails and LinkedIn URLs (they anchor
  people even in messy prose).
- One extraction call with the §2.2 Pass-2 prompt adapted for text; input
  chunked at 30k chars with 500-char overlap.
- Handles: pasted Sales Nav results, "here are some folks to reach out to"
  emails, meeting notes, bio paragraphs.

## 7. Extraction caching (local-first, cost)

- **Hash where the bytes actually are: in the extraction worker, not at
  intake.** Uploads go client→Supabase Storage directly (06), so the server
  never holds the bytes at intake and cannot hash them there (Storage's ETag
  is not a usable md5 for multipart uploads). The extraction worker already
  downloads each object to parse it — compute the sha256 there, as the first
  step, and write it to `outreach.uploads.content_hash` (column + index).
- Before running any model call, look up a prior upload with the same
  `content_hash` whose extraction succeeded → **reuse its ExtractionResult
  verbatim** (copy, with new upload_id provenance), zero model calls. The
  same screenshot dropped into two campaigns pays once.
- (Optional optimization, not required: the client may also send a
  precomputed hash so the worker can short-circuit the download on a cache
  hit; treat it as a hint, re-verify on miss.)

## 8. Acceptance tests (fixtures in `tests/fixtures/extraction/`)

**No live API calls** (11 §Testing philosophy). The deterministic parts —
transcode, tiling geometry, type-sniffing/routing, CSV/XLSX parsing, Stage C
dedupe, and cache-hit reuse — are tested offline. Anywhere a case needs the
vision/mapping model, **stub the model client with a canned tool response**
so the test exercises plumbing, not the model. The *real* transcription
quality of these cases is confirmed later by the user in manual testing, not
here. Fixtures the builder creates:
1. Sales Nav screenshot, 10 rows, clean → 10/10 exact.
2. Same list, two overlapping screenshots → union = 10, no dupes post-C.
3. Tall stitched screenshot (>7500px) → tiling produces no lost/dup rows.
4. Screenshot with 2 truncated edge rows → 8 clean + 2 truncated flags.
5. CSV with headers `Name,Employer,City` → correct mapping, zero warnings.
6. Headerless CSV → synthetic headers, mapping still resolves.
7. XLSX, two sheets (one relevant, one pivot junk) → junk sheet yields 0.
8. PDF attendee list, 3 pages → all people, `pages_with_people` correct.
9. DOCX with a people table + 2 logos → people extracted, logos skipped.
10. TXT with 5 bios in prose → 5 people, emails regex-anchored.
11. Photo of a cat → 0 people, 0 warnings, upload `extracted`.
12. 40×40px image → rejected with quality warning.
13. **HEIC business-card photo → transcoded to PNG, one person extracted
    (name/title/company/email/phone from the card).**
14. **Animated GIF → first frame transcoded, extracted like a screenshot.**
