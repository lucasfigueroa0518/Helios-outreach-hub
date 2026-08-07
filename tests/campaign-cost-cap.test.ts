import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAMPAIGN_COST_CAP_USD,
  leadsToRemoveForCap,
} from '@/lib/campaign-cost-cap';

test('leadsToRemoveForCap is 0 when under cap', () => {
  assert.equal(
    leadsToRemoveForCap({ estimatedTotalUsd: 40, perLeadUsd: 0.05 }),
    0,
  );
});

test('leadsToRemoveForCap rounds up excess over $50', () => {
  assert.equal(CAMPAIGN_COST_CAP_USD, 50);
  // $55 at $0.05/lead → need to cut $5 → 100 leads
  assert.equal(
    leadsToRemoveForCap({ estimatedTotalUsd: 55, perLeadUsd: 0.05 }),
    100,
  );
  // Tiny overrun still requires at least 1 lead removed
  assert.equal(
    leadsToRemoveForCap({ estimatedTotalUsd: 50.01, perLeadUsd: 0.5 }),
    1,
  );
});
