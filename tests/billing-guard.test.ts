import assert from 'node:assert/strict';
import test from 'node:test';

import { parseGcpBudgetNotification } from '@/lib/billing-guard';

test('parseGcpBudgetNotification trips on Pub/Sub budget payload with cost', () => {
  const inner = {
    budgetDisplayName: 'helios-worker-zero',
    costAmount: { currencyCode: 'USD', units: '0', nanos: 2500000 },
    alertThresholdExceeded: 0.01,
  };
  const envelope = {
    message: {
      data: Buffer.from(JSON.stringify(inner), 'utf8').toString('base64'),
    },
  };
  const parsed = parseGcpBudgetNotification(envelope);
  assert.equal(parsed.shouldTrip, true);
  assert.ok(parsed.costAmount != null && parsed.costAmount > 0);
  assert.equal(parsed.currencyCode, 'USD');
  assert.match(parsed.detail, /fail-closed/i);
});

test('parseGcpBudgetNotification trips on flat GCP costAmount number', () => {
  const parsed = parseGcpBudgetNotification({
    budgetDisplayName: 'helios-worker-zero',
    costAmount: 0.0042,
    currencyCode: 'USD',
    alertThresholdExceeded: 0.01,
  });
  assert.equal(parsed.shouldTrip, true);
  assert.equal(parsed.costAmount, 0.0042);
  assert.equal(parsed.currencyCode, 'USD');
});

test('parseGcpBudgetNotification ignores notifications without a cost amount', () => {
  const parsed = parseGcpBudgetNotification({
    budgetDisplayName: 'helios-worker-zero',
    alertThresholdExceeded: 1,
  });
  assert.equal(parsed.shouldTrip, false);
});

test('parseGcpBudgetNotification ignores zero-cost status pings', () => {
  const parsed = parseGcpBudgetNotification({
    budgetDisplayName: 'helios-worker-zero',
    costAmount: 0,
    currencyCode: 'USD',
  });
  assert.equal(parsed.shouldTrip, false);
});
