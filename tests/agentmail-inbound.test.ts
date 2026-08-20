import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentMailReceivedContent,
  shouldIgnoreAgentMailInbound,
  unwrapAgentMailWebhookPayload,
} from '@/lib/drafting/agentmail-engagement';

test('AgentMail webhook unwraps nested Svix-style payloads', () => {
  const inner = unwrapAgentMailWebhookPayload({
    data: {
      event_type: 'message.received',
      event_id: 'evt-1',
      message: { message_id: 'm1', from: 'lead@example.com' },
    },
  });
  assert.equal(inner.event_type, 'message.received');
  assert.equal(inner.message?.message_id, 'm1');
});

test('received content extracts From display-name addresses', () => {
  const content = agentMailReceivedContent({
    event_type: 'message.received',
    message: {
      message_id: 'm1',
      from: 'Blane Clark <blane.clark@keanmiller.com>',
      to: ['Lucas Figueroa <lucas@heliosgroup.email>'],
      subject: 'Out of Office',
      text: 'I am away.',
      timestamp: '2026-08-20T15:00:00.000Z',
      headers: { 'Auto-Submitted': 'auto-replied' },
    },
  });
  assert.ok(content);
  assert.equal(content.fromEmail, 'blane.clark@keanmiller.com');
  assert.deepEqual(content.toEmails, ['lucas@heliosgroup.email']);
  assert.equal(content.headers['auto-submitted'], 'auto-replied');
  assert.equal(content.headers.subject, 'Out of Office');
});

test('own sends and verify inbox inbound are ignored', () => {
  assert.equal(
    shouldIgnoreAgentMailInbound({
      inboxId: 'lucas@heliosgroup.email',
      fromEmail: 'lucas@heliosgroup.email',
    }),
    'own_outbound',
  );
  assert.equal(
    shouldIgnoreAgentMailInbound({
      inboxId: 'abcdefg@agentmail.to',
      fromEmail: 'lead@example.com',
    }),
    'verify_inbox_ignored',
  );
  assert.equal(
    shouldIgnoreAgentMailInbound({
      inboxId: 'lucas@heliosgroup.email',
      fromEmail: 'lead@example.com',
      labels: ['helios-inbound-forward'],
    }),
    'inbound_forward',
  );
  assert.equal(
    shouldIgnoreAgentMailInbound({
      inboxId: 'lucas@heliosgroup.email',
      fromEmail: 'lead@example.com',
      labels: ['unauthenticated'],
    }),
    null,
  );
});
