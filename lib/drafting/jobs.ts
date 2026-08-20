import { loadDraftingAssets } from '@/lib/drafting/assets';
import { addDecimal, worstCaseResearchReservationUsd, worstCaseWriteReservationUsd } from '@/lib/drafting/cost';
import {
  draftingCostEventKey,
  runProviderCallWithCostPersistence,
} from '@/lib/drafting/cost-events';
import { canQueueWrite, isMailboxDraftable } from '@/lib/drafting/eligibility';
import { stripTrailingTextSignature } from '@/lib/drafting/email-signature';
import {
  decideEmptyBriefExecution,
  EMPTY_BRIEF_RETRY_DELAY_MS,
  EMPTY_BRIEF_TERMINAL_MESSAGE,
  EMPTY_RESEARCH_BRIEF_ERROR_CODE,
  isEmptyBriefQuarantined,
  type EmptyBriefRetrySurface,
} from '@/lib/drafting/empty-brief-policy';
import {
  hasBlockingHardLintFailures,
  hasHardLintFailures,
  hasJudgmentHardLintFailures,
  hasMechanicalAutoRepairLintFailures,
  lintDraft,
  mechanicalAutoRepairFindings,
} from '@/lib/drafting/lint';
import { runWithLeaseHeartbeat } from '@/lib/drafting/lease-heartbeat';
import {
  buildEffectiveInputSnapshot,
  buildEffectiveLeadFields,
  normalizeDraftBody,
  normalizeDraftText,
  sha256Fingerprint,
} from '@/lib/drafting/normalize';
import {
  COMPANY_VERDICT_CACHE_POLICY_VERSION,
  buildCompanyVerdictOrigins,
  buildCachedCompanyAdversarialVerdicts,
  runResearchAdversarialVerify,
  type CachedCompanyAdversarialVerdicts,
} from '@/lib/drafting/research-adversarial';
import {
  normalizeSourceIdRefs,
  prefilterResearchPacketForAdversarial,
  reconcileResearchPacketAfterAdversarialQa,
} from '@/lib/drafting/research-reconcile';
import {
  assemblePacketFromReusableContext,
  canSkipSiblingResearch,
} from '@/lib/drafting/research-company-reuse';
import { DRAFTING_RESEARCH_PROMPT_VERSION } from '@/lib/drafting/research-prompt';
import { runDraftingResearch } from '@/lib/drafting/research-provider';
import {
  applyItemScopedMailboxResult,
  claimDraftingItemExecution,
  clearEmptyBriefErrorAfterUsableResearch,
  claimCompanyResearchLease,
  claimDraftingJob,
  failOpenRemainingDraftingMailboxVerifies,
  findReusableCompanyResearch,
  deferDraftingJobForRetry,
  finishCompanyResearchLease,
  finishDraftingJob,
  heartbeatCompanyResearchLease,
  heartbeatDraftingJob,
  heartbeatDraftingItemExecution,
  loadDraftingJobContext,
  parseDeliverySnapshot,
  promoteVerifiedItem,
  queueJob,
  recordDraftingJobCostEvent,
  recordEmptyBriefOutcome,
  releaseDraftingItemExecution,
  refreshCompletionTimestamps,
  saveEmailDraft,
  saveResearchPacket,
  transitionItemState,
  writeJobKey,
  type DraftingItemRow,
  type DraftingRun,
  type ReusableCompanyResearchMatch,
} from '@/lib/drafting/repository';
import { isProviderPressureError } from '@/lib/drafting/provider-admission';
import { jitteredBackoffMs } from '@/lib/orchestration/config';
import { assertTransition, TransitionConflictError } from '@/lib/drafting/state';
import {
  assessResearchTimeliness,
  findDraftTimelinessFailures,
  type DraftTemporalGrounding,
  type ResearchTimelinessAudit,
} from '@/lib/drafting/temporal-policy';
import type { DraftingJobKind, DraftingResearchPacket, LintFinding, LintResult } from '@/lib/drafting/types';
import { CANONICAL_CAPABILITY_IDS } from '@/lib/drafting/types';
import { runDraftingWrite } from '@/lib/drafting/writer-provider';
import { getDraftingMode, resolvedDraftingMaxSearches } from '@/lib/models';
import { probeMailboxEmail } from '@/lib/mailbox-verify';
import { dbQuery, dbTransaction } from '@/lib/db';
import { sendMailboxProbeOnce } from '@/lib/orchestration/mailbox-probe';
import {
  buildDraftingItemInsight,
  logPipelineInsight,
} from '@/lib/pipeline-telemetry';
import { resolveResearchProtocolBudget } from '@/lib/drafting/research-provider';

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

export async function withDraftingItemExecutionFence<T>(
  itemId: string,
  operation: () => Promise<T>,
  dependencies: {
    claim: typeof claimDraftingItemExecution;
    heartbeat: typeof heartbeatDraftingItemExecution;
    release: typeof releaseDraftingItemExecution;
  } = {
    claim: claimDraftingItemExecution,
    heartbeat: heartbeatDraftingItemExecution,
    release: releaseDraftingItemExecution,
  },
): Promise<{ acquired: false } | { acquired: true; result: T }> {
  const owner = await dependencies.claim(itemId);
  if (!owner) return { acquired: false };
  try {
    const result = await runWithLeaseHeartbeat({
      heartbeat: () => dependencies.heartbeat(itemId, owner),
      intervalMs: 30_000,
      operation,
      onHeartbeatError: (error) => {
        console.warn(`[drafting-item-execution] heartbeat failed item=${itemId}:`, error);
      },
    });
    return { acquired: true, result };
  } finally {
    await dependencies.release(itemId, owner).catch((error) => {
      console.warn(`[drafting-item-execution] release failed item=${itemId}:`, error);
    });
  }
}

type CompanyResearchCoordination =
  | { action: 'reuse'; reusable: ReusableCompanyResearchMatch; ownedCompanyKey: string | null }
  | { action: 'own'; ownedCompanyKey: string; reusable: ReusableCompanyResearchMatch | null }
  | { action: 'park'; companyKey: string }
  | { action: 'solo'; ownedCompanyKey: null; reusable: null };

/**
 * Coordinate company-level research without holding a worker shard.
 * - Reuse ready packet → sibling_skip / cheap path
 * - Acquire lease → own the Sonnet research
 * - Another owner researching → park (waiting_company_research); owner wakes us
 * - No company key (generic email) → solo fresh research
 */
async function coordinateCompanyResearch(input: {
  workspaceId: string;
  itemId: string;
  company: string | null;
  email: string | null;
}): Promise<CompanyResearchCoordination> {
  const existing = await findReusableCompanyResearch(input);
  if (existing) {
    return { action: 'reuse', reusable: existing, ownedCompanyKey: null };
  }

  const claim = await claimCompanyResearchLease(input);
  if (!claim) {
    return { action: 'solo', ownedCompanyKey: null, reusable: null };
  }
  if (claim.acquired) {
    // Re-check after claim — a sibling may have finished between find and claim.
    const reusable = await findReusableCompanyResearch(input);
    if (reusable) {
      await finishCompanyResearchLease({
        workspaceId: input.workspaceId,
        itemId: input.itemId,
        companyKey: claim.companyKey,
        status: 'ready',
      });
      return { action: 'reuse', reusable, ownedCompanyKey: null };
    }
    return { action: 'own', ownedCompanyKey: claim.companyKey, reusable: null };
  }

  // Owner is researching — park instead of spinning or duplicating.
  return { action: 'park', companyKey: claim.companyKey };
}

async function withCompanyResearchLeaseHeartbeat<T>(
  lease: { workspaceId: string; itemId: string; companyKey: string } | null,
  operation: () => Promise<T>,
): Promise<T> {
  if (!lease) return operation();
  return runWithLeaseHeartbeat({
    heartbeat: () => heartbeatCompanyResearchLease(lease),
    operation,
    onHeartbeatError: (error) => {
      console.warn('[company-research-singleflight] lease heartbeat failed:', error);
    },
  });
}

function lintWithTimeliness(
  subject: string,
  body: string,
  audit: ResearchTimelinessAudit,
  grounding: DraftTemporalGrounding,
): LintResult {
  const lint = lintDraft(subject, body);
  const combined = `${subject}\n${body}`;
  const temporal = findDraftTimelinessFailures(subject, body, audit, grounding).map((finding) => {
    const start = finding.matchedText ? combined.indexOf(finding.matchedText) : 0;
    return {
      code: finding.code,
      message: finding.message,
      field: 'combined' as const,
      span: {
        start: Math.max(0, start),
        end: Math.max(0, start) + finding.matchedText.length,
        text: finding.matchedText,
      },
    };
  });
  return { hard: [...lint.hard, ...temporal], warnings: lint.warnings };
}

async function ledgerDraftingItemCost(itemId: string): Promise<void> {
  try {
    const { recordDraftingItemCost } = await import('@/lib/cost-ledger');
    await recordDraftingItemCost(itemId);
  } catch (error) {
    console.error('lead cost ledger (drafting) failed:', error);
  }
}

export type ProcessDraftingJobResult = {
  jobId: string;
  status: 'claimed' | 'skipped' | 'done' | 'failed' | 'superseded' | 'cancelled' | 'deferred';
  nextJobIds: string[];
  errorCode?: string;
  errorMessage?: string;
  /** When status is deferred, orch should revive this job after this time. */
  retryAt?: Date;
};

function isStaleJob(
  job: {
    expected_input_fingerprint: string | null;
    expected_research_revision: number | null;
    expected_draft_revision: number | null;
  },
  item: {
    input_fingerprint: string | null;
    research_revision: number;
    draft_revision: number;
  },
): boolean {
  return (
    (job.expected_input_fingerprint != null && job.expected_input_fingerprint !== item.input_fingerprint)
    || (job.expected_research_revision != null && job.expected_research_revision !== item.research_revision)
    || (job.expected_draft_revision != null && job.expected_draft_revision !== item.draft_revision)
  );
}

async function markJobFailed(
  jobId: string,
  code: string,
  message: string,
  actualCostUsd = '0.0000',
  usage?: Record<string, unknown>,
  providerRequestId?: string,
  costEventKey?: string,
): Promise<ProcessDraftingJobResult> {
  await finishDraftingJob({
    jobId,
    status: 'failed',
    actualCostUsd,
    usage,
    providerRequestId,
    costEventKey,
    lastErrorCode: code,
    lastErrorMessage: message,
  });
  return { jobId, status: 'failed', nextJobIds: [], errorCode: code, errorMessage: message };
}

async function handleVerifyMailbox(jobId: string): Promise<ProcessDraftingJobResult> {
  const context = await loadDraftingJobContext(jobId);
  if (!context) {
    return { jobId, status: 'skipped', nextJobIds: [] };
  }

  const { job, item, run } = context;
  if (job.status !== 'in_flight') {
    return { jobId, status: 'skipped', nextJobIds: [] };
  }
  if (isStaleJob(job, item)) {
    await finishDraftingJob({ jobId, status: 'superseded' });
    return { jobId, status: 'superseded', nextJobIds: [] };
  }

  const delivery = parseDeliverySnapshot(item.delivery_snapshot);
  if (!delivery?.effectiveEmail) {
    return markJobFailed(jobId, 'missing_email', 'No effective email to verify');
  }

  if (getDraftingMode() === 'stub') {
    const updated = await applyItemScopedMailboxResult({
      itemId: item.id,
      expectedEmailFingerprint: delivery.effectiveEmailFingerprint,
      status: 'valid',
      providerRequestId: `stub-verify-${item.id.slice(0, 8)}`,
      resultSource: 'stub',
    });
    if (!updated) {
      await finishDraftingJob({ jobId, status: 'superseded' });
      return { jobId, status: 'superseded', nextJobIds: [] };
    }

    let nextJobId: string | null = null;
    await dbTransaction(async (client) => {
      nextJobId = await promoteVerifiedItem(client, {
        itemId: item.id,
        runId: run.id,
      });
      if (!nextJobId) {
        await transitionItemState(client, item.id, 'needs_lead_review', false);
      }
      await refreshCompletionTimestamps(client, item.workspace_id);
    });

    await finishDraftingJob({
      jobId,
      status: 'done',
      providerRequestId: `stub-verify-${item.id.slice(0, 8)}`,
    });
    return {
      jobId,
      status: 'done',
      nextJobIds: nextJobId ? [nextJobId] : [],
    };
  }

  await heartbeatDraftingJob(jobId);

  // Sibling item already rate-limited this drafting workspace — do not probe.
  const siblingRateLimited = await dbQuery<{ hit: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM outreach.drafting_items
        WHERE workspace_id = $1
          AND removed_at IS NULL
          AND coalesce(delivery_snapshot->>'emailVerification', '') = 'rate_limited'
     ) AS hit`,
    [item.workspace_id],
  ).then((r) => Boolean(r.rows[0]?.hit)).catch(() => false);

  if (siblingRateLimited) {
    const updated = await applyItemScopedMailboxResult({
      itemId: item.id,
      expectedEmailFingerprint: delivery.effectiveEmailFingerprint,
      status: 'rate_limited',
      resultSource: 'agentmail_rate_limited',
    });
    if (!updated) {
      await finishDraftingJob({ jobId, status: 'superseded', lastErrorCode: 'mailbox_rate_limited' });
      return { jobId, status: 'superseded', nextJobIds: [], errorCode: 'mailbox_rate_limited' };
    }
    const nextJobIds: string[] = [];
    await dbTransaction(async (client) => {
      const promoted = await promoteVerifiedItem(client, { itemId: item.id, runId: run.id });
      if (promoted) nextJobIds.push(promoted);
      else await transitionItemState(client, item.id, 'needs_lead_review', false);
      await refreshCompletionTimestamps(client, item.workspace_id);
    });
    const siblingJobIds = await failOpenRemainingDraftingMailboxVerifies({
      workspaceId: item.workspace_id,
      draftingRunId: run.id,
      excludeItemId: item.id,
    });
    nextJobIds.push(...siblingJobIds);
    await finishDraftingJob({
      jobId,
      status: 'done',
      lastErrorCode: 'mailbox_rate_limited',
      lastErrorMessage: 'AgentMail already rate limited on this workspace — skipping probe',
    });
    return { jobId, status: 'done', nextJobIds, errorCode: 'mailbox_rate_limited' };
  }

  const probe = await probeMailboxEmail(delivery.effectiveEmail, item.lead_id, {
    sendProbe: (email, leadId) =>
      sendMailboxProbeOnce(email, leadId, `drafting:${run.id}`),
  });

  if (probe.status === 'rate_limited') {
    const updated = await applyItemScopedMailboxResult({
      itemId: item.id,
      expectedEmailFingerprint: delivery.effectiveEmailFingerprint,
      status: 'rate_limited',
      resultSource: 'agentmail_rate_limited',
    });
    if (!updated) {
      await finishDraftingJob({ jobId, status: 'superseded', lastErrorCode: 'mailbox_rate_limited' });
      return { jobId, status: 'superseded', nextJobIds: [], errorCode: 'mailbox_rate_limited' };
    }

    // Fail open into research — draft review shows the unvalidated signal.
    const nextJobIds: string[] = [];
    await dbTransaction(async (client) => {
      const promoted = await promoteVerifiedItem(client, { itemId: item.id, runId: run.id });
      if (promoted) nextJobIds.push(promoted);
      else await transitionItemState(client, item.id, 'needs_lead_review', false);
      await refreshCompletionTimestamps(client, item.workspace_id);
    });

    // Stop probing the rest of this drafting run — cancel pending verifies and
    // promote remaining pending/unknown mailboxes as rate_limited.
    const siblingJobIds = await failOpenRemainingDraftingMailboxVerifies({
      workspaceId: item.workspace_id,
      draftingRunId: run.id,
      excludeItemId: item.id,
    });
    nextJobIds.push(...siblingJobIds);

    await finishDraftingJob({
      jobId,
      status: 'done',
      lastErrorCode: 'mailbox_rate_limited',
      lastErrorMessage: probe.error ?? 'AgentMail rate limited — proceeding unvalidated',
    });
    return { jobId, status: 'done', nextJobIds, errorCode: 'mailbox_rate_limited' };
  }

  const verificationStatus = probe.status === 'valid' || probe.status === 'invalid'
    ? probe.status
    : 'unknown';

  const updated = await applyItemScopedMailboxResult({
    itemId: item.id,
    expectedEmailFingerprint: delivery.effectiveEmailFingerprint,
    status: verificationStatus,
    providerRequestId: probe.status === 'valid' || probe.status === 'invalid'
      ? probe.sent_message_id
      : undefined,
    resultSource: 'agentmail',
  });

  if (!updated) {
    await finishDraftingJob({ jobId, status: 'superseded' });
    return { jobId, status: 'superseded', nextJobIds: [] };
  }

  const nextJobIds: string[] = [];
  if (verificationStatus === 'valid') {
    await dbTransaction(async (client) => {
      const promoted = await promoteVerifiedItem(client, { itemId: item.id, runId: run.id });
      if (promoted) nextJobIds.push(promoted);
      else await transitionItemState(client, item.id, 'needs_lead_review', false);
      await refreshCompletionTimestamps(client, item.workspace_id);
    });
  } else {
    await dbTransaction(async (client) => {
      await transitionItemState(client, item.id, 'needs_lead_review', false);
      await refreshCompletionTimestamps(client, item.workspace_id);
    });
  }

  await finishDraftingJob({
    jobId,
    status: 'done',
    providerRequestId: probe.status === 'valid' || probe.status === 'invalid'
      ? probe.sent_message_id
      : null,
  });

  return { jobId, status: 'done', nextJobIds };
}

async function handleResearch(jobId: string): Promise<ProcessDraftingJobResult> {
  const context = await loadDraftingJobContext(jobId);
  if (!context) return { jobId, status: 'skipped', nextJobIds: [] };

  const { job, item, run } = context;
  if (job.status !== 'in_flight') return { jobId, status: 'skipped', nextJobIds: [] };
  if (isStaleJob(job, item)) {
    await finishDraftingJob({ jobId, status: 'superseded' });
    return { jobId, status: 'superseded', nextJobIds: [] };
  }

  const inputFingerprintValue = item.input_fingerprint ?? '';
  const policyState = {
    attempts: Number(item.empty_brief_attempts),
    inputFingerprint: item.empty_brief_input_fingerprint,
    lastErrorCode: item.last_error_code,
  };
  const requestedManualOverride = job.usage?.emptyBriefSurface === 'manual';
  const surface: EmptyBriefRetrySurface = requestedManualOverride
    && isEmptyBriefQuarantined(policyState, inputFingerprintValue)
    ? 'manual'
    : 'automatic';
  const execution = decideEmptyBriefExecution(
    policyState,
    inputFingerprintValue,
    surface,
  );
  if (!execution.allowed) {
    // Stamp quarantine on the item itself. Job-only failure left last_error_code as
    // stranded_after_interrupt, so system-rescue kept re-queueing doomed research.
    await dbTransaction(async (client) => {
      await client.query(
        `UPDATE outreach.drafting_items
            SET last_error_code = $2,
                last_error_message = $3,
                updated_at = now()
          WHERE id = $1`,
        [item.id, EMPTY_RESEARCH_BRIEF_ERROR_CODE, EMPTY_BRIEF_TERMINAL_MESSAGE],
      );
      await transitionItemState(client, item.id, 'failed_research', true);
      await refreshCompletionTimestamps(client, item.workspace_id);
    });
    return markJobFailed(
      jobId,
      EMPTY_RESEARCH_BRIEF_ERROR_CODE,
      EMPTY_BRIEF_TERMINAL_MESSAGE,
    );
  }

  const delivery = parseDeliverySnapshot(item.delivery_snapshot);
  if (!isMailboxDraftable(delivery)) {
    await finishDraftingJob({ jobId, status: 'superseded', lastErrorCode: 'mailbox_not_valid' });
    return { jobId, status: 'superseded', nextJobIds: [] };
  }

  await dbTransaction(async (client) => {
    await transitionItemState(client, item.id, 'researching', true);
  });

  const assets = await loadDraftingAssets();
  await heartbeatDraftingJob(jobId);

  const jobStartedAt = Date.now();
  let result: Awaited<ReturnType<typeof runDraftingResearch>>;
  let reusableCompanyResearch: ReusableCompanyResearchMatch | null = null;
  let ownedCompanyKey: string | null = null;
  let researchPath: 'sibling_skip' | 'company_reuse' | 'fresh' | 'fresh_after_reuse_miss' = 'fresh';
  let siblingSkip = false;
  let companyReuseMissReason: string | null = null;
  const researchStartedAt = Date.now();
  try {
    const researchInputSnapshot = buildEffectiveInputSnapshot(
      item.input_snapshot,
      item.input_overrides,
    );
    const coordinated: CompanyResearchCoordination = execution.forceFreshResearch
      ? { action: 'solo', ownedCompanyKey: null, reusable: null }
      : await coordinateCompanyResearch({
        workspaceId: item.workspace_id,
        itemId: item.id,
        company: researchInputSnapshot.lead.company,
        email: researchInputSnapshot.lead.email,
      });

    if (coordinated.action === 'park') {
      await dbTransaction(async (client) => {
        await transitionItemState(client, item.id, 'waiting_company_research', true);
        await refreshCompletionTimestamps(client, item.workspace_id);
      });
      await finishDraftingJob({
        jobId,
        status: 'done',
        lastErrorCode: 'waiting_company_research',
        lastErrorMessage: `Parked until company research finishes (${coordinated.companyKey})`,
      });
      logPipelineInsight('draft', `item=${item.id} researchPath=parked`, {
        companyKey: coordinated.companyKey,
      });
      return {
        jobId,
        status: 'done',
        nextJobIds: [],
        errorCode: 'waiting_company_research',
      };
    }

    if (coordinated.action === 'reuse') {
      reusableCompanyResearch = coordinated.reusable;
      ownedCompanyKey = coordinated.ownedCompanyKey;
    } else if (coordinated.action === 'own') {
      ownedCompanyKey = coordinated.ownedCompanyKey;
      reusableCompanyResearch = coordinated.reusable;
    } else {
      ownedCompanyKey = null;
      reusableCompanyResearch = null;
    }

    const companyLease = ownedCompanyKey
      ? { workspaceId: item.workspace_id, itemId: item.id, companyKey: ownedCompanyKey }
      : null;
    const reusableContext = reusableCompanyResearch?.context;
    if (reusableContext && canSkipSiblingResearch(researchInputSnapshot, reusableContext)) {
      siblingSkip = true;
      researchPath = 'sibling_skip';
      const packet = assemblePacketFromReusableContext({
        inputSnapshot: researchInputSnapshot,
        reusable: reusableContext,
      });
      result = {
        packet,
        packetSha256: sha256Fingerprint(packet),
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          searches: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: '0.0000',
          calls: 0,
          turns: 0,
          protocolBudget: {
            maxCalls: 0,
            maxSearches: 0,
            cheapPath: true,
            reportMaxTokens: 0,
            autoMaxTokens: 0,
          },
        },
        providerRequestId: `reuse-assemble-${item.id.slice(0, 8)}`,
        modelId: 'reuse-assemble',
        promptVersion: DRAFTING_RESEARCH_PROMPT_VERSION,
      };
    } else {
      if (reusableContext) {
        researchPath = 'company_reuse';
      } else if (ownedCompanyKey) {
        researchPath = 'fresh';
        companyReuseMissReason = 'no_reusable_ready_context';
      } else {
        researchPath = 'fresh';
        companyReuseMissReason = 'no_company_key';
      }
      result = await withCompanyResearchLeaseHeartbeat(companyLease, () =>
        runDraftingResearch({
          itemId: item.id,
          inputSnapshot: researchInputSnapshot,
          inputFingerprint: item.input_fingerprint ?? '',
          researchRevision: item.research_revision,
          skillContent: assets.skill.content,
          positioningText: assets.positioning.text,
          maxSearches: resolvedDraftingMaxSearches(),
          reusableCompanyContext: reusableContext,
        }),
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // In-flight 429/529 only — do not put research_provider_error on the
    // auto-reconcile path (NON_AUTO_RETRY_ERROR_CODES stays authoritative).
    if (isProviderPressureError(message)) {
      const delayMs = jitteredBackoffMs(Math.max(1, job.attempt_count));
      const retryAt = await deferDraftingJobForRetry({
        jobId,
        delayMs,
        errorCode: 'anthropic_pressure',
        errorMessage: message,
      });
      return {
        jobId,
        status: 'deferred',
        nextJobIds: [jobId],
        errorCode: 'anthropic_pressure',
        errorMessage: message,
        retryAt,
      };
    }
    if (ownedCompanyKey) {
      await finishCompanyResearchLease({
        workspaceId: item.workspace_id,
        itemId: item.id,
        companyKey: ownedCompanyKey,
        status: 'failed',
      });
    }
    await dbTransaction(async (client) => {
      // Persist on the item so NON_AUTO_RETRY_ERROR_CODES can stop system-rescue
      // thrash (job-only errors were overwritten by stranded_after_interrupt).
      await client.query(
        `UPDATE outreach.drafting_items
            SET last_error_code = 'research_provider_error',
                last_error_message = $2,
                updated_at = now()
          WHERE id = $1`,
        [item.id, message.slice(0, 1000)],
      );
      await transitionItemState(client, item.id, 'failed_research', true);
      await refreshCompletionTimestamps(client, item.workspace_id);
    });
    return markJobFailed(jobId, 'research_provider_error', message);
  }
  const researchMs = elapsedMs(researchStartedAt);

  // 1) Structural normalize → 2) Haiku adversarial doubt pass → 3) deterministic reconcile → write
  const normalizeStartedAt = Date.now();
  const normalized = normalizeSourceIdRefs(result.packet);
  const prefiltered = prefilterResearchPacketForAdversarial(normalized.packet);
  let workingPacket = prefiltered.packet;
  const normalizeMs = elapsedMs(normalizeStartedAt);

  let adversarial;
  let cachedCompanyVerdicts: CachedCompanyAdversarialVerdicts = {
    verdicts: [],
    originsByClaimId: {},
  };
  const adversarialStartedAt = Date.now();
  try {
    cachedCompanyVerdicts = reusableCompanyResearch
      ? buildCachedCompanyAdversarialVerdicts({
        currentPacket: workingPacket,
        sourcePacket: reusableCompanyResearch.sourcePacket,
        sourceUsage: reusableCompanyResearch.sourceUsage,
      })
      : cachedCompanyVerdicts;
    const companyLease = ownedCompanyKey
      ? { workspaceId: item.workspace_id, itemId: item.id, companyKey: ownedCompanyKey }
      : null;
    adversarial = await withCompanyResearchLeaseHeartbeat(companyLease, () =>
      runResearchAdversarialVerify({
        inputSnapshot: buildEffectiveInputSnapshot(item.input_snapshot, item.input_overrides),
        packet: workingPacket,
        // Sibling-skip / reuse packets are company-only — never spend full adversarial search.
        maxSearches: siblingSkip || cachedCompanyVerdicts.verdicts.length > 0 ? 0 : undefined,
        cachedCompanyVerdicts: cachedCompanyVerdicts.verdicts,
      }),
    );
    workingPacket = adversarial.packet;
    await heartbeatDraftingJob(jobId);
  } catch (error) {
    // Adversarial failure must not block drafting — fall back to deterministic reconcile only.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[research-adversarial] item=${item.id} failed; continuing with reconcile-only:`, message);
    adversarial = {
      verdicts: [],
      identityClassification: null,
      notes: `adversarial_error: ${message}`,
      packet: workingPacket,
      skipped: true,
      auditMode: 'skip' as const,
      usage: { inputTokens: 0, outputTokens: 0, searches: 0, costUsd: '0.0000' },
      providerRequestId: 'adversarial-error',
      modelId: 'none',
      promptVersion: 'none',
    };
  }
  const adversarialMs = elapsedMs(adversarialStartedAt);

  const reconcileStartedAt = Date.now();
  const reconciled = reconcileResearchPacketAfterAdversarialQa(
    workingPacket,
    adversarial.skipped,
    {
      allowedCapabilityIds: CANONICAL_CAPABILITY_IDS,
      adversarialVerdicts: adversarial.skipped ? undefined : adversarial.verdicts,
    },
  );
  const reconcileMs = elapsedMs(reconcileStartedAt);
  const packet = reconciled.packet;
  const packetSha256 = sha256Fingerprint(packet);
  const researchCostUsd = addDecimal(result.usage.costUsd, adversarial.usage.costUsd);
  const stages = {
    researchMs,
    normalizeMs,
    adversarialMs,
    reconcileMs,
    totalMs: elapsedMs(jobStartedAt),
  };

  if (adversarial.verdicts.length || reconciled.actions.length || adversarial.skipped) {
    console.warn(
      `[research-qa] item=${item.id}`
        + ` adversarial_mode=${adversarial.auditMode}`
        + ` adversarial_keep=${adversarial.verdicts.filter((v) => v.decision === 'keep').length}`
        + ` adversarial_drop=${adversarial.verdicts.filter((v) => v.decision === 'drop').length}`
        + ` reconcile=${reconciled.actions.length}`
        + ` stages_ms=${JSON.stringify(stages)}`
        + (reconciled.needsResearchUpgrade ? ' needsResearchUpgrade' : '')
        + (reconciled.writeBlocked ? ' writeBlocked' : ''),
    );
  }

  const usageProtocol = (result.usage as { protocolBudget?: {
    maxCalls: number;
    maxSearches: number;
    cheapPath: boolean;
    reportMaxTokens: number;
  } }).protocolBudget ?? resolveResearchProtocolBudget({
    hasReusableCompanyContext: Boolean(reusableCompanyResearch),
    maxSearches: Number(result.usage.searches ?? 0),
  });

  const insight = buildDraftingItemInsight({
    researchPath,
    siblingSkip,
    companyReuse: {
      attempted: Boolean(reusableCompanyResearch) || researchPath !== 'fresh',
      hit: Boolean(reusableCompanyResearch),
      sourceDraftingItemId: reusableCompanyResearch?.context.sourceDraftingItemId ?? null,
      missReason: companyReuseMissReason,
    },
    protocolBudget: {
      maxCalls: usageProtocol.maxCalls ?? 0,
      maxSearches: 'maxSearches' in usageProtocol
        ? Number((usageProtocol as { maxSearches?: number }).maxSearches ?? result.usage.searches ?? 0)
        : Number(result.usage.searches ?? 0),
      cheapPath: Boolean(
        (usageProtocol as { cheapPath?: boolean }).cheapPath
          ?? siblingSkip
          ?? reusableCompanyResearch,
      ),
      reportMaxTokens: usageProtocol.reportMaxTokens ?? null,
    },
    adversarial: {
      mode: adversarial.auditMode,
      reason: adversarial.notes ?? '',
      searchesUsed: Number(adversarial.usage.searches ?? 0),
      keep: adversarial.verdicts.filter((v) => v.decision === 'keep').length,
      drop: adversarial.verdicts.filter((v) => v.decision === 'drop').length,
    },
    write: {
      writeBlocked: reconciled.writeBlocked,
      needsResearchUpgrade: reconciled.needsResearchUpgrade,
      repairClass: 'none',
      lintBlockingCodes: [],
      autoRepairAttempted: false,
    },
    stagesMs: stages,
    costs: {
      researchUsd: result.usage.costUsd,
      adversarialUsd: adversarial.usage.costUsd,
      writeUsd: null,
      totalUsd: researchCostUsd,
    },
  });

  logPipelineInsight('draft', `item=${item.id} researchPath=${researchPath}`, {
    siblingSkip,
    adversarialMode: adversarial.auditMode,
    writeBlocked: reconciled.writeBlocked,
    stages,
    costUsd: researchCostUsd,
  });

  const usageBlob = {
    ...result.usage,
    costUsd: researchCostUsd,
    stages,
    insight,
    researchPath,
    siblingSkip,
    adversarial: {
      skipped: adversarial.skipped,
      auditMode: adversarial.auditMode,
      modelId: adversarial.modelId,
      promptVersion: adversarial.promptVersion,
      usage: adversarial.usage,
      verdicts: adversarial.verdicts,
      notes: adversarial.notes,
      companyVerdictCachePolicyVersion: COMPANY_VERDICT_CACHE_POLICY_VERSION,
      companyVerdictOrigins: buildCompanyVerdictOrigins({
        packet: workingPacket,
        verdicts: adversarial.verdicts,
        cachedOriginsByClaimId: cachedCompanyVerdicts.originsByClaimId,
      }),
    },
    normalizeActions: normalized.actions,
    prefilterActions: prefiltered.actions,
    reconcileActions: reconciled.actions,
    needsResearchUpgrade: reconciled.needsResearchUpgrade,
    writeBlocked: reconciled.writeBlocked,
    temporalAudit: reconciled.temporalAudit,
    companyReuse: reusableCompanyResearch
      ? {
        sourceDraftingItemId: reusableCompanyResearch.context.sourceDraftingItemId,
        missReason: null,
      }
      : {
        sourceDraftingItemId: null,
        missReason: companyReuseMissReason,
      },
  };

  let nextJobIdsPush: string | null = null;
  if (reconciled.writeBlocked) {
    const emptyDecision = await dbTransaction(async (client) => {
      await saveResearchPacket(client, item, packet as unknown as Record<string, unknown>, {
        packetSha256,
        status: 'valid',
        identityClassification: packet.leadIdentity.classification,
        resolutionLevel: packet.resolution.level,
        modelId: result.modelId,
        promptVersion: `${result.promptVersion}+${adversarial.promptVersion}`,
        providerRequestId: result.providerRequestId,
        usage: usageBlob,
        temporalAudit: reconciled.temporalAudit,
      });
      const decision = await recordEmptyBriefOutcome(client, {
        itemId: item.id,
        inputFingerprint: inputFingerprintValue,
        surface,
      });
      if (decision.action === 'retry') {
        const retryId = await queueJob(client, {
          runId: run.id,
          itemId: item.id,
          kind: 'research',
          idempotencyKey: `research-retry-empty:${item.id}:${inputFingerprintValue}:attempt=2`,
          expectedInputFingerprint: item.input_fingerprint,
          expectedResearchRevision: item.research_revision + 1,
          expectedDraftRevision: item.draft_revision,
          reservedCostUsd: worstCaseResearchReservationUsd(),
          priority: 3,
          nextAttemptAt: new Date(Date.now() + EMPTY_BRIEF_RETRY_DELAY_MS),
          usage: { emptyBriefSurface: 'automatic', emptyBriefExecution: 2 },
          reviveTerminal: true,
        });
        if (retryId) {
          nextJobIdsPush = retryId;
          await transitionItemState(client, item.id, 'queued_research', true);
        } else {
          await transitionItemState(client, item.id, 'failed_research', true);
        }
      } else {
        await transitionItemState(client, item.id, 'failed_research', true);
      }
      await refreshCompletionTimestamps(client, item.workspace_id);
      return decision;
    });
    let wakeJobIds: string[] = [];
    if (ownedCompanyKey) {
      wakeJobIds = await finishCompanyResearchLease({
        workspaceId: item.workspace_id,
        itemId: item.id,
        companyKey: ownedCompanyKey,
        status: 'failed',
      });
    }
    if (emptyDecision.action === 'retry' && nextJobIdsPush) {
      await finishDraftingJob({
        jobId,
        status: 'done',
        actualCostUsd: researchCostUsd,
        usage: usageBlob,
        providerRequestId: result.providerRequestId,
        costEventKey: draftingCostEventKey({
          stage: 'research',
          providerRequestIds: [result.providerRequestId, adversarial.providerRequestId],
        }),
        lastErrorCode: 'empty_research_brief_retry',
        lastErrorMessage: 'No usable facts after reconcile — queued one research retry',
      });
      await ledgerDraftingItemCost(item.id);
      return {
        jobId,
        status: 'done',
        nextJobIds: [nextJobIdsPush, ...wakeJobIds],
        errorCode: 'empty_research_brief_retry',
      };
    }
    const failed = await markJobFailed(
      jobId,
      EMPTY_RESEARCH_BRIEF_ERROR_CODE,
      EMPTY_BRIEF_TERMINAL_MESSAGE,
      researchCostUsd,
      usageBlob,
      result.providerRequestId,
      draftingCostEventKey({
        stage: 'research',
        providerRequestIds: [result.providerRequestId, adversarial.providerRequestId],
      }),
    );
    await ledgerDraftingItemCost(item.id);
    return failed;
  }

  const nextJobIds: string[] = [];
  await dbTransaction(async (client) => {
    await saveResearchPacket(client, item, packet as unknown as Record<string, unknown>, {
      packetSha256,
      status: 'valid',
      identityClassification: packet.leadIdentity.classification,
      resolutionLevel: packet.resolution.level,
      modelId: result.modelId,
      promptVersion: `${result.promptVersion}+${adversarial.promptVersion}`,
      providerRequestId: result.providerRequestId,
      usage: usageBlob,
      temporalAudit: reconciled.temporalAudit,
    });
    await clearEmptyBriefErrorAfterUsableResearch(
      client,
      item.id,
      inputFingerprintValue,
    );

    const writeReservation = worstCaseWriteReservationUsd();
    // saveResearchPacket bumps research_revision by 1; write must expect the new value.
    const writeJobId = await queueJob(client, {
      runId: run.id,
      itemId: item.id,
      kind: 'write',
      idempotencyKey: writeJobKey(item.id, packetSha256, item.draft_revision),
      expectedInputFingerprint: item.input_fingerprint,
      expectedResearchRevision: item.research_revision + 1,
      expectedDraftRevision: item.draft_revision,
      reservedCostUsd: writeReservation,
      priority: 1,
    });
    if (writeJobId) {
      nextJobIds.push(writeJobId);
      await transitionItemState(client, item.id, 'queued_write', true);
    } else {
      await transitionItemState(client, item.id, 'budget_paused', true);
    }

    await refreshCompletionTimestamps(client, item.workspace_id);
  });
  let wakeJobIds: string[] = [];
  if (ownedCompanyKey) {
    wakeJobIds = await finishCompanyResearchLease({
      workspaceId: item.workspace_id,
      itemId: item.id,
      companyKey: ownedCompanyKey,
      status: 'ready',
    });
  }

  await finishDraftingJob({
    jobId,
    status: 'done',
    actualCostUsd: researchCostUsd,
    usage: usageBlob,
    providerRequestId: result.providerRequestId,
    costEventKey: draftingCostEventKey({
      stage: 'research',
      providerRequestIds: [result.providerRequestId, adversarial.providerRequestId],
    }),
  });

  return { jobId, status: 'done', nextJobIds: [...nextJobIds, ...wakeJobIds] };
}

async function persistDraftFromProvider(
  jobId: string,
  item: DraftingItemRow,
  run: DraftingRun,
  options: {
    isRewrite?: boolean;
    feedback?: string | null;
    isRepair?: boolean;
    previousSubject?: string | null;
    previousBodyText?: string | null;
    hardLintFindings?: LintFinding[] | null;
  } = {},
): Promise<ProcessDraftingJobResult> {
  const delivery = parseDeliverySnapshot(item.delivery_snapshot);
  if (!canQueueWrite(item.input_snapshot, delivery, item.input_overrides)) {
    await finishDraftingJob({ jobId, status: 'superseded', lastErrorCode: 'mailbox_not_valid' });
    return { jobId, status: 'superseded', nextJobIds: [] };
  }

  const assets = await loadDraftingAssets();
  const packetRow = await dbTransaction(async (client) => {
    const { rows } = await client.query<{ packet: DraftingResearchPacket; packet_sha256: string; generation_number?: number }>(
      `SELECT p.packet, p.packet_sha256, d.generation_number
       FROM outreach.draft_research_packets p
       LEFT JOIN outreach.email_drafts d ON d.drafting_item_id = p.drafting_item_id
       WHERE p.drafting_item_id = $1`,
      [item.id],
    );
    return rows[0] ?? null;
  });

  if (!packetRow) {
    return markJobFailed(jobId, 'missing_packet', 'Research packet not found');
  }
  const temporalAudit = assessResearchTimeliness(packetRow.packet);
  const prospectTerms = [
    item.input_snapshot.lead.fullName,
    item.input_snapshot.lead.company,
  ].filter((term): term is string => typeof term === 'string' && term.trim().length >= 3);

  const inFlightState = options.isRewrite
    ? 'rewriting'
    : options.isRepair
      ? 'repairing'
      : 'writing';
  if (item.state !== inFlightState) {
    await dbTransaction(async (client) => {
      await transitionItemState(client, item.id, inFlightState, true);
    });
  }

  await heartbeatDraftingJob(jobId);

  const writeStartedAt = Date.now();
  let writeResult;
  try {
    const stage = options.isRepair ? 'repair' : options.isRewrite ? 'rewrite' : 'write';
    writeResult = await runProviderCallWithCostPersistence({
      stage,
      call: () => runDraftingWrite({
        itemId: item.id,
        inputSnapshot: item.input_snapshot,
        packet: packetRow.packet,
        packetSha256: packetRow.packet_sha256,
        draftRevision: item.draft_revision,
        generationNumber: packetRow.generation_number ?? 1,
        skillContent: assets.skill.content,
        subjectLineContent: assets.subjectLine.content,
        positioningText: assets.positioning.text,
        previousSubject: options.previousSubject,
        previousBodyText: options.previousBodyText,
        hardLintFindings: options.hardLintFindings,
        feedback: options.feedback,
        isRewrite: options.isRewrite,
        isRepair: options.isRepair,
      }),
      persist: (event) => recordDraftingJobCostEvent({
        jobId,
        stage: event.stage,
        providerRequestId: event.providerRequestId,
        actualCostUsd: event.costUsd,
        usage: event.usage,
      }).then(() => undefined),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isProviderPressureError(message)) {
      const context = await loadDraftingJobContext(jobId);
      const delayMs = jitteredBackoffMs(Math.max(1, context?.job.attempt_count ?? 1));
      const retryAt = await deferDraftingJobForRetry({
        jobId,
        delayMs,
        errorCode: 'anthropic_pressure',
        errorMessage: message,
      });
      return {
        jobId,
        status: 'deferred',
        nextJobIds: [jobId],
        errorCode: 'anthropic_pressure',
        errorMessage: message,
        retryAt,
      };
    }
    const failedState = options.isRewrite ? 'failed_rewrite' : 'failed_write';
    await dbTransaction(async (client) => {
      await transitionItemState(client, item.id, failedState, true);
      await refreshCompletionTimestamps(client, item.workspace_id);
    });
    const failed = await markJobFailed(jobId, 'writer_provider_error', message);
    await ledgerDraftingItemCost(item.id);
    return failed;
  }
  const writeMs = elapsedMs(writeStartedAt);

  const lintStartedAt = Date.now();
  const subject = normalizeDraftText(writeResult.draft.subject).replace(/\n/g, ' ').trim();
  const sender = item.input_snapshot.sender;
  const firstName = buildEffectiveLeadFields(item.input_snapshot).firstName;
  // HTML signature is appended at send — never persist a duplicate text sign-off.
  const bodyText = stripTrailingTextSignature(
    normalizeDraftBody(writeResult.draft.bodyText, firstName),
    {
      displayName: sender.displayName,
      title: sender.title,
      companyName: sender.companyName?.trim() || 'Helios Group',
    },
  );
  const grounding: DraftTemporalGrounding = {
    usedFactIds: writeResult.draft.usedFactIds,
    claimLedger: writeResult.draft.claimLedger,
    prospectTerms,
  };
  const lintResult = lintWithTimeliness(subject, bodyText, temporalAudit, grounding);
  const lintMs = elapsedMs(lintStartedAt);
  const blockingCodes = lintResult.hard.map((finding) => finding.code);
  let repairClass: 'none' | 'mechanical' | 'judgment' | 'mixed' | 'skipped_judgment' = 'none';
  if (hasMechanicalAutoRepairLintFailures(lintResult) && !options.isRepair) {
    repairClass = 'mechanical';
  } else if (hasBlockingHardLintFailures(lintResult) && !options.isRepair) {
    repairClass = 'skipped_judgment';
  } else if (options.isRepair) {
    repairClass = hasBlockingHardLintFailures(lintResult) ? 'judgment' : 'mechanical';
  }
  const writeInsight = buildDraftingItemInsight({
    researchPath: 'fresh',
    siblingSkip: false,
    companyReuse: {
      attempted: false,
      hit: false,
      sourceDraftingItemId: null,
      missReason: null,
    },
    protocolBudget: {
      maxCalls: 0,
      maxSearches: null,
      cheapPath: false,
      reportMaxTokens: null,
    },
    adversarial: {
      mode: 'skip',
      reason: 'write_stage',
      searchesUsed: 0,
      keep: 0,
      drop: 0,
    },
    write: {
      writeBlocked: hasBlockingHardLintFailures(lintResult),
      needsResearchUpgrade: false,
      repairClass,
      lintBlockingCodes: blockingCodes,
      autoRepairAttempted: repairClass === 'mechanical' || Boolean(options.isRepair),
    },
    stagesMs: {
      writeMs,
      lintMs,
    },
    costs: {
      researchUsd: null,
      adversarialUsd: null,
      writeUsd: writeResult.usage.costUsd,
      totalUsd: writeResult.usage.costUsd,
    },
  });
  logPipelineInsight('write', `item=${item.id} repairClass=${repairClass}`, {
    blockingCodes,
    isRepair: Boolean(options.isRepair),
    costUsd: writeResult.usage.costUsd,
  });
  const usageBlob = {
    ...writeResult.usage,
    stages: {
      writeMs,
      lintMs,
      isRepair: Boolean(options.isRepair),
      isRewrite: Boolean(options.isRewrite),
      hardLintCount: lintResult.hard.length,
      repairClass,
    },
    insight: writeInsight,
  };

  if (hasMechanicalAutoRepairLintFailures(lintResult) && !options.isRepair) {
    // Persist the failing draft so repair can receive prior prose + named lint codes.
    const mechanical = mechanicalAutoRepairFindings(lintResult);
    const repairJobId = await dbTransaction(async (client) => {
      await saveEmailDraft(client, item, {
        subject,
        bodyText,
        packetSha256: packetRow.packet_sha256,
        generationNumber: packetRow.generation_number ?? 1,
        resolutionUsed: writeResult.draft.resolutionUsed,
        usedFactIds: writeResult.draft.usedFactIds,
        claimLedger: { entries: writeResult.draft.claimLedger },
        askForm: writeResult.draft.askForm,
        lintResult,
        temporalAudit,
        grounding,
        modelId: writeResult.modelId,
        promptVersion: writeResult.promptVersion,
        providerRequestId: writeResult.providerRequestId,
        generationMode: writeResult.generationMode,
        usage: { ...usageBlob, awaitingRepair: true },
      });
      await transitionItemState(client, item.id, 'repairing', true);
      return queueJob(client, {
        runId: run.id,
        itemId: item.id,
        kind: 'repair',
        idempotencyKey: `repair:${item.id}:${item.draft_revision + 1}:${mechanical.map((f) => f.code).join(',')}`,
        expectedInputFingerprint: item.input_fingerprint,
        expectedResearchRevision: item.research_revision,
        expectedDraftRevision: item.draft_revision + 1,
        priority: 8,
        maxAttempts: 1,
      });
    });
    await finishDraftingJob({
      jobId,
      status: 'done',
      actualCostUsd: writeResult.usage.costUsd,
      usage: usageBlob,
      providerRequestId: writeResult.providerRequestId,
      costEventKey: draftingCostEventKey({
        stage: options.isRepair ? 'repair' : options.isRewrite ? 'rewrite' : 'write',
        providerRequestIds: [writeResult.providerRequestId],
      }),
    });
    return {
      jobId,
      status: 'done',
      nextJobIds: repairJobId ? [repairJobId] : [],
    };
  }

  // Judgment / temporal hard fails skip auto-repair on first write. After one
  // mechanical repair, leftover judgment must still land in Email review —
  // otherwise an em dash (common on Haiku) turns a reviewable draft into
  // failed_write. Approve stays blocked until a rewrite clears lint.
  if (
    hasBlockingHardLintFailures(lintResult)
    && (!options.isRepair || hasJudgmentHardLintFailures(lintResult))
  ) {
    await dbTransaction(async (client) => {
      await saveEmailDraft(client, item, {
        subject,
        bodyText,
        packetSha256: packetRow.packet_sha256,
        generationNumber: packetRow.generation_number ?? 1,
        resolutionUsed: writeResult.draft.resolutionUsed,
        usedFactIds: writeResult.draft.usedFactIds,
        claimLedger: { entries: writeResult.draft.claimLedger },
        askForm: writeResult.draft.askForm,
        lintResult,
        temporalAudit,
        grounding,
        modelId: writeResult.modelId,
        promptVersion: writeResult.promptVersion,
        providerRequestId: writeResult.providerRequestId,
        generationMode: writeResult.generationMode,
        usage: usageBlob,
      });
      await transitionItemState(client, item.id, 'ready_for_review', true);
      await refreshCompletionTimestamps(client, item.workspace_id);
    });
    await finishDraftingJob({
      jobId,
      status: 'done',
      actualCostUsd: writeResult.usage.costUsd,
      usage: usageBlob,
      providerRequestId: writeResult.providerRequestId,
      costEventKey: draftingCostEventKey({
        stage: options.isRepair ? 'repair' : options.isRewrite ? 'rewrite' : 'write',
        providerRequestIds: [writeResult.providerRequestId],
      }),
      lastErrorCode: 'hard_lint_needs_rewrite',
      lastErrorMessage: lintResult.hard.map((finding) => finding.code).join(','),
    });
    await ledgerDraftingItemCost(item.id);
    return {
      jobId,
      status: 'done',
      nextJobIds: [],
      errorCode: 'hard_lint_needs_rewrite',
      errorMessage: lintResult.hard.map((finding) => finding.code).join(','),
    };
  }

  if (hasHardLintFailures(lintResult) && options.isRepair) {
    // Soft quality issues (e.g. OVERLOADED_SENTENCE) stay reviewable with
    // "Retry suggested". Only blocking hard lint fails the write.
    if (!hasBlockingHardLintFailures(lintResult)) {
      await dbTransaction(async (client) => {
        await saveEmailDraft(client, item, {
          subject,
          bodyText,
          packetSha256: packetRow.packet_sha256,
          generationNumber: packetRow.generation_number ?? 1,
          resolutionUsed: writeResult.draft.resolutionUsed,
          usedFactIds: writeResult.draft.usedFactIds,
          claimLedger: { entries: writeResult.draft.claimLedger },
          askForm: writeResult.draft.askForm,
          lintResult,
          temporalAudit,
          grounding,
          modelId: writeResult.modelId,
          promptVersion: writeResult.promptVersion,
          providerRequestId: writeResult.providerRequestId,
          generationMode: writeResult.generationMode,
          usage: { ...usageBlob, retrySuggested: true },
        });
        await transitionItemState(client, item.id, 'ready_for_review', true);
        await refreshCompletionTimestamps(client, item.workspace_id);
      });
      await finishDraftingJob({
        jobId,
        status: 'done',
        actualCostUsd: writeResult.usage.costUsd,
        usage: { ...usageBlob, retrySuggested: true },
        providerRequestId: writeResult.providerRequestId,
        costEventKey: draftingCostEventKey({
          stage: options.isRepair ? 'repair' : options.isRewrite ? 'rewrite' : 'write',
          providerRequestIds: [writeResult.providerRequestId],
        }),
      });
      await ledgerDraftingItemCost(item.id);
      return { jobId, status: 'done', nextJobIds: [] };
    }

    await dbTransaction(async (client) => {
      await saveEmailDraft(client, item, {
        subject,
        bodyText,
        packetSha256: packetRow.packet_sha256,
        generationNumber: packetRow.generation_number ?? 1,
        resolutionUsed: writeResult.draft.resolutionUsed,
        usedFactIds: writeResult.draft.usedFactIds,
        claimLedger: { entries: writeResult.draft.claimLedger },
        askForm: writeResult.draft.askForm,
        lintResult,
        temporalAudit,
        grounding,
        modelId: writeResult.modelId,
        promptVersion: writeResult.promptVersion,
        providerRequestId: writeResult.providerRequestId,
        generationMode: writeResult.generationMode,
        usage: usageBlob,
      });
      await transitionItemState(client, item.id, 'failed_write', true);
      await client.query(
        `UPDATE outreach.drafting_items
            SET last_error_code = $2,
                last_error_message = $3,
                updated_at = now()
          WHERE id = $1`,
        [
          item.id,
          'hard_lint_after_repair',
          lintResult.hard.map((finding) => finding.code).join(','),
        ],
      );
      await refreshCompletionTimestamps(client, item.workspace_id);
    });
    const failed = await markJobFailed(
      jobId,
      'hard_lint_after_repair',
      lintResult.hard.map((finding) => finding.code).join(','),
      writeResult.usage.costUsd,
      usageBlob,
      writeResult.providerRequestId,
      draftingCostEventKey({
        stage: options.isRepair ? 'repair' : options.isRewrite ? 'rewrite' : 'write',
        providerRequestIds: [writeResult.providerRequestId],
      }),
    );
    await ledgerDraftingItemCost(item.id);
    return failed;
  }

  await dbTransaction(async (client) => {
    await saveEmailDraft(client, item, {
      subject,
      bodyText,
      packetSha256: packetRow.packet_sha256,
      generationNumber: packetRow.generation_number ?? 1,
      resolutionUsed: writeResult.draft.resolutionUsed,
      usedFactIds: writeResult.draft.usedFactIds,
      claimLedger: { entries: writeResult.draft.claimLedger },
      askForm: writeResult.draft.askForm,
      lintResult,
      temporalAudit,
      grounding,
      modelId: writeResult.modelId,
      promptVersion: writeResult.promptVersion,
      providerRequestId: writeResult.providerRequestId,
      generationMode: writeResult.generationMode,
      usage: usageBlob,
    });
    await transitionItemState(client, item.id, 'ready_for_review', true);
    await refreshCompletionTimestamps(client, item.workspace_id);
  });

  await finishDraftingJob({
    jobId,
    status: 'done',
    actualCostUsd: writeResult.usage.costUsd,
    usage: usageBlob,
    providerRequestId: writeResult.providerRequestId,
    costEventKey: draftingCostEventKey({
      stage: options.isRepair ? 'repair' : options.isRewrite ? 'rewrite' : 'write',
      providerRequestIds: [writeResult.providerRequestId],
    }),
  });
  await ledgerDraftingItemCost(item.id);

  return { jobId, status: 'done', nextJobIds: [] };
}

async function handleWrite(jobId: string): Promise<ProcessDraftingJobResult> {
  const context = await loadDraftingJobContext(jobId);
  if (!context) return { jobId, status: 'skipped', nextJobIds: [] };
  const { job, item, run } = context;
  if (job.status !== 'in_flight') return { jobId, status: 'skipped', nextJobIds: [] };
  if (isStaleJob(job, item)) {
    await finishDraftingJob({ jobId, status: 'superseded' });
    return { jobId, status: 'superseded', nextJobIds: [] };
  }
  return persistDraftFromProvider(jobId, item, run);
}

async function handleRepair(jobId: string): Promise<ProcessDraftingJobResult> {
  const context = await loadDraftingJobContext(jobId);
  if (!context) return { jobId, status: 'skipped', nextJobIds: [] };
  const { job, item, run } = context;
  if (job.status !== 'in_flight') return { jobId, status: 'skipped', nextJobIds: [] };
  if (isStaleJob(job, item)) {
    await finishDraftingJob({ jobId, status: 'superseded' });
    return { jobId, status: 'superseded', nextJobIds: [] };
  }

  const existingDraft = await dbTransaction(async (client) => {
    const { rows } = await client.query<{
      subject: string;
      body_text: string;
      lint_result: LintResult | null;
    }>(
      `SELECT subject, body_text, lint_result FROM outreach.email_drafts WHERE drafting_item_id = $1`,
      [item.id],
    );
    return rows[0] ?? null;
  });

  return persistDraftFromProvider(jobId, item, run, {
    isRepair: true,
    previousSubject: existingDraft?.subject ?? null,
    previousBodyText: existingDraft?.body_text ?? null,
    hardLintFindings: existingDraft?.lint_result
      ? mechanicalAutoRepairFindings(existingDraft.lint_result)
      : null,
  });
}

async function handleRewrite(jobId: string): Promise<ProcessDraftingJobResult> {
  const context = await loadDraftingJobContext(jobId);
  if (!context) return { jobId, status: 'skipped', nextJobIds: [] };
  const { job, item, run } = context;
  if (job.status !== 'in_flight') return { jobId, status: 'skipped', nextJobIds: [] };
  if (isStaleJob(job, item)) {
    await finishDraftingJob({ jobId, status: 'superseded' });
    return { jobId, status: 'superseded', nextJobIds: [] };
  }

  const existingDraft = await dbTransaction(async (client) => {
    const { rows } = await client.query<{ subject: string; body_text: string }>(
      `SELECT subject, body_text FROM outreach.email_drafts WHERE drafting_item_id = $1`,
      [item.id],
    );
    return rows[0] ?? null;
  });

  const feedbackRaw = job.usage && typeof job.usage === 'object'
    ? (job.usage as Record<string, unknown>).rewriteFeedback
    : null;
  const feedback = typeof feedbackRaw === 'string' && feedbackRaw.trim()
    ? feedbackRaw.trim()
    : null;

  return persistDraftFromProvider(jobId, item, run, {
    isRewrite: true,
    feedback,
    previousSubject: existingDraft?.subject ?? null,
    previousBodyText: existingDraft?.body_text ?? null,
  });
}

const HANDLERS: Record<DraftingJobKind, (jobId: string) => Promise<ProcessDraftingJobResult>> = {
  verify_mailbox: handleVerifyMailbox,
  research: handleResearch,
  write: handleWrite,
  repair: handleRepair,
  rewrite: handleRewrite,
};

/** Claim and process one drafting job. Never calls live Anthropic unless DRAFTING_MODE=live. */
export async function processDraftingJob(jobId: string): Promise<ProcessDraftingJobResult> {
  const claimed = await claimDraftingJob(jobId);
  if (!claimed) {
    return { jobId, status: 'skipped', nextJobIds: [] };
  }

  if (claimed.status === 'cancelled' || claimed.status === 'superseded' || claimed.status === 'failed') {
    return { jobId, status: claimed.status as ProcessDraftingJobResult['status'], nextJobIds: [] };
  }

  const workspaceStatus = await loadDraftingJobContext(jobId);
  if (workspaceStatus) {
    const paused = await dbQuery<{ status: string }>(
      `SELECT w.status
         FROM outreach.drafting_workspaces w
        WHERE w.id = $1`,
      [workspaceStatus.run.workspace_id],
    );
    if (paused.rows[0]?.status === 'paused') {
      await finishDraftingJob({
        jobId,
        status: 'cancelled',
        lastErrorCode: 'workspace_paused',
        lastErrorMessage: 'Drafting workspace paused by user',
      });
      return { jobId, status: 'skipped', nextJobIds: [] };
    }
  }

  const handler = HANDLERS[claimed.kind];
  if (!handler) {
    return markJobFailed(jobId, 'unsupported_kind', `Unsupported job kind: ${claimed.kind}`);
  }

  try {
    // Continuous liveness: bump drafting_jobs.heartbeat_at for the WHOLE
    // execution (30s cadence). Checkpoint-only heartbeats let long research
    // look "dead" to rescue, which then revived live jobs and raced them.
    const runClaimedHandler = async (): Promise<ProcessDraftingJobResult> => {
      if (claimed.kind !== 'research') return handler(jobId);
      const fenced = await withDraftingItemExecutionFence(
        claimed.drafting_item_id,
        () => handler(jobId),
      );
      if (!fenced.acquired) {
        await finishDraftingJob({
          jobId,
          status: 'superseded',
          lastErrorCode: 'drafting_item_execution_locked',
          lastErrorMessage: 'Another worker owns this drafting item execution',
        });
        return {
          jobId,
          status: 'superseded',
          nextJobIds: [],
          errorCode: 'drafting_item_execution_locked',
        };
      }
      return fenced.result;
    };

    return await runWithLeaseHeartbeat({
      heartbeat: () => heartbeatDraftingJob(jobId),
      intervalMs: 30_000,
      operation: runClaimedHandler,
      onHeartbeatError: (error) => {
        console.warn(`[drafting-job] heartbeat failed job=${jobId}:`, error);
      },
    });
  } catch (error) {
    if (error instanceof TransitionConflictError) {
      // A concurrent/stale claim lost the state race — supersede quietly,
      // the winning execution owns the item.
      await finishDraftingJob({
        jobId,
        status: 'superseded',
        lastErrorCode: 'state_conflict_superseded',
        lastErrorMessage: error.message,
      });
      return {
        jobId,
        status: 'superseded',
        nextJobIds: [],
        errorCode: 'state_conflict_superseded',
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return markJobFailed(jobId, 'orchestration_error', message);
  }
}

/** Convenience entry: process the next eligible pending job. */
export async function processNextDraftingJob(): Promise<ProcessDraftingJobResult | null> {
  const { dbQuery } = await import('@/lib/db');
  const { rows } = await dbQuery<{ id: string }>(
    `SELECT id FROM outreach.drafting_jobs
     WHERE status = 'pending'
     ORDER BY priority ASC, created_at ASC
     LIMIT 1`,
  );
  if (!rows[0]) return null;
  return processDraftingJob(rows[0].id);
}

export { assertTransition };
