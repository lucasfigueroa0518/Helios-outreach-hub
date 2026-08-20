import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  effectiveDraftingResearchLaneLimit,
  effectiveDraftingWriteLaneLimit,
  effectiveWorkerMaxConcurrency,
  resolveAnthropicMaxInflight,
} from '@/lib/drafting/provider-admission';
import { laneLimit, workerMaxConcurrency } from '@/lib/orchestration/config';

const envSnapshot = { ...process.env };

function parseEnvFile(filePath: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    parsed[match[1]] = match[2];
  }
  return parsed;
}

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  Object.assign(process.env, overrides);
  try {
    fn();
  } finally {
    process.env = { ...envSnapshot };
  }
}

test('cloud worker env example matches laptop drafting admission', () => {
  const example = parseEnvFile(path.join(process.cwd(), 'scripts/gcp/worker.env.example'));
  assert.equal(example.DRAFTING_ANTHROPIC_MAX_INFLIGHT, '8');
  assert.equal(example.ORG_DRAFT_RESEARCH_CONCURRENCY, '8');
  assert.equal(example.ORG_DRAFT_WRITE_CONCURRENCY, '8');
  assert.equal(example.ORCHESTRATION_WORKER_MAX_CONCURRENCY, '16');
  assert.equal(example.ORG_MAILBOX_VERIFY_CONCURRENCY, '3');
  assert.equal(example.PG_POOL_MAX, '8');

  withEnv(example, () => {
    assert.equal(resolveAnthropicMaxInflight(), 8);
    assert.equal(effectiveDraftingResearchLaneLimit(), 4);
    assert.equal(effectiveDraftingWriteLaneLimit(), 1);
    assert.equal(effectiveWorkerMaxConcurrency(), 7);
    assert.equal(laneLimit('drafting'), 4);
    assert.equal(laneLimit('drafting_write'), 1);
    assert.equal(workerMaxConcurrency(), 7);
  });
});
