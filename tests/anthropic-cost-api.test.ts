import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseCostApiAmountUsd,
  fetchAllAnthropicCostReportBuckets,
} from '@/lib/anthropic-cost-api';

test('Cost API amount strings are cents', () => {
  assert.equal(parseCostApiAmountUsd('123.45'), 1.2345);
  assert.equal(parseCostApiAmountUsd('100'), 1);
  assert.equal(parseCostApiAmountUsd('0'), 0);
});

test('cost report pagination concatenates buckets', async () => {
  const pages = [
    {
      data: [{ starting_at: '2026-08-18T00:00:00Z', ending_at: '2026-08-19T00:00:00Z', results: [] }],
      has_more: true,
      next_page: 'page_2',
    },
    {
      data: [{
        starting_at: '2026-08-19T00:00:00Z',
        ending_at: '2026-08-20T00:00:00Z',
        results: [{
          amount: '200',
          cost_type: 'tokens',
          token_type: 'uncached_input_tokens',
          model: 'claude-sonnet-5',
          currency: 'USD',
        }],
      }],
      has_more: false,
      next_page: null,
    },
  ];
  let calls = 0;
  const buckets = await fetchAllAnthropicCostReportBuckets({
    startingAt: '2026-08-18T00:00:00Z',
    endingAt: '2026-08-20T00:00:00Z',
    fetchPage: async ({ page }) => {
      const idx = calls;
      calls += 1;
      if (idx === 0) assert.equal(page, undefined);
      if (idx === 1) assert.equal(page, 'page_2');
      return pages[idx]!;
    },
  });
  assert.equal(buckets.length, 2);
  assert.equal(calls, 2);
  assert.equal(buckets[1]?.results[0]?.amount, '200');
});
