import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attentionCount,
  buildOutreachSentence,
  outreachFocusLabel,
  rowMatchesOutreachFocus,
  sentTileSub,
} from '@/lib/auto-campaigns/outreach-insight';

const base = {
  autoStatus: 'live' as string | null,
  autoError: null as string | null,
  quota: 50,
  attachedToday: 39,
  pulled: 39,
  drafted: 4,
  drafting: true,
  queued: 0,
  sent: 1,
  failed: 0,
  retrySuggested: 0,
  bounced: 0,
  replied: 0,
  attentionLabel: null as string | null,
  nextCycleLabel: 'Fri 2:14 AM',
  nextSendLabel: null as string | null,
  draftingPaused: false,
};

test('fills today when attached is short of quota', () => {
  assert.equal(
    buildOutreachSentence(base),
    'Filling today — 39 of 50 leads in, 4 drafted.',
  );
});

test('leads with the fire, then still names the quota hole', () => {
  assert.equal(
    buildOutreachSentence({
      ...base,
      failed: 1,
      attentionLabel: 'Connell Anderson',
    }),
    '1 send failed — Connell Anderson. 39 of 50 leads in today.',
  );
});

test('paused campaign talks about the queue, not drafting progress', () => {
  assert.equal(
    buildOutreachSentence({
      ...base,
      autoStatus: 'paused',
      drafting: false,
      queued: 12,
      sent: 1,
    }),
    'Paused · 1 sent, 12 emails waiting in the send queue.',
  );
});

test('error status surfaces the stored auto_error', () => {
  assert.equal(
    buildOutreachSentence({
      ...base,
      autoStatus: 'error',
      autoError: 'Apollo rate limited',
    }),
    'Apollo rate limited',
  );
});

test('quota met plus queue names the next send', () => {
  assert.equal(
    buildOutreachSentence({
      ...base,
      attachedToday: 50,
      pulled: 50,
      drafted: 50,
      drafting: false,
      queued: 12,
      sent: 1,
      nextSendLabel: 'Fri 9:12 AM',
    }),
    '1 sent · 12 queued. Next send Fri 9:12 AM.',
  );
});

test('sent tile hides early success-rate noise', () => {
  assert.equal(
    sentTileSub({
      sentToday: 1,
      replied: 0,
      opened: 0,
      sent: 1,
      pulled: 39,
      attachedToday: 39,
      quota: 50,
    }),
    '1 today',
  );
  assert.equal(
    sentTileSub({
      sentToday: 12,
      replied: 2,
      opened: 5,
      sent: 12,
      pulled: 50,
      attachedToday: 50,
      quota: 50,
    }),
    '12 today · 2 replied · 24% reached',
  );
});

test('carousel focus isolates queued, sent, and real failures', () => {
  const queued = {
    state: 'ready_for_review',
    draft: { send_status: 'queued' as const, engagement: 'unsent' as const, retry_suggested: false },
  };
  const sent = {
    state: 'approved',
    draft: { send_status: 'sent' as const, engagement: 'opened' as const, retry_suggested: false },
  };
  const failed = {
    state: 'ready_for_review',
    draft: { send_status: 'failed' as const, engagement: 'failed' as const, retry_suggested: false },
  };
  const retry = {
    state: 'ready_for_review',
    draft: { send_status: 'unsent' as const, engagement: 'unsent' as const, retry_suggested: true },
  };
  assert.equal(rowMatchesOutreachFocus(queued, 'queued'), true);
  assert.equal(rowMatchesOutreachFocus(failed, 'sent'), false);
  assert.equal(rowMatchesOutreachFocus(sent, 'sent'), true);
  assert.equal(rowMatchesOutreachFocus(failed, 'attention'), true);
  assert.equal(rowMatchesOutreachFocus(retry, 'attention'), true);
  assert.equal(rowMatchesOutreachFocus(sent, 'attention'), false);
  assert.equal(outreachFocusLabel('attention'), 'Needs you');
  assert.equal(attentionCount({ failed: 1, retrySuggested: 2, bounced: 0 }), 3);
});
