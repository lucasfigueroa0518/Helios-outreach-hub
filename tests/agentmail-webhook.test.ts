import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  svixSigningKey,
  verifyAgentMailWebhookAuth,
  verifySvixSignature,
} from '@/lib/agentmail-webhook';

const SECRET = 'test-webhook-secret';
const BODY = '{"event_type":"message.received"}';

function sign(secret: string, id: string, timestamp: string, body: string): string {
  const digest = createHmac('sha256', svixSigningKey(secret)).update(`${id}.${timestamp}.${body}`).digest('base64');
  return `v1,${digest}`;
}

test('AgentMail webhook rejects unsigned bodies and a bare svix-id', () => {
  assert.equal(verifyAgentMailWebhookAuth({
    secret: SECRET,
    rawBody: BODY,
  }), false);
  assert.equal(verifyAgentMailWebhookAuth({
    secret: SECRET,
    rawBody: BODY,
    svixId: 'msg_forged',
  }), false);
  assert.equal(verifyAgentMailWebhookAuth({
    secret: SECRET,
    rawBody: BODY,
    svixId: 'msg_forged',
    svixTimestamp: String(Math.floor(Date.now() / 1000)),
    svixSignature: 'v1,not-a-real-signature',
  }), false);
  assert.equal(verifyAgentMailWebhookAuth({
    secret: '',
    rawBody: BODY,
    providedSecret: SECRET,
  }), false);
});

test('AgentMail webhook accepts a matching shared secret', () => {
  assert.equal(verifyAgentMailWebhookAuth({
    secret: SECRET,
    rawBody: BODY,
    providedSecret: SECRET,
  }), true);
  assert.equal(verifyAgentMailWebhookAuth({
    secret: SECRET,
    rawBody: BODY,
    providedSecret: 'wrong-secret',
  }), false);
});

test('AgentMail webhook accepts a verified Svix signature', () => {
  const svixId = 'msg_1';
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const svixSignature = sign(SECRET, svixId, svixTimestamp, BODY);
  assert.equal(verifySvixSignature({
    secret: SECRET,
    rawBody: BODY,
    svixId,
    svixTimestamp,
    svixSignature,
  }), true);
  assert.equal(verifyAgentMailWebhookAuth({
    secret: SECRET,
    rawBody: BODY,
    svixId,
    svixTimestamp,
    svixSignature,
  }), true);
  assert.equal(verifyAgentMailWebhookAuth({
    secret: SECRET,
    rawBody: '{"forged":true}',
    svixId,
    svixTimestamp,
    svixSignature,
  }), false);
});
