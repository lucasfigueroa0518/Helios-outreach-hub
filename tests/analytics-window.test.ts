import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAnalyticsWindow } from '@/lib/analytics';

test('resolveAnalyticsWindow defaults to week', () => {
  const now = new Date('2026-07-28T15:00:00.000Z');
  const window = resolveAnalyticsWindow({ now });
  assert.equal(window.period, 'week');
  assert.equal(window.from, '2026-07-22T00:00:00.000Z');
});

test('resolveAnalyticsWindow custom requires bounds', () => {
  assert.throws(
    () => resolveAnalyticsWindow({ period: 'custom' }),
    /from and to/i,
  );
});
