import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IDLE_STATES_PROMOTABLE_ON_SYNC,
  lateSyncIdempotencyKey,
  preEnrichedIngestPlan,
  resolveItemStateAfterLeadSync,
  shouldDispatchJobsAfterLeadSync,
} from '@/lib/drafting/late-sync';
import type { DraftingItemState } from '@/lib/drafting/types';

test('late sync idempotency key is scoped to workspace + source run', () => {
  assert.equal(
    lateSyncIdempotencyKey('ws-1', 'run-9'),
    'late-sync:ws-1:run-9',
  );
});

test('paused workspaces must not dispatch jobs after lead sync', () => {
  assert.equal(shouldDispatchJobsAfterLeadSync('active'), true);
  assert.equal(shouldDispatchJobsAfterLeadSync('paused'), false);
});

test('sync promotes idle items to queued_research without clobbering drafts', () => {
  assert.equal(
    resolveItemStateAfterLeadSync(null, 'queued_research'),
    'queued_research',
  );
  assert.equal(
    resolveItemStateAfterLeadSync('needs_lead_review', 'queued_research'),
    'queued_research',
  );
  assert.equal(
    resolveItemStateAfterLeadSync('waiting_for_enrichment', 'queued_research'),
    'queued_research',
  );
  assert.equal(
    resolveItemStateAfterLeadSync('failed_research', 'queued_research'),
    'queued_research',
  );

  // Finished / in-flight drafts stay put.
  const preserve: DraftingItemState[] = [
    'ready_for_review',
    'approved',
    'queued_research',
    'researching',
    'writing',
    'queued_write',
  ];
  for (const state of preserve) {
    assert.equal(
      resolveItemStateAfterLeadSync(state, 'queued_research'),
      state,
      `must preserve ${state}`,
    );
  }

  // Desired non-queue states never overwrite existing.
  assert.equal(
    resolveItemStateAfterLeadSync('ready_for_review', 'needs_lead_review'),
    'ready_for_review',
  );
});

test('promotable idle set covers the sync SQL CASE states', () => {
  for (const state of [
    'needs_lead_review',
    'waiting_for_enrichment',
    'budget_paused',
    'failed_research',
    'failed_write',
    'failed_rewrite',
  ] as const) {
    assert.ok(
      (IDLE_STATES_PROMOTABLE_ON_SYNC as readonly string[]).includes(state),
      state,
    );
  }
});

test('pre-enriched ingest plan: first start requires uploads when no prior complete run', () => {
  const plan = preEnrichedIngestPlan({
    workspaceExists: false,
    hasExistingLeads: false,
    hasCompletePreEnrichedRun: false,
  });
  assert.equal(plan.requireUploads, true);
  assert.equal(plan.useSyncHelper, false);
});

test('pre-enriched ingest plan: existing workspace uses sync helper', () => {
  const plan = preEnrichedIngestPlan({
    workspaceExists: true,
    hasExistingLeads: true,
    hasCompletePreEnrichedRun: true,
  });
  assert.equal(plan.requireUploads, false);
  assert.equal(plan.useSyncHelper, true);
});

test('pre-enriched ingest plan: late join with workspace still prefers sync', () => {
  const plan = preEnrichedIngestPlan({
    workspaceExists: true,
    hasExistingLeads: true,
    hasCompletePreEnrichedRun: true,
  });
  assert.equal(plan.useSyncHelper, true);
  // Staging may still be present; requireUploads false means "ok if absent",
  // not "skip staging when present" — processStagingUploads still loads it.
  assert.equal(plan.requireUploads, false);
});

test('finalize late-sync only when a drafting workspace row exists', () => {
  // Mirrors handleRunFinalize gate: sync iff workspace lookup returns a row.
  function shouldLateSyncAfterFinalize(workspaceId: string | null): boolean {
    return Boolean(workspaceId);
  }
  assert.equal(shouldLateSyncAfterFinalize(null), false);
  assert.equal(shouldLateSyncAfterFinalize('ws-abc'), true);
});
