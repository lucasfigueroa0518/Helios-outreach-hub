import assert from 'node:assert/strict';
import test from 'node:test';

import { completeUtcDaysInWindow } from '@/lib/analytics-attributed-cost';
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

test('completeUtcDaysInWindow excludes today', () => {
  const now = new Date('2026-08-19T15:00:00.000Z');
  const window = resolveAnalyticsWindow({ now, period: 'week' });
  const days = completeUtcDaysInWindow(window, now);
  assert.deepEqual(days, { fromDay: '2026-08-13', toDay: '2026-08-18' });
});

test('completeUtcDaysInWindow is null when the window is only today', () => {
  const now = new Date('2026-08-19T15:00:00.000Z');
  const days = completeUtcDaysInWindow({
    from: '2026-08-19T00:00:00.000Z',
    to: '2026-08-19T23:59:59.999Z',
  }, now);
  assert.equal(days, null);
});

test('attributed spend UNION does not read lead_cost_events', async () => {
  const { ATTRIBUTED_COST_UNION_SQL } = await import('@/lib/analytics-attributed-cost');
  assert.equal(/lead_cost_events/i.test(ATTRIBUTED_COST_UNION_SQL), false);
  assert.match(ATTRIBUTED_COST_UNION_SQL, /company_research_jobs/);
  assert.match(ATTRIBUTED_COST_UNION_SQL, /drafting_job_cost_events/);
  assert.match(ATTRIBUTED_COST_UNION_SQL, /reply_sends/);
  assert.match(ATTRIBUTED_COST_UNION_SQL, /extraction_summary/);
  assert.match(ATTRIBUTED_COST_UNION_SQL, /context_updates/);
});

test('spend unit costs use drafted leads and drafting jobs, not roster size or event rows', async () => {
  const { computeSpendUnitCosts } = await import('@/lib/analytics');
  const units = computeSpendUnitCosts({
    total_spend_usd: 50,
    drafting_cost_usd: 42,
    unattributed_cost_usd: 2,
    enrichment_cost_usd: 8,
    drafted_leads: 10,
    drafting_jobs: 20,
    enrichment_jobs: 4,
  });
  assert.equal(units.spend_per_lead_usd, 5);
  assert.equal(units.cost_per_drafting_usd, 2);
  assert.equal(units.cost_per_enrichment_usd, 2);
});
