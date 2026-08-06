import type { DraftingItemState, ReviewStatus } from '@/lib/drafting/types';

export type TransitionConflict = {
  ok: false;
  conflict: true;
  reason: string;
};

export type TransitionSuccess = {
  ok: true;
  state: DraftingItemState;
  reviewStatus: ReviewStatus;
};

export type TransitionResult = TransitionConflict | TransitionSuccess;

export type TransitionContext = {
  mailboxValid?: boolean;
};

const INITIAL_STATE = '__initial__' as const;

type TransitionFrom = DraftingItemState | typeof INITIAL_STATE;

const ALLOWED_TRANSITIONS: Record<TransitionFrom, readonly DraftingItemState[]> = {
  [INITIAL_STATE]: [
    'waiting_for_enrichment',
    'needs_lead_review',
    'verifying_mailbox',
    'queued_research',
    'budget_paused',
  ],
  waiting_for_enrichment: [
    'needs_lead_review',
    'verifying_mailbox',
    'queued_research',
    'budget_paused',
    'removed',
  ],
  needs_lead_review: [
    'verifying_mailbox',
    'queued_research',
    'budget_paused',
    'removed',
  ],
  verifying_mailbox: [
    'needs_lead_review',
    'queued_research',
    'budget_paused',
    'removed',
  ],
  budget_paused: ['queued_research', 'removed'],
  queued_research: ['researching', 'waiting_company_research', 'removed', 'cancelled'],
  waiting_company_research: [
    'queued_research',
    'researching',
    'failed_research',
    'removed',
    'cancelled',
  ],
  researching: [
    'queued_write',
    'waiting_company_research',
    // Self-retry: empty research brief queues exactly one fresh research pass
    // while the item is still mid-research (see handleResearch writeBlocked).
    'queued_research',
    'failed_research',
    'removed',
    'cancelled',
  ],
  queued_write: ['writing', 'removed', 'cancelled'],
  writing: [
    'repairing',
    'ready_for_review',
    'failed_write',
    'removed',
    'cancelled',
  ],
  repairing: ['ready_for_review', 'failed_write', 'removed', 'cancelled'],
  ready_for_review: [
    'approved',
    'queued_rewrite',
    'needs_lead_review',
    'removed',
  ],
  approved: ['ready_for_review', 'queued_rewrite', 'needs_lead_review', 'removed'],
  queued_rewrite: ['rewriting', 'removed', 'cancelled'],
  rewriting: [
    'repairing',
    'ready_for_review',
    'failed_rewrite',
    'removed',
    'cancelled',
  ],
  failed_research: ['queued_research', 'needs_lead_review', 'removed'],
  failed_write: [
    'queued_write',
    'queued_rewrite',
    'approved',
    'ready_for_review',
    'needs_lead_review',
    'removed',
  ],
  failed_rewrite: [
    'queued_rewrite',
    'approved',
    'ready_for_review',
    'needs_lead_review',
    'removed',
  ],
  removed: [],
  cancelled: [],
};

export const MAILBOX_RECHECK_TARGET_STATES = new Set<DraftingItemState>([
  'queued_research',
  'researching',
  'queued_write',
  'writing',
  'repairing',
  'ready_for_review',
  'approved',
  'queued_rewrite',
  'rewriting',
]);

export function syncReviewStatus(state: DraftingItemState): ReviewStatus {
  return state === 'approved' ? 'approved' : 'unreviewed';
}

export function isTransitionAllowed(
  from: DraftingItemState | typeof INITIAL_STATE,
  to: DraftingItemState,
): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function transition(
  from: DraftingItemState | typeof INITIAL_STATE,
  to: DraftingItemState,
  context: TransitionContext = {},
): TransitionResult {
  if (!isTransitionAllowed(from, to)) {
    return {
      ok: false,
      conflict: true,
      reason: `Illegal transition from ${from} to ${to}`,
    };
  }

  if (
    MAILBOX_RECHECK_TARGET_STATES.has(to)
    && context.mailboxValid === false
  ) {
    return {
      ok: false,
      conflict: true,
      reason: 'Mailbox must be valid for this transition',
    };
  }

  return {
    ok: true,
    state: to,
    reviewStatus: syncReviewStatus(to),
  };
}

/**
 * Typed FSM conflict. Callers processing a possibly-stale claim (duplicate
 * worker, revived job) treat this as a benign supersede — never a failure
 * that torches the item or the run.
 */
export class TransitionConflictError extends Error {
  readonly from: string;
  readonly to: string;

  constructor(from: DraftingItemState | typeof INITIAL_STATE, to: DraftingItemState, reason: string) {
    super(reason);
    this.name = 'TransitionConflictError';
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(
  from: DraftingItemState | typeof INITIAL_STATE,
  to: DraftingItemState,
  context: TransitionContext = {},
): TransitionSuccess {
  const result = transition(from, to, context);
  if (!result.ok) {
    throw new TransitionConflictError(from, to, result.reason);
  }
  return result;
}

export { INITIAL_STATE as DRAFTING_INITIAL_STATE };
