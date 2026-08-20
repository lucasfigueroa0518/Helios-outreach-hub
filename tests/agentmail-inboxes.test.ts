import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENTMAIL_VERIFY_INBOX,
  assertOutreachInbox,
  assertVerifyInbox,
  formatAgentMailDisplayName,
  resolveAgentMailSenderName,
  inferIdentitySlug,
  isBlockedOutreachFrom,
  isOutreachInbox,
  isVerifyInbox,
  OUTREACH_INBOX_EMAILS,
  personalForwardEmailForInbox,
  resolveConfiguredVerifyInbox,
} from '@/lib/agentmail-inboxes';
import { agentMailInboxId } from '@/lib/agentmail';

test('verify inbox is locked to abcdefg@agentmail.to', () => {
  assert.equal(AGENTMAIL_VERIFY_INBOX, 'abcdefg@agentmail.to');
  assert.equal(isVerifyInbox('ABCDEFG@agentmail.to'), true);
  assert.equal(isVerifyInbox('lucas@heliosgroup.email'), false);
  assert.equal(assertVerifyInbox('  abcdefg@agentmail.to  '), AGENTMAIL_VERIFY_INBOX);
  assert.throws(() => assertVerifyInbox('lucas@heliosgroup.email'));
  assert.throws(() => assertVerifyInbox('lafwh@agentmail.to'));
});

test('AGENTMAIL_INBOX_ID cannot point probes at an outreach inbox', () => {
  const original = process.env.AGENTMAIL_INBOX_ID;
  try {
    delete process.env.AGENTMAIL_INBOX_ID;
    assert.equal(resolveConfiguredVerifyInbox(), AGENTMAIL_VERIFY_INBOX);
    process.env.AGENTMAIL_INBOX_ID = 'abcdefg@agentmail.to';
    assert.equal(agentMailInboxId(), AGENTMAIL_VERIFY_INBOX);
    process.env.AGENTMAIL_INBOX_ID = 'lucas@heliosgroup.email';
    assert.throws(() => agentMailInboxId());
  } finally {
    if (original === undefined) delete process.env.AGENTMAIL_INBOX_ID;
    else process.env.AGENTMAIL_INBOX_ID = original;
  }
});

test('outreach allowlist is the seven Helios inboxes', () => {
  assert.equal(OUTREACH_INBOX_EMAILS.length, 7);
  assert.equal(isOutreachInbox('lucas@heliosgroup.email'), true);
  assert.equal(isOutreachInbox('thomas@heliosgroup.email'), true);
  assert.equal(isOutreachInbox('thomas@heliosgroup.online'), true);
  assert.equal(isOutreachInbox('lucas@heliosgroup.ai'), false);
  assert.equal(isOutreachInbox(AGENTMAIL_VERIFY_INBOX), false);
  assert.equal(assertOutreachInbox('Lucas@Heliosgroup.email'), 'lucas@heliosgroup.email');
  assert.throws(() => assertOutreachInbox('lucas@heliosgroup.ai'));
  assert.throws(() => assertOutreachInbox(AGENTMAIL_VERIFY_INBOX));
});

test('personal @heliosgroup.ai addresses cannot be used as From', () => {
  assert.equal(isBlockedOutreachFrom('lucas@heliosgroup.ai'), true);
  assert.equal(isBlockedOutreachFrom('tommy@heliosgroup.ai'), true);
  assert.equal(isBlockedOutreachFrom('anyone@heliosgroup.ai'), true);
  assert.equal(isBlockedOutreachFrom('lucas@heliosgroup.email'), false);
  assert.equal(isBlockedOutreachFrom('not-an-email'), true);
});

test('inbound replies forward to the identity personal mailbox', () => {
  assert.equal(personalForwardEmailForInbox('lucas@heliosgroup.email'), 'lucas@heliosgroup.ai');
  assert.equal(personalForwardEmailForInbox('l.figueroa@heliosgroup.email'), 'lucas@heliosgroup.ai');
  assert.equal(personalForwardEmailForInbox('thomas@heliosgroup.email'), 'tommy@heliosgroup.ai');
  assert.equal(personalForwardEmailForInbox('tommy@heliosgroup.email'), 'tommy@heliosgroup.ai');
});

test('identity slug is inferred from snapshot fields', () => {
  assert.equal(inferIdentitySlug({ identitySlug: 'tommy' }), 'tommy');
  assert.equal(inferIdentitySlug({ workEmail: 'thomas@heliosgroup.email' }), 'tommy');
  assert.equal(inferIdentitySlug({ workEmail: 'lucas@heliosgroup.ai' }), 'lucas');
  assert.equal(inferIdentitySlug({ displayName: 'Thomas Pozo' }), 'tommy');
  assert.equal(inferIdentitySlug({ displayName: 'Lucas Figueroa' }), 'lucas');
});

test('AgentMail inbox display names never fall back to AgentMail', () => {
  assert.equal(resolveAgentMailSenderName('Lucas Figueroa', 'lucas@heliosgroup.email'), 'Lucas Figueroa');
  assert.equal(resolveAgentMailSenderName('AgentMail', 'lucas@heliosgroup.email'), 'Lucas Figueroa');
  assert.equal(resolveAgentMailSenderName('', 'thomas@heliosgroup.email'), 'Thomas Pozo');
  assert.equal(
    resolveAgentMailSenderName('Lucas Figueroa <lucas@heliosgroup.email>', 'lucas@heliosgroup.email'),
    'Lucas Figueroa',
  );
  assert.equal(
    formatAgentMailDisplayName('Lucas Figueroa', 'lucas@heliosgroup.email'),
    'Lucas Figueroa <lucas@heliosgroup.email>',
  );
  assert.throws(() => formatAgentMailDisplayName('Lucas', AGENTMAIL_VERIFY_INBOX));
});
