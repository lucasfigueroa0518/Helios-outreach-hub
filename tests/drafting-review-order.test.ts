import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareDraftsForSort,
  draftNeedsReview,
  isReadyForBulkSend,
  sortDraftRows,
  type SortableDraftRow,
} from '@/lib/drafting/draft-review-order';

function row(overrides: Partial<SortableDraftRow> & { id: string }): SortableDraftRow {
  return {
    id: overrides.id,
    ordinal: overrides.ordinal ?? 1,
    state: overrides.state ?? 'ready_for_review',
    review_status: overrides.review_status ?? 'unreviewed',
    draft: overrides.draft === undefined
      ? {
          generated_at: '2026-08-01T12:00:00.000Z',
          retry_suggested: false,
          send_status: 'unsent',
        }
      : overrides.draft,
  };
}

test('draftNeedsReview is true only when neither downloaded nor sent/queued', () => {
  assert.equal(draftNeedsReview(row({ id: 'a' })), true);
  assert.equal(
    draftNeedsReview(row({ id: 'b', state: 'approved', review_status: 'approved' })),
    false,
  );
  assert.equal(
    draftNeedsReview(row({
      id: 'c',
      draft: {
        generated_at: '2026-08-01T12:00:00.000Z',
        retry_suggested: false,
        send_status: 'sent',
      },
    })),
    false,
  );
  assert.equal(
    draftNeedsReview(row({
      id: 'd',
      draft: {
        generated_at: '2026-08-01T12:00:00.000Z',
        retry_suggested: false,
        send_status: 'queued',
      },
    })),
    false,
  );
});

test('review sort puts unreviewed ahead of downloaded/sent', () => {
  const rows = [
    row({
      id: 'sent',
      ordinal: 1,
      draft: {
        generated_at: '2026-08-07T10:00:00.000Z',
        retry_suggested: false,
        send_status: 'sent',
      },
    }),
    row({ id: 'ready-late', ordinal: 3 }),
    row({
      id: 'downloaded',
      ordinal: 2,
      state: 'approved',
      review_status: 'approved',
    }),
    row({ id: 'ready-early', ordinal: 1 }),
  ];

  const sorted = sortDraftRows(rows, 'review').map((entry) => entry.id);
  // Unreviewed first (by ordinal); reviewed/sent trail (also by ordinal).
  assert.deepEqual(sorted, ['ready-early', 'ready-late', 'sent', 'downloaded']);
});

test('recency sort orders by generated_at newest first', () => {
  const rows = [
    row({
      id: 'old',
      ordinal: 3,
      draft: {
        generated_at: '2026-08-01T00:00:00.000Z',
        retry_suggested: false,
        send_status: 'unsent',
      },
    }),
    row({
      id: 'new',
      ordinal: 1,
      draft: {
        generated_at: '2026-08-07T00:00:00.000Z',
        retry_suggested: false,
        send_status: 'unsent',
      },
    }),
    row({
      id: 'mid',
      ordinal: 2,
      draft: {
        generated_at: '2026-08-05T00:00:00.000Z',
        retry_suggested: false,
        send_status: 'unsent',
      },
    }),
  ];

  assert.deepEqual(
    sortDraftRows(rows, 'recency').map((entry) => entry.id),
    ['new', 'mid', 'old'],
  );
  assert.ok(compareDraftsForSort(rows[1]!, rows[0]!, 'recency') < 0);
});

test('isReadyForBulkSend excludes retry-suggested and non-drafted states', () => {
  assert.equal(
    isReadyForBulkSend({ state: 'ready_for_review', retrySuggested: false }),
    true,
  );
  assert.equal(
    isReadyForBulkSend({ state: 'approved', retrySuggested: false }),
    true,
  );
  assert.equal(
    isReadyForBulkSend({ state: 'ready_for_review', retrySuggested: true }),
    false,
  );
  assert.equal(
    isReadyForBulkSend({
      state: 'ready_for_review',
      retrySuggested: false,
      sendStatus: 'sent',
    }),
    false,
  );
  assert.equal(
    isReadyForBulkSend({ state: 'rewriting', retrySuggested: false }),
    false,
  );
});
