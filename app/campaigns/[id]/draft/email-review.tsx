'use client';

import Link from 'next/link';
import { startTransition, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Pencil, RotateCcw, Send, X } from 'lucide-react';

import type { DraftingItemRow, SenderProfile } from '@/app/campaigns/[id]/draft/types';
import {
  sortDraftRows,
  type DraftSortMode,
} from '@/lib/drafting/draft-review-order';
import {
  outreachFocusLabel,
  rowMatchesOutreachFocus,
  type OutreachCarouselFocus,
} from '@/lib/auto-campaigns/outreach-insight';
import { formatNyDateLabel } from '@/lib/drafting/send-queue-schedule';

function statusChipLabel(
  state: DraftingItemRow['state'],
  reviewStatus: DraftingItemRow['review_status'],
  retrySuggested: boolean,
) {
  if (state === 'approved' || reviewStatus === 'approved') return 'Downloaded';
  if (retrySuggested && (state === 'ready_for_review' || state.startsWith('failed_'))) {
    return 'Retry suggested';
  }
  if (state === 'ready_for_review') return 'Ready';
  if (state === 'rewriting' || state === 'queued_rewrite') return 'Rewriting';
  if (state === 'needs_lead_review') return 'Needs decision';
  if (state.startsWith('failed_')) return 'Failed';
  return state.replace(/_/g, ' ');
}

function statusChipClass(
  state: DraftingItemRow['state'],
  retrySuggested: boolean,
) {
  if (state === 'approved') return 'drafting-status-chip--approved';
  if (retrySuggested && (state === 'ready_for_review' || state.startsWith('failed_'))) {
    return 'drafting-status-chip--retry-suggested';
  }
  if (state === 'ready_for_review') return 'drafting-status-chip--ready';
  if (state === 'rewriting' || state === 'queued_rewrite') return 'drafting-status-chip--rewriting';
  if (state === 'needs_lead_review') return 'drafting-status-chip--attention';
  if (state.startsWith('failed_')) return 'drafting-status-chip--failed';
  return '';
}

function canDecideOnDraft(row: DraftingItemRow): boolean {
  if (!row.draft) return false;
  if (row.state === 'ready_for_review') return true;
  if (
    (row.state === 'failed_write' || row.state === 'failed_rewrite')
    && row.draft.retry_suggested
  ) {
    return true;
  }
  return false;
}

function isDraftSendable(state: DraftingItemRow['state']): boolean {
  return state === 'ready_for_review' || state === 'approved';
}

/** Swap to the next email at the green flash peak; comedown finishes over the next card. */
const APPROVE_PEAK_MS = 180;
const APPROVE_TOTAL_MS = 360;

export function EmailReview({
  campaignId,
  autoMode = false,
  rows,
  sortMode,
  focus = null,
  currentItemId,
  sender,
  sends,
  onSelectItem,
  onRefresh,
  onOptimisticApprove,
  onOptimisticRewrite,
  onBeginRewriteWatch,
  onEndRewriteWatch,
  onRewriteFailed,
  onRewriteQueued,
  onDecision,
}: {
  campaignId: string;
  autoMode?: boolean;
  rows: DraftingItemRow[];
  sortMode: DraftSortMode;
  focus?: OutreachCarouselFocus | null;
  currentItemId: string | null;
  sender: SenderProfile | null;
  sends: {
    configured: boolean;
    available: boolean;
    blocking_reasons: string[];
    pending: number;
    today_remaining?: number;
    queued_count?: number;
    next_schedule_date?: string | null;
  };
  onSelectItem: (itemId: string) => void;
  onRefresh: () => void;
  onOptimisticApprove: (itemId: string, recipientLabel: string) => void;
  onOptimisticRewrite: (itemId: string) => void;
  onBeginRewriteWatch: (itemId: string, revision: number) => void;
  onEndRewriteWatch: (itemId: string) => void;
  onRewriteFailed: (itemId: string) => void;
  onRewriteQueued: (itemId: string) => void;
  onDecision: () => void;
}) {
  const reviewable = sortDraftRows(
    rows.filter((row) => rowMatchesOutreachFocus(row, focus)),
    sortMode,
  );
  const currentIndex = reviewable.findIndex((row) => row.id === currentItemId);
  const current = currentIndex >= 0 ? reviewable[currentIndex] : reviewable[0] ?? null;

  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [contentRevision, setContentRevision] = useState(0);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [actionError, setActionError] = useState<string | null>(null);
  const [rewriteFeedback, setRewriteFeedback] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);
  const [approveFlash, setApproveFlash] = useState(false);
  const [sendFlash, setSendFlash] = useState(false);
  const [editFlash, setEditFlash] = useState(false);
  const [rewriteJustLanded, setRewriteJustLanded] = useState(false);
  const [sendState, setSendState] = useState<'idle' | 'sending' | 'error'>('idle');
  const [sendError, setSendError] = useState<string | null>(null);
  const [bulkSendState, setBulkSendState] = useState<'idle' | 'sending' | 'error'>('idle');
  const [bulkSendMessage, setBulkSendMessage] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const feedbackRef = useRef<HTMLTextAreaElement>(null);
  const inFlightRef = useRef<Set<string>>(new Set());
  const advanceTimerRef = useRef<number | null>(null);
  const comedownTimerRef = useRef<number | null>(null);
  const approveHoldRef = useRef(false);
  const sendHoldRef = useRef(false);
  const rewriteWatchRef = useRef<{ itemId: string; revision: number } | null>(null);
  const directionPanelId = useId();

  useEffect(() => {
    if (!current?.draft) return;
    setSubject(current.draft.subject);
    setBody(current.draft.body_text);
    setContentRevision(current.draft.content_revision);
    setEditing(false);
    setSaveState('idle');
    setShowFeedback(false);
    setRewriteFeedback('');
    if (rewriteWatchRef.current?.itemId !== current.id) {
      setActionError(null);
      setRewriteJustLanded(false);
    }
    // Keep decision flashes mounted across the peak→next swap so comedown is continuous.
    if (!approveHoldRef.current) setApproveFlash(false);
    if (!sendHoldRef.current) setSendFlash(false);
    setSendState('idle');
    setSendError(null);
  }, [current?.id, current?.draft?.content_revision, current?.draft?.send_status]);

  // When a watched rewrite finishes, swap in the new draft in place (no navigation / reload).
  useEffect(() => {
    const watched = rewriteWatchRef.current;
    if (!watched) return;
    const row = rows.find((item) => item.id === watched.itemId);
    if (!row?.draft) return;
    if (row.draft.content_revision <= watched.revision) return;
    if (
      row.state !== 'ready_for_review'
      && row.state !== 'failed_write'
      && row.state !== 'failed_rewrite'
    ) {
      return;
    }
    rewriteWatchRef.current = null;
    onEndRewriteWatch(watched.itemId);
    if (current?.id === watched.itemId) {
      setSubject(row.draft.subject);
      setBody(row.draft.body_text);
      setContentRevision(row.draft.content_revision);
      setEditing(false);
      setRewriteJustLanded(true);
      const timer = window.setTimeout(() => setRewriteJustLanded(false), 1600);
      return () => window.clearTimeout(timer);
    }
  }, [current?.id, onEndRewriteWatch, rows]);

  useEffect(() => {
    if (!showFeedback) return;
    const timer = window.setTimeout(() => feedbackRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [showFeedback]);

  // Recover phantom "rewriting" from a failed optimistic retry (server never queued).
  useEffect(() => {
    if (!current) return;
    if (current.state !== 'queued_rewrite' && current.state !== 'rewriting') return;
    const itemId = current.id;
    if (inFlightRef.current.has(itemId)) return;
    const timer = window.setTimeout(() => {
      if (inFlightRef.current.has(itemId)) return;
      onRefresh();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [current?.id, current?.state, onRefresh]);

  useEffect(() => () => {
    if (advanceTimerRef.current) window.clearTimeout(advanceTimerRef.current);
    if (comedownTimerRef.current) window.clearTimeout(comedownTimerRef.current);
  }, []);

  const flushSave = useCallback(async () => {
    if (!current?.draft || !editing) return true;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (subject === current.draft.subject && body === current.draft.body_text) return true;
    setSaveState('saving');
    const response = await fetch(`/api/drafts/${current.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_content_revision: contentRevision,
        expected_input_fingerprint: current.input_fingerprint,
        subject,
        body_text: body,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      setSaveState('error');
      if (response.status === 409) onRefresh();
      return false;
    }
    setContentRevision(data.content_revision);
    setSaveState('saved');
    return true;
  }, [body, contentRevision, current, editing, onRefresh, subject]);

  function scheduleSave(nextSubject: string, nextBody: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void (async () => {
        if (!current?.draft) return;
        setSaveState('saving');
        const response = await fetch(`/api/drafts/${current.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expected_content_revision: contentRevision,
            expected_input_fingerprint: current.input_fingerprint,
            subject: nextSubject,
            body_text: nextBody,
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          setSaveState('error');
          return;
        }
        setContentRevision(data.content_revision);
        setSaveState('saved');
      })();
    }, 500);
  }

  function findNextDecidable(fromIndex: number, excludeId: string) {
    const after = reviewable.find(
      (row, index) => index > fromIndex && row.id !== excludeId && canDecideOnDraft(row),
    );
    if (after) return after;
    return reviewable.find((row) => row.id !== excludeId && canDecideOnDraft(row)) ?? null;
  }

  function goTo(offset: number) {
    if (!reviewable.length) return;
    const baseIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = baseIndex + offset;
    if (nextIndex < 0 || nextIndex >= reviewable.length) return;
    startTransition(() => {
      onSelectItem(reviewable[nextIndex].id);
    });
    if (editing) void flushSave();
  }

  function clearDecisionTimers() {
    if (advanceTimerRef.current) window.clearTimeout(advanceTimerRef.current);
    if (comedownTimerRef.current) window.clearTimeout(comedownTimerRef.current);
    advanceTimerRef.current = null;
    comedownTimerRef.current = null;
  }

  function findNextSendable(fromIndex: number, excludeId: string) {
    const matches = (row: DraftingItemRow) =>
      row.id !== excludeId
      && isDraftSendable(row.state)
      && row.draft?.send_status !== 'sent'
      && row.draft?.send_status !== 'queued'
      && row.draft?.send_status !== 'sending';
    const after = reviewable.find((row, index) => index > fromIndex && matches(row));
    if (after) return after;
    return reviewable.find((row) => matches(row)) ?? null;
  }

  /** Download: swap email at flash peak; green comedown continues over the next email. */
  function advanceAfterApprove(fromIndex: number, decidedId: string) {
    const next = findNextDecidable(fromIndex, decidedId);
    clearDecisionTimers();
    advanceTimerRef.current = window.setTimeout(() => {
      if (next) {
        startTransition(() => {
          onSelectItem(next.id);
        });
      }
      comedownTimerRef.current = window.setTimeout(() => {
        approveHoldRef.current = false;
        setApproveFlash(false);
        comedownTimerRef.current = null;
      }, APPROVE_TOTAL_MS - APPROVE_PEAK_MS);
      advanceTimerRef.current = null;
    }, APPROVE_PEAK_MS);
  }

  /** Send: same peak swap + card flash as download. */
  function advanceAfterSend(fromIndex: number, sentId: string) {
    const next = findNextSendable(fromIndex, sentId);
    clearDecisionTimers();
    advanceTimerRef.current = window.setTimeout(() => {
      if (next) {
        startTransition(() => {
          onSelectItem(next.id);
        });
      }
      comedownTimerRef.current = window.setTimeout(() => {
        sendHoldRef.current = false;
        setSendFlash(false);
        comedownTimerRef.current = null;
      }, APPROVE_TOTAL_MS - APPROVE_PEAK_MS);
      advanceTimerRef.current = null;
    }, APPROVE_PEAK_MS);
  }

  async function persistEditsIfNeeded(options: {
    itemId: string;
    fingerprint: string | null;
    revision: number;
    nextSubject: string;
    nextBody: string;
    baselineSubject: string;
    baselineBody: string;
  }): Promise<number | null> {
    if (
      options.nextSubject === options.baselineSubject
      && options.nextBody === options.baselineBody
    ) {
      return options.revision;
    }
    const response = await fetch(`/api/drafts/${options.itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_content_revision: options.revision,
        expected_input_fingerprint: options.fingerprint,
        subject: options.nextSubject,
        body_text: options.nextBody,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return null;
    return typeof data.content_revision === 'number' ? data.content_revision : options.revision;
  }

  function sendCurrentDraft() {
    if (!current?.draft) return;
    if (current.draft.send_status === 'sent') return;
    if (current.draft.send_status === 'queued' || current.draft.send_status === 'sending') return;
    if (!sends.configured || !isDraftSendable(current.state)) return;
    if (inFlightRef.current.has(current.id) || approveFlash || sendFlash || rewriting) return;

    const itemId = current.id;
    const fromIndex = currentIndex;

    inFlightRef.current.add(itemId);
    setSendError(null);
    setActionError(null);
    sendHoldRef.current = true;
    setSendFlash(true);
    setShowFeedback(false);
    setEditing(false);

    void (async () => {
      try {
        const response = await fetch(`/api/drafts/${itemId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'send' }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          sendHoldRef.current = false;
          setSendFlash(false);
          setSendState('error');
          setSendError(typeof data.error === 'string' ? data.error : 'Could not send email');
          onRefresh();
          return;
        }
        if (data.status === 'queued') {
          sendHoldRef.current = false;
          setSendFlash(false);
          setSendState('idle');
          onRefresh();
          return;
        }
        advanceAfterSend(fromIndex, itemId);
        setSendState('idle');
        onRefresh();
      } catch (error) {
        sendHoldRef.current = false;
        setSendFlash(false);
        setSendState('error');
        setSendError(error instanceof Error ? error.message : 'Could not send email');
        onRefresh();
      } finally {
        inFlightRef.current.delete(itemId);
      }
    })();
  }

  function cancelQueuedDraft() {
    if (!current?.draft?.queue_id) return;
    if (inFlightRef.current.has(current.id)) return;
    const queueId = current.draft.queue_id;
    const itemId = current.id;
    inFlightRef.current.add(itemId);
    setSendError(null);
    void (async () => {
      try {
        const response = await fetch('/api/send-queue', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [queueId] }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setSendError(typeof data.error === 'string' ? data.error : 'Could not cancel queued send');
        }
        onRefresh();
      } catch (error) {
        setSendError(error instanceof Error ? error.message : 'Could not cancel queued send');
        onRefresh();
      } finally {
        inFlightRef.current.delete(itemId);
      }
    })();
  }

  function sendQueuedDraftNow() {
    if (!current?.draft?.queue_id) return;
    if ((sends.today_remaining ?? 0) < 1) {
      setSendError('No send slots remaining today');
      return;
    }
    if (inFlightRef.current.has(current.id)) return;
    const queueId = current.draft.queue_id;
    const itemId = current.id;
    const fromIndex = currentIndex;
    inFlightRef.current.add(itemId);
    setSendError(null);
    sendHoldRef.current = true;
    setSendFlash(true);
    void (async () => {
      try {
        const response = await fetch('/api/send-queue/send-now', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [queueId] }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          sendHoldRef.current = false;
          setSendFlash(false);
          setSendError(typeof data.error === 'string' ? data.error : 'Could not send now');
          onRefresh();
          return;
        }
        if ((data.queued ?? 0) > 0 && (data.sent ?? 0) === 0) {
          sendHoldRef.current = false;
          setSendFlash(false);
          setSendState('idle');
          onRefresh();
          return;
        }
        if ((data.failed ?? 0) > 0 && (data.sent ?? 0) === 0) {
          sendHoldRef.current = false;
          setSendFlash(false);
          setSendError(typeof data.error === 'string' ? data.error : 'Could not send now');
          onRefresh();
          return;
        }
        advanceAfterSend(fromIndex, itemId);
        setSendState('idle');
        onRefresh();
      } catch (error) {
        sendHoldRef.current = false;
        setSendFlash(false);
        setSendError(error instanceof Error ? error.message : 'Could not send now');
        onRefresh();
      } finally {
        inFlightRef.current.delete(itemId);
      }
    })();
  }

  function sendAllReady() {
    if (!sends.available || bulkSendState === 'sending') return;
    setBulkSendState('sending');
    setBulkSendMessage(null);
    void (async () => {
      try {
        const response = await fetch(`/api/campaigns/${campaignId}/drafting/send`, {
          method: 'POST',
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setBulkSendState('error');
          setBulkSendMessage(typeof data.error === 'string' ? data.error : 'Send failed');
          onRefresh();
          return;
        }
        setBulkSendState('idle');
        const parts = [
          data.sent ? `Sent ${data.sent} now` : null,
          data.queued ? `Queued ${data.queued} — retrying when Agent Mail is back` : null,
          data.failed ? `${data.failed} failed` : null,
        ].filter(Boolean);
        setBulkSendMessage(parts.length > 0 ? parts.join(' · ') : 'Nothing to send');
        onRefresh();
      } catch (error) {
        setBulkSendState('error');
        setBulkSendMessage(error instanceof Error ? error.message : 'Send failed');
        onRefresh();
      }
    })();
  }

  function approve() {
    if (!current?.draft || !current.input_fingerprint || !canDecideOnDraft(current)) return;
    if (inFlightRef.current.has(current.id)) return;

    const itemId = current.id;
    const revision = contentRevision;
    const fingerprint = current.input_fingerprint;
    const fromIndex = currentIndex;
    const nextSubject = subject;
    const nextBody = body;
    const baselineSubject = current.draft.subject;
    const baselineBody = current.draft.body_text;
    const recipientLabel = current.effective_fields.fullName
      ?? current.effective_fields.email
      ?? 'Draft';

    inFlightRef.current.add(itemId);
    setActionError(null);
    approveHoldRef.current = true;
    setApproveFlash(true);
    setShowFeedback(false);
    setEditing(false);
    onOptimisticApprove(itemId, recipientLabel);
    onDecision();
    advanceAfterApprove(fromIndex, itemId);

    void (async () => {
      try {
        const savedRevision = await persistEditsIfNeeded({
          itemId,
          fingerprint,
          revision,
          nextSubject,
          nextBody,
          baselineSubject,
          baselineBody,
        });
        if (savedRevision === null) {
          setActionError('Could not save edits before download');
          onRefresh();
          return;
        }
        const response = await fetch(`/api/drafts/${itemId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'approve',
            expected_content_revision: savedRevision,
            expected_input_fingerprint: fingerprint,
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setActionError(typeof data.error === 'string' ? data.error : 'Could not download draft');
          onRefresh();
          return;
        }
        onRefresh();
      } finally {
        inFlightRef.current.delete(itemId);
      }
    })();
  }

  function denyRewrite() {
    if (!current?.draft || !canDecideOnDraft(current)) return;
    if (inFlightRef.current.has(current.id)) return;

    const itemId = current.id;
    const revision = contentRevision;
    const fingerprint = current.input_fingerprint;
    const feedback = rewriteFeedback.trim() || undefined;
    const nextSubject = subject;
    const nextBody = body;
    const baselineSubject = current.draft.subject;
    const baselineBody = current.draft.body_text;

    inFlightRef.current.add(itemId);
    setActionError(null);
    setRewriteJustLanded(false);
    setShowFeedback(false);
    setRewriteFeedback('');
    setEditing(false);
    onOptimisticRewrite(itemId);

    void (async () => {
      try {
        const savedRevision = await persistEditsIfNeeded({
          itemId,
          fingerprint,
          revision,
          nextSubject,
          nextBody,
          baselineSubject,
          baselineBody,
        });
        if (savedRevision === null) {
          onRewriteFailed(itemId);
          setActionError('Could not save edits before retry');
          onRefresh();
          return;
        }
        rewriteWatchRef.current = { itemId, revision: savedRevision };
        onBeginRewriteWatch(itemId, savedRevision);
        const response = await fetch(`/api/drafts/${itemId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'rewrite',
            expected_content_revision: savedRevision,
            idempotency_key: `rewrite:${itemId}:${savedRevision}:${Date.now()}`,
            feedback,
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          rewriteWatchRef.current = null;
          onEndRewriteWatch(itemId);
          onRewriteFailed(itemId);
          setActionError(typeof data.error === 'string' ? data.error : 'Could not queue rewrite');
          onRefresh();
          return;
        }
        onRewriteQueued(itemId);
      } catch (error) {
        rewriteWatchRef.current = null;
        onEndRewriteWatch(itemId);
        onRewriteFailed(itemId);
        setActionError(error instanceof Error ? error.message : 'Could not queue rewrite');
        onRefresh();
      } finally {
        inFlightRef.current.delete(itemId);
      }
    })();
  }

  function toggleEditing() {
    if (editing) {
      setEditing(false);
      void flushSave();
      return;
    }
    setEditFlash(true);
    setEditing(true);
    window.setTimeout(() => {
      setEditFlash(false);
      subjectRef.current?.focus();
    }, 0);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        if (event.key === 'Escape' && showFeedback) {
          event.preventDefault();
          setShowFeedback(false);
        }
        return;
      }
      if (!current?.draft) return;
      if (event.key === 'Escape' && showFeedback) {
        event.preventDefault();
        setShowFeedback(false);
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goTo(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        goTo(1);
      } else if (event.key === 'e' || event.key === 'E') {
        event.preventDefault();
        toggleEditing();
      } else if (event.key === 'd' || event.key === 'D') {
        event.preventDefault();
        approve();
      } else if (event.key === 'r' || event.key === 'R') {
        event.preventDefault();
        denyRewrite();
      } else if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        setShowFeedback((value) => !value);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const draftCount = reviewable.length;
  const emailPosition = currentIndex >= 0 ? currentIndex + 1 : 1;
  const readySendCount = sends.pending;

  if (!draftCount) {
    return (
      <div className="empty-state drafting-email-empty">
        <strong>{focus ? `No emails in “${outreachFocusLabel(focus)}”` : 'No drafts ready yet'}</strong>
        <span>
          {focus
            ? 'Click the tile again to show every draft.'
            : 'Researching leads. The first draft will appear here as soon as it is ready.'}
        </span>
      </div>
    );
  }

  if (!current?.draft) return null;

  const verification = current.delivery_snapshot?.emailVerification ?? 'unknown';
  const verificationChipLabel = verification === 'rate_limited'
    ? 'Verification rate limited'
    : verification;
  const sendDisabledReasonId = 'drafting-send-disabled-reason';
  const retrySuggested = Boolean(current.draft.retry_suggested);
  const rewriting = current.state === 'queued_rewrite' || current.state === 'rewriting';
  const decidable = canDecideOnDraft(current) && !approveFlash && !sendFlash && !rewriting;
  const alreadySent = current.draft.send_status === 'sent';
  const isQueued = current.draft.send_status === 'queued'
    || current.draft.send_status === 'sending';
  const queuedLabel = current.draft.schedule_date
    ? `Queued · ${formatNyDateLabel(current.draft.schedule_date)}`
    : 'Queued';
  const canSend = sends.configured
    && isDraftSendable(current.state)
    && !alreadySent
    && !isQueued
    && !approveFlash
    && !sendFlash
    && !rewriting;
  const sendDisabledReason = !sends.configured
    ? 'Add AGENT_MAIL_API to .env.local to enable sending'
    : alreadySent
      ? 'This draft was already sent'
      : isQueued
        ? queuedLabel
        : !isDraftSendable(current.state)
          ? 'Draft is not ready to send yet'
          : sendFlash
            ? 'Sending…'
            : null;
  const feedbackCharsLeft = 500 - rewriteFeedback.length;
  const shellClass = [
    'drafting-email-shell',
    approveFlash ? 'drafting-email-shell--approving' : '',
    sendFlash ? 'drafting-email-shell--sent-burst' : '',
    rewriting ? 'drafting-email-shell--rewriting' : '',
    rewriteJustLanded ? 'drafting-email-shell--rewrite-landed' : '',
  ].filter(Boolean).join(' ');
  const cardClass = [
    'drafting-email-card',
    'card',
    editing || editFlash ? 'drafting-email-card--editing' : '',
    alreadySent ? 'drafting-email-card--sent' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={shellClass}>
      {approveFlash ? (
        <div className="drafting-approve-burst" aria-hidden="true">
          <span className="drafting-approve-burst__check"><Download size={28} /></span>
          <span className="drafting-approve-burst__label">Downloaded</span>
        </div>
      ) : null}
      {sendFlash ? (
        <div className="drafting-send-burst" aria-hidden="true">
          <span className="drafting-send-burst__icon"><Send size={28} /></span>
          <span className="drafting-send-burst__label">Sent</span>
        </div>
      ) : null}
      <article className={cardClass} aria-label="Draft review" aria-busy={rewriting}>
      <header className="drafting-email-card__header">
        <button
          type="button"
          className="drafting-icon-btn"
          aria-label="Previous draft"
          disabled={currentIndex <= 0 || approveFlash || sendFlash}
          onClick={() => goTo(-1)}
        >
          <ChevronLeft size={18} />
        </button>
        <div className="drafting-email-card__meta">
          <div className="drafting-email-card__recipient">
            <strong>{current.effective_fields.fullName}</strong>
            <span>
              {current.effective_fields.title}
              {current.effective_fields.company ? ` · ${current.effective_fields.company}` : ''}
            </span>
          </div>
          <div className="drafting-email-card__progress">
            Email {emailPosition} of {draftCount}
            {readySendCount > 0 ? (
              <span className="drafting-email-card__progress-meta">
                {' · '}
                {readySendCount} ready to send
              </span>
            ) : null}
          </div>
          <div className="drafting-status-chip-row">
            <span
              className={`drafting-status-chip ${statusChipClass(current.state, retrySuggested)}`}
              title={
                retrySuggested && decidable
                  ? 'Automatic repair left a soft quality issue (e.g. stacked clauses). You can download as-is or retry.'
                  : undefined
              }
            >
              {statusChipLabel(current.state, current.review_status, retrySuggested)}
            </span>
            {isQueued ? (
              <Link
                href="/hub/queue"
                className="drafting-status-chip drafting-status-chip--queued"
                title="Open send queue"
              >
                {queuedLabel}
              </Link>
            ) : null}
            {alreadySent || current.draft.send_status === 'failed' ? (
              current.draft.engagement === 'replied' && current.draft.email_send_id ? (
                <Link
                  href={`/hub/conversations?thread=${current.draft.email_send_id}`}
                  className="drafting-status-chip drafting-status-chip--approved"
                  title="Open conversation"
                >
                  Replied
                </Link>
              ) : (
                <span
                  className={`drafting-status-chip ${
                    current.draft.engagement === 'bounced'
                    || current.draft.engagement === 'complained'
                    || current.draft.engagement === 'failed'
                      ? 'drafting-status-chip--failed'
                      : current.draft.engagement === 'opened'
                        || current.draft.engagement === 'clicked'
                        || current.draft.engagement === 'delivered'
                        ? 'drafting-status-chip--approved'
                        : current.draft.engagement === 'sent'
                          ? 'drafting-status-chip--ready'
                          : 'drafting-status-chip--attention'
                  }`}
                  title={
                    current.draft.open_count > 0 || current.draft.click_count > 0
                      ? `${current.draft.open_count} open${current.draft.open_count === 1 ? '' : 's'} · ${current.draft.click_count} click${current.draft.click_count === 1 ? '' : 's'}`
                      : undefined
                  }
                >
                  {current.draft.engagement === 'clicked'
                    ? 'Clicked'
                    : current.draft.engagement === 'opened'
                      ? 'Opened'
                      : current.draft.engagement === 'delivered'
                        ? 'Delivered'
                        : current.draft.engagement === 'bounced'
                          ? 'Bounced'
                          : current.draft.engagement === 'complained'
                            ? 'Complained'
                            : current.draft.engagement === 'failed'
                              ? 'Send failed'
                              : current.draft.engagement === 'replied'
                                ? 'Replied'
                                : 'Sent'}
                </span>
              )
            ) : null}
            {rewriting ? (
              <span className="drafting-rewrite-spinner loading-spinner" aria-hidden="true" />
            ) : null}
            {rewriteJustLanded ? (
              <span className="drafting-rewrite-landed" role="status">Updated</span>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          className="drafting-icon-btn"
          aria-label="Next draft"
          disabled={currentIndex < 0 || currentIndex >= reviewable.length - 1 || approveFlash || sendFlash}
          onClick={() => goTo(1)}
        >
          <ChevronRight size={18} />
        </button>
      </header>

      <div className="drafting-email-card__preview">
        <div className="drafting-email-line">
          <span className="drafting-email-line__label">From</span>
          <span>
            {sender
              ? `${sender.display_name} · inbox assigned at send`
              : 'Sender profile loading…'}
          </span>
        </div>
        <div className="drafting-email-line">
          <span className="drafting-email-line__label">To</span>
          <span>
            {current.effective_fields.fullName} &lt;{current.effective_fields.email}&gt;
          </span>
          <span className={`email-verify-chip email-verify-chip--${verification}`}>
            {verificationChipLabel}
          </span>
        </div>
        <div className="drafting-email-line drafting-email-line--subject">
          <span className="drafting-email-line__label">Subject</span>
          {editing ? (
            <input
              ref={subjectRef}
              className="drafting-email-subject"
              value={subject}
              onChange={(event) => {
                setSubject(event.target.value);
                scheduleSave(event.target.value, body);
              }}
              onBlur={() => void flushSave()}
            />
          ) : (
            <span className="drafting-email-subject-display">{subject}</span>
          )}
        </div>
        {editing ? (
          <textarea
            className="drafting-email-body drafting-email-body--editable"
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
              scheduleSave(subject, event.target.value);
            }}
            onBlur={() => void flushSave()}
            rows={12}
          />
        ) : (
          <pre className="drafting-email-body">{body}</pre>
        )}
      </div>

      <div className="drafting-email-card__toolbar">
        {editing ? (
          <span className="drafting-save-state">
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Couldn\'t save' : 'Editing'}
          </span>
        ) : null}
        {retrySuggested && decidable ? (
          <p className="drafting-retry-hint">
            {autoMode
              ? 'Retry suggested — this draft was not auto-queued. Click Retry to send it.'
              : 'Soft lint remains (e.g. stacked clauses). Download if the note is fine, or hit retry to regenerate.'}
          </p>
        ) : null}
        {rewriting ? (
          <p className="drafting-retry-hint" role="status">
            Rewriting this draft — the email will update here when ready.
          </p>
        ) : null}
        {actionError ? (
          <p className="drafting-action-error" role="alert">{actionError}</p>
        ) : null}
        <div className="drafting-email-actions-row">
          <div className="drafting-email-actions">
            <button
              type="button"
              className="drafting-icon-btn drafting-icon-btn--quiet"
              aria-label={editing ? 'Finish editing' : 'Edit draft (E)'}
              title={editing ? 'Finish editing' : 'Edit (E)'}
              disabled={approveFlash || sendFlash || rewriting}
              onClick={toggleEditing}
            >
              <Pencil size={16} />
            </button>
            <button
              type="button"
              className="drafting-icon-btn drafting-icon-btn--quiet"
              aria-label="Download for export (D)"
              title="Download for export (D)"
              disabled={!decidable}
              onClick={approve}
            >
              <Download size={16} />
            </button>
            <button
              type="button"
              className="drafting-icon-btn drafting-icon-btn--deny"
              aria-label="Deny and try again (R)"
              title="Deny and try again (R)"
              disabled={!decidable}
              onClick={denyRewrite}
            >
              <RotateCcw size={16} />
            </button>
            {isQueued && current.draft.send_status === 'queued' ? (
              <>
                <button
                  type="button"
                  className="drafting-icon-btn drafting-icon-btn--send"
                  aria-label="Send queued email now"
                  title={(sends.today_remaining ?? 0) > 0 ? 'Send now' : 'No slots remaining today'}
                  disabled={(sends.today_remaining ?? 0) < 1 || sendFlash}
                  onClick={sendQueuedDraftNow}
                >
                  <Send size={16} />
                </button>
                <button
                  type="button"
                  className="drafting-icon-btn drafting-icon-btn--deny"
                  aria-label="Cancel queued send"
                  title="Cancel queued send"
                  onClick={cancelQueuedDraft}
                >
                  <X size={16} />
                </button>
              </>
            ) : autoMode && retrySuggested ? (
              <button
                type="button"
                className="btn btn--secondary"
                aria-label="Retry suggested draft"
                disabled={!sends.configured || sendFlash}
                onClick={sendCurrentDraft}
              >
                Retry
              </button>
            ) : autoMode ? null : (
              <button
                type="button"
                className="drafting-icon-btn drafting-icon-btn--send"
                aria-label="Send email"
                aria-describedby={sendDisabledReason ? sendDisabledReasonId : undefined}
                title={canSend ? 'Send via Resend' : sendDisabledReason ?? 'Send'}
                disabled={!canSend}
                onClick={sendCurrentDraft}
              >
                <Send size={16} />
              </button>
            )}
          </div>
          {autoMode ? null : (
          <div className="drafting-send-all">
            <button
              type="button"
              className="btn btn--primary drafting-send-all__btn"
              disabled={!sends.available || bulkSendState === 'sending' || sends.pending < 1}
              title={
                !sends.configured
                  ? 'Add AGENT_MAIL_API to enable sending'
                  : sends.pending < 1
                    ? 'No ready drafts to send (retry-suggested drafts are skipped)'
                    : `Send ${sends.pending} ready email${sends.pending === 1 ? '' : 's'} via Resend`
              }
              onClick={sendAllReady}
            >
              {bulkSendState === 'sending'
                ? 'Sending…'
                : `Send ${sends.pending} Ready Email${sends.pending === 1 ? '' : 's'}`}
            </button>
            {bulkSendMessage ? (
              <p
                className={`drafting-send-all__status${bulkSendState === 'error' ? ' drafting-send-all__status--error' : ''}`}
                role="status"
              >
                {bulkSendMessage}
              </p>
            ) : null}
          </div>
          )}
        </div>
        {showFeedback ? (
          <div
            id={directionPanelId}
            className="drafting-direction-panel"
            role="region"
            aria-label="Rewrite direction"
          >
            <label className="drafting-direction-panel__label" htmlFor={`${directionPanelId}-input`}>
              Direction for rewrite
            </label>
            <textarea
              id={`${directionPanelId}-input`}
              ref={feedbackRef}
              className="drafting-direction-panel__input"
              value={rewriteFeedback}
              maxLength={500}
              rows={3}
              placeholder="e.g. Split the long opening into two short sentences. Keep the World Cup timing."
              onChange={(event) => setRewriteFeedback(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setShowFeedback(false);
                  return;
                }
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  denyRewrite();
                }
              }}
            />
            <div className="drafting-direction-panel__footer">
              <span className="drafting-direction-panel__hint">
                Optional · ⌘/Ctrl+Enter to retry · {feedbackCharsLeft} left
              </span>
              <div className="drafting-direction-panel__actions">
                <button
                  type="button"
                  className="btn btn--quiet"
                  onClick={() => {
                    setShowFeedback(false);
                    setRewriteFeedback('');
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={!decidable}
                  onClick={denyRewrite}
                >
                  Retry with direction
                </button>
              </div>
            </div>
          </div>
        ) : null}
        <p className="drafting-send-note" id={sendDisabledReasonId}>
          {sendFlash
            ? 'Sending via Resend…'
            : sendError
              ? sendError
              : isQueued
                ? (
                  <>
                    {queuedLabel}
                    {' · '}
                    <Link href="/hub/queue">Open queue</Link>
                    {(sends.today_remaining ?? 0) > 0 ? ' · Send now available' : ''}
                  </>
                )
                : alreadySent
                  ? [
                      current.draft.engagement === 'replied' && current.draft.replied_at
                        ? `Replied ${new Date(current.draft.replied_at).toLocaleString()}`
                        : current.draft.engagement === 'opened' && current.draft.opened_at
                          ? `Opened ${new Date(current.draft.opened_at).toLocaleString()}`
                          : current.draft.engagement === 'delivered' && current.draft.delivered_at
                            ? `Delivered ${new Date(current.draft.delivered_at).toLocaleString()}`
                            : current.draft.engagement === 'bounced' && current.draft.bounced_at
                              ? `Bounced ${new Date(current.draft.bounced_at).toLocaleString()}`
                              : current.draft.sent_at
                                ? `Sent ${new Date(current.draft.sent_at).toLocaleString()}`
                                : 'Sent',
                      current.draft.open_count > 0
                        ? `${current.draft.open_count} open${current.draft.open_count === 1 ? '' : 's'}`
                        : null,
                    ].filter(Boolean).join(' · ')
                  : sendDisabledReason ?? 'Send any draft via Resend — download is only required for export.'}
        </p>
      </div>
    </article>
    </div>
  );
}
