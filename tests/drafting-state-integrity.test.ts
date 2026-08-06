/**
 * Regression tests for the drafting FSM integrity fixes (bug ledger D-003):
 *
 * 1. The empty-research-brief self-retry transitions `researching →
 *    queued_research` — this edge was missing from the FSM map, so every
 *    retry threw "Illegal transition", rolled back the packet save, and
 *    burned the job as `failed` (campaign #12: 4 research jobs).
 * 2. FSM conflicts throw a typed `TransitionConflictError` so a stale or
 *    duplicate claim is superseded quietly instead of failing the item.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertTransition,
  isTransitionAllowed,
  transition,
  TransitionConflictError,
} from '../lib/drafting/state';

test('researching → queued_research self-retry edge is legal', () => {
  assert.equal(isTransitionAllowed('researching', 'queued_research'), true);
  const result = transition('researching', 'queued_research', { mailboxValid: true });
  assert.equal(result.ok, true);
});

test('duplicate-claim transitions still conflict (no silent overwrite)', () => {
  // A revived duplicate trying to re-enter researching while the live worker
  // already holds the item must conflict, not overwrite.
  assert.equal(isTransitionAllowed('researching', 'researching'), false);
  assert.equal(isTransitionAllowed('queued_write', 'queued_research'), false);
});

test('assertTransition throws typed TransitionConflictError', () => {
  try {
    assertTransition('researching', 'researching');
    assert.fail('expected TransitionConflictError');
  } catch (error) {
    assert.ok(error instanceof TransitionConflictError);
    assert.equal(error.from, 'researching');
    assert.equal(error.to, 'researching');
    assert.match(error.message, /Illegal transition/);
  }
});

test('mailbox gate still enforced on retry edge', () => {
  const result = transition('researching', 'queued_research', { mailboxValid: false });
  assert.equal(result.ok, false);
});
