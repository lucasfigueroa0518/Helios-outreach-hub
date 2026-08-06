import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentMailMessageItem } from '@/lib/agentmail';
import {
  findBounceForProbe,
  isAgentMailRateLimitError,
  isBounceForTarget,
  mailboxCandidateEmails,
  mailboxVerificationTransition,
  mailboxVerifyWaitMs,
  probeMailboxEmail,
  shouldScheduleMailboxVerification,
} from '@/lib/mailbox-verify';

const inboxId = 'lafwh@agentmail.to';
const sent = { message_id: 'probe-123', thread_id: 'thread-1', sent_at: new Date().toISOString() };

test('shouldScheduleMailboxVerification only schedules direct and inferred', () => {
  assert.equal(shouldScheduleMailboxVerification('direct'), true);
  assert.equal(shouldScheduleMailboxVerification('inferred'), true);
  assert.equal(shouldScheduleMailboxVerification('format_guess'), true);
  assert.equal(shouldScheduleMailboxVerification('not_found'), false);
  assert.equal(shouldScheduleMailboxVerification(null), false);
});

test('mailboxCandidateEmails preserves primary-first order and skips blanks', () => {
  assert.deepEqual(
    mailboxCandidateEmails({
      email_primary: 'A@Example.com',
      email_alt_1: '  ',
      email_alt_2: 'b@example.com',
    }),
    ['a@example.com', 'b@example.com'],
  );
  assert.deepEqual(
    mailboxCandidateEmails({
      email_primary: 'one@co.com',
      email_alt_1: 'two@co.com',
      email_alt_2: 'three@co.com',
    }),
    ['one@co.com', 'two@co.com', 'three@co.com'],
  );
});

test('mailboxVerifyWaitMs clamps to a safe range', () => {
  const original = process.env.AGENTMAIL_VERIFY_WAIT_MS;
  process.env.AGENTMAIL_VERIFY_WAIT_MS = '30000';
  assert.equal(mailboxVerifyWaitMs(), 30_000);
  process.env.AGENTMAIL_VERIFY_WAIT_MS = '1000';
  assert.equal(mailboxVerifyWaitMs(), 5_000);
  process.env.AGENTMAIL_VERIFY_WAIT_MS = '999999';
  assert.equal(mailboxVerifyWaitMs(), 120_000);
  if (original === undefined) delete process.env.AGENTMAIL_VERIFY_WAIT_MS;
  else process.env.AGENTMAIL_VERIFY_WAIT_MS = original;
});

test('a bounced provisional direct is removed and sent to rescue', () => {
  assert.deepEqual(mailboxVerificationTransition({
    verification: 'invalid',
    emailStatus: 'direct',
    provisionalDirect: true,
  }), {
    emailStatus: 'not_found',
    clearEmail: true,
    enqueueRescue: true,
  });
  assert.equal(mailboxVerificationTransition({
    verification: 'invalid',
    emailStatus: 'direct',
    provisionalDirect: false,
  }).clearEmail, false);
});

test('isBounceForTarget ignores outbound probe messages', () => {
  const outbound: AgentMailMessageItem = {
    message_id: 'out-1',
    from: inboxId,
    to: ['user@example.com'],
    subject: 'a',
    text: 'f',
  };
  assert.equal(isBounceForTarget(outbound, 'user@example.com', sent, inboxId), false);
});

test('isBounceForTarget detects mailer-daemon bounce mentioning target', () => {
  const bounce: AgentMailMessageItem = {
    message_id: 'bounce-1',
    from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
    subject: 'Delivery Status Notification (Failure)',
    text: 'The following address failed: user@example.com',
    in_reply_to: sent.message_id,
  };
  assert.equal(isBounceForTarget(bounce, 'user@example.com', sent, inboxId), true);
});

test('isBounceForTarget detects undeliverable subject with target in body', () => {
  const bounce: AgentMailMessageItem = {
    message_id: 'bounce-2',
    from: 'postmaster@recipient-domain.com',
    subject: 'Undeliverable: a',
    preview: 'user@example.com could not be delivered',
  };
  assert.equal(isBounceForTarget(bounce, 'user@example.com', sent, inboxId), true);
});

test('findBounceForProbe returns first matching bounce from inbox list', async () => {
  const bounce: AgentMailMessageItem = {
    message_id: 'bounce-3',
    from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
    subject: 'Delivery has failed',
    text: 'user@example.com',
    in_reply_to: sent.message_id,
  };
  const listMessages = async () => [bounce];
  const getMessage = async () => bounce;
  const found = await findBounceForProbe('user@example.com', sent, inboxId, listMessages, getMessage);
  assert.equal(found?.message_id, 'bounce-3');
});

test('findBounceForProbe returns null when inbox has no bounce', async () => {
  const listMessages = async () => [{
    message_id: 'other-1',
    from: 'news@company.com',
    subject: 'Weekly update',
    text: 'Hello team',
  }];
  const getMessage = async () => ({ message_id: 'other-1' });
  const found = await findBounceForProbe('user@example.com', sent, inboxId, listMessages, getMessage);
  assert.equal(found, null);
});

test('isAgentMailRateLimitError detects daily send limit and 429 responses', () => {
  assert.equal(isAgentMailRateLimitError(new Error('AgentMail 429: Daily send limit exceeded')), true);
  assert.equal(isAgentMailRateLimitError(new Error('rate limit hit')), true);
  assert.equal(isAgentMailRateLimitError(new Error('connection reset')), false);
});

test('probeMailboxEmail returns rate_limited without treating it as unknown', async () => {
  const result = await probeMailboxEmail('user@example.com', 'lead-1', {
    sendProbe: async () => {
      throw new Error('AgentMail 429: Daily send limit exceeded');
    },
    sleep: async () => {},
  });
  assert.deepEqual(result, {
    status: 'rate_limited',
    reason: 'rate_limited',
    error: 'AgentMail 429: Daily send limit exceeded',
  });
});
