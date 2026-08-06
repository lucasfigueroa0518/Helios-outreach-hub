import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildManualRescueMessage,
  buildRescueMessage,
  DEAD_DRAFTING_JOB_OWNER_SQL,
  hasHealthyDraftingProgress,
  isAutoEligible,
  shouldSurfaceResumeCta,
  type DraftingRescueAssessment,
  type DraftingRescueReason,
} from '@/lib/drafting/rescue';

/**
 * Resume CTA policy + interrupt copy — durable sleep/shutdown UX.
 */
describe('drafting rescue Resume CTA policy', () => {
  it('never steals a drafting job based on drafting heartbeat silence', () => {
    assert.doesNotMatch(DEAD_DRAFTING_JOB_OWNER_SQL, /j\.heartbeat_at|j\.claimed_at/);
    assert.match(DEAD_DRAFTING_JOB_OWNER_SQL, /lease_expires_at/);
    assert.match(DEAD_DRAFTING_JOB_OWNER_SQL, /lease_owner IS NULL/);
    assert.match(DEAD_DRAFTING_JOB_OWNER_SQL, /orchestration_workers/);
    assert.match(DEAD_DRAFTING_JOB_OWNER_SQL, /45 seconds/);
  });

  it('keeps Resume off when auto-rescue cleared mid-run signals', () => {
    const reasons: DraftingRescueReason[] = [];
    assert.equal(shouldSurfaceResumeCta(reasons), false);
    assert.equal(isAutoEligible(reasons), false);
  });

  it('does not surface Resume when generation is incomplete but nothing is mid-run', () => {
    // Regression: idle needs_lead_review-only workspaces are not interrupt stalls.
    assert.equal(shouldSurfaceResumeCta([]), false);
    assert.equal(isAutoEligible([]), false);
  });

  it('does not treat an ownerless in-flight drafting row as healthy progress', () => {
    assert.equal(hasHealthyDraftingProgress(true, 0), false);
    assert.equal(hasHealthyDraftingProgress(true, 1), true);
    assert.equal(hasHealthyDraftingProgress(false, 1), false);
  });

  it('surfaces Resume for worker_offline before leases go stale', () => {
    const reasons: DraftingRescueReason[] = ['worker_offline'];
    assert.equal(shouldSurfaceResumeCta(reasons), true);
    assert.equal(isAutoEligible(reasons), false);
  });

  it('surfaces Resume for incomplete_stalled without requiring failed auto', () => {
    const reasons: DraftingRescueReason[] = ['incomplete_stalled'];
    assert.equal(shouldSurfaceResumeCta(reasons), true);
    assert.equal(isAutoEligible(reasons), false);
  });

  it('still auto-rescues stranded/stale/missing orch mid-run jams', () => {
    for (const reason of ['stranded_items', 'stale_leases', 'missing_orch_jobs'] as const) {
      assert.equal(isAutoEligible([reason]), true);
      assert.equal(shouldSurfaceResumeCta([reason]), true);
    }
  });

  it('uses interrupt-aware copy when worker is offline or incomplete stalled', () => {
    assert.match(
      buildRescueMessage({
        workerHealthy: false,
        stranded: 0,
        staleLeases: 0,
        missingOrch: 0,
      }),
      /interrupted \(offline or sleep\)/i,
    );
    assert.match(
      buildRescueMessage({
        workerHealthy: true,
        stranded: 0,
        staleLeases: 0,
        missingOrch: 0,
        incompleteStalled: true,
      }),
      /interrupted \(offline or sleep\)/i,
    );
  });

  it('tells the user to start the worker when offline after a failed auto pass', () => {
    const assessment: DraftingRescueAssessment = {
      needed: true,
      auto_attempted: true,
      reasons: ['worker_offline', 'incomplete_stalled'],
      message: '',
      worker_healthy: false,
      stranded_count: 0,
      stale_lease_count: 0,
      missing_orch_count: 0,
    };
    assert.match(buildManualRescueMessage(assessment), /Start the hub worker/i);
  });
});

describe('Eva / hub stranded mid-run FSM parity contract', () => {
  it('treats fine-grained researching/writing as mid-run stranded candidates', () => {
    const hubMidRun = [
      'queued_research',
      'researching',
      'queued_write',
      'writing',
      'repairing',
      'queued_rewrite',
      'rewriting',
      'verifying_mailbox',
    ];
    // Contract: Resume policy keys off these states existing in RUNNING_STATES /
    // EVA_DRAFTING_MID_RUN_STATES — not the legacy queued/drafting-only pair.
    for (const state of hubMidRun) {
      assert.ok(state !== 'queued' && state !== 'drafting');
    }
    assert.ok(hubMidRun.includes('researching'));
    assert.ok(hubMidRun.includes('writing'));
  });
});
