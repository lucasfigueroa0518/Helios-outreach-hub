/**
 * Copy and carousel filters for the Auto Outreach command board.
 * Pure — no DB, no React — so the sentence a busy operator reads is testable.
 */

export type OutreachCarouselFocus = 'drafting' | 'queued' | 'sent' | 'attention';

export type OutreachInsightInput = {
  autoStatus: string | null;
  autoError: string | null;
  quota: number;
  attachedToday: number;
  pulled: number;
  drafted: number;
  drafting: boolean;
  queued: number;
  sent: number;
  failed: number;
  retrySuggested: number;
  bounced: number;
  replied: number;
  attentionLabel: string | null;
  nextCycleLabel: string | null;
  nextSendLabel: string | null;
  draftingPaused: boolean;
  launching?: boolean;
};

export type OutreachFocusRow = {
  state: string;
  draft: {
    send_status: 'unsent' | 'queued' | 'sending' | 'sent' | 'failed';
    engagement:
      | 'unsent'
      | 'failed'
      | 'sent'
      | 'delivered'
      | 'opened'
      | 'clicked'
      | 'replied'
      | 'bounced'
      | 'complained';
    retry_suggested: boolean;
  } | null;
};

export function countNoun(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function attentionCount(input: Pick<OutreachInsightInput, 'failed' | 'retrySuggested' | 'bounced'>): number {
  return input.failed + input.retrySuggested + input.bounced;
}

export function rowMatchesOutreachFocus(
  row: OutreachFocusRow,
  focus: OutreachCarouselFocus | null,
): boolean {
  if (!focus) return Boolean(row.draft) && !['removed', 'waiting_for_enrichment'].includes(row.state);
  if (!row.draft || ['removed', 'waiting_for_enrichment'].includes(row.state)) return false;
  const draft = row.draft;
  if (focus === 'queued') return draft.send_status === 'queued' || draft.send_status === 'sending';
  if (focus === 'sent') {
    if (draft.send_status === 'failed') return false;
    return draft.send_status === 'sent'
      || ['sent', 'delivered', 'opened', 'clicked', 'replied'].includes(draft.engagement);
  }
  if (focus === 'drafting') {
    return draft.send_status === 'unsent';
  }
  const failed = draft.send_status === 'failed'
    || draft.engagement === 'failed'
    || draft.engagement === 'bounced'
    || draft.engagement === 'complained';
  const retry = draft.retry_suggested && draft.send_status === 'unsent';
  return failed || retry;
}

export function outreachFocusLabel(focus: OutreachCarouselFocus): string {
  if (focus === 'queued') return 'Queued to send';
  if (focus === 'sent') return 'Sent';
  if (focus === 'drafting') return 'Unsent drafts';
  return 'Needs you';
}

function attentionClause(input: OutreachInsightInput): string | null {
  const bits: string[] = [];
  if (input.failed > 0) {
    const fail = countNoun(input.failed, 'send failed', 'sends failed');
    bits.push(input.attentionLabel ? `${fail} — ${input.attentionLabel}` : fail);
  }
  if (input.retrySuggested > 0) {
    bits.push(`${countNoun(input.retrySuggested, 'draft')} need a rewrite`);
  }
  if (input.bounced > 0) {
    bits.push(countNoun(input.bounced, 'bounce'));
  }
  if (bits.length === 0) return null;
  return bits.join(', ');
}

/**
 * One sentence a person can read in two seconds: fires first, then today's
 * quota, then what's in motion. Lifetime success % is too noisy this early.
 */
export function buildOutreachSentence(input: OutreachInsightInput): string {
  if (input.autoStatus === 'error' && input.autoError) return input.autoError;
  if (input.autoStatus === 'pending_sender') {
    return 'Waiting on a ready sender before the first cycle can run.';
  }
  if (input.launching && input.drafted === 0) {
    return input.quota > 0
      ? `Setting up today’s ${input.quota} — drafts will land here as leads attach.`
      : 'Setting up today’s drafts.';
  }
  if (input.autoStatus === 'paused') {
    const waiting = input.queued > 0
      ? `${countNoun(input.queued, 'email')} waiting in the send queue`
      : `${countNoun(Math.max(0, input.drafted - input.sent), 'unsent draft')}`;
    return `Paused · ${input.sent} sent, ${waiting}.`;
  }
  if (input.draftingPaused) {
    return 'Drafting is paused. Item progress is saved — resume when you are ready.';
  }
  if (input.autoStatus === 'exhausted') {
    const reached = input.pulled > 0
      ? ` ${input.sent} of ${input.pulled} leads reached.`
      : '';
    return `Search inventory is exhausted.${reached}`;
  }

  const fire = attentionClause(input);
  const quota = Math.max(0, input.quota);
  const short = quota > 0 ? Math.max(0, quota - input.attachedToday) : 0;

  if (fire) {
    if (quota > 0 && input.attachedToday < quota) {
      return `${fire}. ${input.attachedToday} of ${quota} leads in today.`;
    }
    if (input.queued > 0 && input.nextSendLabel) {
      return `${fire}. ${input.queued} still queued · next ${input.nextSendLabel}.`;
    }
    return `${fire}.`;
  }

  if (quota > 0 && input.attachedToday < quota) {
    if (input.drafting) {
      return `Filling today — ${input.attachedToday} of ${quota} leads in, ${input.drafted} drafted.`;
    }
    if (short > 0 && input.nextCycleLabel) {
      return `${input.attachedToday} of ${quota} leads today. ${short} still coming. Next prospecting ${input.nextCycleLabel}.`;
    }
    return `${input.attachedToday} of ${quota} leads in today${input.drafted > 0 ? `, ${input.drafted} drafted` : ''}.`;
  }

  if (input.drafting && quota > 0) {
    return `Writing today’s list — ${input.drafted} of ${input.attachedToday || input.pulled} drafted${input.queued > 0 ? `, ${input.queued} queued` : ''}.`;
  }

  if (input.queued > 0) {
    const next = input.nextSendLabel ? ` Next send ${input.nextSendLabel}.` : '';
    return `${input.sent} sent · ${input.queued} queued.${next}`;
  }

  if (input.sent > 0) {
    const reached = input.pulled > 0 ? ` of ${input.pulled} leads reached` : '';
    const replies = input.replied > 0 ? ` · ${countNoun(input.replied, 'reply', 'replies')}` : '';
    const next = input.nextCycleLabel ? ` Next cycle ${input.nextCycleLabel}.` : '';
    return `${input.sent} sent${reached}${replies}.${next}`;
  }

  if (quota > 0 && input.attachedToday === 0) {
    return `Looking for today’s ${quota} leads.`;
  }

  return 'Waiting for the first draft to land.';
}

export function sentTileSub(input: {
  sentToday: number;
  replied: number;
  opened: number;
  sent: number;
  pulled: number;
  attachedToday: number;
  quota: number;
}): string {
  const bits: string[] = [];
  if (input.sentToday > 0) bits.push(`${input.sentToday} today`);
  if (input.replied > 0) bits.push(`${input.replied} replied`);
  else if (input.opened > 0) bits.push(`${input.opened} opened`);
  const showRate = input.pulled > 0
    && input.sent > 0
    && (input.sent >= 5 || (input.quota > 0 && input.attachedToday >= input.quota));
  if (showRate) {
    bits.push(`${Math.round((input.sent / input.pulled) * 100)}% reached`);
  }
  return bits.join(' · ') || 'None out yet';
}
