import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isProviderPressureError,
  isTransientSendError,
  resolveAnthropicMaxInflight,
} from '../lib/drafting/provider-admission';
import { draftingAnthropicSnapshot } from '../lib/drafting/anthropic-semaphore';
import { primaryFleetWorkerId } from '../lib/orchestration/fleet';
import { RECONCILE_ORPHAN_FANOUT_LIMIT } from '../lib/orchestration/repository';
import { releaseReservation } from '../lib/drafting/cost';

const envSnapshot = { ...process.env };

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  Object.assign(process.env, overrides);
  try {
    fn();
  } finally {
    process.env = { ...envSnapshot };
  }
}

test('reservation release math never goes negative', () => {
  assert.equal(releaseReservation('0.0900', '0.0600'), '0.0300');
  assert.equal(releaseReservation('0.0200', '0.0600'), '0.0000');
});

test('anthropic semaphore and admission share one ceiling', () => {
  withEnv({ DRAFTING_ANTHROPIC_MAX_INFLIGHT: '6' }, () => {
    assert.equal(resolveAnthropicMaxInflight(), 6);
    assert.equal(draftingAnthropicSnapshot().configuredLimit, 6);
  });
});

test('transient send classifier is narrow (429/5xx), not all failures', () => {
  assert.equal(isTransientSendError('429 rate limit exceeded'), true);
  assert.equal(isTransientSendError('Resend 503 temporarily unavailable'), true);
  assert.equal(isProviderPressureError('overloaded_error'), true);
  assert.equal(isTransientSendError('Recipient email is missing or invalid'), false);
  assert.equal(isTransientSendError('RESEND_API_KEY is not configured'), false);
  assert.equal(isTransientSendError('Draft is no longer sendable'), false);
});

test('fleet primary id is opt-in via env', () => {
  withEnv({ ORCHESTRATION_PRIMARY_WORKER_ID: undefined }, () => {
    assert.equal(primaryFleetWorkerId(), null);
  });
  withEnv({ ORCHESTRATION_PRIMARY_WORKER_ID: 'gcp-e2-micro-1' }, () => {
    assert.equal(primaryFleetWorkerId(), 'gcp-e2-micro-1');
  });
});

test('reconcile orphan fan-out has a hard page limit', () => {
  assert.ok(RECONCILE_ORPHAN_FANOUT_LIMIT <= 100);
  assert.ok(RECONCILE_ORPHAN_FANOUT_LIMIT >= 10);
});
