import {
  buildEffectiveLeadFields,
  missingRequiredFields,
} from '@/lib/drafting/normalize';
import type {
  DeliverySnapshot,
  DraftingCounterSnapshot,
  DraftingItemCounterInput,
  DraftingItemState,
  InputOverrides,
  InputSnapshot,
} from '@/lib/drafting/types';

export const GENERATED_STATES = ['ready_for_review', 'approved'] as const;

export const DRAFTED_STATES = ['ready_for_review', 'approved'] as const;

export const RUNNING_STATES = [
  'queued_research',
  'waiting_company_research',
  'researching',
  'queued_write',
  'writing',
  'repairing',
  'queued_rewrite',
  'rewriting',
  'verifying_mailbox',
] as const satisfies readonly DraftingItemState[];

export const FAILED_STATES = [
  'failed_research',
  'failed_write',
  'failed_rewrite',
] as const satisfies readonly DraftingItemState[];

export const LEADS_ATTENTION_STATES = [
  'needs_lead_review',
  'budget_paused',
  ...FAILED_STATES,
] as const satisfies readonly DraftingItemState[];

export function isMailboxValid(
  delivery: DeliverySnapshot | null | undefined,
): delivery is DeliverySnapshot {
  return (
    delivery != null
    && delivery.emailVerification === 'valid'
    && typeof delivery.effectiveEmail === 'string'
    && delivery.effectiveEmail.length > 0
    && typeof delivery.effectiveEmailFingerprint === 'string'
    && delivery.effectiveEmailFingerprint.length > 0
  );
}

/**
 * Fail-open for AgentMail rate limits: address may proceed to drafting, but
 * review UI must still show it was not validated.
 */
export function isMailboxDraftable(
  delivery: DeliverySnapshot | null | undefined,
): delivery is DeliverySnapshot {
  if (delivery == null) return false;
  if (
    typeof delivery.effectiveEmail !== 'string'
    || delivery.effectiveEmail.length === 0
    || typeof delivery.effectiveEmailFingerprint !== 'string'
    || delivery.effectiveEmailFingerprint.length === 0
  ) {
    return false;
  }
  return (
    delivery.emailVerification === 'valid'
    || delivery.emailVerification === 'rate_limited'
  );
}

export function isMailboxUnvalidated(delivery: DeliverySnapshot | null | undefined): boolean {
  return delivery?.emailVerification === 'rate_limited';
}

export function isLeadComplete(
  snapshot: InputSnapshot,
  overrides: InputOverrides = {},
): boolean {
  return missingRequiredFields(buildEffectiveLeadFields(snapshot, overrides)).length === 0;
}

/** Leads mode: mailbox not draftable or a required profile field is missing. */
export function isLeadsModeRow(
  snapshot: InputSnapshot,
  delivery: DeliverySnapshot | null | undefined,
  overrides: InputOverrides = {},
): boolean {
  return !isMailboxDraftable(delivery) || !isLeadComplete(snapshot, overrides);
}

export function canQueueResearch(
  snapshot: InputSnapshot,
  delivery: DeliverySnapshot | null | undefined,
  overrides: InputOverrides = {},
): boolean {
  return isMailboxDraftable(delivery) && isLeadComplete(snapshot, overrides);
}

export function canQueueWrite(
  snapshot: InputSnapshot,
  delivery: DeliverySnapshot | null | undefined,
  overrides: InputOverrides = {},
): boolean {
  return isMailboxDraftable(delivery) && isLeadComplete(snapshot, overrides);
}

export function canQueueRewrite(
  snapshot: InputSnapshot,
  delivery: DeliverySnapshot | null | undefined,
  overrides: InputOverrides = {},
): boolean {
  return isMailboxDraftable(delivery) && isLeadComplete(snapshot, overrides);
}

export function isDraftedState(state: DraftingItemState): boolean {
  return (DRAFTED_STATES as readonly string[]).includes(state);
}

export function isGeneratedState(state: DraftingItemState): boolean {
  return (GENERATED_STATES as readonly string[]).includes(state);
}

export function countMailboxValidTotal(items: readonly DraftingItemCounterInput[]): number {
  // Includes AgentMail-validated + rate-limited fail-open (draftable) mailboxes.
  return items.filter((item) => !item.removedAt && isMailboxDraftable(item.deliverySnapshot)).length;
}

export function countDrafted(items: readonly DraftingItemCounterInput[]): number {
  return items.filter((item) => !item.removedAt && isDraftedState(item.state)).length;
}

export function countApproved(items: readonly DraftingItemCounterInput[]): number {
  return items.filter((item) => !item.removedAt && item.state === 'approved').length;
}

export function isGenerationComplete(
  mailboxValidTotal: number,
  drafted: number,
): boolean {
  return mailboxValidTotal > 0 && drafted === mailboxValidTotal;
}

export function isReviewComplete(
  mailboxValidTotal: number,
  approved: number,
): boolean {
  return mailboxValidTotal > 0 && approved === mailboxValidTotal;
}

export function computeDraftingCounters(
  items: readonly DraftingItemCounterInput[],
): DraftingCounterSnapshot {
  const active = items.filter((item) => !item.removedAt);
  const mailboxValidTotal = countMailboxValidTotal(items);
  const drafted = countDrafted(items);
  const approved = countApproved(items);

  return {
    waitingForEnrichment: active.filter((item) => item.state === 'waiting_for_enrichment').length,
    leadsAttention: active.filter((item) =>
      (LEADS_ATTENTION_STATES as readonly string[]).includes(item.state),
    ).length,
    verifying: active.filter((item) => item.state === 'verifying_mailbox').length,
    removed: items.filter((item) => item.removedAt != null || item.state === 'removed').length,
    budgetPaused: active.filter((item) => item.state === 'budget_paused').length,
    running: active.filter((item) =>
      (RUNNING_STATES as readonly string[]).includes(item.state),
    ).length,
    generated: active.filter((item) => isGeneratedState(item.state)).length,
    approved,
    failed: active.filter((item) =>
      (FAILED_STATES as readonly string[]).includes(item.state),
    ).length,
    mailboxValidTotal,
    drafted,
  };
}

export function generationProgressLabel(mailboxValidTotal: number, drafted: number): string {
  if (mailboxValidTotal === 0) {
    return 'No draftable mailboxes yet';
  }
  return `${drafted} of ${mailboxValidTotal} draftable emails drafted`;
}
