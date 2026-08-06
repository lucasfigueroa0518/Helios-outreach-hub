import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  decideEmptyBriefExecution,
  EMPTY_BRIEF_MAX_AUTOMATIC_EXECUTIONS,
  isEmptyBriefQuarantined,
  recordEmptyBriefCompletion,
} from '@/lib/drafting/empty-brief-policy';

describe('durable empty research brief policy', () => {
  it('allows one automatic retry, then quarantines the fingerprint', () => {
    const initial = { attempts: 0, inputFingerprint: null, lastErrorCode: null };
    assert.deepEqual(decideEmptyBriefExecution(initial, 'fp-a', 'automatic'), {
      allowed: true,
      executionNumber: 1,
      forceFreshResearch: false,
    });

    const first = recordEmptyBriefCompletion(initial, 'fp-a', 'automatic');
    assert.equal(first.action, 'retry');
    assert.equal(first.attempts, 1);
    assert.equal(first.retryExecutionNumber, 2);

    const secondExecution = decideEmptyBriefExecution({
      attempts: first.attempts,
      inputFingerprint: first.inputFingerprint,
    }, 'fp-a', 'automatic');
    assert.equal(secondExecution.allowed, true);
    assert.equal(secondExecution.forceFreshResearch, true);

    const second = recordEmptyBriefCompletion({
      attempts: first.attempts,
      inputFingerprint: first.inputFingerprint,
    }, 'fp-a', 'automatic');
    assert.equal(second.action, 'quarantine');
    assert.equal(second.attempts, EMPTY_BRIEF_MAX_AUTOMATIC_EXECUTIONS);
    assert.equal(recordEmptyBriefCompletion({
      attempts: 1,
      inputFingerprint: 'fp-a',
    }, 'fp-a', 'automatic', 1).action, 'retry');
    assert.equal(recordEmptyBriefCompletion({
      attempts: 2,
      inputFingerprint: 'fp-a',
    }, 'fp-a', 'automatic', 2).attempts, 2);
    assert.equal(isEmptyBriefQuarantined({
      attempts: second.attempts,
      inputFingerprint: second.inputFingerprint,
      lastErrorCode: 'empty_research_brief',
    }, 'fp-a'), true);
  });

  it('does not let job-row or transport attempt resets evade the item budget', () => {
    const durable = {
      attempts: 2,
      inputFingerprint: 'fp-a',
      lastErrorCode: 'empty_research_brief',
    };
    for (const disposableJobAttempt of [0, 1, 99]) {
      assert.equal(disposableJobAttempt >= 0, true);
      assert.equal(decideEmptyBriefExecution(durable, 'fp-a', 'automatic').allowed, false);
    }
  });

  it('starts a fresh automatic budget when the input fingerprint changes', () => {
    const terminal = {
      attempts: 2,
      inputFingerprint: 'fp-a',
      lastErrorCode: 'empty_research_brief',
    };
    assert.deepEqual(decideEmptyBriefExecution(terminal, 'fp-b', 'automatic'), {
      allowed: true,
      executionNumber: 1,
      forceFreshResearch: false,
    });
  });

  it('allows one explicit manual epoch without erasing prior attempts', () => {
    const terminal = {
      attempts: 2,
      inputFingerprint: 'fp-a',
      lastErrorCode: 'empty_research_brief',
    };
    assert.deepEqual(decideEmptyBriefExecution(terminal, 'fp-a', 'manual'), {
      allowed: true,
      executionNumber: 3,
      forceFreshResearch: true,
    });
    assert.equal(recordEmptyBriefCompletion(terminal, 'fp-a', 'manual').attempts, 3);
  });

  it('wires delayed attempt two, fresh strategy, cost persistence, and rescue quarantine', () => {
    const jobs = readFileSync(new URL('../lib/drafting/jobs.ts', import.meta.url), 'utf8');
    const repository = readFileSync(
      new URL('../lib/drafting/repository.ts', import.meta.url),
      'utf8',
    );
    const rescue = readFileSync(new URL('../lib/drafting/rescue.ts', import.meta.url), 'utf8');
    assert.match(jobs, /attempt=2/);
    assert.match(jobs, /execution\.forceFreshResearch/);
    assert.match(jobs, /actualCostUsd: researchCostUsd/);
    assert.doesNotMatch(jobs, /job\.attempt_count[^]*allowRetry/);
    assert.match(repository, /empty_brief_attempts/);
    assert.match(repository, /isEmptyBriefQuarantined/);
    assert.match(repository, /nextAttemptAt/);
    assert.match(repository, /retry_audit = CASE/);
    for (const field of [
      'actorId',
      'oldFingerprint',
      'newFingerprint',
      'priorAttempts',
      'reason',
      'surface',
    ]) {
      assert.match(repository, new RegExp(`'${field}'`));
    }
    assert.match(rescue, /automatic: true/);
  });
});
