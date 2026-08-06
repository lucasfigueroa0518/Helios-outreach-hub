/**
 * Pure drafting queue eligibility helpers (no DB imports).
 *
 * Used by Go to Drafting, single/bulk approve, and the system reconciler so
 * large campaigns do not strand draftable leads in needs_lead_review.
 */
import { canQueueResearch, isLeadComplete } from '@/lib/drafting/eligibility';
import type {
  DeliverySnapshot,
  DraftingItemState,
  InputOverrides,
  InputSnapshot,
} from '@/lib/drafting/types';

/**
 * States the system may auto-advance without a human click.
 * failed_write / failed_rewrite stay human-gated — hard lint must not burn shards.
 */
export const AUTO_QUEUE_IDLE_STATES = [
  'needs_lead_review',
  'waiting_for_enrichment',
  'budget_paused',
  'failed_research',
] as const satisfies readonly DraftingItemState[];

/** States a human Approve (single/bulk) may re-enter from. */
export const QUEUEABLE_IDLE_STATES = [
  ...AUTO_QUEUE_IDLE_STATES,
  'failed_write',
  'failed_rewrite',
] as const satisfies readonly DraftingItemState[];

export type QueueableIdleState = (typeof QUEUEABLE_IDLE_STATES)[number];
export type AutoQueueIdleState = (typeof AUTO_QUEUE_IDLE_STATES)[number];

/** Research failures that must not steal drafting shards on system reconcile. */
export const NON_AUTO_RETRY_ERROR_CODES = new Set([
  'empty_research_brief',
  'research_provider_error',
  'hard_lint_no_auto_repair',
  'hard_lint_after_repair',
]);

export function isQueueableIdleState(state: string): state is QueueableIdleState {
  return (QUEUEABLE_IDLE_STATES as readonly string[]).includes(state);
}

export function isAutoQueueIdleState(state: string): state is AutoQueueIdleState {
  return (AUTO_QUEUE_IDLE_STATES as readonly string[]).includes(state);
}

export type DraftingEnqueueAction = 'research' | 'verify_mailbox';

/**
 * Decide whether an idle item should leave Leads mode.
 * - Auto/system paths never re-queue hard write failures.
 * - Human lead_approval may retry write failures when draftable.
 * - Complete-but-unverified mailboxes get verify_mailbox (matches single approve).
 */
export function resolveDraftingEnqueueAction(input: {
  state: DraftingItemState;
  snapshot: InputSnapshot;
  delivery: DeliverySnapshot | null;
  overrides?: InputOverrides;
  /** system / go_to_drafting / retry vs human lead_approval */
  mode: 'auto' | 'human';
  lastErrorCode?: string | null;
}): DraftingEnqueueAction | null {
  const idleOk = input.mode === 'human'
    ? isQueueableIdleState(input.state)
    : isAutoQueueIdleState(input.state);
  if (!idleOk) return null;

  if (
    input.mode === 'auto'
    && input.state === 'failed_research'
    && input.lastErrorCode
    && NON_AUTO_RETRY_ERROR_CODES.has(input.lastErrorCode)
  ) {
    return null;
  }

  if (canQueueResearch(input.snapshot, input.delivery, input.overrides)) {
    return 'research';
  }

  // Pending / unknown / inferred — queue AgentMail verify when fields are complete.
  const delivery = input.delivery;
  const needsMailboxVerify = Boolean(
    delivery
    && delivery.effectiveEmail.length > 0
    && delivery.emailVerification !== 'invalid'
    && delivery.emailVerification !== 'missing'
    && delivery.emailVerification !== 'valid'
    && delivery.emailVerification !== 'rate_limited',
  );
  if (
    isLeadComplete(input.snapshot, input.overrides)
    && needsMailboxVerify
  ) {
    // Human-only for write/rewrite failures (already excluded from auto idle).
    if (input.state === 'failed_write' || input.state === 'failed_rewrite') {
      return null;
    }
    return 'verify_mailbox';
  }

  return null;
}

/**
 * True when an idle item is eligible to auto-enter research (draftable + complete).
 * Kept for callers/tests that only care about research auto-queue.
 */
export function shouldAutoQueueDraftingItem(input: {
  state: DraftingItemState;
  snapshot: InputSnapshot;
  delivery: DeliverySnapshot | null;
  overrides?: InputOverrides;
  lastErrorCode?: string | null;
}): boolean {
  return resolveDraftingEnqueueAction({ ...input, mode: 'auto' }) === 'research';
}

/** Approve-for-drafting is allowed whenever the row is idle in Leads mode. */
export function canApproveIdleDraftingItem(input: {
  state: DraftingItemState;
  missingFieldCount: number;
}): boolean {
  if (input.missingFieldCount > 0) return false;
  if (input.state === 'verifying_mailbox') {
    return false;
  }
  // waiting_for_enrichment: allow approve once fields are complete — verify/research
  // will proceed; enrichment lag must not permanently trap the row.
  return isQueueableIdleState(input.state);
}
