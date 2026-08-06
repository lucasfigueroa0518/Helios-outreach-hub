import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeTileLayout,
  isTooSmallToTranscribe,
  MAX_IMAGE_WIDTH,
  MAX_TILE_HEIGHT,
  shouldTileImage,
  TILE_OVERLAP,
} from '@/lib/image-tiling';
import { sniffImageDimensions } from '@/lib/image-dimensions';
import {
  chooseRetryAttempt,
  dedupeExtractedPeople,
  extractFromTile,
  extractPeopleFromTiles,
  mismatchWarning,
  needsRetry,
  type RawExtractedPerson,
  type VisionCaller,
} from '@/lib/vision-extraction';
import {
  extractPeopleFromPdfChunks,
  splitPdfIntoChunks,
  type PdfCaller,
} from '@/lib/pdf-vision';
import type { ExtractedPerson } from '@/lib/extraction';
import { PDFDocument } from 'pdf-lib';

function tile(bytes = Buffer.alloc(1), index = 0, total = 1) {
  return { bytes, mediaType: 'image/png' as const, index, total };
}

// --- Tiling geometry (08 §2.1) — pure, no sharp/native decoder involved ---

test('a short image needs no tiling', () => {
  assert.deepEqual(computeTileLayout(1200), [{ top: 0, height: 1200 }]);
  assert.equal(shouldTileImage(1200, 500_000), false);
});

test('tiling decision uses the ORIGINAL height/bytes, before downscale', () => {
  assert.equal(shouldTileImage(7500, 500_000), false);
  assert.equal(shouldTileImage(7501, 500_000), true);
  assert.equal(shouldTileImage(1000, 4.5 * 1024 * 1024 + 1), true);
});

test('a tall (>7500px) screenshot slices into overlapping 1500px bands', () => {
  const layout = computeTileLayout(9000);
  assert.ok(layout.length > 1, 'expected multiple tiles');
  for (const segment of layout) assert.ok(segment.height <= MAX_TILE_HEIGHT);
  // consecutive tiles overlap by exactly 250px, and the union covers the full height
  for (let i = 1; i < layout.length; i++) {
    const previousBottom = layout[i - 1].top + layout[i - 1].height;
    assert.equal(previousBottom - layout[i].top, TILE_OVERLAP);
  }
  assert.equal(layout[layout.length - 1].top + layout[layout.length - 1].height, 9000);
});

test('tile width never exceeds the 1568px vision sweet spot', () => {
  assert.equal(MAX_IMAGE_WIDTH, 1568);
});

test('quality rejection covers both tiny dimensions and tiny byte size', () => {
  assert.equal(isTooSmallToTranscribe(40, 40, 50_000), true);
  assert.equal(isTooSmallToTranscribe(2000, 2000, 5_000), true);
  assert.equal(isTooSmallToTranscribe(2000, 2000, 50_000), false);
});

// --- Two-pass reconcile logic (08 §2.2) — pure ---

test('exact count match needs no retry and no warning', () => {
  assert.equal(needsRetry(10, 10), false);
  assert.equal(mismatchWarning(10, 10), null);
});

test('a mismatch of 1-2 is accepted with a warning, no retry', () => {
  assert.equal(needsRetry(10, 9), false);
  assert.equal(needsRetry(10, 8), false);
  assert.match(mismatchWarning(10, 8) ?? '', /count close \(saw 10, extracted 8\) — accepted/);
});

test('a mismatch of 3+ uses mismatch wording', () => {
  assert.match(mismatchWarning(10, 7) ?? '', /count mismatch \(saw 10, extracted 7\)/);
});

test('a mismatch of >=3 (or >20%) triggers one retry', () => {
  assert.equal(needsRetry(10, 7), true);
  assert.equal(needsRetry(4, 3), true); // diff=1 but 25% > 20%
});

test('retry keeps whichever attempt is closer to the count pass', () => {
  const first = [1, 2, 3, 4, 5]; // length 5, counted 10 -> diff 5
  const second = [1, 2, 3, 4, 5, 6, 7, 8, 9]; // length 9, counted 10 -> diff 1
  assert.equal(chooseRetryAttempt(10, first, second), second);
  assert.equal(chooseRetryAttempt(10, second, first), second);
});

// --- Per-tile orchestration with a stubbed model client (08 §8 / CLAUDE.md Rule 1) ---

function stubCaller(script: {
  count: { count: number; layout: 'list' | 'grid' | 'table' | 'profile' | 'other' | 'none' };
  extract: RawExtractedPerson[][];
}): VisionCaller {
  let extractCalls = 0;
  return {
    async count(_tile) {
      return script.count;
    },
    async extract(_tile) {
      const people = script.extract[Math.min(extractCalls, script.extract.length - 1)];
      extractCalls++;
      return { people };
    },
  };
}

test('clean 10/10 extraction produces no warnings (08 §8 fixture 1)', async () => {
  const people10: RawExtractedPerson[] = Array.from({ length: 10 }, (_, i) => ({
    full_name: `Person ${i + 1}`,
    company: 'Acme',
    confidence: 'high',
    truncated: false,
  }));
  const caller = stubCaller({ count: { count: 10, layout: 'list' }, extract: [people10] });
  const result = await extractFromTile(tile(), caller, 'upload-1');
  assert.equal(result.people.length, 10);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.people[0].provenance.locator, 'image/row:1');
});

test('a photo with zero people yields zero people and zero warnings (08 §8 fixture 11)', async () => {
  const caller = stubCaller({ count: { count: 0, layout: 'none' }, extract: [] });
  const result = await extractFromTile(tile(), caller, 'upload-1');
  assert.deepEqual(result, { people: [], warnings: [], counted: 0 });
});

test('a major mismatch triggers exactly one retry and keeps the closer attempt', async () => {
  const short: RawExtractedPerson[] = Array.from({ length: 5 }, (_, i) => ({
    full_name: `Short ${i}`, confidence: 'high', truncated: false,
  }));
  const closer: RawExtractedPerson[] = Array.from({ length: 9 }, (_, i) => ({
    full_name: `Closer ${i}`, confidence: 'high', truncated: false,
  }));
  const caller = stubCaller({ count: { count: 10, layout: 'list' }, extract: [short, closer] });
  const result = await extractFromTile(tile(), caller, 'upload-1');
  assert.equal(result.people.length, 9);
  assert.match(result.warnings[0], /count close \(saw 10, extracted 9\) — accepted/);
});

test('an unreadable/blank name is skipped and warned about, never emitted as a person', async () => {
  const raw: RawExtractedPerson[] = [
    { full_name: 'Jane Smith', confidence: 'high', truncated: false },
    { full_name: '', confidence: 'low', truncated: true },
  ];
  const caller = stubCaller({ count: { count: 2, layout: 'list' }, extract: [raw] });
  const result = await extractFromTile(tile(), caller, 'upload-1');
  assert.equal(result.people.length, 1);
  assert.equal(result.people[0].full_name, 'Jane Smith');
  assert.match(result.warnings[0], /unreadable name, entry skipped/);
});

test('multi-tile extraction dedupes the same person recurring across overlapping tiles, union of fields wins', async () => {
  const tileOnePeople: RawExtractedPerson[] = [
    { full_name: 'Jane Smith', company: 'Acme Inc', confidence: 'high', truncated: false },
  ];
  const tileTwoPeople: RawExtractedPerson[] = [
    { full_name: 'Jane Smith', title: 'VP Sales', confidence: 'high', truncated: false },
    { full_name: 'John Doe', company: 'Acme Inc', confidence: 'high', truncated: false },
  ];
  let tileIndex = 0;
  const caller: VisionCaller = {
    async count(_tile) {
      const counts = [1, 2];
      const count = counts[tileIndex];
      return { count, layout: 'list' };
    },
    async extract(_tile) {
      const batches = [tileOnePeople, tileTwoPeople];
      const people = batches[tileIndex];
      tileIndex++;
      return { people };
    },
  };
  const result = await extractPeopleFromTiles(
    [tile(Buffer.alloc(1), 0, 2), tile(Buffer.alloc(1), 1, 2)],
    'upload-1',
    caller,
  );
  assert.equal(result.people.length, 2, 'Jane Smith should collapse into one row');
  const jane = result.people.find((p) => p.full_name === 'Jane Smith');
  assert.equal(jane?.company, 'Acme Inc');
  assert.equal(jane?.title, 'VP Sales');
  const john = result.people.find((p) => p.full_name === 'John Doe');
  assert.ok(john);
});

test('mostly-empty low-confidence extraction is flagged failed_quality, not silently accepted', async () => {
  const blurryRows: RawExtractedPerson[] = Array.from({ length: 6 }, (_, i) => ({
    full_name: `Blur ${i}`, confidence: 'low', truncated: false,
  }));
  const caller = stubCaller({ count: { count: 6, layout: 'list' }, extract: [blurryRows] });
  const result = await extractPeopleFromTiles([tile(Buffer.alloc(1), 0, 1)], 'upload-1', caller);
  assert.deepEqual(result.people, []);
  assert.match(result.warnings[0], /image too low-resolution/);
});

test('dedupeExtractedPeople merges richest-field-wins by normalized name+company', () => {
  const base = (overrides: Partial<ExtractedPerson>): ExtractedPerson => ({
    full_name: 'Jane Smith',
    confidence: 'high',
    truncated: false,
    provenance: { upload_id: 'u1', locator: 'image/row:1' },
    ...overrides,
  });
  const deduped = dedupeExtractedPeople([
    base({ company: 'Acme, Inc.' }),
    base({ company: 'Acme', title: 'CFO', provenance: { upload_id: 'u1', locator: 'image/row:5' } }),
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].company, 'Acme, Inc.');
  assert.equal(deduped[0].title, 'CFO');
});

// --- PDF chunking + extraction (08 §3) ---

test('a PDF under the 90-page cap is sent as a single chunk', async () => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 5; i++) doc.addPage();
  const bytes = Buffer.from(await doc.save());
  const chunks = await splitPdfIntoChunks(bytes);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].pageCount, 5);
  assert.equal(chunks[0].startPage, 1);
});

test('a PDF over the 90-page cap splits into 90-page chunks with correct start pages', async () => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 185; i++) doc.addPage();
  const bytes = Buffer.from(await doc.save());
  const chunks = await splitPdfIntoChunks(bytes);
  assert.deepEqual(chunks.map((c) => c.pageCount), [90, 90, 5]);
  assert.deepEqual(chunks.map((c) => c.startPage), [1, 91, 181]);
});

test('PDF extraction maps each person to their absolute page via locator pdf:p{n}', async () => {
  const caller: PdfCaller = {
    async extract() {
      return {
        people: [
          { full_name: 'Alex Attendee', confidence: 'high', truncated: false, page: 1 },
          { full_name: 'Bree Attendee', confidence: 'high', truncated: false, page: 3 },
        ],
        pages_with_people: [1, 3],
      };
    },
  };
  const result = await extractPeopleFromPdfChunks(
    [{ bytes: Buffer.from(''), startPage: 91, pageCount: 90 }],
    'upload-1',
    caller,
  );
  assert.equal(result.people[0].provenance.locator, 'pdf:p91');
  assert.equal(result.people[1].provenance.locator, 'pdf:p93');
});

test('header sniff reads PNG dimensions without native decoders', () => {
  const png = Buffer.alloc(24);
  png.write('PNG', 1, 3, 'ascii');
  png.writeUInt32BE(800, 16);
  png.writeUInt32BE(1200, 20);
  assert.deepEqual(sniffImageDimensions(png, 'image/png'), { width: 800, height: 1200 });
});
