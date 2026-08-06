import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  campaignRampDelayMs,
  effectiveDraftingResearchLaneLimit,
  effectiveDraftingWriteLaneLimit,
  effectiveWorkerMaxConcurrency,
  isProviderPressureError,
  PEAK_ANTHROPIC_CALLS_PER_RESEARCH_PIPELINE,
} from '../lib/drafting/provider-admission';

const envSnapshot = { ...process.env };

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  Object.assign(process.env, overrides);
  try {
    fn();
  } finally {
    process.env = { ...envSnapshot };
  }
}

test('research lane limit is capped by anthropic budget / peak calls per pipeline', () => {
  withEnv({
    DRAFTING_ANTHROPIC_MAX_INFLIGHT: '8',
    ORG_DRAFT_RESEARCH_CONCURRENCY: '8',
    ORG_DRAFT_WRITE_CONCURRENCY: '8',
  }, () => {
    assert.equal(
      effectiveDraftingResearchLaneLimit(),
      Math.floor(8 / PEAK_ANTHROPIC_CALLS_PER_RESEARCH_PIPELINE),
    );
  });
});

test('write lane limit reserves research headroom within provider budget', () => {
  withEnv({
    DRAFTING_ANTHROPIC_MAX_INFLIGHT: '8',
    ORG_DRAFT_RESEARCH_CONCURRENCY: '8',
    ORG_DRAFT_WRITE_CONCURRENCY: '8',
  }, () => {
    const research = effectiveDraftingResearchLaneLimit();
    const write = effectiveDraftingWriteLaneLimit();
    assert.ok(research >= 1);
    assert.ok(write >= 1);
    assert.ok(research + write <= 8);
  });
});

test('campaign cold-start ramp staggers pipeline starts', () => {
  withEnv({ DRAFTING_CAMPAIGN_RAMP_MS: '3000' }, () => {
    assert.equal(campaignRampDelayMs(0), 0);
    assert.equal(campaignRampDelayMs(1), 3000);
    assert.equal(campaignRampDelayMs(4), 12000);
  });
});

test('529 overloaded counts as provider pressure', () => {
  assert.equal(
    isProviderPressureError('529 {"error":{"type":"overloaded_error","message":"Overloaded"}}'),
    true,
  );
});

test('worker max concurrency cannot exceed derived provider budget', () => {
  withEnv({
    DRAFTING_ANTHROPIC_MAX_INFLIGHT: '8',
    ORCHESTRATION_WORKER_MAX_CONCURRENCY: '16',
  }, () => {
    assert.ok(effectiveWorkerMaxConcurrency() <= 16);
    assert.ok(effectiveWorkerMaxConcurrency() <= 8 + 2);
  });
});
