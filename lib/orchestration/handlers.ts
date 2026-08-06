import { dbQuery } from '@/lib/db';
import { listPendingJobsForRun } from '@/lib/drafting/transport';
import { extractOneUpload } from '@/lib/run-extraction';
import type {
  DispatchWork,
  OrchestrationJob,
  WorkHandlerResult,
  WorkKind,
} from '@/lib/orchestration/types';
import { RetryableWorkError } from '@/lib/orchestration/types';
import {
  canFinalizeEnrichingRun,
  countOpenEnrichmentWork,
  OPEN_ENRICHMENT_ORCH_KINDS,
} from '@/lib/orchestration/enrichment-finalize-guard';
import {
  enqueueWorkBatch,
  garbageCollectStaleWorkers,
  resetBackingPendingWork,
} from '@/lib/orchestration/repository';

function child<K extends WorkKind>(
  kind: K,
  payload: DispatchWork<K>['payload'],
  dedupeKey: string,
  scopeKey: string,
  options: Pick<DispatchWork<K>, 'priority' | 'maxAttempts' | 'reviveTerminal'> = {},
): DispatchWork<K> {
  return { kind, payload, dedupeKey, scopeKey, ...options };
}

async function runStatus(runId: string): Promise<string | null> {
  const { rows } = await dbQuery<{ status: string }>(
    `SELECT status FROM outreach.runs WHERE id = $1`,
    [runId],
  );
  return rows[0]?.status ?? null;
}

async function handleRunProcess(
  job: OrchestrationJob<'run.process'>,
): Promise<WorkHandlerResult> {
  const { runId } = job.payload;
  const status = await runStatus(runId);
  if (!status || status === 'cancelled' || status === 'complete') {
    return { result: { skipped: true, status } };
  }

  await dbQuery(
    `UPDATE outreach.runs
        SET status = 'extracting',
            started_at = coalesce(started_at, now()),
            error = NULL
      WHERE id = $1 AND status IN ('queued', 'extracting')`,
    [runId],
  );
  const { rows: uploads } = await dbQuery<{ id: string }>(
    `SELECT id FROM outreach.uploads WHERE run_id = $1 ORDER BY created_at`,
    [runId],
  );
  const children: DispatchWork[] = uploads.map((upload) =>
    child(
      'upload.extract',
      { runId, uploadId: upload.id },
      `${runId}:${upload.id}`,
      runId,
    ),
  );
  children.push(child('run.prepare', { runId }, runId, runId));
  return { children, result: { uploadCount: uploads.length } };
}

async function handleUploadExtract(
  job: OrchestrationJob<'upload.extract'>,
): Promise<WorkHandlerResult> {
  const status = await runStatus(job.payload.runId);
  if (!status || status === 'cancelled') return { result: { skipped: true, status } };
  await extractOneUpload(job.payload.runId, job.payload.uploadId);
  return { result: { extracted: true } };
}

async function buildEnrichmentChildren(runId: string): Promise<{
  children: DispatchWork[];
  prepared: Awaited<ReturnType<typeof import('@/lib/enrichment').prepareRunEnrichment>>;
}> {
  const { prepareRunEnrichment } = await import('@/lib/enrichment');
  const prepared = await prepareRunEnrichment(runId);
  const children: DispatchWork[] = [];
  for (const domain of prepared.verifyDomains ?? []) {
    children.push(child(
      'domain.verify',
      { domain, runId },
      `${runId}:${domain.toLowerCase()}`,
      runId,
    ));
  }
  if (prepared.finalize) {
    children.push(child('run.finalize', { runId }, runId, runId));
  } else {
    for (const jobId of prepared.jobIds) {
      children.push(child(
        'research.company',
        { jobId },
        jobId,
        runId,
        { reviveTerminal: true },
      ));
    }
  }
  return { children, prepared };
}

async function handleRunPrepare(
  job: OrchestrationJob<'run.prepare'>,
): Promise<WorkHandlerResult> {
  const { runId } = job.payload;
  const status = await runStatus(runId);
  if (!status || status === 'cancelled' || status === 'complete') {
    return { result: { skipped: true, status } };
  }

  const { rows: uploadState } = await dbQuery<{
    total: number;
    terminal: number;
    extracted: number;
    failed: number;
    people: number;
  }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status IN ('extracted', 'failed', 'failed_quality'))::int AS terminal,
            count(*) FILTER (WHERE status = 'extracted')::int AS extracted,
            count(*) FILTER (WHERE status IN ('failed', 'failed_quality'))::int AS failed,
            coalesce(sum((extraction_summary->>'people_found')::int), 0)::int AS people
       FROM outreach.uploads
      WHERE run_id = $1`,
    [runId],
  );
  const uploads = uploadState[0];
  if (!uploads || uploads.total !== uploads.terminal) {
    throw new RetryableWorkError('Waiting for upload extraction jobs', 1_000, 'barrier_wait');
  }

  const { resolveRunPeople } = await import('@/lib/identity');
  await resolveRunPeople(runId);
  await dbQuery(
    `UPDATE outreach.runs
        SET stats = stats || jsonb_build_object(
          'files', $2::int,
          'files_extracted', $3::int,
          'files_failed', $4::int,
          'people_extracted', $5::int
        )
      WHERE id = $1 AND status <> 'cancelled'`,
    [runId, uploads.total, uploads.extracted, uploads.failed, uploads.people],
  );

  const statusAfterIdentity = await runStatus(runId);
  if (statusAfterIdentity === 'awaiting_prior_enrichment') {
    return { children: [], result: { pausedForPriorEnrichment: true } };
  }

  const { children, prepared } = await buildEnrichmentChildren(runId);
  return {
    children,
    result: {
      researchJobs: prepared.jobIds.length,
      finalize: prepared.finalize,
    },
  };
}

async function handleRunEnrich(
  job: OrchestrationJob<'run.enrich'>,
): Promise<WorkHandlerResult> {
  const { runId } = job.payload;
  const status = await runStatus(runId);
  if (!status || status === 'cancelled' || status === 'complete') {
    return { result: { skipped: true, status } };
  }
  if (status !== 'enriching') {
    return { result: { skipped: true, status } };
  }

  const { children, prepared } = await buildEnrichmentChildren(runId);
  return {
    children,
    result: {
      researchJobs: prepared.jobIds.length,
      finalize: prepared.finalize,
    },
  };
}

async function researchScope(jobId: string, fallback: string): Promise<string> {
  const { rows } = await dbQuery<{ requested_by_runs: string[] }>(
    `SELECT requested_by_runs FROM outreach.company_research_jobs WHERE id = $1`,
    [jobId],
  );
  return rows[0]?.requested_by_runs?.[0] ?? fallback;
}

async function handleResearch(
  job: OrchestrationJob<
    'research.company' | 'research.profile_rescue' | 'research.email_rescue'
  >,
): Promise<WorkHandlerResult> {
  try {
    const { executeResearchJob } = await import('@/lib/enrichment');
    const result = await executeResearchJob(job.payload.jobId);
    const children: DispatchWork[] = [];
    const scopeKey = await researchScope(job.payload.jobId, job.scope_key);

    for (const followupJobId of result.followupJobIds) {
      children.push(child(
        'research.company',
        { jobId: followupJobId },
        followupJobId,
        scopeKey,
        { reviveTerminal: true },
      ));
    }
    for (const rescueJobId of result.profileRescueJobIds) {
      children.push(child(
        'research.profile_rescue',
        { jobId: rescueJobId },
        rescueJobId,
        scopeKey,
        { reviveTerminal: true },
      ));
    }
    for (const rescueJobId of result.emailRescueJobIds) {
      children.push(child(
        'research.email_rescue',
        { jobId: rescueJobId },
        rescueJobId,
        scopeKey,
        { reviveTerminal: true },
      ));
    }
    for (const runId of result.completedRunIds) {
      children.push(child('run.finalize', { runId }, runId, runId));
    }
    for (const domain of result.verifyDomains) {
      children.push(child(
        'domain.verify',
        { domain, runId: scopeKey },
        `${scopeKey}:${domain.toLowerCase()}`,
        scopeKey,
      ));
    }
    return {
      children,
      result: {
        followups: result.followupJobIds.length,
        profileRescues: result.profileRescueJobIds.length,
        emailRescues: result.emailRescueJobIds.length,
        completedRuns: result.completedRunIds.length,
      },
    };
  } catch (error) {
    const { ResearchRetryError } = await import('@/lib/enrichment');
    if (error instanceof ResearchRetryError) {
      throw new RetryableWorkError(error.message, error.waitMs, 'research_retry', { cause: error });
    }
    throw error;
  }
}

async function handleRunFinalize(
  job: OrchestrationJob<'run.finalize'>,
): Promise<WorkHandlerResult> {
  const { runId } = job.payload;
  if ((await runStatus(runId)) === 'cancelled') return { result: { skipped: true } };
  const openWork = await countOpenEnrichmentWork(runId);
  if (!canFinalizeEnrichingRun(openWork)) {
    throw new RetryableWorkError(
      `Enrichment still open for run ${runId} (research=${openWork.researchJobs}, orch=${openWork.orchJobs})`,
      2_000,
      'enrichment_still_open',
    );
  }
  const { finalizeRunEnrichment } = await import('@/lib/enrichment');
  const domains = await finalizeRunEnrichment(runId);
  const children: DispatchWork[] = domains.map((domain) =>
    child(
      'domain.verify',
      { domain, runId },
      `${runId}:${domain.toLowerCase()}`,
      runId,
    ),
  );
  children.push(child(
    'mailbox.run',
    { runId },
    runId,
    runId,
    { reviveTerminal: true },
  ));
  return { children, result: { domains: domains.length } };
}

async function handleDomainVerify(
  job: OrchestrationJob<'domain.verify'>,
): Promise<WorkHandlerResult> {
  const { verifyDomainMx } = await import('@/lib/enrichment');
  await verifyDomainMx(job.payload.domain, job.payload.runId);
  return { result: { domain: job.payload.domain } };
}

async function handleMailboxLead(
  job: OrchestrationJob<'mailbox.lead'>,
): Promise<WorkHandlerResult> {
  const { runMailboxVerificationCascadeForLead } = await import('@/lib/mailbox-verify');
  const {
    isUncertainMailboxProbeError,
    sendMailboxProbeOnce,
  } = await import('@/lib/orchestration/mailbox-probe');
  const result = await runMailboxVerificationCascadeForLead(
    job.payload.leadId,
    job.payload.runId,
    {
      sendProbe: (email, leadId) =>
        sendMailboxProbeOnce(email, leadId, job.payload.runId, job.payload.runId),
    },
  );
  if (result.status === 'rate_limited') {
    // Fail open: persist rate_limited on the lead and stop retrying. Drafting
    // eligibility treats rate_limited as draftable with an unvalidated signal.
    return { result: result as Record<string, unknown> };
  }
  if (result.status === 'unknown' && result.reason !== 'provider_not_configured') {
    if (isUncertainMailboxProbeError(result.error)) {
      return { result: result as Record<string, unknown> };
    }
    throw new RetryableWorkError(
      result.error ?? 'Mailbox provider returned an unknown result',
      60_000,
      'mailbox_provider_error',
    );
  }
  return { result: result as Record<string, unknown> };
}

async function handleMailboxRun(
  job: OrchestrationJob<'mailbox.run'>,
): Promise<WorkHandlerResult> {
  const { sweepPendingMailboxVerifications } = await import('@/lib/mailbox-verify');
  await sweepPendingMailboxVerifications(job.payload.runId);
  return { result: { scheduled: true } };
}

async function handleDraftingRunStart(
  job: OrchestrationJob<'drafting.run.start'>,
): Promise<WorkHandlerResult> {
  const { orchKindForDraftingJobKind } = await import('@/lib/drafting/transport');
  const pending = await listPendingJobsForRun(job.payload.draftingRunId);
  const children = pending.map((draftingJob) =>
    child(
      orchKindForDraftingJobKind(draftingJob.kind),
      { jobId: draftingJob.id },
      draftingJob.id,
      job.payload.draftingRunId,
      { reviveTerminal: true },
    ),
  );
  return { children, result: { jobs: pending.length } };
}

async function handleDraftingJob(
  job: OrchestrationJob<
    'drafting.job.verify_mailbox' | 'drafting.job.process' | 'drafting.job.write'
  >,
): Promise<WorkHandlerResult> {
  const { processDraftingJob } = await import('@/lib/drafting/jobs');
  const { loadPendingDraftingJobsByIds, orchKindForDraftingJobKind } = await import(
    '@/lib/drafting/transport'
  );
  const result = await processDraftingJob(job.payload.jobId);
  const nextJobs = await loadPendingDraftingJobsByIds(result.nextJobIds);
  const children: DispatchWork[] = nextJobs.map((draftingJob) =>
    child(
      orchKindForDraftingJobKind(draftingJob.kind),
      { jobId: draftingJob.id },
      draftingJob.id,
      job.scope_key,
      { reviveTerminal: true },
    ),
  );
  return {
    children,
    result: {
      businessStatus: result.status,
      followups: result.nextJobIds.length,
      errorCode: result.errorCode,
    },
  };
}

async function handleReconcile(
  _job: OrchestrationJob<'system.reconcile'>,
): Promise<WorkHandlerResult> {
  const staleWorkersRemoved = await garbageCollectStaleWorkers().catch(() => 0);
  const children = await resetBackingPendingWork();

  // Only finalize when enriching AND no open research / prep / research orch work.
  // Re-enrich flips status to enriching before research rows exist; without the orch
  // gate, reconcile finalizes mid-flight (Campaign #9 scar).
  const terminalRuns = await dbQuery<{ id: string }>(
    `SELECT r.id
       FROM outreach.runs r
      WHERE r.status = 'enriching'
        AND NOT EXISTS (
          SELECT 1
            FROM outreach.company_research_jobs research
           WHERE r.id = ANY(research.requested_by_runs)
             AND research.status IN ('pending', 'in_flight')
        )
        AND NOT EXISTS (
          SELECT 1
            FROM outreach.orchestration_jobs oj
           WHERE oj.scope_key = r.id::text
             AND oj.kind = ANY($1::text[])
             AND oj.status IN ('pending', 'in_flight')
        )`,
    [[...OPEN_ENRICHMENT_ORCH_KINDS]],
  );
  for (const run of terminalRuns.rows) {
    children.push(child(
      'run.finalize',
      { runId: run.id },
      run.id,
      run.id,
      { reviveTerminal: true },
    ));
  }

  const interruptedRuns = await dbQuery<{ id: string }>(
    `SELECT id
       FROM outreach.runs
      WHERE status IN ('queued', 'extracting')
        AND started_at > now() - interval '7 days'`,
  );
  for (const run of interruptedRuns.rows) {
    children.push(child(
      'run.process',
      { runId: run.id },
      run.id,
      run.id,
      { reviveTerminal: true },
    ));
  }

  // Backstop only for recently completed, human-authorized runs. This is not
  // an enrichment sweep and never targets unrelated stored contacts.
  const mailboxRuns = await dbQuery<{ id: string }>(
    `SELECT DISTINCT r.id
       FROM outreach.runs r
       JOIN outreach.campaign_leads campaign_lead ON campaign_lead.run_id = r.id
       JOIN outreach.leads lead ON lead.id = campaign_lead.lead_id
      WHERE r.status = 'complete'
        AND r.finished_at > now() - interval '24 hours'
        AND coalesce(lead.email_verification, 'pending') IN ('pending', 'unknown')`,
  );
  for (const run of mailboxRuns.rows) {
    children.push(child(
      'mailbox.run',
      { runId: run.id },
      run.id,
      run.id,
      { reviveTerminal: true },
    ));
  }

  // Drafting: re-queue idle eligible items stranded in Leads mode (complete +
  // mailbox draftable but never promoted after go-to-drafting / verify).
  const draftingWorkspaces = await dbQuery<{
    id: string;
    created_by: string;
  }>(
    `SELECT dw.id, dw.created_by::text AS created_by
       FROM outreach.drafting_workspaces dw
      WHERE dw.status = 'active'
        AND EXISTS (
          SELECT 1
            FROM outreach.drafting_items di
           WHERE di.workspace_id = dw.id
             AND di.removed_at IS NULL
             AND di.state IN (
               'needs_lead_review', 'waiting_for_enrichment', 'budget_paused',
               'failed_research'
             )
        )`,
  );

  let draftingQueued = 0;
  if (draftingWorkspaces.rows.length > 0) {
    const { reconcileDraftingWorkspaceQueue } = await import('@/lib/drafting/repository');
    for (const workspace of draftingWorkspaces.rows) {
      try {
        const reconciled = await reconcileDraftingWorkspaceQueue({
          workspaceId: workspace.id,
          ownerId: workspace.created_by,
          trigger: 'retry',
          idempotencyKey: `system-reconcile-drafting:${workspace.id}:${new Date().toISOString().slice(0, 13)}`,
        });
        draftingQueued += reconciled.queued;
      } catch {
        // Keep reconcile resilient — one workspace failure must not block the sweep.
      }
    }
  }

  // Also recover stranded mid-run items (laptop sleep / dead worker) that sit
  // outside idle reconcile states.
  let draftingRescued = 0;
  try {
    const { rescueActiveDraftingWorkspaces } = await import('@/lib/drafting/rescue');
    const { wakeOrphanedParkedCompanyResearch } = await import('@/lib/drafting/repository');
    draftingRescued = await rescueActiveDraftingWorkspaces();
    draftingRescued += await wakeOrphanedParkedCompanyResearch().catch(() => 0);
  } catch {
    // Keep reconcile resilient.
  }

  // Warm temporal quality-gate audits for reviewable drafts so Download/Export
  // rarely cold-recomputes on click.
  let gatesWarmed = 0;
  try {
    const {
      warmStaleDraftTimeliness,
      GATE_WARM_RECONCILE_LIMIT,
    } = await import('@/lib/drafting/gate-warm');
    gatesWarmed = await warmStaleDraftTimeliness({ limit: GATE_WARM_RECONCILE_LIMIT });
  } catch {
    // Keep reconcile resilient.
  }

  // Best-effort Resend delivery gap-fill (webhooks are the live path).
  let emailDeliveryReconciled = 0;
  try {
    const { reconcileRecentEmailDelivery } = await import('@/lib/drafting/resend-engagement');
    emailDeliveryReconciled = await reconcileRecentEmailDelivery(25);
  } catch {
    // Keep reconcile resilient.
  }

  // Close idle drafting runs everywhere (also repairs historical eternal
  // `active` runs that predate run finalization).
  let draftingRunsFinalized = 0;
  try {
    const { dbTransaction } = await import('@/lib/db');
    const { finalizeIdleDraftingRuns } = await import('@/lib/drafting/repository');
    const workspaces = await dbQuery<{ id: string }>(
      `SELECT DISTINCT workspace_id AS id
         FROM outreach.drafting_runs
        WHERE status = 'active'`,
    );
    for (const workspace of workspaces.rows) {
      draftingRunsFinalized += await dbTransaction(
        (client) => finalizeIdleDraftingRuns(client, workspace.id),
      ).catch(() => 0);
    }
  } catch {
    // Keep reconcile resilient.
  }

  return {
    children,
    result: {
      recoveredBackingJobs: children.length,
      terminalRuns: terminalRuns.rowCount ?? 0,
      interruptedRuns: interruptedRuns.rowCount ?? 0,
      draftingQueued,
      draftingRescued,
      draftingRunsFinalized,
      gatesWarmed,
      emailDeliveryReconciled,
      staleWorkersRemoved,
    },
  };
}

type Handler = (job: OrchestrationJob) => Promise<WorkHandlerResult>;

const HANDLERS: Record<WorkKind, Handler> = {
  'run.process': handleRunProcess as Handler,
  'upload.extract': handleUploadExtract as Handler,
  'run.prepare': handleRunPrepare as Handler,
  'run.enrich': handleRunEnrich as Handler,
  'research.company': handleResearch as Handler,
  'research.profile_rescue': handleResearch as Handler,
  'research.email_rescue': handleResearch as Handler,
  'run.finalize': handleRunFinalize as Handler,
  'domain.verify': handleDomainVerify as Handler,
  'mailbox.lead': handleMailboxLead as Handler,
  'mailbox.run': handleMailboxRun as Handler,
  'drafting.run.start': handleDraftingRunStart as Handler,
  'drafting.job.verify_mailbox': handleDraftingJob as Handler,
  'drafting.job.process': handleDraftingJob as Handler,
  'drafting.job.write': handleDraftingJob as Handler,
  'system.reconcile': handleReconcile as Handler,
};

export async function handleWork(job: OrchestrationJob): Promise<WorkHandlerResult> {
  const handler = HANDLERS[job.kind];
  if (!handler) throw new Error(`No orchestration handler registered for ${job.kind}`);
  return handler(job);
}

export async function markTerminalWorkFailure(
  job: OrchestrationJob,
  message: string,
): Promise<void> {
  if (!['run.process', 'run.prepare', 'run.enrich', 'run.finalize'].includes(job.kind)) return;
  const runId = (job.payload as { runId?: string }).runId;
  if (!runId) return;
  await dbQuery(
    `UPDATE outreach.runs
        SET status = 'failed', error = $2, finished_at = now()
      WHERE id = $1 AND status <> 'cancelled'`,
    [runId, message.slice(0, 4_000)],
  );
}

export async function enqueueReconciliation(reason: string): Promise<void> {
  const bucket = Math.floor(Date.now() / 30_000);
  await enqueueWorkBatch([
    child(
      'system.reconcile',
      { reason },
      String(bucket),
      'system',
      { maxAttempts: 3 },
    ),
  ]);
}
