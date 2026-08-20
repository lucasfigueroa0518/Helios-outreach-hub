import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AGENTMAIL_ACCOUNT_PAUSE_RETRY_MS,
  isAgentMailAccountSendingPausedError,
  nextAgentMailPauseRetryAt,
} from '@/lib/drafting/agentmail-send-errors';
import { isTransientSendError } from '@/lib/drafting/provider-admission';
import { isAgentMailRecipientBlockedError } from '@/lib/mailbox-verify';

const PAUSE_403 = 'AgentMail 403: {"name":"MessageRejectedError","code":"message_rejected","message":"Message rejected: Sending paused for this account. For more information, please check the inbox of the email address associated with your AWS account.","fix":"The message was not sent. Review the reason above, adjust the recipients or content, and resend.","docs":"https://docs.agentmail.to/errors#message_rejected"}';

test('Agent Mail account pause is a durable 4h retry, not a dead send', () => {
  assert.equal(isAgentMailAccountSendingPausedError(PAUSE_403), true);
  assert.equal(isAgentMailAccountSendingPausedError(new Error(PAUSE_403)), true);
  assert.equal(isAgentMailAccountSendingPausedError('AccountSendingPausedException'), true);
  assert.equal(AGENTMAIL_ACCOUNT_PAUSE_RETRY_MS, 4 * 60 * 60 * 1000);

  const from = new Date('2026-08-19T17:34:00.000Z');
  assert.equal(nextAgentMailPauseRetryAt(from).toISOString(), '2026-08-19T21:34:00.000Z');
});

test('Agent Mail account pause is not a terminal recipient block or short-backoff transient', () => {
  assert.equal(isAgentMailRecipientBlockedError(PAUSE_403), false);
  assert.equal(isTransientSendError(PAUSE_403), false);
  assert.equal(
    isAgentMailRecipientBlockedError('AgentMail 403: {"code":"message_rejected","message":"Recipient(s) blocked"}'),
    true,
  );
  assert.equal(
    isAgentMailAccountSendingPausedError('AgentMail 403: outreach cannot send from that inbox'),
    false,
  );
});
