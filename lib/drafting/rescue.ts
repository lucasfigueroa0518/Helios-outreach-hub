/**
 * Detect and recover stranded drafting runs (laptop sleep, dead worker,
 * orphaned researching/writing states with no open job).
 */
import { randomUUID } from 'node:crypto';

import { dbQuery } from '@/lib/db';
import { GENERATED_STATES, RUNNING_STATES } from '@/lib/drafting/eligibility';
import {
  reconcileDraftingWorkspaceQueue,
  wakeOrphanedParkedCompanyResearch,
} from '@/lib/drafting/repository';
import {
  isDraftingWorkspacePaused,
  WORKSPACE_PAUSED_MESSAGE,
} from '@/lib/drafting/workspace-pause';
import {
  dispatchDraftingJobs,
  orchKindForDraftingJobKind,
} from '@/lib/drafting/transport';
import type { DraftingItemState, DraftingJobKind } from '@/lib/drafting/types';
import {
  enqueueWorkBatch,
  hasHealthyWorker,
  resetBackingPendingWork,
} from '@/lib/orchestration/repository';
import type { DispatchWork } from '@/lib/orchestration/types';

export type DraftingRescueReason =
  | 'worker_offline'
  | 'stale_leases'
  | 'stranded_items'
  | 'missing_orch_jobs'
  | 'incomplete_stalled';

export type DraftingRescueAssessment = {
  /**
   * Show the Resume CTA when generation is incomplete and the run is not
   * healthily progressing (or auto-rescue left mid-run work stuck).
   */
  needed: boolean;
  /** True when the system already attempted an automatic rescue for this jam. */
  auto_attempted: boolean;
  reasons: DraftingRescueReason[];
  message: string;
  worker_healthy: boolean;
  stranded_count: number;
  stale_lease_count: number;
  missing_orch_count: number;
};

export type DraftingRescueResult = {
  assessment: DraftingRescueAssessment;
  recovered_leases: number;
  revived_drafting_jobs: number;
  stranded_reset: number;
  reconciled_queued: number;
  dispatched: number;
};

/** Mid-run / lease issues the system should auto-heal without nagging the user. */
const AUTO_RESCUE_REASONS: ReadonlySet<DraftingRescueReason> = new Set([
  'stranded_items',
  'stale_leases',
  'missing_orch_jobs',
]);

/** Reasons that surface Resume even before / without a failed auto pass. */
const RESUME_CTA_REASONS: ReadonlySet<DraftingRescueReason> = new Set([
  'worker_offline',
  'incomplete_stalled',
  'stranded_items',
  'stale_leases',
  'missing_orch_jobs',
]);

const AUTO_RESCUE_COOLDOWN_MS = 45_000;
const lastAutoRescueAt = new Map<string, number>();

const INTERRUPT_RESUME_COPY =
  'Drafting was interrupted (offline or sleep). Resume will reclaim jobs and continue remaining drafts.';

/** Ownership-only reclaim predicate; drafting heartbeat silence is irrelevant. */
export const DEAD_DRAFTING_JOB_OWNER_SQL = `
  (
    NOT EXISTS (
      SELECT 1
        FROM outreach.orchestration_jobs oj
       WHERE oj.dedupe_key = j.id::text
         AND oj.kind LIKE 'drafting.job.%'
         AND oj.status = 'in_flight'
    )
    OR EXISTS (
      SELECT 1
        FROM outreach.orchestration_jobs oj
       WHERE oj.dedupe_key = j.id::text
         AND oj.kind LIKE 'drafting.job.%'
         AND oj.status = 'in_flight'
         AND (
           (oj.lease_expires_at IS NOT NULL AND oj.lease_expires_at < now())
           OR oj.lease_owner IS NULL
           OR NOT EXISTS (
             SELECT 1
               FROM outreach.orchestration_workers w
              WHERE w.worker_id = oj.lease_owner
                AND w.heartbeat_at > now() - interval '45 seconds'
           )
         )
    )
  )`;

export function isAutoEligible(reasons: readonly DraftingRescueReason[]): boolean {
  return reasons.some((reason) => AUTO_RESCUE_REASONS.has(reason));
}

/** Whether the Draft page should show Resume drafting. */
export function shouldSurfaceResumeCta(reasons: readonly DraftingRescueReason[]): boolean {
  return reasons.some((reason) => RESUME_CTA_REASONS.has(reason));
}

export function hasHealthyDraftingProgress(
  workerHealthy: boolean,
  liveOrchestrationCount: number,
): boolean {
  return workerHealthy && liveOrchestrationCount > 0;
}

export function buildRescueMessage(input: {
  workerHealthy: boolean;
  stranded: number;
  staleLeases: number;
  missingOrch: number;
  incompleteStalled?: boolean;
}): string {
  if (!input.workerHealthy || input.incompleteStalled) {
    return INTERRUPT_RESUME_COPY;
  }
  const parts: string[] = [];
  if (input.stranded > 0) {
    parts.push(`${input.stranded} draft${input.stranded === 1 ? '' : 's'} stuck mid-run`);
  }
  if (input.staleLeases > 0) {
    parts.push(`${input.staleLeases} timed-out job lease${input.staleLeases === 1 ? '' : 's'}`);
  }
  if (input.missingOrch > 0) {
    parts.push(`${input.missingOrch} pending job${input.missingOrch === 1 ? '' : 's'} not on the worker queue`);
  }
  if (parts.length === 0) return INTERRUPT_RESUME_COPY;
  return `Drafting looks stuck (${parts.join(' · ')}). Resume will reclaim leases and requeue work.`;
}

export function buildManualRescueMessage(assessment: DraftingRescueAssessment): string {
  if (!assessment.worker_healthy || assessment.reasons.includes('incomplete_stalled')) {
    if (!assessment.worker_healthy) {
      return 'Drafting was interrupted (offline or sleep). Start the hub worker (`npm run dev` or `npm run worker`), then Resume.';
    }
    return INTERRUPT_RESUME_COPY;
  }
  return assessment.message
    || 'Automatic resume did not clear the jam. Try Resume drafting.';
}

const STRANDED_IDLE_MAP: Record<string, DraftingItemState> = {
  queued_research: 'failed_research',
  // waiting_company_research is intentional park — owner wakes siblings.
  researching: 'failed_research',
  queued_write: 'failed_write',
  writing: 'failed_write',
  repairing: 'failed_write',
  queued_rewrite: 'failed_rewrite',
  rewriting: 'failed_rewrite',
  verifying_mailbox: 'needs_lead_review',
};

/**
 * Raw stuck signals. `needed` is always false here — call
 * `resolveRescueForUi` (snapshot) or a manual POST for the CTA flag.
 */
export async function assessDraftingRescue(workspaceId: string): Promise<DraftingRescueAssessment> {
  const workerHealthy = await hasHealthyWorker().catch(() => false);

  // Parked company-wait items intentionally have no job — owner will wake them.
  const strandedStates = RUNNING_STATES.filter((state) => state !== 'waiting_company_research');
  const stranded = await dbQuery<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM outreach.drafting_items di
      WHERE di.workspace_id = $1
        AND di.removed_at IS NULL
        AND di.state = ANY($2::text[])
        AND NOT EXISTS (
          SELECT 1 FROM outreach.drafting_jobs j
           WHERE j.drafting_item_id = di.id
             AND j.status IN ('pending', 'in_flight', 'claimed')
        )`,
    [workspaceId, strandedStates],
  );

  const staleLeases = await dbQuery<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM outreach.orchestration_jobs oj
      WHERE oj.status = 'in_flight'
        AND oj.kind LIKE 'drafting.job.%'
        AND (
          (oj.lease_expires_at IS NOT NULL AND oj.lease_expires_at < now())
          OR oj.lease_owner IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM outreach.orchestration_workers w
             WHERE w.worker_id = oj.lease_owner
               AND w.heartbeat_at > now() - interval '45 seconds'
          )
        )`,
  );

  // 15s grace: enqueue → orch dispatch is not atomic, so a just-created
  // pending job briefly has no orch row. Counting that window as a jam made
  // every UI poll auto-rescue healthy runs.
  const missingOrch = await dbQuery<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM outreach.drafting_jobs j
       JOIN outreach.drafting_runs r ON r.id = j.drafting_run_id
      WHERE r.workspace_id = $1
        AND (
          (j.status = 'pending' AND j.next_attempt_at <= now() - interval '15 seconds')
          OR (
            j.status IN ('in_flight', 'claimed')
            AND coalesce(j.claimed_at, j.created_at) <= now() - interval '15 seconds'
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM outreach.orchestration_jobs oj
           WHERE oj.dedupe_key = j.id::text
             AND oj.kind LIKE 'drafting.job.%'
             AND oj.status IN ('pending', 'in_flight')
        )`,
    [workspaceId],
  );

  const liveOrch = await dbQuery<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM outreach.orchestration_jobs oj
      WHERE oj.kind LIKE 'drafting.job.%'
        AND oj.status IN ('pending', 'in_flight')
        AND EXISTS (
          SELECT 1
            FROM outreach.drafting_runs r
           WHERE r.workspace_id = $1::uuid
             AND oj.scope_key = r.id::text
        )`,
    [workspaceId],
  );

  const pipeline = await dbQuery<{
    remaining_draftable: number;
    running_evidence: number;
    generated: number;
    mailbox_draftable: number;
  }>(
    `SELECT
        count(*) FILTER (
          WHERE di.delivery_snapshot ->> 'emailVerification' IN ('valid', 'rate_limited')
            AND di.state <> ALL($2::text[])
        )::int AS remaining_draftable,
        count(*) FILTER (WHERE di.state = ANY($3::text[]))::int AS running_evidence,
        count(*) FILTER (WHERE di.state = ANY($2::text[]))::int AS generated,
        count(*) FILTER (
          WHERE di.delivery_snapshot ->> 'emailVerification' IN ('valid', 'rate_limited')
        )::int AS mailbox_draftable
       FROM outreach.drafting_items di
      WHERE di.workspace_id = $1
        AND di.removed_at IS NULL`,
    [workspaceId, [...GENERATED_STATES], [...RUNNING_STATES]],
  );

  const pendingJobs = await dbQuery<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM outreach.drafting_jobs j
       JOIN outreach.drafting_runs r ON r.id = j.drafting_run_id
      WHERE r.workspace_id = $1
        AND j.status IN ('pending', 'in_flight', 'claimed')`,
    [workspaceId],
  );

  const strandedCount = stranded.rows[0]?.n ?? 0;
  const staleLeaseCount = staleLeases.rows[0]?.n ?? 0;
  const missingOrchCount = missingOrch.rows[0]?.n ?? 0;
  const liveOrchCount = liveOrch.rows[0]?.n ?? 0;
  const remainingDraftable = pipeline.rows[0]?.remaining_draftable ?? 0;
  const mailboxDraftable = pipeline.rows[0]?.mailbox_draftable ?? 0;
  const generated = pipeline.rows[0]?.generated ?? 0;
  const runningEvidence = (pipeline.rows[0]?.running_evidence ?? 0)
    + (pendingJobs.rows[0]?.n ?? 0);
  const midRunJamEvidence = runningEvidence + strandedCount + missingOrchCount;

  const generationIncomplete = mailboxDraftable > 0 && generated < mailboxDraftable;
  // A drafting_jobs row is not an owner fence. Only a live orchestration row
  // proves that an in-flight draft has a worker; otherwise a dead pre-rebuild
  // row can mask itself as "healthy" forever.
  const healthyProgressing = hasHealthyDraftingProgress(workerHealthy, liveOrchCount);
  const incompleteStalled = generationIncomplete
    && remainingDraftable > 0
    && midRunJamEvidence > 0
    && !healthyProgressing;

  const reasons: DraftingRescueReason[] = [];
  if (!workerHealthy && generationIncomplete && midRunJamEvidence > 0) {
    reasons.push('worker_offline');
  }
  if (staleLeaseCount > 0) reasons.push('stale_leases');
  if (strandedCount > 0) reasons.push('stranded_items');
  if (missingOrchCount > 0) reasons.push('missing_orch_jobs');
  if (incompleteStalled) reasons.push('incomplete_stalled');

  const surface = shouldSurfaceResumeCta(reasons);
  const message = surface
    ? buildRescueMessage({
      workerHealthy,
      stranded: strandedCount,
      staleLeases: staleLeaseCount,
      missingOrch: missingOrchCount,
      incompleteStalled,
    })
    : '';

  return {
    needed: false,
    auto_attempted: false,
    reasons,
    message,
    worker_healthy: workerHealthy,
    stranded_count: strandedCount,
    stale_lease_count: staleLeaseCount,
    missing_orch_count: missingOrchCount,
  };
}

/**
 * Snapshot/UI path: auto-rescue mid-run jams immediately; surface Resume when
 * generation is incomplete and not healthily progressing (or auto left a jam).
 */
export async function resolveRescueForUi(
  campaignId: string,
  ownerId: string,
  workspaceId: string,
): Promise<DraftingRescueAssessment> {
  const workspaceStatus = await dbQuery<{ status: string }>(
    `SELECT status FROM outreach.drafting_workspaces WHERE id = $1`,
    [workspaceId],
  );
  if (isDraftingWorkspacePaused(workspaceStatus.rows[0]?.status)) {
    return {
      needed: true,
      auto_attempted: false,
      reasons: [],
      message: WORKSPACE_PAUSED_MESSAGE,
      worker_healthy: await hasHealthyWorker().catch(() => false),
      stranded_count: 0,
      stale_lease_count: 0,
      missing_orch_count: 0,
    };
  }

  let assessment = await assessDraftingRescue(workspaceId);
  let autoAttempted = false;

  if (isAutoEligible(assessment.reasons)) {
    const last = lastAutoRescueAt.get(workspaceId) ?? 0;
    const now = Date.now();
    const inCooldown = now - last < AUTO_RESCUE_COOLDOWN_MS;

    if (!inCooldown) {
      lastAutoRescueAt.set(workspaceId, now);
      try {
        await rescueDraftingWorkspace(campaignId, ownerId, { automatic: true });
      } catch {
        // Fall through to manual CTA.
      }
      autoAttempted = true;
      assessment = await assessDraftingRescue(workspaceId);
    } else {
      autoAttempted = true;
    }
  }

  const needed = shouldSurfaceResumeCta(assessment.reasons);
  if (!needed) {
    return {
      ...assessment,
      needed: false,
      auto_attempted: autoAttempted,
      message: '',
    };
  }

  return {
    ...assessment,
    needed: true,
    auto_attempted: autoAttempted,
    message: autoAttempted && isAutoEligible(assessment.reasons)
      ? buildManualRescueMessage(assessment)
      : (assessment.message || buildManualRescueMessage(assessment)),
  };
}

async function reclaimStaleLeases(workspaceId: string): Promise<{
  recoveredOrch: number;
  revivedDrafting: number;
}> {
  // Reclaim drafting orch leases held by dead/quiet workers globally — lane
  // concurrency is shared, so a dead lease on another workspace blocks this one.
  const orch = await dbQuery<{ id: string }>(
    `UPDATE outreach.orchestration_jobs oj
        SET status = 'pending',
            lease_owner = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            available_at = now(),
            updated_at = now()
      WHERE oj.status = 'in_flight'
        AND oj.kind LIKE 'drafting.job.%'
        AND (
          (oj.lease_expires_at IS NOT NULL AND oj.lease_expires_at < now())
          OR oj.lease_owner IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM outreach.orchestration_workers w
             WHERE w.worker_id = oj.lease_owner
               AND w.heartbeat_at > now() - interval '45 seconds'
          )
        )
      RETURNING oj.id`,
  );

  // Also free system.reconcile leases stuck on dead workers so sweeps resume.
  await dbQuery(
    `UPDATE outreach.orchestration_jobs oj
        SET status = 'pending',
            lease_owner = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            available_at = now(),
            updated_at = now()
      WHERE oj.status = 'in_flight'
        AND oj.kind = 'system.reconcile'
        AND (
          (oj.lease_expires_at IS NOT NULL AND oj.lease_expires_at < now())
          OR oj.lease_owner IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM outreach.orchestration_workers w
             WHERE w.worker_id = oj.lease_owner
               AND w.heartbeat_at > now() - interval '45 seconds'
          )
        )`,
  );

  // User-initiated rescue: drafting_jobs heartbeat silence is never proof of
  // death. Ownership comes exclusively from the backing orchestration lease:
  // no backing owner, an expired lease, or an owner absent from the live
  // worker registry. This preserves the orchestration lease as the fence.
  const drafting = await dbQuery<{ id: string; kind: DraftingJobKind; attempt_count: number }>(
    `UPDATE outreach.drafting_jobs j
        SET status = 'pending',
            claimed_at = NULL,
            heartbeat_at = NULL,
            finished_at = NULL,
            next_attempt_at = now()
       FROM outreach.drafting_runs r
      WHERE r.id = j.drafting_run_id
        AND r.workspace_id = $1
        AND j.status = 'in_flight'
        AND ${DEAD_DRAFTING_JOB_OWNER_SQL}
      RETURNING j.id, j.kind, j.attempt_count`,
    [workspaceId],
  );

  if (drafting.rows.length > 0) {
    const works: DispatchWork[] = drafting.rows.map((row) => ({
      kind: orchKindForDraftingJobKind(row.kind),
      payload: { jobId: row.id },
      dedupeKey: row.id,
      scopeKey: workspaceId,
      reviveTerminal: true,
    }));
    await enqueueWorkBatch(works);
  }

  return {
    recoveredOrch: orch.rows.length,
    revivedDrafting: drafting.rows.length,
  };
}

async function resetStrandedRunningItems(workspaceId: string): Promise<number> {
  const stranded = await dbQuery<{ id: string; state: DraftingItemState }>(
    `SELECT di.id, di.state
       FROM outreach.drafting_items di
      WHERE di.workspace_id = $1
        AND di.removed_at IS NULL
        AND di.state = ANY($2::text[])
        AND NOT EXISTS (
          SELECT 1 FROM outreach.drafting_jobs j
           WHERE j.drafting_item_id = di.id
             AND j.status IN ('pending', 'in_flight', 'claimed')
        )`,
    [workspaceId, [...RUNNING_STATES]],
  );

  let reset = 0;
  for (const row of stranded.rows) {
    const next = STRANDED_IDLE_MAP[row.state];
    if (!next) continue;
    await dbQuery(
      `UPDATE outreach.drafting_items
          SET state = $2,
              last_error_code = coalesce(last_error_code, 'stranded_after_interrupt'),
              last_error_message = coalesce(
                last_error_message,
                'Run interrupted (worker offline / laptop sleep) — ready to resume'
              ),
              updated_at = now()
        WHERE id = $1`,
      [row.id, next],
    );
    reset += 1;
  }
  return reset;
}

/**
 * Full rescue for a campaign workspace: reclaim leases, unstick orphan
 * researching/writing rows, wake parked company siblings, reconcile the
 * queue (including interrupt failures), and dispatch pending work.
 */
export async function rescueDraftingWorkspace(
  campaignId: string,
  ownerId: string,
  options: { automatic?: boolean } = {},
): Promise<DraftingRescueResult> {
  const workspace = await dbQuery<{ id: string; status: string }>(
    `SELECT dw.id, dw.status
       FROM outreach.drafting_workspaces dw
       JOIN outreach.campaigns c ON c.id = dw.campaign_id
      WHERE dw.campaign_id = $1
        AND c.owner_id = $2`,
    [campaignId, ownerId],
  );
  const workspaceId = workspace.rows[0]?.id;
  if (!workspaceId) {
    return {
      assessment: {
        needed: false,
        auto_attempted: false,
        reasons: [],
        message: '',
        worker_healthy: await hasHealthyWorker().catch(() => false),
        stranded_count: 0,
        stale_lease_count: 0,
        missing_orch_count: 0,
      },
      recovered_leases: 0,
      revived_drafting_jobs: 0,
      stranded_reset: 0,
      reconciled_queued: 0,
      dispatched: 0,
    };
  }
  if (isDraftingWorkspacePaused(workspace.rows[0]?.status)) {
    return {
      assessment: {
        needed: true,
        auto_attempted: false,
        reasons: [],
        message: WORKSPACE_PAUSED_MESSAGE,
        worker_healthy: await hasHealthyWorker().catch(() => false),
        stranded_count: 0,
        stale_lease_count: 0,
        missing_orch_count: 0,
      },
      recovered_leases: 0,
      revived_drafting_jobs: 0,
      stranded_reset: 0,
      reconciled_queued: 0,
      dispatched: 0,
    };
  }

  const before = await assessDraftingRescue(workspaceId);
  const leases = await reclaimStaleLeases(workspaceId);
  const strandedReset = await resetStrandedRunningItems(workspaceId);
  // Wake siblings whose company owner died without finishCompanyResearchLease.
  await wakeOrphanedParkedCompanyResearch().catch(() => 0);

  // Human-mode keeps the established interrupt recovery breadth, but the
  // repository's durable quarantine guard prevents workspace Resume from
  // overriding terminal empty-brief failures. Only a per-lead approval can.
  const reconciled = await reconcileDraftingWorkspaceQueue({
    workspaceId,
    ownerId,
    trigger: options.automatic ? 'retry' : 'lead_approval',
    idempotencyKey: `rescue:${workspaceId}:${randomUUID()}`,
  });

  const backing = await resetBackingPendingWork();
  let dispatched = 0;
  if (backing.length > 0) {
    await enqueueWorkBatch(backing);
    dispatched += backing.length;
  }
  if (reconciled.jobs.length > 0) {
    await dispatchDraftingJobs(reconciled.jobs.map((job) => ({
      id: job.id,
      kind: job.kind,
      attempt_count: job.attempt_count,
    })));
    dispatched += reconciled.jobs.length;
  }

  // Kick the periodic reconciler so enrichment/mailbox siblings also heal.
  const bucket = Math.floor(Date.now() / 30_000);
  await enqueueWorkBatch([{
    kind: 'system.reconcile',
    payload: { reason: 'user_rescue' },
    dedupeKey: String(bucket),
    scopeKey: 'system',
    maxAttempts: 3,
  }]).catch(() => undefined);

  const assessment = await assessDraftingRescue(workspaceId);
  const wasNeedingResume = shouldSurfaceResumeCta(before.reasons);
  const stillNeedsResume = shouldSurfaceResumeCta(assessment.reasons);
  return {
    assessment: {
      ...assessment,
      auto_attempted: true,
      needed: stillNeedsResume,
      message: wasNeedingResume
        ? (stillNeedsResume
          ? buildManualRescueMessage(assessment)
          : `Rescued: reclaimed ${leases.recoveredOrch + leases.revivedDrafting} lease(s), reset ${strandedReset} stranded item(s), queued ${reconciled.queued}.`)
        : (assessment.message || buildRescueMessage({
          workerHealthy: assessment.worker_healthy,
          stranded: assessment.stranded_count,
          staleLeases: assessment.stale_lease_count,
          missingOrch: assessment.missing_orch_count,
          incompleteStalled: assessment.reasons.includes('incomplete_stalled'),
        })),
    },
    recovered_leases: leases.recoveredOrch,
    revived_drafting_jobs: leases.revivedDrafting,
    stranded_reset: strandedReset,
    reconciled_queued: reconciled.queued,
    dispatched,
  };
}

/** Used by system.reconcile — no ownership check beyond workspace id. */
export async function rescueActiveDraftingWorkspaces(): Promise<number> {
  const workspaces = await dbQuery<{ id: string; created_by: string }>(
    `SELECT id, created_by::text AS created_by
       FROM outreach.drafting_workspaces
      WHERE status = 'active'`,
  );
  let rescued = 0;
  for (const row of workspaces.rows) {
    const assessment = await assessDraftingRescue(row.id);
    if (!isAutoEligible(assessment.reasons)) continue;
    await reclaimStaleLeases(row.id);
    const strandedReset = await resetStrandedRunningItems(row.id);
    await wakeOrphanedParkedCompanyResearch().catch(() => 0);
    // After reclaim/reset, re-assess — skip reconcile when the queue is healthy
    // so we do not spam empty target_count=0 drafting_runs every tick.
    const after = await assessDraftingRescue(row.id);
    if (strandedReset === 0 && !isAutoEligible(after.reasons)) continue;
    try {
      const reconciled = await reconcileDraftingWorkspaceQueue({
        workspaceId: row.id,
        ownerId: row.created_by,
        trigger: 'retry',
        idempotencyKey: `system-rescue:${row.id}:${new Date().toISOString().slice(0, 13)}`,
      });
      if (reconciled.queued === 0 && strandedReset === 0) continue;
      rescued += reconciled.queued + strandedReset;
    } catch {
      // Keep sweep resilient.
    }
  }
  return rescued;
}

export function emptyRescueAssessment(workerHealthy = true): DraftingRescueAssessment {
  return {
    needed: false,
    auto_attempted: false,
    reasons: [],
    message: '',
    worker_healthy: workerHealthy,
    stranded_count: 0,
    stale_lease_count: 0,
    missing_orch_count: 0,
  };
}
