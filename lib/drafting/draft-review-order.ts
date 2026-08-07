/**
 * Client/server-safe helpers for draft browse order and bulk-send readiness.
 */

export type DraftSortMode = 'recency' | 'review';

export type SortableDraftRow = {
  id: string;
  ordinal: number;
  state: string;
  review_status: string;
  draft: {
    generated_at: string | null;
    retry_suggested: boolean;
    send_status: 'unsent' | 'queued' | 'sending' | 'sent' | 'failed';
  } | null;
};

/** Still awaiting download/send — front of the queue in review sort. */
export function draftNeedsReview(row: SortableDraftRow): boolean {
  if (!row.draft) return false;
  const downloaded = row.state === 'approved' || row.review_status === 'approved';
  const sentOrQueued = row.draft.send_status === 'sent'
    || row.draft.send_status === 'queued'
    || row.draft.send_status === 'sending';
  return !downloaded && !sentOrQueued;
}

function generatedAtMs(row: SortableDraftRow): number {
  const raw = row.draft?.generated_at;
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

export function compareDraftsForSort(
  a: SortableDraftRow,
  b: SortableDraftRow,
  mode: DraftSortMode,
): number {
  if (mode === 'review') {
    const aNeeds = draftNeedsReview(a) ? 0 : 1;
    const bNeeds = draftNeedsReview(b) ? 0 : 1;
    if (aNeeds !== bNeeds) return aNeeds - bNeeds;
    return a.ordinal - b.ordinal;
  }

  const byRecency = generatedAtMs(b) - generatedAtMs(a);
  if (byRecency !== 0) return byRecency;
  return b.ordinal - a.ordinal;
}

export function sortDraftRows<T extends SortableDraftRow>(
  rows: readonly T[],
  mode: DraftSortMode,
): T[] {
  return [...rows].sort((a, b) => compareDraftsForSort(a, b, mode));
}

/** Bulk Send All Ready: drafted, unsent, no retry suggested. */
export function isReadyForBulkSend(row: {
  state: string;
  retrySuggested: boolean;
  sendStatus?: 'unsent' | 'queued' | 'sending' | 'sent' | 'failed' | null;
}): boolean {
  if (row.state !== 'ready_for_review' && row.state !== 'approved') return false;
  if (row.retrySuggested) return false;
  if (
    row.sendStatus === 'sent'
    || row.sendStatus === 'queued'
    || row.sendStatus === 'sending'
  ) {
    return false;
  }
  return true;
}
