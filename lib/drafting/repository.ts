import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { inferIdentitySlug } from '@/lib/agentmail-inboxes';
import { assertCampaignOwner } from '@/lib/auth';
import { formatEmailStatus } from '@/lib/campaign-sheet';
import { dbQuery, dbTransaction } from '@/lib/db';
import { loadDraftingAssets } from '@/lib/drafting/assets';
import { resolveCompanyResearchKey } from '@/lib/drafting/company-research-key';
import { estimateResearchCost, worstCaseResearchReservationUsd } from '@/lib/drafting/cost';
import { draftingCostEventKey, type DraftingCostStage } from '@/lib/drafting/cost-events';
import {
  isSenderProfileSignatureReady,
  stripTrailingTextSignature,
} from '@/lib/drafting/email-signature';
import {
  DraftingConflictError,
  DraftingExportBlockedError,
  DraftingNotFoundError,
  DraftingValidationError,
} from '@/lib/drafting/errors';
import {
  EMPTY_BRIEF_TERMINAL_MESSAGE,
  EMPTY_RESEARCH_BRIEF_ERROR_CODE,
  isEmptyBriefQuarantined,
  recordEmptyBriefCompletion,
  type EmptyBriefCompletionDecision,
  type EmptyBriefRetrySurface,
} from '@/lib/drafting/empty-brief-policy';
import {
  RUNNING_STATES,
  computeDraftingCounters,
  isGenerationComplete,
  isDraftedState,
  isLeadsModeRow,
  isMailboxDraftable,
  isReviewComplete,
} from '@/lib/drafting/eligibility';
import { resolveDeliveryVerificationStatus } from '@/lib/drafting/delivery-trust';
import {
  canApproveIdleDraftingItem,
  resolveDraftingEnqueueAction,
} from '@/lib/drafting/queue-orchestration';
import {
  ApprovedDraftExportRow,
  UnverifiedLeadExportRow,
  mapApprovedExportRow,
  mailboxVerificationLabel,
  preflightFinalDraftExport,
  preflightFinalDraftSend,
} from '@/lib/drafting/exports';
import {
  DAILY_SEND_CAP,
  enqueueOverflowSend,
  formatNyDate,
  loadActiveQueueByItemIds,
  ownerQueueStats,
  todayRemaining,
  type ActiveQueueInfo,
} from '@/lib/drafting/send-queue';
import {
  EmailSendConfigurationError,
  EmailSendProviderError,
  isEmailSendConfigured,
} from '@/lib/drafting/send';
import { dispatchDraftingRunStarted, dispatchDraftingJobs } from '@/lib/drafting/transport';
import { campaignRampDelayMs } from '@/lib/drafting/provider-admission';
import { shouldDispatchJobsAfterLeadSync } from '@/lib/drafting/late-sync';
import type { DraftingRescueAssessment } from '@/lib/drafting/rescue';
import { isReadyForBulkSend } from '@/lib/drafting/draft-review-order';
import {
  hasBlockingHardLintFailures,
  hasRetrySuggestedLint,
  isRetrySuggestedLintCode,
  lintDraft,
} from '@/lib/drafting/lint';
import {
  buildEffectiveLeadFields,
  emailFingerprint,
  extractFirstName,
  inputFingerprint,
  missingRequiredFields,
  normalizeDraftBody,
  normalizeDraftText,
  normalizeEmail,
  normalizeRequiredField,
} from '@/lib/drafting/normalize';
import { buildReusableCompanyResearchContext } from '@/lib/drafting/research-company-reuse';
import {
  asResearchTimelinessAudit,
  isFreshTemporalAudit,
  persistTimelinessAudit,
  warmStaleDraftTimeliness,
  GATE_WARM_BATCH_LIMIT,
} from '@/lib/drafting/gate-warm';
import {
  assessResearchTimeliness,
  findDraftTimelinessFailures,
  reconcileManualDraftGrounding,
  type DraftTemporalGrounding,
  type ResearchTimelinessAudit,
} from '@/lib/drafting/temporal-policy';
import { syncReviewStatus, assertTransition } from '@/lib/drafting/state';
import { LINKEDIN_RELATIONSHIP_LABEL } from '@/lib/models';
import type {
  DeliverySnapshot,
  DraftGenerationMode,
  DraftingItemState,
  DraftingJobKind,
  DraftingJobStatus,
  DraftingResearchPacket,
  InputOverrides,
  InputSnapshot,
  LintResult,
  MailboxVerificationStatus,
  ReusableCompanyResearchContext,
  ReviewStatus,
  SenderSignatureMode,
} from '@/lib/drafting/types';

// ── Shared row types ────────────────────────────────────────────────────────

export type SenderProfileRow = {
  id: string;
  display_name: string;
  work_email: string;
  title: string;
  company_name: string;
  headshot_storage_path: string | null;
  signature_mode: SenderSignatureMode;
  timezone: string | null;
  voice_notes: string | null;
  professional_context: Record<string, unknown>;
  revision: number;
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

const SENDER_PROFILE_SELECT = `id, display_name, work_email, title, company_name, headshot_storage_path,
            signature_mode, timezone, voice_notes,
            professional_context, revision, is_default, created_at, updated_at`;

export type DraftingWorkspaceRow = {
  id: string;
  campaign_id: string;
  status: string;
  updated_at: string;
  generation_completed_at: string | null;
  review_completed_at: string | null;
  sender_profile_id: string | null;
  paused_at: string | null;
};

type DbDraftingItemRow = {
  id: string;
  workspace_id: string;
  lead_id: string;
  ordinal: number;
  state: DraftingItemState;
  input_snapshot: InputSnapshot;
  input_overrides: InputOverrides;
  missing_fields: string[];
  input_fingerprint: string | null;
  input_revision: number;
  delivery_snapshot: DeliverySnapshot;
  review_status: ReviewStatus;
  removed_at: string | null;
  last_error_code: string | null;
  empty_brief_attempts: number;
  empty_brief_input_fingerprint: string | null;
  empty_brief_last_at: string | null;
};

type DbDraftRow = {
  drafting_item_id: string;
  subject: string;
  body_text: string;
  content_revision: number;
  input_fingerprint: string;
  research_packet_sha256: string;
  grounding_status: string;
  lint_result: LintResult;
  used_fact_ids: string[];
  claim_ledger: { entries?: DraftTemporalGrounding['claimLedger'] };
  draft_grounding: DraftTemporalGrounding | null;
  temporal_status: 'verified' | 'context_only' | 'blocked';
  temporal_audit: ResearchTimelinessAudit | Record<string, unknown>;
  generation_mode: DraftGenerationMode;
  generated_at: string | null;
};

export class DraftingTimelinessError extends Error {
  constructor(public readonly codes: string[]) {
    super(`Draft timeliness check failed: ${codes.join(', ')}`);
    this.name = 'DraftingTimelinessError';
  }
}

export function assertDraftGenerationMode(
  mode: DraftGenerationMode,
  options: { allowStubReview?: boolean } = {},
): void {
  if (mode === 'live') return;
  if (mode === 'stub' && options.allowStubReview) return;
  throw new DraftingTimelinessError(['NON_LIVE_DRAFT_DELIVERY_BLOCKED']);
}

export function resolvePersistedDraftGrounding(
  draft: Pick<DbDraftRow, 'draft_grounding' | 'used_fact_ids' | 'claim_ledger'>,
): DraftTemporalGrounding {
  const persisted = draft.draft_grounding;
  return {
    usedFactIds: persisted?.usedFactIds ?? draft.used_fact_ids ?? [],
    claimLedger: persisted?.claimLedger ?? draft.claim_ledger?.entries ?? [],
    ...(persisted?.prospectTerms ? { prospectTerms: persisted.prospectTerms } : {}),
  };
}

export type DraftingItemSummary = {
  id: string;
  ordinal: number;
  state: DraftingItemState;
  review_status: ReviewStatus;
  input_revision: number;
  input_fingerprint: string | null;
  last_error_code: string | null;
  empty_brief_attempts: number;
  empty_brief_input_fingerprint: string | null;
  missing_fields: string[];
  effective_fields: ReturnType<typeof buildEffectiveLeadFields>;
  delivery_snapshot: DeliverySnapshot | null;
  can_approve_for_drafting: boolean;
  draft: {
    subject: string;
    body_text: string;
    content_revision: number;
    lint_hard: number;
    lint_warnings: number;
    /** Soft quality issues remain (e.g. overloaded sentence) — show Retry suggested. */
    retry_suggested: boolean;
    lint_hard_codes: string[];
    /** When the draft content was last generated (for recency sort). */
    generated_at: string | null;
    /** Cached research temporal audit status (warmed on snapshot / reconcile). */
    temporal_status: 'verified' | 'context_only' | 'blocked' | 'unknown';
    /** True when live draft currently passes export quality gates (lint + temporal). */
    export_quality_ready: boolean;
    send_status: 'unsent' | 'queued' | 'sending' | 'sent' | 'failed';
    queue_id: string | null;
    schedule_date: string | null;
    email_send_id: string | null;
    sent_at: string | null;
    send_error: string | null;
    engagement: EmailEngagementLifecycle;
    delivered_at: string | null;
    opened_at: string | null;
    clicked_at: string | null;
    bounced_at: string | null;
    replied_at: string | null;
    open_count: number;
    click_count: number;
  } | null;
};

export type WorkspaceActivityPhase = 'verify' | 'research' | 'writing' | 'repair' | 'rewrite';

export type WorkspaceActivityItem = {
  item_id: string;
  ordinal: number;
  lead_name: string | null;
  company: string | null;
  title: string | null;
  phase: WorkspaceActivityPhase;
  state: DraftingItemState;
  snippet: string | null;
};

export type WorkspaceActivity = {
  worker_limit: number;
  active_workers: number;
  items: WorkspaceActivityItem[];
};

export type WorkspaceSnapshot = {
  workspace: {
    id: string;
    status: string;
    updated_at: string;
    generation_complete: boolean;
    review_complete: boolean;
    paused: boolean;
    paused_at: string | null;
  };
  activity: WorkspaceActivity;
  counts: {
    total: number;
    mailbox_valid_total: number;
    running: number;
    generated: number;
    approved: number;
    waiting_for_enrichment: number;
    verifying_mailbox: number;
    leads_attention: number;
    budget_paused: number;
    failed: number;
    sent: number;
    delivered: number;
    opened: number;
    replied: number;
    bounced: number;
  };
  progress: {
    generated: number;
    mailbox_valid_total: number;
    reviewed: number;
    generated_for_review: number;
  };
  current_item: DraftingItemSummary | null;
  neighbors: {
    previous_item_id: string | null;
    next_item_id: string | null;
  };
  email_rows: DraftingItemSummary[];
  leads_rows: DraftingItemSummary[];
  attention_rows: DraftingItemSummary[];
  exports: {
    available: boolean;
    blocking_reasons: string[];
  };
  sends: {
    configured: boolean;
    available: boolean;
    blocking_reasons: string[];
    pending: number;
    today_remaining: number;
    queued_count: number;
    next_schedule_date: string | null;
  };
  rescue: DraftingRescueAssessment;
};

export type StartDraftingResult = {
  workspace_id: string;
  drafting_run_id: string;
  created_items: number;
  mailbox_valid_total: number;
  queued_items: number;
  waiting_for_enrichment: number;
  verifying_mailbox: number;
  leads_attention: number;
  already_current: number;
  projected_cost: { low_usd: string; high_usd: string };
  budget: { limit_usd: string; paused_items: number };
  href: string;
  transport_warning?: string;
};

export type SyncDraftingLeadsResult = {
  workspace_id: string;
  drafting_run_id: string;
  created_items: number;
  mailbox_valid_total: number;
  queued_items: number;
  waiting_for_enrichment: number;
  verifying_mailbox: number;
  leads_attention: number;
  transport_warning?: string;
};

export type SyncDraftingLeadsTrigger = 'go_to_drafting' | 'retry';

// ── Owner helpers ───────────────────────────────────────────────────────────

async function assertCampaignOwned(campaignId: string, ownerId: string): Promise<void> {
  const owned = await assertCampaignOwner(campaignId, ownerId);
  if (!owned) throw new DraftingNotFoundError('Campaign not found');
}

async function getOwnedWorkspace(
  campaignId: string,
  ownerId: string,
): Promise<DraftingWorkspaceRow | null> {
  const { rows } = await dbQuery<DraftingWorkspaceRow>(
    `SELECT w.id, w.campaign_id, w.status, w.updated_at,
            w.generation_completed_at, w.review_completed_at, w.sender_profile_id,
            w.paused_at
     FROM outreach.drafting_workspaces w
     JOIN outreach.campaigns c ON c.id = w.campaign_id
     WHERE w.campaign_id = $1 AND c.owner_id = $2`,
    [campaignId, ownerId],
  );
  return rows[0] ?? null;
}

async function getOwnedItemContext(
  itemId: string,
  ownerId: string,
): Promise<{ item: DbDraftingItemRow; campaignId: string; workspaceId: string }> {
  const { rows } = await dbQuery<DbDraftingItemRow & { campaign_id: string }>(
    `SELECT i.*, w.campaign_id
     FROM outreach.drafting_items i
     JOIN outreach.drafting_workspaces w ON w.id = i.workspace_id
     JOIN outreach.campaigns c ON c.id = w.campaign_id
     WHERE i.id = $1 AND c.owner_id = $2`,
    [itemId, ownerId],
  );
  const row = rows[0];
  if (!row) throw new DraftingNotFoundError('Drafting item not found');
  const { campaign_id: campaignId, ...item } = row;
  return { item, campaignId, workspaceId: item.workspace_id };
}

export function parseDeliverySnapshot(
  raw: DeliverySnapshot | Record<string, unknown> | null | undefined,
): DeliverySnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const snapshot = raw as DeliverySnapshot;
  if (!snapshot.effectiveEmail && !snapshot.emailVerification) return null;
  return snapshot;
}

type EmailSendRecord = {
  id: string;
  status: 'sent' | 'failed';
  sent_at: string | null;
  provider_message_id: string | null;
  error_message: string | null;
  delivered_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  bounced_at: string | null;
  complained_at: string | null;
  replied_at: string | null;
  open_count: number;
  click_count: number;
};

export type EmailEngagementLifecycle =
  | 'unsent'
  | 'failed'
  | 'sent'
  | 'delivered'
  | 'opened'
  | 'clicked'
  | 'replied'
  | 'bounced'
  | 'complained';

export function deriveEmailEngagementLifecycle(
  send: Pick<
    EmailSendRecord,
    | 'status'
    | 'delivered_at'
    | 'opened_at'
    | 'clicked_at'
    | 'bounced_at'
    | 'complained_at'
    | 'replied_at'
  > | null,
): EmailEngagementLifecycle {
  if (!send) return 'unsent';
  if (send.status === 'failed') return 'failed';
  if (send.bounced_at) return 'bounced';
  if (send.complained_at) return 'complained';
  if (send.replied_at) return 'replied';
  if (send.clicked_at) return 'clicked';
  if (send.opened_at) return 'opened';
  if (send.delivered_at) return 'delivered';
  if (send.status === 'sent') return 'sent';
  return 'unsent';
}

async function loadLatestEmailSendStatuses(
  itemIds: string[],
): Promise<Map<string, EmailSendRecord>> {
  if (itemIds.length === 0) return new Map();
  const { rows } = await dbQuery<{
    id: string;
    drafting_item_id: string;
    status: 'sent' | 'failed';
    sent_at: string | null;
    provider_message_id: string | null;
    error_message: string | null;
    delivered_at: string | null;
    opened_at: string | null;
    clicked_at: string | null;
    bounced_at: string | null;
    complained_at: string | null;
    replied_at: string | null;
    open_count: number | null;
    click_count: number | null;
  }>(
    `SELECT DISTINCT ON (drafting_item_id)
            id::text, drafting_item_id, status, sent_at, provider_message_id, error_message,
            delivered_at, opened_at, clicked_at, bounced_at, complained_at, replied_at,
            open_count, click_count
       FROM outreach.email_sends
      WHERE drafting_item_id = ANY($1::uuid[])
      ORDER BY drafting_item_id, updated_at DESC`,
    [itemIds],
  );
  return new Map(rows.map((row) => [row.drafting_item_id, {
    id: row.id,
    status: row.status,
    sent_at: row.sent_at,
    provider_message_id: row.provider_message_id,
    error_message: row.error_message,
    delivered_at: row.delivered_at,
    opened_at: row.opened_at,
    clicked_at: row.clicked_at,
    bounced_at: row.bounced_at,
    complained_at: row.complained_at,
    replied_at: row.replied_at,
    open_count: Number(row.open_count ?? 0),
    click_count: Number(row.click_count ?? 0),
  }]));
}

function summarizeItem(
  item: DbDraftingItemRow,
  draft: DbDraftRow | null,
  sendStatus: EmailSendRecord | null = null,
  queueInfo: ActiveQueueInfo | null = null,
): DraftingItemSummary {
  const snapshot = item.input_snapshot;
  const effective = buildEffectiveLeadFields(snapshot, item.input_overrides);
  const delivery = parseDeliverySnapshot(item.delivery_snapshot);
  const missing = missingRequiredFields(effective);
  const lint = draft?.lint_result ?? { hard: [], warnings: [] };
  const temporalStatus = draft?.temporal_status ?? 'unknown';
  const exportQualityReady = Boolean(
    draft
    && draft.generation_mode === 'live'
    && temporalStatus !== 'blocked'
    && !hasBlockingHardLintFailures(lint),
  );
  return {
    id: item.id,
    ordinal: Number(item.ordinal),
    state: item.state,
    review_status: item.review_status,
    input_revision: Number(item.input_revision),
    input_fingerprint: item.input_fingerprint,
    last_error_code: item.last_error_code,
    empty_brief_attempts: Number(item.empty_brief_attempts),
    empty_brief_input_fingerprint: item.empty_brief_input_fingerprint,
    missing_fields: missing.map(String),
    effective_fields: effective,
    delivery_snapshot: delivery,
    can_approve_for_drafting: canApproveIdleDraftingItem({
      state: item.state,
      missingFieldCount: missing.length,
    }),
    draft: draft
      ? {
          subject: draft.subject,
          body_text: normalizeDraftBody(draft.body_text, effective.firstName),
          content_revision: Number(draft.content_revision),
          lint_hard: lint.hard.length,
          lint_warnings: lint.warnings.length,
          retry_suggested: hasRetrySuggestedLint(lint),
          lint_hard_codes: lint.hard.map((finding) => finding.code),
          generated_at: draft.generated_at ?? null,
          temporal_status: temporalStatus === 'verified'
            || temporalStatus === 'context_only'
            || temporalStatus === 'blocked'
            ? temporalStatus
            : 'unknown',
          export_quality_ready: exportQualityReady,
          send_status: sendStatus?.status === 'sent'
            ? 'sent'
            : queueInfo?.status === 'sending'
              ? 'sending'
              : queueInfo
                ? 'queued'
                : sendStatus?.status === 'failed'
                  ? 'failed'
                  : 'unsent',
          queue_id: queueInfo?.queue_id ?? null,
          schedule_date: queueInfo?.schedule_date ?? null,
          email_send_id: sendStatus?.id ?? null,
          sent_at: sendStatus?.sent_at ?? null,
          send_error: sendStatus?.error_message ?? null,
          engagement: deriveEmailEngagementLifecycle(sendStatus),
          delivered_at: sendStatus?.delivered_at ?? null,
          opened_at: sendStatus?.opened_at ?? null,
          clicked_at: sendStatus?.clicked_at ?? null,
          bounced_at: sendStatus?.bounced_at ?? null,
          replied_at: sendStatus?.replied_at ?? null,
          open_count: sendStatus?.open_count ?? 0,
          click_count: sendStatus?.click_count ?? 0,
        }
      : null,
  };
}

/** Trim caller-supplied extra columns into a clean string map for the writer input. */
function normalizeCustomContext(
  extra: Record<string, string> | null | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!extra) return result;
  for (const [key, rawValue] of Object.entries(extra)) {
    const label = key.trim();
    const value = typeof rawValue === 'string' ? rawValue.trim() : String(rawValue ?? '').trim();
    if (label && value) result[label] = value;
  }
  return result;
}

function buildInputSnapshotFromLead(input: {
  lead: {
    first_name: string | null;
    last_name: string | null;
    email_primary: string | null;
    title: string | null;
    company_name: string | null;
    location: string | null;
    linkedin_url: string | null;
    email_status: string;
    email_verification: string | null;
  };
  relationship_snapshot: Record<string, unknown> | null;
  extra_fields?: Record<string, string> | null;
  source_run_id: string | null;
  sender: SenderProfileRow;
  assetVersions: InputSnapshot['assets'];
}): InputSnapshot {
  const fullName = normalizeRequiredField(
    [input.lead.first_name, input.lead.last_name].filter(Boolean).join(' '),
  );
  const customContext = normalizeCustomContext(input.extra_fields);
  const linkedinRelationship = customContext[LINKEDIN_RELATIONSHIP_LABEL] ?? null;
  const tier = typeof input.relationship_snapshot?.relationship_tier === 'string'
    ? input.relationship_snapshot.relationship_tier
    : null;
  let priorRelationshipActivity: string | null = null;
  if (tier === 'active') priorRelationshipActivity = 'Within 6 months';
  else if (tier === 'dormant') priorRelationshipActivity = 'Older than 6 months';

  return {
    schemaVersion: 1,
    lead: {
      fullName,
      firstName: extractFirstName(fullName),
      lastName: normalizeRequiredField(input.lead.last_name),
      email: normalizeEmail(input.lead.email_primary),
      company: normalizeRequiredField(input.lead.company_name),
      title: normalizeRequiredField(input.lead.title),
      workLocation: normalizeRequiredField(input.lead.location),
      linkedinUrl: normalizeRequiredField(input.lead.linkedin_url),
      emailStatus: input.lead.email_status,
      emailDecision: input.lead.email_verification,
    },
    relationship: {
      pastWork: typeof input.relationship_snapshot?.past_work === 'string'
        ? input.relationship_snapshot.past_work
        : null,
      priorRelationshipActivity,
      lastContacted: typeof input.relationship_snapshot?.last_contacted === 'string'
        ? input.relationship_snapshot.last_contacted
        : null,
      lastContactedBy: typeof input.relationship_snapshot?.last_contacted_by === 'string'
        ? input.relationship_snapshot.last_contacted_by
        : null,
      relationshipTier: tier,
      reusedFromPriorLead: false,
      capturedAt: null,
    },
    connectingContext: {
      mode: 'cold',
      introducerName: null,
      suppliedContext: null,
      linkedinConnectionDegree: linkedinRelationship,
      rawCrmIndicator: linkedinRelationship,
    },
    customContext,
    provenance: {
      sourceRunId: input.source_run_id,
      profileEnrichment: {},
      emailProvenance: {},
    },
    sender: {
      profileId: input.sender.id,
      profileRevision: Number(input.sender.revision),
      identitySlug: inferIdentitySlug({
        workEmail: input.sender.work_email,
        displayName: input.sender.display_name,
      }),
      displayName: input.sender.display_name,
      workEmail: input.sender.work_email,
      title: input.sender.title,
      companyName: input.sender.company_name,
      headshotStoragePath: input.sender.headshot_storage_path,
      signatureMode: input.sender.signature_mode,
      voiceNotes: input.sender.voice_notes,
      professionalContext: input.sender.professional_context ?? {},
    },
    assets: input.assetVersions,
  };
}

function deliveryFromLeadVerification(
  email: string | null,
  verification: string | null,
  emailStatus: string | null = null,
): DeliverySnapshot {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return {
      effectiveEmail: '',
      effectiveEmailFingerprint: '',
      emailVerification: 'missing',
      verifiedAt: null,
      resultSource: 'enrichment',
      providerRequestId: null,
    };
  }

  // Upload / Embark-DB / inferred emails all require AgentMail (or rate-limit
  // fail-open). resolveDeliveryVerificationStatus never invents "valid".
  const status = resolveDeliveryVerificationStatus(verification, emailStatus);

  return {
    effectiveEmail: normalized,
    effectiveEmailFingerprint: emailFingerprint(normalized),
    emailVerification: (status as DeliverySnapshot['emailVerification']) ?? 'pending',
    verifiedAt: status === 'valid' ? new Date().toISOString() : null,
    resultSource: 'enrichment',
    providerRequestId: null,
  };
}

const WORKSPACE_PAGE_DEFAULT = 100;
const WORKSPACE_PAGE_MAX = 250;
const LEAD_SYNC_CHUNK = 150;

async function loadWorkspaceItems(
  workspaceId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<DbDraftingItemRow[]> {
  const hasPage = options.limit != null;
  const limit = hasPage
    ? Math.min(WORKSPACE_PAGE_MAX, Math.max(1, options.limit ?? WORKSPACE_PAGE_DEFAULT))
    : null;
  const offset = Math.max(0, options.offset ?? 0);
  const { rows } = await dbQuery<DbDraftingItemRow>(
    hasPage
      ? `SELECT id, workspace_id, lead_id, ordinal, state, input_snapshot, input_overrides,
                missing_fields, input_fingerprint, input_revision, delivery_snapshot,
                review_status, removed_at, last_error_code, empty_brief_attempts,
                empty_brief_input_fingerprint, empty_brief_last_at
         FROM outreach.drafting_items
         WHERE workspace_id = $1 AND removed_at IS NULL AND state <> 'removed'
         ORDER BY ordinal
         LIMIT $2 OFFSET $3`
      : `SELECT id, workspace_id, lead_id, ordinal, state, input_snapshot, input_overrides,
                missing_fields, input_fingerprint, input_revision, delivery_snapshot,
                review_status, removed_at, last_error_code, empty_brief_attempts,
                empty_brief_input_fingerprint, empty_brief_last_at
         FROM outreach.drafting_items
         WHERE workspace_id = $1 AND removed_at IS NULL AND state <> 'removed'
         ORDER BY ordinal`,
    hasPage ? [workspaceId, limit, offset] : [workspaceId],
  );
  return rows;
}

/** Lightweight rows for counter aggregation (no draft bodies). */
async function loadWorkspaceItemStates(workspaceId: string): Promise<Array<{
  id: string;
  state: DraftingItemState;
  delivery_snapshot: Record<string, unknown> | null;
  removed_at: string | null;
}>> {
  const { rows } = await dbQuery<{
    id: string;
    state: DraftingItemState;
    delivery_snapshot: Record<string, unknown> | null;
    removed_at: string | null;
  }>(
    `SELECT id, state, delivery_snapshot, removed_at
       FROM outreach.drafting_items
      WHERE workspace_id = $1 AND removed_at IS NULL AND state <> 'removed'
      ORDER BY ordinal`,
    [workspaceId],
  );
  return rows;
}

async function loadDraftsForItems(itemIds: string[]): Promise<Map<string, DbDraftRow>> {
  const drafts = new Map<string, DbDraftRow>();
  if (itemIds.length === 0) return drafts;
  const { rows } = await dbQuery<DbDraftRow>(
    `SELECT drafting_item_id, subject, body_text, content_revision, input_fingerprint,
            research_packet_sha256, grounding_status, lint_result, used_fact_ids,
            claim_ledger, draft_grounding, temporal_status, temporal_audit, generation_mode,
            generated_at::text
       FROM outreach.email_drafts
      WHERE drafting_item_id = ANY($1::uuid[])`,
    [itemIds],
  );
  for (const row of rows) drafts.set(row.drafting_item_id, row);
  return drafts;
}

async function loadDraftForItem(itemId: string): Promise<DbDraftRow | null> {
  const drafts = await loadDraftsForItems([itemId]);
  return drafts.get(itemId) ?? null;
}

/** Re-evaluate persisted evidence against server time before approval or export. */
async function assertDraftTimelyNow(
  draft: DbDraftRow,
  options: { allowStubReview?: boolean } = {},
): Promise<void> {
  assertDraftGenerationMode(draft.generation_mode, options);
  if (draft.generation_mode === 'stub') return;
  const { rows } = await dbQuery<{ packet: DraftingResearchPacket }>(
    `SELECT packet
       FROM outreach.draft_research_packets
      WHERE drafting_item_id = $1`,
    [draft.drafting_item_id],
  );
  const packet = rows[0]?.packet;
  if (!packet) throw new DraftingTimelinessError(['MISSING_RESEARCH_PACKET']);

  const cachedAudit = asResearchTimelinessAudit(draft.temporal_audit);
  const grounding = resolvePersistedDraftGrounding(draft);
  let audit: ResearchTimelinessAudit;

  if (isFreshTemporalAudit(cachedAudit, packet.asOf)) {
    // Warm path: reuse recent audit; still validate draft body against it (CPU only).
    audit = cachedAudit!;
  } else {
    audit = assessResearchTimeliness(packet);
    await dbTransaction(async (client) => {
      await persistTimelinessAudit(client, draft.drafting_item_id, audit);
    });
  }

  const findings = findDraftTimelinessFailures(draft.subject, draft.body_text, audit, grounding);
  if (findings.length) {
    throw new DraftingTimelinessError([...new Set(findings.map((finding) => finding.code))]);
  }
}

// ── Sender profiles ─────────────────────────────────────────────────────────

export async function listSenderProfiles(userId: string): Promise<SenderProfileRow[]> {
  const { rows } = await dbQuery<SenderProfileRow>(
    `SELECT ${SENDER_PROFILE_SELECT}
     FROM outreach.sender_profiles
     WHERE user_id = $1
     ORDER BY is_default DESC, updated_at DESC`,
    [userId],
  );
  return rows;
}

export async function upsertSenderProfile(
  userId: string,
  input: {
    id?: string;
    display_name: string;
    work_email: string;
    title: string;
    company_name?: string | null;
    headshot_storage_path?: string | null;
    signature_mode?: SenderSignatureMode;
    timezone?: string | null;
    voice_notes?: string | null;
    professional_context?: Record<string, unknown>;
    is_default?: boolean;
  },
): Promise<SenderProfileRow> {
  const displayName = normalizeRequiredField(input.display_name);
  const workEmail = normalizeEmail(input.work_email);
  const title = normalizeRequiredField(input.title);
  if (!displayName || !workEmail || !title) {
    throw new DraftingValidationError('Sender profile requires display name, work email, and title');
  }
  const companyName = normalizeRequiredField(input.company_name ?? 'Helios Group') || 'Helios Group';
  const signatureMode = input.signature_mode ?? 'name_and_role';
  if (!['name', 'name_and_role'].includes(signatureMode)) {
    throw new DraftingValidationError('Invalid signature mode');
  }

  return dbTransaction(async (client) => {
    if (input.is_default) {
      await client.query(
        `UPDATE outreach.sender_profiles SET is_default = false WHERE user_id = $1`,
        [userId],
      );
    }

    if (input.id) {
      const updated = await client.query<SenderProfileRow>(
        `UPDATE outreach.sender_profiles
         SET display_name = $3,
             work_email = $4,
             title = $5,
             company_name = $6,
             headshot_storage_path = COALESCE($7, headshot_storage_path),
             signature_mode = $8,
             timezone = $9,
             voice_notes = $10,
             professional_context = coalesce($11::jsonb, professional_context),
             is_default = coalesce($12, is_default),
             revision = revision + 1,
             updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING ${SENDER_PROFILE_SELECT}`,
        [
          input.id,
          userId,
          displayName,
          workEmail,
          title,
          companyName,
          input.headshot_storage_path === undefined ? null : input.headshot_storage_path,
          signatureMode,
          input.timezone ?? null,
          input.voice_notes ?? null,
          input.professional_context ? JSON.stringify(input.professional_context) : null,
          input.is_default ?? null,
        ],
      );
      if (!updated.rows[0]) throw new DraftingNotFoundError('Sender profile not found');
      return updated.rows[0];
    }

    const created = await client.query<SenderProfileRow>(
      `INSERT INTO outreach.sender_profiles (
         user_id, display_name, work_email, title, company_name, headshot_storage_path,
         signature_mode, timezone, voice_notes, professional_context, is_default
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10::jsonb, '{}'::jsonb), coalesce($11, false))
       RETURNING ${SENDER_PROFILE_SELECT}`,
      [
        userId,
        displayName,
        workEmail,
        title,
        companyName,
        input.headshot_storage_path ?? null,
        signatureMode,
        input.timezone ?? null,
        input.voice_notes ?? null,
        input.professional_context ? JSON.stringify(input.professional_context) : null,
        input.is_default ?? false,
      ],
    );
    return created.rows[0];
  });
}

export async function setSenderProfileHeadshot(
  userId: string,
  profileId: string,
  storagePath: string,
): Promise<SenderProfileRow> {
  const { rows } = await dbQuery<SenderProfileRow>(
    `UPDATE outreach.sender_profiles
        SET headshot_storage_path = $3,
            revision = revision + 1,
            updated_at = now()
      WHERE id = $1 AND user_id = $2
      RETURNING ${SENDER_PROFILE_SELECT}`,
    [profileId, userId, storagePath],
  );
  if (!rows[0]) throw new DraftingNotFoundError('Sender profile not found');
  return rows[0];
}

export async function getSenderProfileHeadshotPath(
  profileId: string,
): Promise<string | null> {
  const { rows } = await dbQuery<{ headshot_storage_path: string | null; work_email: string }>(
    `SELECT headshot_storage_path, work_email
       FROM outreach.sender_profiles
      WHERE id = $1`,
    [profileId],
  );
  return rows[0]?.headshot_storage_path ?? null;
}

/** Resolve a sender headshot storage path from profile id and/or work email. */
export async function resolveSenderHeadshotStoragePath(input: {
  profileId?: string | null;
  workEmail?: string | null;
  headshotStoragePath?: string | null;
}): Promise<string | null> {
  const direct = input.headshotStoragePath?.trim();
  if (direct) return direct;

  const profileId = input.profileId?.trim();
  if (profileId && /^[0-9a-f-]{36}$/i.test(profileId)) {
    const fromId = await getSenderProfileHeadshotPath(profileId);
    if (fromId) return fromId;
  }

  const workEmail = input.workEmail?.trim().toLowerCase();
  if (!workEmail) return null;
  const { rows } = await dbQuery<{ headshot_storage_path: string | null }>(
    `SELECT headshot_storage_path
       FROM outreach.sender_profiles
      WHERE lower(work_email) = $1
        AND headshot_storage_path IS NOT NULL
        AND length(trim(headshot_storage_path)) > 0
      ORDER BY is_default DESC, updated_at DESC
      LIMIT 1`,
    [workEmail],
  );
  return rows[0]?.headshot_storage_path?.trim() || null;
}

async function resolveSenderProfile(
  userId: string,
  senderProfileId?: string,
): Promise<SenderProfileRow> {
  if (senderProfileId) {
    const { rows } = await dbQuery<SenderProfileRow>(
      `SELECT ${SENDER_PROFILE_SELECT}
       FROM outreach.sender_profiles
       WHERE id = $1 AND user_id = $2`,
      [senderProfileId, userId],
    );
    if (!rows[0]) throw new DraftingNotFoundError('Sender profile not found');
    assertSenderProfileSignatureReady(rows[0]);
    return rows[0];
  }

  const { rows } = await dbQuery<SenderProfileRow>(
    `SELECT ${SENDER_PROFILE_SELECT}
     FROM outreach.sender_profiles
     WHERE user_id = $1
     ORDER BY is_default DESC, updated_at DESC
     LIMIT 1`,
    [userId],
  );
  if (!rows[0]) {
    throw new DraftingValidationError('Sender profile required', { sender_profile: 'required' });
  }
  assertSenderProfileSignatureReady(rows[0]);
  return rows[0];
}

function assertSenderProfileSignatureReady(profile: SenderProfileRow): void {
  if (isSenderProfileSignatureReady(profile)) return;
  throw new DraftingValidationError(
    'Sender profile requires name, position, and headshot before drafting',
    { sender_profile: 'incomplete' },
  );
}

function activityPhaseForState(state: DraftingItemState): WorkspaceActivityPhase | null {
  if (state === 'verifying_mailbox') return 'verify';
  if (
    state === 'queued_research'
    || state === 'waiting_company_research'
    || state === 'researching'
  ) {
    return 'research';
  }
  if (state === 'queued_write' || state === 'writing') return 'writing';
  if (state === 'repairing') return 'repair';
  if (state === 'queued_rewrite' || state === 'rewriting') return 'rewrite';
  return null;
}

function extractResearchSnippet(packet: Record<string, unknown> | null): string | null {
  if (!packet) return null;
  const leadIdentity = packet.leadIdentity;
  if (leadIdentity && typeof leadIdentity === 'object' && !Array.isArray(leadIdentity)) {
    const currentSummary = (leadIdentity as Record<string, unknown>).currentSummary;
    if (typeof currentSummary === 'string' && currentSummary.trim()) {
      return currentSummary.trim().slice(0, 200);
    }
  }
  const resolution = packet.resolution;
  if (resolution && typeof resolution === 'object' && !Array.isArray(resolution)) {
    const reasonForWriting = (resolution as Record<string, unknown>).reasonForWriting;
    if (typeof reasonForWriting === 'string' && reasonForWriting.trim()) {
      return reasonForWriting.trim().slice(0, 200);
    }
  }
  const prospectWorld = packet.prospectWorld;
  if (prospectWorld && typeof prospectWorld === 'object' && !Array.isArray(prospectWorld)) {
    const roleReality = (prospectWorld as Record<string, unknown>).roleReality;
    if (typeof roleReality === 'string' && roleReality.trim()) {
      return roleReality.trim().slice(0, 200);
    }
  }
  const personFacts = packet.personFacts;
  if (Array.isArray(personFacts) && personFacts.length > 0) {
    const first = personFacts[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const claim = (first as Record<string, unknown>).normalizedClaim;
      if (typeof claim === 'string' && claim.trim()) {
        return claim.trim().slice(0, 200);
      }
    }
  }
  return null;
}

async function loadWorkspaceActivity(
  workspaceId: string,
  activeWorkers: number,
): Promise<WorkspaceActivity> {
  const workerLimit = Math.max(1, Number(process.env.ORG_DRAFT_RESEARCH_CONCURRENCY ?? 4));
  const writeLimit = Math.max(1, Number(process.env.ORG_DRAFT_WRITE_CONCURRENCY ?? 4));
  const { rows } = await dbQuery<{
    id: string;
    ordinal: number;
    state: DraftingItemState;
    input_snapshot: InputSnapshot;
    input_overrides: InputOverrides;
    packet: Record<string, unknown> | null;
  }>(
    `SELECT di.id, di.ordinal, di.state, di.input_snapshot, di.input_overrides, drp.packet
     FROM outreach.drafting_items di
     LEFT JOIN outreach.draft_research_packets drp ON drp.drafting_item_id = di.id
     WHERE di.workspace_id = $1
       AND di.removed_at IS NULL
       AND di.state = ANY($2::text[])
     ORDER BY di.ordinal ASC
     LIMIT 24`,
    [workspaceId, [...RUNNING_STATES]],
  );

  return {
    worker_limit: workerLimit + writeLimit,
    active_workers: activeWorkers,
    items: rows.flatMap((row) => {
      const phase = activityPhaseForState(row.state);
      if (!phase) return [];
      const effective = buildEffectiveLeadFields(row.input_snapshot, row.input_overrides);
      return [{
        item_id: row.id,
        ordinal: Number(row.ordinal),
        lead_name: effective.fullName,
        company: effective.company,
        title: effective.title,
        phase,
        state: row.state,
        snippet: extractResearchSnippet(row.packet),
      }];
    }),
  };
}

function emptyWorkspaceActivity(): WorkspaceActivity {
  const research = Math.max(1, Number(process.env.ORG_DRAFT_RESEARCH_CONCURRENCY ?? 4));
  const write = Math.max(1, Number(process.env.ORG_DRAFT_WRITE_CONCURRENCY ?? 4));
  return {
    worker_limit: research + write,
    active_workers: 0,
    items: [],
  };
}

// ── Workspace snapshot ──────────────────────────────────────────────────────

export async function getWorkspaceSnapshot(
  campaignId: string,
  ownerId: string,
  options: {
    itemId?: string;
    filter?: 'to_review' | 'approved' | 'all_generated' | 'needs_attention';
    /** Page size for email/leads rows (default 100). Pass 0 to load all (legacy). */
    limit?: number;
    offset?: number;
  } = {},
): Promise<WorkspaceSnapshot> {
  await assertCampaignOwned(campaignId, ownerId);
  const workspace = await getOwnedWorkspace(campaignId, ownerId);

  if (!workspace) {
    return {
      workspace: {
        id: '',
        status: 'inactive',
        updated_at: new Date().toISOString(),
        generation_complete: false,
        review_complete: false,
        paused: false,
        paused_at: null,
      },
      activity: emptyWorkspaceActivity(),
      counts: {
        total: 0,
        mailbox_valid_total: 0,
        running: 0,
        generated: 0,
        approved: 0,
        waiting_for_enrichment: 0,
        verifying_mailbox: 0,
        leads_attention: 0,
        budget_paused: 0,
        failed: 0,
        sent: 0,
        delivered: 0,
        opened: 0,
        replied: 0,
        bounced: 0,
      },
      progress: {
        generated: 0,
        mailbox_valid_total: 0,
        reviewed: 0,
        generated_for_review: 0,
      },
      current_item: null,
      neighbors: { previous_item_id: null, next_item_id: null },
      email_rows: [],
      leads_rows: [],
      attention_rows: [],
      exports: { available: false, blocking_reasons: ['Workspace has not been started'] },
      sends: {
        configured: isEmailSendConfigured(),
        available: false,
        blocking_reasons: ['Workspace has not been started'],
        pending: 0,
        today_remaining: DAILY_SEND_CAP,
        queued_count: 0,
        next_schedule_date: null,
      },
      rescue: {
        needed: false,
        auto_attempted: false,
        reasons: [],
        message: '',
        worker_healthy: true,
        stranded_count: 0,
        stale_lease_count: 0,
        missing_orch_count: 0,
      },
    };
  }

  // Warm stale temporal audits before summarizing so review UI / Download see
  // a recent gate result without waiting for a cold click-time recompute.
  await warmStaleDraftTimeliness({
    workspaceId: workspace.id,
    limit: GATE_WARM_BATCH_LIMIT,
  }).catch(() => 0);

  const pageLimit = options.limit === 0
    ? undefined
    : Math.min(WORKSPACE_PAGE_MAX, Math.max(1, options.limit ?? WORKSPACE_PAGE_DEFAULT));
  const pageOffset = Math.max(0, options.offset ?? 0);

  // Counters over all items (light select); full rows only for the current page.
  const allStates = await loadWorkspaceItemStates(workspace.id);
  const counterInputs = allStates.map((item) => ({
    state: item.state,
    deliverySnapshot: parseDeliverySnapshot(item.delivery_snapshot),
    removedAt: item.removed_at,
  }));
  const counters = computeDraftingCounters(counterInputs);

  const items = await loadWorkspaceItems(
    workspace.id,
    pageLimit == null ? {} : { limit: pageLimit, offset: pageOffset },
  );
  const drafts = await loadDraftsForItems(items.map((item) => item.id));
  const itemIds = items.map((item) => item.id);
  const sendStatuses = await loadLatestEmailSendStatuses(itemIds);
  const queueStatuses = await loadActiveQueueByItemIds(itemIds);

  const summaries = items.map((item) =>
    summarizeItem(
      item,
      drafts.get(item.id) ?? null,
      sendStatuses.get(item.id) ?? null,
      queueStatuses.get(item.id) ?? null,
    ),
  );
  const generationComplete = isGenerationComplete(counters.mailboxValidTotal, counters.drafted);
  const reviewComplete = isReviewComplete(counters.mailboxValidTotal, counters.approved);

  const leadsState = new Set([
    'needs_lead_review',
    'verifying_mailbox',
    'waiting_for_enrichment',
    'budget_paused',
    'failed_research',
    'failed_write',
    'failed_rewrite',
  ]);
  const leadsRows = summaries.filter((row) => {
    const item = items.find((entry) => entry.id === row.id)!;
    // Stay in Leads mode until Approve for drafting moves the item into a
    // running/generated state — including failed jobs that need a retry.
    if (leadsState.has(item.state)) return true;
    return isLeadsModeRow(item.input_snapshot, row.delivery_snapshot, item.input_overrides);
  });
  const leadsIds = new Set(leadsRows.map((row) => row.id));
  const emailRows = summaries.filter((row) => !leadsIds.has(row.id));

  const attentionRows = summaries.filter((row) =>
    row.state === 'needs_lead_review'
    || row.state.startsWith('failed_'),
  );

  let currentItem: DraftingItemSummary | null = null;
  let previousId: string | null = null;
  let nextId: string | null = null;
  if (options.itemId) {
    const idx = summaries.findIndex((row) => row.id === options.itemId);
    if (idx >= 0) {
      currentItem = summaries[idx];
      previousId = idx > 0 ? summaries[idx - 1].id : null;
      nextId = idx < summaries.length - 1 ? summaries[idx + 1].id : null;
    }
  }

  const { rows: sendAgg } = await dbQuery<{
    sent: number;
    delivered: number;
    opened: number;
    replied: number;
    bounced: number;
    pending_send: number;
    non_live_approved: number;
    non_live_sendable: number;
  }>(
    `SELECT
       count(*) FILTER (WHERE s.status = 'sent')::int AS sent,
       count(*) FILTER (WHERE s.delivered_at IS NOT NULL)::int AS delivered,
       count(*) FILTER (WHERE s.opened_at IS NOT NULL)::int AS opened,
       count(*) FILTER (WHERE s.replied_at IS NOT NULL)::int AS replied,
       count(*) FILTER (WHERE s.bounced_at IS NOT NULL)::int AS bounced,
       count(*) FILTER (
         WHERE i.state IN ('ready_for_review', 'approved')
           AND d.drafting_item_id IS NOT NULL
           AND coalesce(s.status, '') NOT IN ('sent', 'queued', 'sending')
           AND NOT EXISTS (
             SELECT 1
               FROM outreach.email_send_queue q
              WHERE q.drafting_item_id = i.id
                AND q.status IN ('queued', 'sending')
           )
           AND NOT EXISTS (
             SELECT 1
               FROM jsonb_array_elements(coalesce(d.lint_result -> 'hard', '[]'::jsonb)) AS finding
              WHERE finding->>'code' = 'OVERLOADED_SENTENCE'
           )
       )::int AS pending_send,
       count(*) FILTER (
         WHERE i.state = 'approved' AND d.generation_mode IN ('stub', 'legacy')
       )::int AS non_live_approved,
       count(*) FILTER (
         WHERE i.state IN ('generated', 'approved', 'sent')
           AND d.generation_mode IN ('stub', 'legacy')
       )::int AS non_live_sendable
     FROM outreach.drafting_items i
     LEFT JOIN outreach.email_drafts d ON d.drafting_item_id = i.id
     LEFT JOIN LATERAL (
       SELECT status, delivered_at, opened_at, replied_at, bounced_at
         FROM outreach.email_sends es
        WHERE es.drafting_item_id = i.id
        ORDER BY es.created_at DESC
        LIMIT 1
     ) s ON true
     WHERE i.workspace_id = $1 AND i.removed_at IS NULL AND i.state <> 'removed'`,
    [workspace.id],
  ).catch(async () => {
    // Fallback when email_sends shape differs — page-local counts.
    return {
      rows: [{
        sent: summaries.filter((row) => row.draft?.send_status === 'sent').length,
        delivered: summaries.filter((row) => row.draft?.delivered_at).length,
        opened: summaries.filter((row) => row.draft?.opened_at).length,
        replied: summaries.filter((row) => row.draft?.replied_at).length,
        bounced: summaries.filter((row) => row.draft?.bounced_at).length,
        pending_send: summaries.filter(
          (row) => row.draft
            && isReadyForBulkSend({
              state: row.state,
              retrySuggested: row.draft.retry_suggested,
              sendStatus: row.draft.send_status,
            }),
        ).length,
        non_live_approved: items.filter((item) => {
          if (item.state !== 'approved') return false;
          const mode = drafts.get(item.id)?.generation_mode;
          return mode === 'stub' || mode === 'legacy';
        }).length,
        non_live_sendable: items.filter((item) => {
          if (!isDraftedState(item.state as DraftingItemState)) return false;
          const mode = drafts.get(item.id)?.generation_mode;
          return mode === 'stub' || mode === 'legacy';
        }).length,
      }],
    };
  });
  const sentCount = sendAgg[0]?.sent ?? 0;
  const deliveredCount = sendAgg[0]?.delivered ?? 0;
  const openedCount = sendAgg[0]?.opened ?? 0;
  const repliedCount = sendAgg[0]?.replied ?? 0;
  const bouncedCount = sendAgg[0]?.bounced ?? 0;
  const sendConfigured = isEmailSendConfigured();
  const pendingSendCount = sendAgg[0]?.pending_send ?? 0;
  const nonLiveApproved = (sendAgg[0]?.non_live_approved ?? 0) > 0;
  const nonLiveSendable = (sendAgg[0]?.non_live_sendable ?? 0) > 0;
  const exportAvailable = counters.approved > 0 && !nonLiveApproved;
  const blockingReasons: string[] = [];
  if (counters.approved === 0) {
    blockingReasons.push('Download at least one draft to export');
  } else if (nonLiveApproved) {
    blockingReasons.push(
      'Stub/legacy drafts cannot be exported — regenerate with DRAFTING_MODE=live',
    );
  }
  const sendBlockingReasons: string[] = [];
  if (!sendConfigured) {
    sendBlockingReasons.push('Add AGENT_MAIL_API to .env.local to enable sending');
  } else if (nonLiveSendable) {
    sendBlockingReasons.push(
      'Stub/legacy drafts cannot be sent — regenerate with DRAFTING_MODE=live',
    );
  } else if (pendingSendCount === 0) {
    sendBlockingReasons.push('No ready drafts to send (retry-suggested drafts are skipped)');
  }
  const sendAvailable = sendConfigured
    && !nonLiveSendable
    && pendingSendCount > 0;

  const activity = await loadWorkspaceActivity(workspace.id, counters.running);
  // Dynamic import avoids a runtime cycle (rescue → reconcileDraftingWorkspaceQueue).
  const { resolveRescueForUi } = await import('@/lib/drafting/rescue');
  const rescue = await resolveRescueForUi(campaignId, ownerId, workspace.id);
  const queueStats = await ownerQueueStats(ownerId);

  return {
    workspace: {
      id: workspace.id,
      status: workspace.status,
      updated_at: workspace.updated_at,
      generation_complete: generationComplete,
      review_complete: reviewComplete,
      paused: workspace.status === 'paused',
      paused_at: workspace.paused_at,
    },
    activity,
    counts: {
      total: allStates.length,
      mailbox_valid_total: counters.mailboxValidTotal,
      running: counters.running,
      generated: counters.generated,
      approved: counters.approved,
      waiting_for_enrichment: counters.waitingForEnrichment,
      verifying_mailbox: counters.verifying,
      leads_attention: counters.leadsAttention,
      budget_paused: counters.budgetPaused,
      failed: counters.failed,
      sent: sentCount,
      delivered: deliveredCount,
      opened: openedCount,
      replied: repliedCount,
      bounced: bouncedCount,
    },
    progress: {
      generated: counters.generated,
      mailbox_valid_total: counters.mailboxValidTotal,
      reviewed: counters.approved,
      generated_for_review: counters.generated,
    },
    current_item: currentItem,
    neighbors: { previous_item_id: previousId, next_item_id: nextId },
    email_rows: emailRows,
    leads_rows: leadsRows,
    attention_rows: attentionRows,
    exports: {
      available: exportAvailable,
      blocking_reasons: blockingReasons,
    },
    sends: {
      configured: sendConfigured,
      available: sendAvailable,
      blocking_reasons: sendBlockingReasons,
      pending: pendingSendCount,
      today_remaining: queueStats.today_remaining,
      queued_count: queueStats.queued_count,
      next_schedule_date: queueStats.next_schedule_date,
    },
    rescue,
  };
}

// ── Start / resume drafting ─────────────────────────────────────────────────

/**
 * Upsert all campaign_leads into an existing drafting workspace and queue
 * research for newly eligible idle items. Does not create the workspace.
 * When the workspace is paused, items are still upserted but jobs are not
 * dispatched (matches reconcile pause behavior).
 */
export async function syncCampaignLeadsIntoDraftingWorkspace(
  campaignId: string,
  ownerId: string,
  input: {
    trigger?: SyncDraftingLeadsTrigger;
    idempotencyKey: string;
    budgetCapUsd?: string;
    senderProfileId?: string;
  },
): Promise<SyncDraftingLeadsResult> {
  await assertCampaignOwned(campaignId, ownerId);

  const workspace = await getOwnedWorkspace(campaignId, ownerId);
  if (!workspace) {
    throw new DraftingNotFoundError('Drafting workspace not found');
  }

  const trigger: SyncDraftingLeadsTrigger = input.trigger ?? 'retry';
  const sender = await resolveSenderProfile(
    ownerId,
    input.senderProfileId ?? workspace.sender_profile_id ?? undefined,
  );
  const assets = await loadDraftingAssets();
  const budgetLimit = input.budgetCapUsd ?? process.env.DRAFTING_DEFAULT_BATCH_BUDGET_USD ?? '50.0000';
  const projected = estimateResearchCost();
  const workspacePaused = !shouldDispatchJobsAfterLeadSync(workspace.status);

  const result = await dbTransaction(async (client) => {
    if (trigger === 'go_to_drafting') {
      const existingRun = await client.query<{ id: string }>(
        `SELECT id FROM outreach.drafting_runs
         WHERE triggered_by = $1 AND idempotency_key = $2`,
        [ownerId, input.idempotencyKey],
      );
      if (existingRun.rows[0]) {
        throw new DraftingConflictError('Idempotent drafting run already exists', 'idempotency_collision');
      }
    }

    const run = await client.query<{ id: string; inserted: boolean }>(
      `INSERT INTO outreach.drafting_runs (
         workspace_id, triggered_by, trigger, idempotency_key, target_count,
         projected_cost_low_usd, projected_cost_high_usd, budget_limit_usd
       ) VALUES ($1, $2, $3, $4, 0, $5::numeric, $6::numeric, $7::numeric)
       ON CONFLICT (triggered_by, idempotency_key) DO UPDATE
         SET target_count = outreach.drafting_runs.target_count
       RETURNING id, (xmax = 0) AS inserted`,
      [
        workspace.id,
        ownerId,
        trigger,
        input.idempotencyKey,
        projected.lowUsd,
        projected.highUsd,
        budgetLimit,
      ],
    );
    const draftingRunId = run.rows[0].id;

    const leads = await client.query<{
      lead_id: string;
      first_name: string | null;
      last_name: string | null;
      email_primary: string | null;
      title: string | null;
      company_name: string | null;
      location: string | null;
      linkedin_url: string | null;
      email_status: string;
      email_verification: string | null;
      relationship_snapshot: Record<string, unknown> | null;
      extra_fields: Record<string, string> | null;
      latest_run_id: string | null;
      latest_run_status: string | null;
    }>(
      `SELECT cl.lead_id, l.first_name, l.last_name, l.email_primary, l.title, l.company_name,
              l.location, l.linkedin_url, l.email_status, l.email_verification,
              cl.relationship_snapshot, cl.extra_fields,
              lr.id AS latest_run_id, lr.status AS latest_run_status
       FROM outreach.campaign_leads cl
       JOIN outreach.leads l ON l.id = cl.lead_id
       LEFT JOIN outreach.runs lr ON lr.id = cl.run_id
       WHERE cl.campaign_id = $1
       ORDER BY l.last_name NULLS LAST, l.first_name NULLS LAST, cl.lead_id`,
      [campaignId],
    );

    let createdItems = 0;
    let queuedItems = 0;
    let waitingForEnrichment = 0;
    let verifyingMailbox = 0;
    let leadsAttention = 0;
    let mailboxValidTotal = 0;
    const pendingJobs: Array<{ id: string; kind: string; attempt_count: number }> = [];

    for (const [index, lead] of leads.rows.entries()) {
      const snapshot = buildInputSnapshotFromLead({
        lead,
        relationship_snapshot: lead.relationship_snapshot,
        extra_fields: lead.extra_fields,
        source_run_id: lead.latest_run_id,
        sender,
        assetVersions: {
          skillVersion: assets.versions.skillVersion,
          skillSha256: assets.versions.skillSha256,
          subjectLineVersion: assets.versions.subjectLineVersion,
          subjectLineSha256: assets.versions.subjectLineSha256,
          positioningVersion: assets.versions.positioningVersion,
          positioningSha256: assets.versions.positioningSha256,
          capabilityCatalogVersion: assets.versions.capabilityCatalogVersion,
          capabilityCatalogSha256: assets.versions.capabilityCatalogSha256,
        },
      });
      const effective = buildEffectiveLeadFields(snapshot);
      const missing = missingRequiredFields(effective);
      const delivery = deliveryFromLeadVerification(
        lead.email_primary,
        lead.email_verification,
        lead.email_status,
      );
      const mailboxDraftable = isMailboxDraftable(delivery);

      let state: DraftingItemState = 'needs_lead_review';
      if (lead.latest_run_status && lead.latest_run_status !== 'complete') {
        state = 'waiting_for_enrichment';
        waitingForEnrichment += 1;
      } else if (!mailboxDraftable || missing.length > 0) {
        state = 'needs_lead_review';
        leadsAttention += 1;
      } else if (mailboxDraftable) {
        state = 'queued_research';
      }
      if (mailboxDraftable) mailboxValidTotal += 1;

      const fingerprint = inputFingerprint(snapshot);
      const inserted = await client.query<{ id: string; state: DraftingItemState }>(
        `INSERT INTO outreach.drafting_items (
           workspace_id, lead_id, source_campaign_lead_run_id, ordinal, state,
           input_snapshot, missing_fields, input_fingerprint, input_revision, delivery_snapshot
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 1, $9::jsonb)
         ON CONFLICT (workspace_id, lead_id) DO UPDATE
           SET input_snapshot = EXCLUDED.input_snapshot,
               missing_fields = EXCLUDED.missing_fields,
               input_fingerprint = EXCLUDED.input_fingerprint,
               delivery_snapshot = EXCLUDED.delivery_snapshot,
               -- Promote idle items that are now draftable+complete. Never
               -- clobber an in-flight or already-generated state.
               state = CASE
                 WHEN outreach.drafting_items.state IN (
                   'needs_lead_review', 'waiting_for_enrichment', 'budget_paused',
                   'failed_research', 'failed_write', 'failed_rewrite'
                 ) AND EXCLUDED.state = 'queued_research'
                   THEN EXCLUDED.state
                 ELSE outreach.drafting_items.state
               END,
               updated_at = now()
         RETURNING id, state`,
        [
          workspace.id,
          lead.lead_id,
          lead.latest_run_id,
          index + 1,
          state,
          JSON.stringify(snapshot),
          missing,
          fingerprint,
          JSON.stringify(delivery),
        ],
      );
      const itemId = inserted.rows[0].id;
      const persistedState = inserted.rows[0].state;
      createdItems += 1;

      await client.query(
        `INSERT INTO outreach.drafting_run_items (drafting_run_id, drafting_item_id, source_enrichment_run_id, authorization_state)
         VALUES ($1, $2, $3, 'queued')
         ON CONFLICT (drafting_run_id, drafting_item_id) DO NOTHING`,
        [draftingRunId, itemId, lead.latest_run_id],
      );

      // Paused workspaces still upsert items but do not enqueue research jobs.
      if (!workspacePaused && persistedState === 'queued_research') {
        const active = await client.query<{ id: string }>(
          `SELECT id FROM outreach.drafting_jobs
            WHERE drafting_item_id = $1
              AND status IN ('pending', 'in_flight')
            LIMIT 1`,
          [itemId],
        );
        if (!active.rows[0]) {
          const rampSeconds = campaignRampDelayMs(pendingJobs.length) / 1000;
          const job = await client.query<{ id: string; kind: string; attempt_count: number }>(
            `INSERT INTO outreach.drafting_jobs (
               drafting_run_id, drafting_item_id, kind, idempotency_key,
               expected_input_fingerprint, status, next_attempt_at
             ) VALUES ($1, $2, 'research', $3, $4, 'pending', now() + make_interval(secs => $5::double precision))
             ON CONFLICT (idempotency_key) DO UPDATE SET
               drafting_run_id = EXCLUDED.drafting_run_id,
               expected_input_fingerprint = EXCLUDED.expected_input_fingerprint,
               status = CASE
                 WHEN outreach.drafting_jobs.status IN ('failed', 'cancelled', 'superseded', 'done')
                   THEN 'pending'
                 ELSE outreach.drafting_jobs.status
               END,
               attempt_count = CASE
                 WHEN outreach.drafting_jobs.status IN ('failed', 'cancelled', 'superseded', 'done')
                   THEN 0
                 ELSE outreach.drafting_jobs.attempt_count
               END,
               execution_epoch = CASE
                 WHEN outreach.drafting_jobs.status IN ('failed', 'cancelled', 'superseded', 'done')
                   THEN outreach.drafting_jobs.execution_epoch + 1
                 ELSE outreach.drafting_jobs.execution_epoch
               END,
               claimed_at = CASE
                 WHEN outreach.drafting_jobs.status IN ('failed', 'cancelled', 'superseded', 'done')
                   THEN NULL
                 ELSE outreach.drafting_jobs.claimed_at
               END,
               finished_at = CASE
                 WHEN outreach.drafting_jobs.status IN ('failed', 'cancelled', 'superseded', 'done')
                   THEN NULL
                 ELSE outreach.drafting_jobs.finished_at
               END,
               next_attempt_at = CASE
                 WHEN outreach.drafting_jobs.status IN ('failed', 'cancelled', 'superseded', 'done')
                   THEN now() + make_interval(secs => $5::double precision)
                 ELSE outreach.drafting_jobs.next_attempt_at
               END
             RETURNING id, kind, attempt_count`,
            [
              draftingRunId,
              itemId,
              `research:${itemId}:${fingerprint}`,
              fingerprint,
              rampSeconds,
            ],
          );
          if (job.rows[0]) {
            pendingJobs.push(job.rows[0]);
            queuedItems += 1;
          }
        } else {
          queuedItems += 1;
        }
      }
    }

    await client.query(
      `UPDATE outreach.drafting_runs SET target_count = $2 WHERE id = $1`,
      [draftingRunId, queuedItems],
    );

    return {
      draftingRunId,
      createdItems,
      mailboxValidTotal,
      queuedItems,
      waitingForEnrichment,
      verifyingMailbox,
      leadsAttention,
      pendingJobs,
    };
  });

  let transportWarning: string | undefined;
  console.info('[drafting_lead_sync]', JSON.stringify({
    event: 'sync_complete',
    campaignId,
    workspaceId: workspace.id,
    createdItems: result.createdItems,
    queuedItems: result.queuedItems,
    pendingJobs: result.pendingJobs.length,
    at: new Date().toISOString(),
  }));
  if (!workspacePaused) {
    try {
      if (result.pendingJobs.length > 0) {
        for (let i = 0; i < result.pendingJobs.length; i += LEAD_SYNC_CHUNK) {
          const slice = result.pendingJobs.slice(i, i + LEAD_SYNC_CHUNK);
          await dispatchDraftingJobs(slice.map((job) => ({
            id: job.id,
            kind: job.kind as DraftingJobKind,
            attempt_count: job.attempt_count,
          })));
          console.info('[drafting_lead_sync]', JSON.stringify({
            event: 'dispatch_chunk',
            campaignId,
            offset: i,
            count: slice.length,
            at: new Date().toISOString(),
          }));
        }
      } else {
        await dispatchDraftingRunStarted(result.draftingRunId);
      }
    } catch (error) {
      transportWarning = error instanceof Error ? error.message : 'Job transport unavailable';
    }

    try {
      const reconciled = await reconcileDraftingWorkspaceQueue({
        workspaceId: workspace.id,
        ownerId,
        trigger: trigger === 'go_to_drafting' ? 'go_to_drafting' : 'retry',
        idempotencyKey: `reconcile-${trigger}:${workspace.id}:${input.idempotencyKey}`,
      });
      if (reconciled.queued > 0) {
        result.queuedItems += reconciled.queued;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Drafting reconcile failed';
      transportWarning = transportWarning ? `${transportWarning}; ${message}` : message;
    }
  }

  return {
    workspace_id: workspace.id,
    drafting_run_id: result.draftingRunId,
    created_items: result.createdItems,
    mailbox_valid_total: result.mailboxValidTotal,
    queued_items: result.queuedItems,
    waiting_for_enrichment: result.waitingForEnrichment,
    verifying_mailbox: result.verifyingMailbox,
    leads_attention: result.leadsAttention,
    ...(transportWarning ? { transport_warning: transportWarning } : {}),
  };
}

export async function startDraftingWorkspace(
  campaignId: string,
  ownerId: string,
  input: {
    senderProfileId?: string;
    budgetCapUsd?: string;
    idempotencyKey?: string;
  },
): Promise<StartDraftingResult> {
  await assertCampaignOwned(campaignId, ownerId);

  const campaign = await dbQuery<{ id: string; status: string; name: string }>(
    `SELECT id, status, name FROM outreach.campaigns WHERE id = $1 AND owner_id = $2`,
    [campaignId, ownerId],
  );
  if (!campaign.rows[0]) throw new DraftingNotFoundError('Campaign not found');
  if (campaign.rows[0].status !== 'active') {
    throw new DraftingValidationError('Campaign must be active to start drafting');
  }

  const existingWorkspace = await dbQuery<{ status: string }>(
    `SELECT status FROM outreach.drafting_workspaces WHERE campaign_id = $1`,
    [campaignId],
  );
  if (existingWorkspace.rows[0]?.status === 'paused') {
    throw new DraftingValidationError(
      'Drafting workspace is paused — click Resume on the Draft page to continue',
    );
  }

  // If enrichment already burned AgentMail rate limits, fail-open remaining
  // pending/null verifications so this start queues research — not more probes.
  {
    const {
      failOpenRemainingMailboxVerificationsForRun,
      runHasMailboxRateLimit,
    } = await import('@/lib/mailbox-verify');
    const runRows = await dbQuery<{ run_id: string }>(
      `SELECT DISTINCT run_id
         FROM outreach.campaign_leads
        WHERE campaign_id = $1 AND run_id IS NOT NULL`,
      [campaignId],
    );
    for (const row of runRows.rows) {
      if (await runHasMailboxRateLimit(row.run_id)) {
        await failOpenRemainingMailboxVerificationsForRun(row.run_id);
      }
    }
  }

  const sender = await resolveSenderProfile(ownerId, input.senderProfileId);
  const assets = await loadDraftingAssets();
  const idempotencyKey = input.idempotencyKey ?? randomUUID();
  const budgetLimit = input.budgetCapUsd ?? process.env.DRAFTING_DEFAULT_BATCH_BUDGET_USD ?? '50.0000';
  const projected = estimateResearchCost();

  await dbTransaction(async (client) => {
    await client.query<DraftingWorkspaceRow>(
      `INSERT INTO outreach.drafting_workspaces (
         campaign_id, created_by, sender_profile_id, last_started_at,
         skill_version, skill_sha256, positioning_version, positioning_sha256,
         capability_catalog_version, capability_catalog_sha256
       )
       VALUES ($1, $2, $3, now(), $4, $5, $6, $7, $8, $9)
       ON CONFLICT (campaign_id) DO UPDATE
         SET sender_profile_id = EXCLUDED.sender_profile_id,
             last_started_at = now(),
             skill_version = EXCLUDED.skill_version,
             skill_sha256 = EXCLUDED.skill_sha256,
             positioning_version = EXCLUDED.positioning_version,
             positioning_sha256 = EXCLUDED.positioning_sha256,
             capability_catalog_version = EXCLUDED.capability_catalog_version,
             capability_catalog_sha256 = EXCLUDED.capability_catalog_sha256,
             updated_at = now()
       RETURNING id, campaign_id, status, updated_at, generation_completed_at,
                 review_completed_at, sender_profile_id`,
      [
        campaignId,
        ownerId,
        sender.id,
        assets.versions.skillVersion,
        assets.versions.skillSha256,
        assets.versions.positioningVersion,
        assets.versions.positioningSha256,
        assets.versions.capabilityCatalogVersion,
        assets.versions.capabilityCatalogSha256,
      ],
    );
  });

  const synced = await syncCampaignLeadsIntoDraftingWorkspace(campaignId, ownerId, {
    trigger: 'go_to_drafting',
    idempotencyKey,
    budgetCapUsd: budgetLimit,
    senderProfileId: sender.id,
  });

  return {
    workspace_id: synced.workspace_id,
    drafting_run_id: synced.drafting_run_id,
    created_items: synced.created_items,
    mailbox_valid_total: synced.mailbox_valid_total,
    queued_items: synced.queued_items,
    waiting_for_enrichment: synced.waiting_for_enrichment,
    verifying_mailbox: synced.verifying_mailbox,
    leads_attention: synced.leads_attention,
    already_current: 0,
    projected_cost: { low_usd: projected.lowUsd, high_usd: projected.highUsd },
    budget: { limit_usd: budgetLimit, paused_items: 0 },
    href: `/campaigns/${campaignId}/draft`,
    ...(synced.transport_warning ? { transport_warning: synced.transport_warning } : {}),
  };
}

// ── Item mutations ──────────────────────────────────────────────────────────

const INPUT_FIELD_ALLOWLIST = new Set([
  'email',
  'fullName',
  'company',
  'title',
  'workLocation',
  'connectingContext',
]);

export async function updateDraftingItemInput(
  itemId: string,
  ownerId: string,
  input: {
    expectedRevision: number;
    fields: Record<string, unknown>;
  },
): Promise<{
  item: DraftingItemSummary;
  can_approve_for_drafting: boolean;
}> {
  const { item } = await getOwnedItemContext(itemId, ownerId);
  if (Number(item.input_revision) !== input.expectedRevision) {
    throw new DraftingConflictError('Input revision conflict', 'revision_conflict');
  }

  const overrides: InputOverrides = { ...item.input_overrides };
  for (const [key, value] of Object.entries(input.fields)) {
    if (!INPUT_FIELD_ALLOWLIST.has(key)) {
      throw new DraftingValidationError(`Field not allowed: ${key}`);
    }
    if (key === 'connectingContext' && value && typeof value === 'object') {
      overrides.connectingContext = value as InputOverrides['connectingContext'];
      continue;
    }
    if (['email', 'fullName', 'company', 'title', 'workLocation'].includes(key)) {
      const normalized = value == null || value === ''
        ? null
        : normalizeRequiredField(String(value));
      if (key === 'email') {
        overrides.email = normalizeEmail(String(value));
      } else if (key === 'fullName') {
        overrides.fullName = normalized;
      } else if (key === 'company') {
        overrides.company = normalized;
      } else if (key === 'title') {
        overrides.title = normalized;
      } else if (key === 'workLocation') {
        overrides.workLocation = normalized;
      }
    }
  }

  const effective = buildEffectiveLeadFields(item.input_snapshot, overrides);
  const missing = missingRequiredFields(effective);
  const fingerprint = inputFingerprint(item.input_snapshot, overrides);
  const delivery = parseDeliverySnapshot(item.delivery_snapshot);

  const { rows } = await dbQuery<DbDraftingItemRow>(
    `UPDATE outreach.drafting_items
     SET input_overrides = $2::jsonb,
         missing_fields = $3,
         input_fingerprint = $4,
         input_revision = input_revision + 1,
         empty_brief_attempts = CASE
           WHEN input_fingerprint IS DISTINCT FROM $4 THEN 0
           ELSE empty_brief_attempts
         END,
         empty_brief_input_fingerprint = CASE
           WHEN input_fingerprint IS DISTINCT FROM $4 THEN NULL
           ELSE empty_brief_input_fingerprint
         END,
         empty_brief_last_at = CASE
           WHEN input_fingerprint IS DISTINCT FROM $4 THEN NULL
           ELSE empty_brief_last_at
         END,
         last_error_code = CASE
           WHEN input_fingerprint IS DISTINCT FROM $4
                AND last_error_code = $5 THEN NULL
           ELSE last_error_code
         END,
         updated_at = now()
     WHERE id = $1
     RETURNING id, workspace_id, lead_id, ordinal, state, input_snapshot, input_overrides,
               missing_fields, input_fingerprint, input_revision, delivery_snapshot,
               review_status, removed_at, last_error_code, empty_brief_attempts,
               empty_brief_input_fingerprint, empty_brief_last_at`,
    [
      itemId,
      JSON.stringify(overrides),
      missing,
      fingerprint,
      EMPTY_RESEARCH_BRIEF_ERROR_CODE,
    ],
  );

  const updated = rows[0];
  const draft = await loadDraftForItem(itemId);
  const summary = summarizeItem(updated, draft);
  return {
    item: summary,
    can_approve_for_drafting: canApproveIdleDraftingItem({
      state: updated.state,
      missingFieldCount: missing.length,
    }),
  };
}

export async function removeDraftingItem(
  itemId: string,
  ownerId: string,
  input: { expectedRevision: number; confirm?: boolean },
): Promise<{ removed: boolean }> {
  if (!input.confirm) {
    throw new DraftingValidationError('Explicit confirmation is required to remove a lead');
  }
  const { item, campaignId } = await getOwnedItemContext(itemId, ownerId);
  if (Number(item.input_revision) !== input.expectedRevision) {
    throw new DraftingConflictError('Input revision conflict', 'revision_conflict');
  }
  if (item.state === 'removed' || item.removed_at) {
    return { removed: true };
  }

  await dbTransaction(async (client) => {
    await client.query(
      `DELETE FROM outreach.campaign_leads
       WHERE campaign_id = $1 AND lead_id = $2`,
      [campaignId, item.lead_id],
    );
    await client.query(
      `UPDATE outreach.drafting_items
       SET state = 'removed',
           removed_at = now(),
           removed_by = $2,
           updated_at = now()
       WHERE id = $1`,
      [itemId, ownerId],
    );
    await client.query(
      `UPDATE outreach.drafting_jobs
       SET status = 'cancelled', finished_at = now()
       WHERE drafting_item_id = $1 AND status IN ('pending', 'in_flight')`,
      [itemId],
    );
  });

  return { removed: true };
}

export async function approveDraftingLead(
  itemId: string,
  ownerId: string,
  input: {
    expectedRevision: number;
    idempotencyKey?: string;
    retryReason?: string;
    retrySurface?: 'lead_approval';
  },
): Promise<{
  verification_state: 'pending' | 'valid';
  job_id?: string;
}> {
  const { item } = await getOwnedItemContext(itemId, ownerId);
  if (Number(item.input_revision) !== input.expectedRevision) {
    throw new DraftingConflictError('Input revision conflict', 'revision_conflict');
  }

  const effective = buildEffectiveLeadFields(item.input_snapshot, item.input_overrides);
  const missing = missingRequiredFields(effective);
  if (missing.length > 0) {
    throw new DraftingValidationError('All required fields must be complete before approval', {
      missing_fields: missing.join(', '),
    });
  }

  const delivery = parseDeliverySnapshot(item.delivery_snapshot);
  const idempotencyKey = input.idempotencyKey ?? randomUUID();
  const mailboxDraftable = isMailboxDraftable(delivery);
  const manualEmptyBriefRetry = isEmptyBriefQuarantined(
    {
      attempts: Number(item.empty_brief_attempts),
      inputFingerprint: item.empty_brief_input_fingerprint,
      lastErrorCode: item.last_error_code,
    },
    item.input_fingerprint ?? '',
  );
  const jobKind: DraftingJobKind = mailboxDraftable ? 'research' : 'verify_mailbox';
  const jobIdempotencyKey = mailboxDraftable
    ? `approve-research:${itemId}:${idempotencyKey}`
    : `approve-verify:${itemId}:${idempotencyKey}`;

  const result = await dbTransaction(async (client) => {
    const workspace = await client.query<{ id: string }>(
      `SELECT id FROM outreach.drafting_workspaces WHERE id = $1 FOR UPDATE`,
      [item.workspace_id],
    );

    const run = await client.query<{ id: string }>(
      `INSERT INTO outreach.drafting_runs (
         workspace_id, triggered_by, trigger, idempotency_key, target_count, budget_limit_usd
       ) VALUES ($1, $2, 'lead_approval', $3, 1, coalesce($4::numeric, 5.0000))
       ON CONFLICT (triggered_by, idempotency_key) DO UPDATE
         SET target_count = outreach.drafting_runs.target_count
       RETURNING id`,
      [
        workspace.rows[0].id,
        ownerId,
        idempotencyKey,
        process.env.DRAFTING_DEFAULT_BATCH_BUDGET_USD ?? '50.0000',
      ],
    );
    const draftingRunId = run.rows[0].id;

    // Revive terminal jobs with the same approval key so "Approve again" retries
    // after a failed research/verify without colliding on the unique index.
    const job = await client.query<{ id: string; kind: string; attempt_count: number }>(
      `INSERT INTO outreach.drafting_jobs (
         drafting_run_id, drafting_item_id, kind, idempotency_key,
         expected_input_fingerprint, usage, status
       ) VALUES ($1, $2, $3, $4, $5, '{"emptyBriefSurface":"manual"}'::jsonb, 'pending')
       ON CONFLICT (idempotency_key) DO UPDATE SET
         drafting_run_id = EXCLUDED.drafting_run_id,
         kind = EXCLUDED.kind,
         expected_input_fingerprint = EXCLUDED.expected_input_fingerprint,
         usage = outreach.drafting_jobs.usage || jsonb_build_object(
           'latestRevival', EXCLUDED.usage,
           'revivedAt', now()
         ),
         status = CASE
           WHEN outreach.drafting_jobs.status IN ('failed', 'cancelled', 'superseded', 'done')
             THEN 'pending'
           ELSE outreach.drafting_jobs.status
         END,
         attempt_count = CASE
           WHEN outreach.drafting_jobs.status IN ('failed', 'cancelled', 'superseded', 'done')
             THEN 0
           ELSE outreach.drafting_jobs.attempt_count
         END,
         execution_epoch = CASE
           WHEN outreach.drafting_jobs.status IN ('failed', 'cancelled', 'superseded', 'done')
             THEN outreach.drafting_jobs.execution_epoch + 1
           ELSE outreach.drafting_jobs.execution_epoch
         END,
         claimed_at = CASE
           WHEN outreach.drafting_jobs.status IN ('failed', 'cancelled', 'superseded', 'done')
             THEN NULL
           ELSE outreach.drafting_jobs.claimed_at
         END,
         heartbeat_at = CASE
           WHEN outreach.drafting_jobs.status IN ('failed', 'cancelled', 'superseded', 'done')
             THEN NULL
           ELSE outreach.drafting_jobs.heartbeat_at
         END,
         finished_at = CASE
           WHEN outreach.drafting_jobs.status IN ('failed', 'cancelled', 'superseded', 'done')
             THEN NULL
           ELSE outreach.drafting_jobs.finished_at
         END,
         last_error_code = CASE
           WHEN outreach.drafting_jobs.status IN ('failed', 'cancelled', 'superseded', 'done')
             THEN NULL
           ELSE outreach.drafting_jobs.last_error_code
         END,
         last_error_message = CASE
           WHEN outreach.drafting_jobs.status IN ('failed', 'cancelled', 'superseded', 'done')
             THEN NULL
           ELSE outreach.drafting_jobs.last_error_message
         END,
         next_attempt_at = now()
       RETURNING id, kind, attempt_count`,
      [
        draftingRunId,
        itemId,
        jobKind,
        jobIdempotencyKey,
        item.input_fingerprint,
      ],
    );

    await client.query(
      `UPDATE outreach.drafting_items
       SET state = $2,
           retry_audit = CASE WHEN $3::boolean
             THEN retry_audit || jsonb_build_array(jsonb_build_object(
               'actorId', $4::text,
               'at', now(),
               'oldFingerprint', $5::text,
               'newFingerprint', $6::text,
               'priorAttempts', $7::int,
               'reason', $8::text,
               'surface', $9::text
             ))
             ELSE retry_audit
           END,
           updated_at = now()
       WHERE id = $1`,
      [
        itemId,
        mailboxDraftable ? 'queued_research' : 'verifying_mailbox',
        manualEmptyBriefRetry,
        ownerId,
        item.empty_brief_input_fingerprint,
        item.input_fingerprint,
        Number(item.empty_brief_attempts),
        input.retryReason?.trim() || 'research_found_no_usable_personalization',
        input.retrySurface ?? 'lead_approval',
      ],
    );
    return {
      verification_state: mailboxDraftable ? ('valid' as const) : ('pending' as const),
      job: job.rows[0],
    };
  });

  await dispatchDraftingJobs([{
    id: result.job.id,
    kind: result.job.kind as DraftingJobKind,
    attempt_count: result.job.attempt_count,
  }]);
  return {
    verification_state: result.verification_state,
    job_id: result.job.id,
  };
}

// ── Draft mutations ─────────────────────────────────────────────────────────

export async function saveDraft(
  draftId: string,
  ownerId: string,
  input: {
    expectedContentRevision: number;
    expectedInputFingerprint?: string;
    subject?: string;
    bodyText?: string;
  },
): Promise<{
  content_revision: number;
  lint: LintResult;
  saved_at: string;
}> {
  const { item } = await getOwnedItemContext(draftId, ownerId);
  if (
    input.expectedInputFingerprint
    && item.input_fingerprint
    && input.expectedInputFingerprint !== item.input_fingerprint
  ) {
    throw new DraftingConflictError('Input fingerprint conflict', 'fingerprint_conflict');
  }

  const existing = await loadDraftForItem(draftId);
  const subject = input.subject ?? existing?.subject ?? '';
  const sender = item.input_snapshot.sender;
  const bodyText = stripTrailingTextSignature(
    normalizeDraftBody(input.bodyText ?? existing?.body_text ?? '', buildEffectiveLeadFields(item.input_snapshot, item.input_overrides).firstName),
    {
      displayName: sender.displayName,
      title: sender.title,
      companyName: sender.companyName?.trim() || 'Helios Group',
    },
  );
  const currentRevision = Number(existing?.content_revision ?? 0);

  if (existing && currentRevision !== input.expectedContentRevision) {
    throw new DraftingConflictError('Content revision conflict', 'revision_conflict');
  }

  const grounding = reconcileManualDraftGrounding(
    bodyText,
    existing
      ? resolvePersistedDraftGrounding(existing)
      : { usedFactIds: [], claimLedger: [] },
  );
  const { rows: packetRows } = await dbQuery<{ packet: DraftingResearchPacket }>(
    `SELECT packet
       FROM outreach.draft_research_packets
      WHERE drafting_item_id = $1`,
    [draftId],
  );
  const temporalAudit = packetRows[0]?.packet
    ? assessResearchTimeliness(packetRows[0].packet)
    : null;
  const baseLint = lintDraft(subject, bodyText);
  const combined = `${subject}\n${bodyText}`;
  const temporalLint = temporalAudit
    ? findDraftTimelinessFailures(subject, bodyText, temporalAudit, grounding).map((finding) => {
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
    })
    : [];
  const lint: LintResult = {
    hard: [...baseLint.hard, ...temporalLint],
    warnings: baseLint.warnings,
  };
  const nextRevision = currentRevision + 1;
  const fingerprint = item.input_fingerprint ?? inputFingerprint(item.input_snapshot, item.input_overrides);
  const canMarkReady = !hasBlockingHardLintFailures(lint);

  await dbTransaction(async (client) => {
    await client.query(
      `INSERT INTO outreach.email_drafts (
         drafting_item_id, input_fingerprint, research_packet_sha256, content_revision,
         subject, body_text, lint_result, used_fact_ids, claim_ledger, draft_grounding,
         temporal_status, temporal_audit,
         generation_mode, grounding_status, manually_edited, edited_by, edited_at
       ) VALUES (
         $1, $2, coalesce($3, ''), $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10::jsonb,
         $11, $12::jsonb, 'legacy', 'manual_override', true, $13, now()
       )
       ON CONFLICT (drafting_item_id) DO UPDATE
         SET subject = EXCLUDED.subject,
             body_text = EXCLUDED.body_text,
             content_revision = EXCLUDED.content_revision,
             lint_result = EXCLUDED.lint_result,
             used_fact_ids = EXCLUDED.used_fact_ids,
             claim_ledger = EXCLUDED.claim_ledger,
             draft_grounding = EXCLUDED.draft_grounding,
             temporal_status = EXCLUDED.temporal_status,
             temporal_audit = EXCLUDED.temporal_audit,
             grounding_status = 'manual_override',
             manually_edited = true,
             edited_by = EXCLUDED.edited_by,
             edited_at = now(),
             input_fingerprint = EXCLUDED.input_fingerprint,
             updated_at = now()`,
      [
        draftId,
        fingerprint,
        existing?.research_packet_sha256 ?? '',
        nextRevision,
        subject,
        bodyText,
        JSON.stringify(lint),
        grounding.usedFactIds,
        JSON.stringify({ entries: grounding.claimLedger }),
        JSON.stringify(grounding),
        temporalAudit?.status ?? existing?.temporal_status ?? 'blocked',
        JSON.stringify(temporalAudit ?? existing?.temporal_audit ?? {}),
        ownerId,
      ],
    );
    // Issue C: never promote (or keep promoting) hard-lint drafts to ready via save.
    if (canMarkReady) {
      const reviewStatus = syncReviewStatus('ready_for_review');
      await client.query(
        `UPDATE outreach.drafting_items
         SET state = 'ready_for_review',
             review_status = $2,
             draft_revision = draft_revision + 1,
             updated_at = now()
         WHERE id = $1`,
        [draftId, reviewStatus],
      );
    } else {
      await client.query(
        `UPDATE outreach.drafting_items
         SET draft_revision = draft_revision + 1,
             updated_at = now()
         WHERE id = $1`,
        [draftId],
      );
    }
  });

  return {
    content_revision: nextRevision,
    lint,
    saved_at: new Date().toISOString(),
  };
}

export async function approveDraft(
  draftId: string,
  ownerId: string,
  input: {
    expectedContentRevision: number;
    expectedInputFingerprint: string;
    expectedPacketSha256?: string;
  },
): Promise<{
  approved: boolean;
  counts: WorkspaceSnapshot['counts'];
}> {
  const { item, campaignId } = await getOwnedItemContext(draftId, ownerId);
  const draft = await loadDraftForItem(draftId);
  if (!draft) throw new DraftingNotFoundError('Draft not found');

  if (Number(draft.content_revision) !== input.expectedContentRevision) {
    throw new DraftingConflictError('Content revision conflict', 'revision_conflict');
  }
  if (draft.input_fingerprint !== input.expectedInputFingerprint) {
    throw new DraftingConflictError('Input fingerprint conflict', 'fingerprint_conflict');
  }
  if (
    input.expectedPacketSha256
    && draft.research_packet_sha256 !== input.expectedPacketSha256
  ) {
    throw new DraftingConflictError('Research packet hash conflict', 'packet_conflict');
  }

  const lint = draft.lint_result ?? lintDraft(draft.subject, draft.body_text);
  if (hasBlockingHardLintFailures(lint)) {
    throw new DraftingValidationError('Draft has hard lint failures');
  }
  if (!['ready_for_review', 'failed_write', 'failed_rewrite'].includes(item.state)) {
    throw new DraftingValidationError('Draft is not available for download');
  }
  await assertDraftTimelyNow(draft, { allowStubReview: true });

  await dbQuery(
    `UPDATE outreach.drafting_items
     SET state = 'approved',
         review_status = 'approved',
         reviewed_by = $2,
         reviewed_at = now(),
         updated_at = now()
     WHERE id = $1`,
    [draftId, ownerId],
  );

  const snapshot = await getWorkspaceSnapshot(campaignId, ownerId);
  return { approved: true, counts: snapshot.counts };
}

export async function requestDraftRewrite(
  draftId: string,
  ownerId: string,
  input: {
    expectedContentRevision: number;
    idempotencyKey?: string;
    feedback?: string;
  },
): Promise<{ job_id: string }> {
  const { item } = await getOwnedItemContext(draftId, ownerId);
  const draft = await loadDraftForItem(draftId);
  if (!draft) throw new DraftingNotFoundError('Draft not found');
  if (Number(draft.content_revision) !== input.expectedContentRevision) {
    throw new DraftingConflictError('Content revision conflict', 'revision_conflict');
  }
  if (input.feedback && input.feedback.length > 500) {
    throw new DraftingValidationError('Feedback is too long');
  }
  if (!['ready_for_review', 'failed_write', 'failed_rewrite', 'approved'].includes(item.state)) {
    throw new DraftingValidationError('Draft is not available for rewrite');
  }

  const idempotencyKey = input.idempotencyKey ?? randomUUID();
  const feedback = input.feedback?.trim() || null;
  const job = await dbTransaction(async (client) => {
    const run = await client.query<{ id: string }>(
      `INSERT INTO outreach.drafting_runs (
         workspace_id, triggered_by, trigger, idempotency_key, target_count, budget_limit_usd
       ) VALUES ($1, $2, 'rewrite', $3, 1, coalesce($4::numeric, 1.0000))
       RETURNING id`,
      [
        item.workspace_id,
        ownerId,
        idempotencyKey,
        process.env.DRAFTING_REWRITE_BUDGET_USD ?? '1.0000',
      ],
    );
    const inserted = await client.query<{ id: string; kind: string; attempt_count: number }>(
      `INSERT INTO outreach.drafting_jobs (
         drafting_run_id, drafting_item_id, kind, idempotency_key,
         expected_input_fingerprint, expected_draft_revision, status, usage
       ) VALUES ($1, $2, 'rewrite', $3, $4, $5, 'pending', $6::jsonb)
       RETURNING id, kind, attempt_count`,
      [
        run.rows[0].id,
        draftId,
        `rewrite:${draftId}:${idempotencyKey}`,
        item.input_fingerprint,
        draft.content_revision,
        JSON.stringify(feedback ? { rewriteFeedback: feedback } : {}),
      ],
    );
    await client.query(
      `UPDATE outreach.drafting_items
       SET state = 'queued_rewrite', updated_at = now()
       WHERE id = $1`,
      [draftId],
    );
    return inserted.rows[0];
  });

  await dispatchDraftingJobs([{
    id: job.id,
    kind: job.kind as DraftingJobKind,
    attempt_count: job.attempt_count,
  }]);
  return { job_id: job.id };
}

// ── Exports ─────────────────────────────────────────────────────────────────

/** Batch-load packets and revalidate timeliness with TTL reuse + one write txn. */
async function assertDraftsTimelyBatch(drafts: DbDraftRow[]): Promise<void> {
  if (drafts.length === 0) return;
  for (const draft of drafts) {
    assertDraftGenerationMode(draft.generation_mode);
  }
  const liveDrafts = drafts.filter((draft) => draft.generation_mode === 'live');
  if (liveDrafts.length === 0) return;

  const { rows: packets } = await dbQuery<{
    drafting_item_id: string;
    packet: DraftingResearchPacket;
  }>(
    `SELECT drafting_item_id, packet
       FROM outreach.draft_research_packets
      WHERE drafting_item_id = ANY($1::uuid[])`,
    [liveDrafts.map((draft) => draft.drafting_item_id)],
  );
  const packetByItem = new Map(packets.map((row) => [row.drafting_item_id, row.packet]));

  const toPersist: Array<{ itemId: string; audit: ResearchTimelinessAudit }> = [];
  const failureCodes = new Set<string>();

  for (const draft of liveDrafts) {
    const packet = packetByItem.get(draft.drafting_item_id);
    if (!packet) {
      failureCodes.add('MISSING_RESEARCH_PACKET');
      continue;
    }
    const cachedAudit = asResearchTimelinessAudit(draft.temporal_audit);
    let audit: ResearchTimelinessAudit;
    if (isFreshTemporalAudit(cachedAudit, packet.asOf)) {
      audit = cachedAudit!;
    } else {
      audit = assessResearchTimeliness(packet);
      toPersist.push({ itemId: draft.drafting_item_id, audit });
    }
    const findings = findDraftTimelinessFailures(
      draft.subject,
      draft.body_text,
      audit,
      resolvePersistedDraftGrounding(draft),
    );
    for (const finding of findings) failureCodes.add(finding.code);
  }

  if (toPersist.length > 0) {
    await dbTransaction(async (client) => {
      for (const entry of toPersist) {
        await persistTimelinessAudit(client, entry.itemId, entry.audit);
      }
    });
  }

  if (failureCodes.size > 0) {
    throw new DraftingTimelinessError([...failureCodes]);
  }
}

async function loadDraftExportRows(
  campaignId: string,
  ownerId: string,
  options: {
    approvedOnly: boolean;
    /** Optional timeliness gate (off for export and send). */
    requireTimeliness?: boolean;
  },
): Promise<{
  campaignName: string;
  rows: ApprovedDraftExportRow[];
  unresolvedLeads: number;
}> {
  const requireTimeliness = options.requireTimeliness ?? true;
  await assertCampaignOwned(campaignId, ownerId);
  const workspace = await getOwnedWorkspace(campaignId, ownerId);
  if (!workspace) throw new DraftingNotFoundError('Drafting workspace not found');

  const campaign = await dbQuery<{ name: string }>(
    `SELECT name FROM outreach.campaigns WHERE id = $1`,
    [campaignId],
  );

  const items = await loadWorkspaceItems(workspace.id);
  const candidates: Array<{
    item: DbDraftingItemRow;
    delivery: DeliverySnapshot | null;
  }> = [];
  let unresolvedLeads = 0;

  for (const item of items) {
    const delivery = parseDeliverySnapshot(item.delivery_snapshot);
    if (isLeadsModeRow(item.input_snapshot, delivery, item.input_overrides)) {
      unresolvedLeads += 1;
      continue;
    }
    if (options.approvedOnly) {
      if (item.state !== 'approved') continue;
    } else if (!isDraftedState(item.state as DraftingItemState)) {
      continue;
    }
    candidates.push({ item, delivery });
  }

  const drafts = await loadDraftsForItems(candidates.map((entry) => entry.item.id));
  const draftList = candidates
    .map((entry) => drafts.get(entry.item.id))
    .filter((draft): draft is DbDraftRow => Boolean(draft));

  if (requireTimeliness) {
    await assertDraftsTimelyBatch(draftList);
  }

  const rows: ApprovedDraftExportRow[] = [];
  for (const { item, delivery } of candidates) {
    const draft = drafts.get(item.id);
    if (!draft) continue;
    const lint = draft.lint_result ?? lintDraft(draft.subject, draft.body_text);
    rows.push(mapApprovedExportRow({
      itemId: item.id,
      ordinal: Number(item.ordinal),
      snapshot: item.input_snapshot,
      deliverySnapshot: delivery,
      state: item.state,
      reviewStatus: item.review_status,
      inputFingerprint: item.input_fingerprint ?? '',
      subject: draft.subject,
      bodyText: draft.body_text,
      draftInputFingerprint: draft.input_fingerprint,
      researchPacketSha256: draft.research_packet_sha256,
      draftResearchPacketSha256: draft.research_packet_sha256,
      contentRevision: Number(draft.content_revision),
      groundingStatus: draft.grounding_status,
      lintHardCount: lint.hard.filter((finding) => !isRetrySuggestedLintCode(finding.code)).length,
      retrySuggested: hasRetrySuggestedLint(lint),
    }));
  }

  rows.sort((a, b) => a.ordinal - b.ordinal);
  return {
    campaignName: campaign.rows[0]?.name ?? 'campaign',
    rows,
    unresolvedLeads,
  };
}

async function loadApprovedExportRows(campaignId: string, ownerId: string): Promise<{
  campaignName: string;
  rows: ApprovedDraftExportRow[];
  unresolvedLeads: number;
}> {
  // Export is intentionally more lenient than send: any drafted email, no timeliness gate.
  return loadDraftExportRows(campaignId, ownerId, {
    approvedOnly: false,
    requireTimeliness: false,
  });
}

async function loadSendableDraftRows(campaignId: string, ownerId: string): Promise<{
  campaignName: string;
  rows: ApprovedDraftExportRow[];
  unresolvedLeads: number;
}> {
  return loadDraftExportRows(campaignId, ownerId, {
    approvedOnly: false,
    requireTimeliness: false,
  });
}

export async function exportMailCsv(campaignId: string, ownerId: string) {
  const { campaignName, rows, unresolvedLeads } = await loadApprovedExportRows(campaignId, ownerId);
  const preflight = preflightFinalDraftExport(rows);
  if (!preflight.ok) {
    throw new DraftingExportBlockedError(preflight.blockers);
  }
  const { buildMailCsv, exportDateStamp, sanitizeCampaignFilename } = await import('@/lib/drafting/exports');
  const bytes = buildMailCsv(rows);
  return {
    bytes,
    filename: `${sanitizeCampaignFilename(campaignName)}-approved-drafts-${exportDateStamp()}.csv`,
    mime: 'text/csv; charset=utf-8',
    meta: { ...preflight.meta, unresolved_leads: unresolvedLeads },
  };
}

export async function exportCoworkMarkdown(campaignId: string, ownerId: string) {
  const { campaignName, rows, unresolvedLeads } = await loadApprovedExportRows(campaignId, ownerId);
  const preflight = preflightFinalDraftExport(rows);
  if (!preflight.ok) {
    throw new DraftingExportBlockedError(preflight.blockers);
  }
  const { buildCoworkMarkdown, exportDateStamp, sanitizeCampaignFilename } = await import('@/lib/drafting/exports');
  const sender = rows[0];
  const markdown = buildCoworkMarkdown({
    campaignName,
    senderName: sender.fromName,
    senderEmail: sender.fromEmail,
    rows,
  });
  return {
    bytes: new TextEncoder().encode(markdown),
    filename: `${sanitizeCampaignFilename(campaignName)}-cowork-draft-prompt-${exportDateStamp()}.md`,
    mime: 'text/markdown; charset=utf-8',
    meta: { ...preflight.meta, unresolved_leads: unresolvedLeads },
  };
}

export async function exportUnverifiedLeadsCsv(campaignId: string, ownerId: string) {
  await assertCampaignOwned(campaignId, ownerId);
  const workspace = await getOwnedWorkspace(campaignId, ownerId);
  if (!workspace) throw new DraftingNotFoundError('Drafting workspace not found');

  const campaign = await dbQuery<{ name: string }>(
    `SELECT name FROM outreach.campaigns WHERE id = $1`,
    [campaignId],
  );

  const items = await loadWorkspaceItems(workspace.id);
  const rows: UnverifiedLeadExportRow[] = [];

  for (const item of items) {
    const deliverySnapshot = parseDeliverySnapshot(item.delivery_snapshot);
    const inLeadsMode = isLeadsModeRow(item.input_snapshot, deliverySnapshot, item.input_overrides);
    if (!inLeadsMode) continue;
    if (deliverySnapshot && isMailboxDraftable(deliverySnapshot)) continue;

    const effective = buildEffectiveLeadFields(item.input_snapshot, item.input_overrides);
    const blockers: string[] = [];
    if (!effective.email) blockers.push('Missing email');
    if (!effective.fullName) blockers.push('Missing full name');
    if (!effective.company) blockers.push('Missing company');
    if (!effective.title) blockers.push('Missing title');
    if (!effective.workLocation) blockers.push('Missing location');

    const rawDelivery = item.delivery_snapshot as Record<string, unknown>;
    const mailboxStatus = typeof rawDelivery.emailVerification === 'string'
      ? rawDelivery.emailVerification
      : undefined;
    if (mailboxStatus && mailboxStatus !== 'valid') {
      blockers.push(`Mailbox ${mailboxVerificationLabel(mailboxStatus)}`);
    }
    const verifiedAt = typeof rawDelivery.verifiedAt === 'string' ? rawDelivery.verifiedAt : '';

    rows.push({
      fullName: effective.fullName ?? '',
      email: effective.email ?? '',
      company: effective.company ?? '',
      title: effective.title ?? '',
      location: effective.workLocation ?? '',
      mailboxVerification: mailboxVerificationLabel(mailboxStatus),
      draftingBlocker: blockers.join('; ') || 'Mailbox not verified valid',
      emailOrigin: formatEmailStatus(item.input_snapshot.lead.emailStatus ?? ''),
      verifiedAt,
    });
  }

  if (rows.length === 0) {
    throw new DraftingNotFoundError('No unverified leads available for export');
  }

  const { buildUnverifiedLeadsCsv, exportDateStamp, sanitizeCampaignFilename } = await import('@/lib/drafting/exports');
  return {
    bytes: buildUnverifiedLeadsCsv(rows),
    filename: `${sanitizeCampaignFilename(campaign.rows[0]?.name ?? 'campaign')}-unverified-leads-${exportDateStamp()}.csv`,
    mime: 'text/csv; charset=utf-8',
    count: rows.length,
  };
}

export type DraftSendResult = {
  item_id: string;
  recipient: string;
  status: 'sent' | 'failed' | 'skipped' | 'queued';
  provider_message_id?: string;
  error?: string;
  queue_id?: string;
  schedule_date?: string;
};

async function dispatchDraftSend(
  row: ApprovedDraftExportRow,
  campaignId: string,
  ownerId: string,
  options: { forceImmediate?: boolean } = {},
): Promise<DraftSendResult> {
  const recipient = row.toFullName || row.toEmail;
  const sendStatuses = await loadLatestEmailSendStatuses([row.itemId]);
  if (sendStatuses.get(row.itemId)?.status === 'sent') {
    return {
      item_id: row.itemId,
      recipient,
      status: 'skipped',
      error: 'Already sent',
    };
  }

  const activeQueue = await loadActiveQueueByItemIds([row.itemId]);
  const existing = activeQueue.get(row.itemId);
  if (existing) {
    return {
      item_id: row.itemId,
      recipient,
      status: 'queued',
      queue_id: existing.queue_id,
      schedule_date: existing.schedule_date,
    };
  }

  const queued = await enqueueOverflowSend({
    ownerId,
    itemId: row.itemId,
    campaignId,
    toEmail: row.toEmail,
    subject: row.subject,
    recipientName: recipient,
  });
  if (queued.schedule_date === formatNyDate() && queued.from_email) {
    const { sendNowQueueItems } = await import('@/lib/drafting/send-queue');
    try {
      const nowResult = await sendNowQueueItems({ ownerId, ids: [queued.id] });
      const sent = nowResult.results[0];
      if (sent?.status === 'sent') {
        return {
          item_id: row.itemId,
          recipient,
          status: 'sent',
          queue_id: queued.id,
          schedule_date: queued.schedule_date,
        };
      }
      if (sent?.status === 'queued') {
        return {
          item_id: row.itemId,
          recipient,
          status: 'queued',
          queue_id: queued.id,
          schedule_date: sent.schedule_date ?? queued.schedule_date,
        };
      }
      if (sent?.status === 'failed') {
        return {
          item_id: row.itemId,
          recipient,
          status: 'failed',
          error: sent.error,
          queue_id: queued.id,
        };
      }
    } catch {
      // Capacity or send-now refusal — leave queued for the scheduled slot.
    }
  }
  return {
    item_id: row.itemId,
    recipient,
    status: 'queued',
    queue_id: queued.id,
    schedule_date: queued.schedule_date,
  };
}

export async function sendApprovedDraft(itemId: string, ownerId: string): Promise<DraftSendResult> {
  if (!isEmailSendConfigured()) {
    throw new EmailSendConfigurationError('AGENT_MAIL_API is not configured');
  }

  const { campaignId } = await getOwnedItemContext(itemId, ownerId);
  const { rows } = await loadSendableDraftRows(campaignId, ownerId);
  const row = rows.find((entry) => entry.itemId === itemId);
  if (!row) {
    throw new DraftingValidationError('Draft is not available to send');
  }

  const preflight = preflightFinalDraftSend([row]);
  if (!preflight.ok) {
    throw new DraftingExportBlockedError(preflight.blockers, 'Draft is not ready to send');
  }

  const result = await dispatchDraftSend(row, campaignId, ownerId);
  if (result.status === 'skipped') {
    throw new DraftingConflictError(result.error ?? 'Already sent', 'already_sent');
  }
  if (result.status === 'failed') {
    throw new EmailSendProviderError(result.error ?? 'Send failed');
  }
  return result;
}

export async function sendCampaignApprovedDrafts(
  campaignId: string,
  ownerId: string,
): Promise<{
  sent: number;
  failed: number;
  skipped: number;
  queued: number;
  results: DraftSendResult[];
}> {
  if (!isEmailSendConfigured()) {
    throw new EmailSendConfigurationError('AGENT_MAIL_API is not configured');
  }

  const { rows: allRows } = await loadSendableDraftRows(campaignId, ownerId);
  // Send All Ready: only drafts without retry-suggested soft lint.
  const rows = allRows.filter((row) => isReadyForBulkSend({
    state: row.state,
    retrySuggested: row.retrySuggested,
  }));
  const sendStatuses = await loadLatestEmailSendStatuses(rows.map((row) => row.itemId));
  const activeQueue = await loadActiveQueueByItemIds(rows.map((row) => row.itemId));
  const unsentRows = rows.filter(
    (row) => sendStatuses.get(row.itemId)?.status !== 'sent'
      && !activeQueue.has(row.itemId),
  );
  const alreadyQueued = rows.filter(
    (row) => sendStatuses.get(row.itemId)?.status !== 'sent'
      && activeQueue.has(row.itemId),
  );
  const skipped = allRows.length - unsentRows.length - alreadyQueued.length;

  if (unsentRows.length === 0 && alreadyQueued.length === 0) {
    throw new DraftingValidationError('No ready drafts to send');
  }

  if (unsentRows.length > 0) {
    const preflight = preflightFinalDraftSend(unsentRows);
    if (!preflight.ok) {
      throw new DraftingExportBlockedError(preflight.blockers, 'Campaign send is not ready');
    }
  }

  const results: DraftSendResult[] = [];

  for (const row of alreadyQueued) {
    const existing = activeQueue.get(row.itemId)!;
    results.push({
      item_id: row.itemId,
      recipient: row.toFullName || row.toEmail,
      status: 'queued',
      queue_id: existing.queue_id,
      schedule_date: existing.schedule_date,
    });
  }

  if (unsentRows.length > 0) {
    const { enqueueOverflowBatch, sendNowQueueItems } = await import('@/lib/drafting/send-queue');
    const queuedRows = await enqueueOverflowBatch(
      ownerId,
      unsentRows.map((row) => ({
        ownerId,
        itemId: row.itemId,
        campaignId,
        toEmail: row.toEmail,
        subject: row.subject,
        recipientName: row.toFullName || row.toEmail,
      })),
    );
    const byItem = new Map(queuedRows.map((row) => [row.drafting_item_id, row]));
    const today = formatNyDate();
    const todayIds = queuedRows
      .filter((row) => row.schedule_date === today && row.from_email)
      .map((row) => row.id);
    const sendByQueue = new Map<string, { status: 'sent' | 'failed' | 'queued'; error?: string; schedule_date?: string }>();
    if (todayIds.length > 0) {
      try {
        const nowResult = await sendNowQueueItems({ ownerId, ids: todayIds });
        for (const result of nowResult.results) {
          sendByQueue.set(result.queue_id, result);
        }
      } catch {
        // Capacity or send-now refusal — leave queued for the scheduled slot.
      }
    }
    for (const row of unsentRows) {
      const queued = byItem.get(row.itemId);
      const sent = queued ? sendByQueue.get(queued.id) : undefined;
      if (sent?.status === 'sent') {
        results.push({
          item_id: row.itemId,
          recipient: row.toFullName || row.toEmail,
          status: 'sent',
          queue_id: queued?.id,
          schedule_date: queued?.schedule_date,
        });
        continue;
      }
      if (sent?.status === 'failed') {
        results.push({
          item_id: row.itemId,
          recipient: row.toFullName || row.toEmail,
          status: 'failed',
          error: sent.error,
          queue_id: queued?.id,
        });
        continue;
      }
      results.push({
        item_id: row.itemId,
        recipient: row.toFullName || row.toEmail,
        status: 'queued',
        queue_id: queued?.id,
        schedule_date: sent?.schedule_date ?? queued?.schedule_date,
      });
    }
  }

  return {
    sent: results.filter((result) => result.status === 'sent').length,
    failed: results.filter((result) => result.status === 'failed').length,
    skipped,
    queued: results.filter((result) => result.status === 'queued').length,
    results,
  };
}

// ── Job orchestration helpers (used by lib/drafting/jobs.ts) ────────────────

export type DraftingItemRow = DbDraftingItemRow & {
  lead_id: string;
  research_revision: number;
  draft_revision: number;
};

export type DraftingRun = {
  id: string;
  workspace_id: string;
  status: string;
  budget_limit_usd: string;
  reserved_cost_usd: string;
};

export type DraftingJobRow = {
  id: string;
  drafting_run_id: string;
  drafting_item_id: string;
  kind: DraftingJobKind;
  status: DraftingJobStatus;
  attempt_count: number;
  expected_input_fingerprint: string | null;
  expected_research_revision: number | null;
  expected_draft_revision: number | null;
  usage?: Record<string, unknown>;
};

export function writeJobKey(itemId: string, packetSha256: string, draftRevision: number): string {
  return `write:${itemId}:${packetSha256}:${draftRevision}`;
}

const DRAFTING_EXECUTION_LOCK_SECONDS = 120;

export async function claimDraftingItemExecution(
  itemId: string,
): Promise<string | null> {
  const owner = randomUUID();
  const { rows } = await dbQuery<{ drafting_execution_owner: string }>(
    `UPDATE outreach.drafting_items
        SET drafting_execution_owner = $2,
            drafting_execution_expires_at = now() + make_interval(secs => $3),
            updated_at = now()
      WHERE id = $1
        AND (
          drafting_execution_owner IS NULL
          OR drafting_execution_expires_at IS NULL
          OR drafting_execution_expires_at < now()
        )
      RETURNING drafting_execution_owner`,
    [itemId, owner, DRAFTING_EXECUTION_LOCK_SECONDS],
  );
  return rows[0]?.drafting_execution_owner ?? null;
}

export async function heartbeatDraftingItemExecution(
  itemId: string,
  owner: string,
): Promise<void> {
  await dbQuery(
    `UPDATE outreach.drafting_items
        SET drafting_execution_expires_at = now() + make_interval(secs => $3),
            updated_at = now()
      WHERE id = $1
        AND drafting_execution_owner = $2`,
    [itemId, owner, DRAFTING_EXECUTION_LOCK_SECONDS],
  );
}

export async function releaseDraftingItemExecution(
  itemId: string,
  owner: string,
): Promise<void> {
  await dbQuery(
    `UPDATE outreach.drafting_items
        SET drafting_execution_owner = NULL,
            drafting_execution_expires_at = NULL,
            updated_at = now()
      WHERE id = $1
        AND drafting_execution_owner = $2`,
    [itemId, owner],
  );
}

export async function claimDraftingJob(jobId?: string): Promise<DraftingJobRow | null> {
  const { rows } = await dbQuery<DraftingJobRow>(
    `SELECT id, drafting_run_id, drafting_item_id, kind, status, attempt_count,
            expected_input_fingerprint, expected_research_revision, expected_draft_revision
     FROM public.claim_drafting_job($1)`,
    [jobId ?? null],
  );
  return rows[0] ?? null;
}

export async function finishDraftingJob(input: {
  jobId: string;
  status: 'done' | 'failed' | 'superseded' | 'cancelled';
  actualCostUsd?: string | null;
  usage?: Record<string, unknown>;
  providerRequestId?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  costEventKey?: string | null;
}): Promise<DraftingJobRow | null> {
  const { rows } = await dbQuery<DraftingJobRow>(
    `SELECT id, drafting_run_id, drafting_item_id, kind, status, attempt_count,
            expected_input_fingerprint, expected_research_revision, expected_draft_revision
     FROM public.finish_drafting_job($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
    [
      input.jobId,
      input.status,
      input.actualCostUsd ?? null,
      input.usage ? JSON.stringify(input.usage) : null,
      input.providerRequestId ?? null,
      input.lastErrorCode ?? null,
      input.lastErrorMessage ?? null,
      input.costEventKey ?? null,
    ],
  );
  return rows[0] ?? null;
}

/**
 * Defer an in-flight drafting job for a transient provider retry without
 * releasing its reservation or marking a terminal research_provider_error.
 */
export async function deferDraftingJobForRetry(input: {
  jobId: string;
  delayMs: number;
  errorCode: string;
  errorMessage: string;
}): Promise<Date> {
  const delaySeconds = Math.max(1, Math.ceil(input.delayMs / 1000));
  const { rows } = await dbQuery<{ next_attempt_at: string }>(
    `UPDATE outreach.drafting_jobs
        SET status = 'pending',
            claimed_at = NULL,
            heartbeat_at = NULL,
            next_attempt_at = now() + make_interval(secs => $2::double precision),
            last_error_code = $3,
            last_error_message = $4,
            usage = outreach.drafting_jobs.usage || jsonb_build_object(
              'transientDeferAt', now(),
              'transientDeferCode', $3::text
            )
      WHERE id = $1
        AND status = 'in_flight'
      RETURNING next_attempt_at::text`,
    [
      input.jobId,
      delaySeconds,
      input.errorCode,
      input.errorMessage.slice(0, 1000),
    ],
  );
  const next = rows[0]?.next_attempt_at;
  return next ? new Date(next) : new Date(Date.now() + input.delayMs);
}

/** Heal run reserved totals from open jobs only (pending/in_flight). */
export async function recomputeActiveRunReservations(limit = 50): Promise<number> {
  const { rowCount } = await dbQuery(
    `WITH targets AS (
       SELECT id
         FROM outreach.drafting_runs
        WHERE status = 'active'
        ORDER BY started_at DESC
        LIMIT $1
     )
     UPDATE outreach.drafting_runs AS r
        SET reserved_cost_usd = coalesce((
              SELECT sum(j.reserved_cost_usd)
                FROM outreach.drafting_jobs j
               WHERE j.drafting_run_id = r.id
                 AND j.status IN ('pending', 'in_flight')
            ), 0::numeric)
       FROM targets t
      WHERE r.id = t.id`,
    [limit],
  );
  return rowCount ?? 0;
}

type DraftingCostEventQuery = (
  text: string,
  params: unknown[],
) => Promise<{ rows: Array<{ inserted: boolean }> }>;

/**
 * Persist one successful provider result without finishing the job. The SQL
 * function owns append-once insertion plus cumulative job/run rollup.
 */
export async function recordDraftingJobCostEvent(
  input: {
    jobId: string;
    stage: DraftingCostStage;
    providerRequestId: string;
    actualCostUsd: string;
    usage: Record<string, unknown>;
  },
  query: DraftingCostEventQuery = (text, params) =>
    dbQuery<{ inserted: boolean }>(text, params),
): Promise<boolean> {
  const eventKey = draftingCostEventKey({
    stage: input.stage,
    providerRequestIds: [input.providerRequestId],
  });
  const { rows } = await query(
    `SELECT public.record_drafting_job_cost_event(
       $1, $2::numeric, $3::jsonb, $4, $5
     ) AS inserted`,
    [
      input.jobId,
      input.actualCostUsd,
      JSON.stringify(input.usage),
      input.providerRequestId,
      eventKey,
    ],
  );
  return rows[0]?.inserted === true;
}

export async function heartbeatDraftingJob(jobId: string): Promise<void> {
  await dbQuery(
    `UPDATE outreach.drafting_jobs SET heartbeat_at = now() WHERE id = $1`,
    [jobId],
  );
}

export type ReusableCompanyResearchMatch = {
  context: ReusableCompanyResearchContext;
  sourcePacket: DraftingResearchPacket;
  sourceUsage: Record<string, unknown>;
};

export async function findReusableCompanyResearch(input: {
  workspaceId: string;
  itemId: string;
  company: string | null;
  email: string | null;
}): Promise<ReusableCompanyResearchMatch | null> {
  const company = normalizeRequiredField(input.company);
  const companyKey = resolveCompanyResearchKey(input.email);
  if (!company || !companyKey) return null;

  const { rows } = await dbQuery<{
    drafting_item_id: string;
    packet: DraftingResearchPacket;
    usage: Record<string, unknown>;
  }>(
    `SELECT p.drafting_item_id, p.packet, p.usage
       FROM outreach.draft_research_packets p
       JOIN outreach.drafting_items source_item
         ON source_item.id = p.drafting_item_id
      WHERE source_item.workspace_id = $1
        AND source_item.id <> $2
        AND p.status = 'valid'
        AND p.schema_version = '2'
        AND p.temporal_status <> 'blocked'
        AND p.researched_at >= now() - interval '72 hours'
        AND lower(split_part(trim(coalesce(
              source_item.input_overrides ->> 'email',
              source_item.input_snapshot #>> '{lead,email}',
              ''
            )), '@', 2)) = $3
      ORDER BY p.researched_at DESC
      LIMIT 1`,
    [input.workspaceId, input.itemId, companyKey],
  );
  const source = rows[0];
  if (!source) return null;

  const context = buildReusableCompanyResearchContext({
    sourceDraftingItemId: source.drafting_item_id,
    company,
    packet: source.packet,
  });
  if (!context) return null;
  return {
    context,
    sourcePacket: source.packet,
    sourceUsage: source.usage ?? {},
  };
}

export type CompanyResearchLeaseClaim = {
  companyKey: string;
  acquired: boolean;
  ownerItemId: string;
  leaseExpiresAt: string;
};

export async function claimCompanyResearchLease(input: {
  workspaceId: string;
  itemId: string;
  email: string | null;
}): Promise<CompanyResearchLeaseClaim | null> {
  const companyKey = resolveCompanyResearchKey(input.email);
  if (!companyKey) return null;
  const { rows } = await dbQuery<{
    owner_item_id: string;
    lease_expires_at: string;
  }>(
    `INSERT INTO outreach.drafting_company_research_leases AS leases (
       workspace_id, company_key, owner_item_id, status, lease_expires_at
     ) VALUES ($1, $2, $3, 'researching', now() + interval '15 minutes')
     ON CONFLICT (workspace_id, company_key) DO UPDATE SET
       owner_item_id = CASE
         WHEN leases.owner_item_id = EXCLUDED.owner_item_id
           OR leases.status <> 'researching'
           OR leases.lease_expires_at <= now()
           OR leases.created_at <= now() - interval '45 minutes'
         THEN EXCLUDED.owner_item_id
         ELSE leases.owner_item_id
       END,
       status = CASE
         WHEN leases.owner_item_id = EXCLUDED.owner_item_id
           OR leases.status <> 'researching'
           OR leases.lease_expires_at <= now()
           OR leases.created_at <= now() - interval '45 minutes'
         THEN 'researching'
         ELSE leases.status
       END,
       created_at = CASE
         WHEN leases.owner_item_id = EXCLUDED.owner_item_id
           AND leases.status = 'researching'
           AND leases.lease_expires_at > now()
           AND leases.created_at > now() - interval '45 minutes'
         THEN leases.created_at
         WHEN leases.owner_item_id = EXCLUDED.owner_item_id
           OR leases.status <> 'researching'
           OR leases.lease_expires_at <= now()
           OR leases.created_at <= now() - interval '45 minutes'
         THEN now()
         ELSE leases.created_at
       END,
       lease_expires_at = CASE
         WHEN leases.owner_item_id = EXCLUDED.owner_item_id
           OR leases.status <> 'researching'
           OR leases.lease_expires_at <= now()
           OR leases.created_at <= now() - interval '45 minutes'
         THEN now() + interval '15 minutes'
         ELSE leases.lease_expires_at
       END,
       updated_at = CASE
         WHEN leases.owner_item_id = EXCLUDED.owner_item_id
           OR leases.status <> 'researching'
           OR leases.lease_expires_at <= now()
           OR leases.created_at <= now() - interval '45 minutes'
         THEN now()
         ELSE leases.updated_at
       END
     RETURNING owner_item_id, lease_expires_at`,
    [input.workspaceId, companyKey, input.itemId],
  );
  const row = rows[0];
  if (!row) throw new Error('Company research lease claim returned no row');
  return {
    companyKey,
    acquired: row.owner_item_id === input.itemId,
    ownerItemId: row.owner_item_id,
    leaseExpiresAt: row.lease_expires_at,
  };
}

export async function finishCompanyResearchLease(input: {
  workspaceId: string;
  itemId: string;
  companyKey: string;
  status: 'ready' | 'failed';
}): Promise<string[]> {
  await dbQuery(
    `UPDATE outreach.drafting_company_research_leases
        SET status = $4,
            lease_expires_at = now(),
            updated_at = now()
      WHERE workspace_id = $1
        AND company_key = $2
        AND owner_item_id = $3`,
    [input.workspaceId, input.companyKey, input.itemId, input.status],
  );
  // Wake parked siblings so they can sibling-skip (ready) or become the next owner (failed).
  return wakeParkedCompanyResearchSiblings({
    workspaceId: input.workspaceId,
    companyKey: input.companyKey,
  });
}

/**
 * Wake parked siblings whose company owner crashed / lease expired without
 * calling finishCompanyResearchLease. Safe to run from system.reconcile.
 */
export async function wakeOrphanedParkedCompanyResearch(): Promise<number> {
  const orphans = await dbQuery<{
    workspace_id: string;
    company_key: string;
  }>(
    `SELECT DISTINCT di.workspace_id::text AS workspace_id,
            lower(split_part(trim(coalesce(
              di.input_overrides ->> 'email',
              di.input_snapshot #>> '{lead,email}',
              ''
            )), '@', 2)) AS company_key
       FROM outreach.drafting_items di
      WHERE di.removed_at IS NULL
        AND di.state = 'waiting_company_research'
        AND NOT (
          di.last_error_code = 'empty_research_brief'
          AND di.empty_brief_input_fingerprint = di.input_fingerprint
          AND di.empty_brief_attempts >= 2
        )
        AND lower(split_part(trim(coalesce(
              di.input_overrides ->> 'email',
              di.input_snapshot #>> '{lead,email}',
              ''
            )), '@', 2)) <> ''
        AND NOT EXISTS (
          SELECT 1
            FROM outreach.drafting_company_research_leases l
           WHERE l.workspace_id = di.workspace_id
             AND l.company_key = lower(split_part(trim(coalesce(
               di.input_overrides ->> 'email',
               di.input_snapshot #>> '{lead,email}',
               ''
             )), '@', 2))
             AND l.status = 'researching'
             AND l.lease_expires_at > now()
        )`,
  );
  let woken = 0;
  for (const row of orphans.rows) {
    if (!row.company_key) continue;
    const ids = await wakeParkedCompanyResearchSiblings({
      workspaceId: row.workspace_id,
      companyKey: row.company_key,
    });
    woken += ids.length;
  }
  return woken;
}

/**
 * Re-queue items parked on a company research lease. Does not hold worker shards
 * while the owner researches — that was the old 4s spin-wait failure mode.
 */
export async function wakeParkedCompanyResearchSiblings(input: {
  workspaceId: string;
  companyKey: string;
}): Promise<string[]> {
  const parked = await dbQuery<{
    id: string;
    input_fingerprint: string;
    research_revision: number;
    draft_revision: number;
    created_by: string;
  }>(
    `SELECT di.id,
            di.input_fingerprint,
            di.research_revision,
            di.draft_revision,
            dw.created_by::text AS created_by
       FROM outreach.drafting_items di
       JOIN outreach.drafting_workspaces dw ON dw.id = di.workspace_id
      WHERE di.workspace_id = $1
        AND di.removed_at IS NULL
        AND di.state = 'waiting_company_research'
        AND NOT (
          di.last_error_code = 'empty_research_brief'
          AND di.empty_brief_input_fingerprint = di.input_fingerprint
          AND di.empty_brief_attempts >= 2
        )
        AND lower(split_part(trim(coalesce(
              di.input_overrides ->> 'email',
              di.input_snapshot #>> '{lead,email}',
              ''
            )), '@', 2)) = $2
      ORDER BY di.ordinal, di.id`,
    [input.workspaceId, input.companyKey],
  );
  if (parked.rows.length === 0) return [];

  const runRow = await dbQuery<{ id: string }>(
    `SELECT id
       FROM outreach.drafting_runs
      WHERE workspace_id = $1
      ORDER BY started_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    [input.workspaceId],
  );
  let draftingRunId = runRow.rows[0]?.id ?? null;
  if (!draftingRunId) {
    const created = await dbQuery<{ id: string }>(
      `INSERT INTO outreach.drafting_runs (
         workspace_id, triggered_by, trigger, idempotency_key, target_count, budget_limit_usd
       ) VALUES (
         $1, $2, 'retry', $3, 0,
         coalesce($4::numeric, 50.0000)
       )
       RETURNING id`,
      [
        input.workspaceId,
        parked.rows[0].created_by,
        `wake-company:${input.workspaceId}:${input.companyKey}:${Date.now()}`,
        process.env.DRAFTING_DEFAULT_BATCH_BUDGET_USD ?? '50.0000',
      ],
    );
    draftingRunId = created.rows[0]?.id ?? null;
  }
  if (!draftingRunId) return [];

  const nextJobIds: string[] = [];
  for (const row of parked.rows) {
    await dbTransaction(async (client) => {
      await transitionItemState(client, row.id, 'queued_research', true);
      const jobId = await queueJob(client, {
        runId: draftingRunId!,
        itemId: row.id,
        kind: 'research',
        idempotencyKey: `wake-company:${row.id}:${input.companyKey}:${row.research_revision}`,
        expectedInputFingerprint: row.input_fingerprint,
        expectedResearchRevision: row.research_revision,
        expectedDraftRevision: row.draft_revision,
        reservedCostUsd: worstCaseResearchReservationUsd(),
        priority: 2,
      });
      if (jobId) nextJobIds.push(jobId);
      await refreshCompletionTimestamps(client, input.workspaceId);
    });
  }

  if (nextJobIds.length > 0) {
    try {
      const { dispatchDraftingJobs } = await import('@/lib/drafting/transport');
      const jobs = await dbQuery<{ id: string; kind: string; attempt_count: number }>(
        `SELECT id, kind, attempt_count FROM outreach.drafting_jobs WHERE id = ANY($1::uuid[])`,
        [nextJobIds],
      );
      await dispatchDraftingJobs(jobs.rows.map((job) => ({
        id: job.id,
        kind: job.kind as DraftingJobKind,
        attempt_count: job.attempt_count,
      })));
    } catch {
      // Orch dispatch is best-effort; pending drafting_jobs remain claimable.
    }
  }
  return nextJobIds;
}

/** Hard ceiling so a hung Anthropic call cannot renew a company lease forever. */
export const COMPANY_RESEARCH_LEASE_MAX_AGE_MINUTES = 45;

export async function heartbeatCompanyResearchLease(input: {
  workspaceId: string;
  itemId: string;
  companyKey: string;
}): Promise<void> {
  await dbQuery(
    `UPDATE outreach.drafting_company_research_leases
        SET lease_expires_at = now() + interval '15 minutes',
            updated_at = now()
      WHERE workspace_id = $1
        AND company_key = $2
        AND owner_item_id = $3
        AND status = 'researching'
        AND created_at > now() - make_interval(mins => $4)`,
    [
      input.workspaceId,
      input.companyKey,
      input.itemId,
      COMPANY_RESEARCH_LEASE_MAX_AGE_MINUTES,
    ],
  );
}

/** Expire researching leases past the hard max age so parked siblings can wake. */
export async function expireOveragedCompanyResearchLeases(): Promise<number> {
  const { rowCount } = await dbQuery(
    `UPDATE outreach.drafting_company_research_leases
        SET status = 'failed',
            lease_expires_at = now(),
            updated_at = now()
      WHERE status = 'researching'
        AND created_at <= now() - make_interval(mins => $1)`,
    [COMPANY_RESEARCH_LEASE_MAX_AGE_MINUTES],
  );
  return rowCount ?? 0;
}

export async function loadDraftingJobContext(jobId: string): Promise<{
  job: DraftingJobRow;
  item: DraftingItemRow;
  run: DraftingRun;
} | null> {
  type JobContextRow = DraftingJobRow & DraftingItemRow & {
    run_status: string;
    budget_limit_usd: string;
    reserved_cost_usd: string;
  };

  const { rows } = await dbQuery<JobContextRow>(
    `SELECT j.id, j.drafting_run_id, j.drafting_item_id, j.kind, j.status, j.attempt_count,
            j.expected_input_fingerprint, j.expected_research_revision, j.expected_draft_revision,
            j.usage,
            i.id AS item_id, i.workspace_id, i.lead_id, i.ordinal, i.state, i.input_snapshot,
            i.input_overrides, i.missing_fields, i.input_fingerprint, i.input_revision,
            i.delivery_snapshot, i.review_status, i.removed_at, i.research_revision, i.draft_revision,
            i.last_error_code, i.empty_brief_attempts,
            i.empty_brief_input_fingerprint, i.empty_brief_last_at,
            r.id AS run_id, r.workspace_id AS run_workspace_id, r.status AS run_status,
            r.budget_limit_usd, r.reserved_cost_usd
     FROM outreach.drafting_jobs j
     JOIN outreach.drafting_items i ON i.id = j.drafting_item_id
     JOIN outreach.drafting_runs r ON r.id = j.drafting_run_id
     WHERE j.id = $1`,
    [jobId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    job: {
      id: row.id,
      drafting_run_id: row.drafting_run_id,
      drafting_item_id: row.drafting_item_id,
      kind: row.kind,
      status: row.status,
      attempt_count: row.attempt_count,
      expected_input_fingerprint: row.expected_input_fingerprint,
      expected_research_revision: row.expected_research_revision,
      expected_draft_revision: row.expected_draft_revision,
      usage: row.usage ?? {},
    },
    item: {
      id: row.drafting_item_id,
      workspace_id: row.workspace_id,
      lead_id: row.lead_id,
      ordinal: row.ordinal,
      state: row.state,
      input_snapshot: row.input_snapshot,
      input_overrides: row.input_overrides,
      missing_fields: row.missing_fields,
      input_fingerprint: row.input_fingerprint,
      input_revision: row.input_revision,
      delivery_snapshot: row.delivery_snapshot,
      review_status: row.review_status,
      removed_at: row.removed_at,
      last_error_code: row.last_error_code,
      empty_brief_attempts: row.empty_brief_attempts,
      empty_brief_input_fingerprint: row.empty_brief_input_fingerprint,
      empty_brief_last_at: row.empty_brief_last_at,
      research_revision: row.research_revision,
      draft_revision: row.draft_revision,
    },
    run: {
      id: row.drafting_run_id,
      workspace_id: row.workspace_id,
      status: row.run_status,
      budget_limit_usd: row.budget_limit_usd,
      reserved_cost_usd: row.reserved_cost_usd,
    },
  };
}

export async function transitionItemState(
  client: PoolClient,
  itemId: string,
  to: DraftingItemState,
  mailboxValid = false,
): Promise<void> {
  const current = await client.query<{ state: DraftingItemState }>(
    `SELECT state FROM outreach.drafting_items WHERE id = $1 FOR UPDATE`,
    [itemId],
  );
  const from = current.rows[0]?.state ?? 'needs_lead_review';
  const result = assertTransition(from, to, { mailboxValid });
  await client.query(
    `UPDATE outreach.drafting_items
     SET state = $2, review_status = $3, updated_at = now()
     WHERE id = $1`,
    [itemId, result.state, result.reviewStatus],
  );
}

export async function recordEmptyBriefOutcome(
  client: PoolClient,
  input: {
    itemId: string;
    inputFingerprint: string;
    surface: EmptyBriefRetrySurface;
  },
): Promise<EmptyBriefCompletionDecision> {
  const current = await client.query<{
    empty_brief_attempts: number;
    empty_brief_input_fingerprint: string | null;
    last_error_code: string | null;
  }>(
    `SELECT empty_brief_attempts, empty_brief_input_fingerprint, last_error_code
       FROM outreach.drafting_items
      WHERE id = $1
      FOR UPDATE`,
    [input.itemId],
  );
  const row = current.rows[0];
  if (!row) throw new DraftingNotFoundError('Drafting item not found');

  const decision = recordEmptyBriefCompletion(
    {
      attempts: Number(row.empty_brief_attempts),
      inputFingerprint: row.empty_brief_input_fingerprint,
      lastErrorCode: row.last_error_code,
    },
    input.inputFingerprint,
    input.surface,
  );
  await client.query(
    `UPDATE outreach.drafting_items
        SET empty_brief_attempts = $2,
            empty_brief_input_fingerprint = $3,
            empty_brief_last_at = now(),
            last_error_code = $4,
            last_error_message = $5,
            updated_at = now()
      WHERE id = $1`,
    [
      input.itemId,
      decision.attempts,
      decision.inputFingerprint,
      decision.action === 'quarantine'
        ? EMPTY_RESEARCH_BRIEF_ERROR_CODE
        : 'empty_research_brief_retry',
      decision.action === 'quarantine'
        ? EMPTY_BRIEF_TERMINAL_MESSAGE
        : 'No usable facts after reconcile — queued one fresh research retry',
    ],
  );
  return decision;
}

export async function clearEmptyBriefErrorAfterUsableResearch(
  client: PoolClient,
  itemId: string,
  inputFingerprintValue: string,
): Promise<void> {
  await client.query(
    `UPDATE outreach.drafting_items
        SET last_error_code = CASE
              WHEN empty_brief_input_fingerprint = $2
                   AND last_error_code IN ($3, 'empty_research_brief_retry')
                THEN NULL
              ELSE last_error_code
            END,
            last_error_message = CASE
              WHEN empty_brief_input_fingerprint = $2
                   AND last_error_code IN ($3, 'empty_research_brief_retry')
                THEN NULL
              ELSE last_error_message
            END,
            updated_at = now()
      WHERE id = $1`,
    [itemId, inputFingerprintValue, EMPTY_RESEARCH_BRIEF_ERROR_CODE],
  );
}

export async function refreshCompletionTimestamps(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  const { rows } = await client.query<{ state: DraftingItemState; delivery_snapshot: DeliverySnapshot; removed_at: string | null }>(
    `SELECT state, delivery_snapshot, removed_at
     FROM outreach.drafting_items
     WHERE workspace_id = $1`,
    [workspaceId],
  );
  const counterInputs = rows.map((row) => ({
    state: row.state,
    deliverySnapshot: parseDeliverySnapshot(row.delivery_snapshot),
    removedAt: row.removed_at,
  }));
  const counters = computeDraftingCounters(counterInputs);
  const generationComplete = isGenerationComplete(counters.mailboxValidTotal, counters.drafted);
  const reviewComplete = isReviewComplete(counters.mailboxValidTotal, counters.approved);

  await client.query(
    `UPDATE outreach.drafting_workspaces
     SET generation_completed_at = CASE WHEN $2 THEN coalesce(generation_completed_at, now()) ELSE NULL END,
         review_completed_at = CASE WHEN $3 THEN coalesce(review_completed_at, now()) ELSE NULL END,
         status = CASE
           WHEN status = 'paused' THEN 'paused'
           WHEN $3 THEN 'review_complete'
           ELSE 'active'
         END,
         updated_at = now()
     WHERE id = $1`,
    [workspaceId, generationComplete, reviewComplete],
  );

  await finalizeIdleDraftingRuns(client, workspaceId);
}

/**
 * Close out runs whose work is finished. A run is idle when it has no open
 * jobs AND none of its items are still mid-pipeline (parked company-research
 * siblings can wake back into the run, so those keep it open). Empty runs
 * (target_count = 0, no jobs) close immediately — historically these leaked
 * as eternal `active` rows and made run health unreadable.
 */
export async function finalizeIdleDraftingRuns(
  client: PoolClient,
  workspaceId: string,
): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE outreach.drafting_runs r
        SET status = CASE
              WHEN EXISTS (
                SELECT 1 FROM outreach.drafting_jobs j
                 WHERE j.drafting_run_id = r.id AND j.status = 'failed'
              ) THEN 'partial'
              ELSE 'complete'
            END,
            finished_at = now()
      WHERE r.workspace_id = $1
        AND r.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM outreach.drafting_jobs j
           WHERE j.drafting_run_id = r.id
             AND j.status IN ('pending', 'in_flight')
        )
        AND NOT EXISTS (
          SELECT 1
            FROM outreach.drafting_jobs j
            JOIN outreach.drafting_items i ON i.id = j.drafting_item_id
           WHERE j.drafting_run_id = r.id
             AND i.removed_at IS NULL
             AND i.state = ANY($2::text[])
        )`,
    [workspaceId, [...RUNNING_STATES]],
  );
  return rowCount ?? 0;
}

export async function queueJob(
  client: PoolClient,
  input: {
    runId: string;
    itemId: string;
    kind: DraftingJobKind;
    idempotencyKey: string;
    expectedInputFingerprint?: string | null;
    expectedResearchRevision?: number | null;
    expectedDraftRevision?: number | null;
    reservedCostUsd?: string;
    priority?: number;
    maxAttempts?: number;
    nextAttemptAt?: Date;
    usage?: Record<string, unknown>;
    reviveTerminal?: boolean;
  },
): Promise<string | null> {
  const run = await client.query<{ budget_limit_usd: string; reserved_cost_usd: string }>(
    `SELECT budget_limit_usd, reserved_cost_usd FROM outreach.drafting_runs WHERE id = $1 FOR UPDATE`,
    [input.runId],
  );
  const budget = run.rows[0];
  if (!budget) return null;

  const reserveAmount = input.reservedCostUsd ?? worstCaseResearchReservationUsd();
  const remaining = Number(budget.budget_limit_usd) - Number(budget.reserved_cost_usd);
  if (remaining < Number(reserveAmount)) return null;

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO outreach.drafting_jobs (
       drafting_run_id, drafting_item_id, kind, idempotency_key,
       expected_input_fingerprint, expected_research_revision, expected_draft_revision,
       reserved_cost_usd, priority, max_attempts, next_attempt_at, usage, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, 'pending')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      input.runId,
      input.itemId,
      input.kind,
      input.idempotencyKey,
      input.expectedInputFingerprint ?? null,
      input.expectedResearchRevision ?? null,
      input.expectedDraftRevision ?? null,
      reserveAmount,
      input.priority ?? 0,
      input.maxAttempts ?? 3,
      input.nextAttemptAt ?? new Date(),
      JSON.stringify(input.usage ?? {}),
    ],
  );
  if (!inserted.rows[0]) {
    const existing = await client.query<{ id: string; status: DraftingJobStatus }>(
      `SELECT id, status FROM outreach.drafting_jobs WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    );
    const row = existing.rows[0];
    if (
      row
      && input.reviveTerminal
      && ['failed', 'cancelled', 'superseded'].includes(row.status)
    ) {
      const revived = await client.query<{ id: string; reserved_cost_usd: string }>(
        `UPDATE outreach.drafting_jobs
            SET status = 'pending',
                claimed_at = NULL,
                heartbeat_at = NULL,
                finished_at = NULL,
                next_attempt_at = $2,
                last_error_code = NULL,
                last_error_message = NULL,
                usage = outreach.drafting_jobs.usage || jsonb_build_object(
                  'latestRevival', $3::jsonb,
                  'revivedAt', now()
                ),
                execution_epoch = outreach.drafting_jobs.execution_epoch + 1
          WHERE id = $1
          RETURNING id, reserved_cost_usd::text`,
        [
          row.id,
          input.nextAttemptAt ?? new Date(),
          JSON.stringify(input.usage ?? {}),
        ],
      );
      const revivedRow = revived.rows[0];
      if (!revivedRow) return null;
      // finish_drafting_job released the prior reservation; re-reserve on revive.
      const reviveReserve = Number(revivedRow.reserved_cost_usd);
      if (Number.isFinite(reviveReserve) && reviveReserve > 0) {
        await client.query(
          `UPDATE outreach.drafting_runs
              SET reserved_cost_usd = reserved_cost_usd + $2::numeric
            WHERE id = $1`,
          [input.runId, revivedRow.reserved_cost_usd],
        );
      }
      return revivedRow.id;
    }
    return row && ['pending', 'in_flight'].includes(row.status) ? row.id : null;
  }

  await client.query(
    `UPDATE outreach.drafting_runs
     SET reserved_cost_usd = reserved_cost_usd + $2
     WHERE id = $1`,
    [input.runId, reserveAmount],
  );
  return inserted.rows[0].id;
}

export async function applyItemScopedMailboxResult(input: {
  itemId: string;
  expectedEmailFingerprint: string;
  status: MailboxVerificationStatus;
  providerRequestId?: string;
  resultSource?: string;
}): Promise<boolean> {
  // Only patch verification fields — never blank effectiveEmail via jsonb || merge.
  const deliveryPatch = {
    emailVerification: input.status,
    verifiedAt: new Date().toISOString(),
    resultSource: input.resultSource ?? 'agentmail',
    providerRequestId: input.providerRequestId ?? null,
  };

  const { rows } = await dbQuery<{ id: string; lead_id: string }>(
    `UPDATE outreach.drafting_items
     SET delivery_snapshot = delivery_snapshot || $2::jsonb,
         updated_at = now()
     WHERE id = $1
       AND coalesce(delivery_snapshot->>'effectiveEmailFingerprint', '') = $3
     RETURNING id, lead_id`,
    [input.itemId, JSON.stringify(deliveryPatch), input.expectedEmailFingerprint],
  );
  if (!rows[0]) return false;

  // Keep lead verification in sync so re-Go-to-Drafting rebuilds the same signal.
  if (
    input.status === 'valid'
    || input.status === 'invalid'
    || input.status === 'rate_limited'
    || input.status === 'unknown'
  ) {
    await dbQuery(
      `UPDATE outreach.leads
          SET email_verification = $2,
              email_verified_at = now(),
              updated_at = now()
        WHERE id = $1
          AND (
            email_verification IS NULL
            OR email_verification IN ('pending', 'unknown', 'rate_limited')
            OR ($2 = 'valid' AND email_verification <> 'valid')
            OR ($2 = 'invalid')
          )`,
      [rows[0].lead_id, input.status],
    );
  }
  return true;
}

export type ReconcileDraftingQueueResult = {
  drafting_run_id: string;
  examined: number;
  queued: number;
  skipped: number;
  jobs: Array<{ id: string; kind: DraftingJobKind; attempt_count: number; item_id: string }>;
};

/**
 * Queue research/verify for every idle eligible drafting item in a workspace.
 * Idempotent against pending/in_flight jobs. Used by Go to Drafting, bulk
 * approve, and the system reconciler.
 */
export async function reconcileDraftingWorkspaceQueue(input: {
  workspaceId: string;
  ownerId: string;
  trigger: 'go_to_drafting' | 'lead_approval' | 'retry';
  idempotencyKey: string;
  itemIds?: string[];
  budgetLimitUsd?: string;
  allowEmptyBriefOverride?: boolean;
}): Promise<ReconcileDraftingQueueResult> {
  const mode = input.trigger === 'lead_approval' ? 'human' : 'auto';
  const idleStatesSql = mode === 'human'
    ? '{needs_lead_review,waiting_for_enrichment,budget_paused,failed_research,failed_write,failed_rewrite}'
    : '{needs_lead_review,waiting_for_enrichment,budget_paused,failed_research}';

  const paused = await dbQuery<{ status: string }>(
    `SELECT status FROM outreach.drafting_workspaces WHERE id = $1`,
    [input.workspaceId],
  );
  if (paused.rows[0]?.status === 'paused') {
    return { drafting_run_id: '', examined: 0, queued: 0, skipped: 0, jobs: [] };
  }

  const result = await dbTransaction(async (client) => {
    const itemFilter = input.itemIds && input.itemIds.length > 0
      ? 'AND di.id = ANY($2::uuid[])'
      : '';
    const params: unknown[] = input.itemIds && input.itemIds.length > 0
      ? [input.workspaceId, input.itemIds]
      : [input.workspaceId];

    const items = await client.query<{
      id: string;
      state: DraftingItemState;
      input_snapshot: InputSnapshot;
      input_overrides: InputOverrides;
      input_fingerprint: string;
      delivery_snapshot: DeliverySnapshot | Record<string, unknown> | null;
      last_error_code: string | null;
      empty_brief_attempts: number;
      empty_brief_input_fingerprint: string | null;
    }>(
      `SELECT di.id, di.state, di.input_snapshot, di.input_overrides,
              di.input_fingerprint, di.delivery_snapshot, di.last_error_code,
              di.empty_brief_attempts, di.empty_brief_input_fingerprint
         FROM outreach.drafting_items di
        WHERE di.workspace_id = $1
          AND di.removed_at IS NULL
          AND di.state = ANY('${idleStatesSql}'::text[])
          ${itemFilter}
        ORDER BY di.ordinal
        FOR UPDATE OF di`,
      params,
    );

    const run = await client.query<{
      id: string;
      budget_limit_usd: string;
      reserved_cost_usd: string;
      actual_cost_usd: string;
      inserted: boolean;
    }>(
      `INSERT INTO outreach.drafting_runs (
         workspace_id, triggered_by, trigger, idempotency_key, target_count, budget_limit_usd
       ) VALUES ($1, $2, $3, $4, 0, coalesce($5::numeric, 50.0000))
       ON CONFLICT (triggered_by, idempotency_key) DO UPDATE
         SET target_count = outreach.drafting_runs.target_count
       RETURNING id, budget_limit_usd::text, reserved_cost_usd::text, actual_cost_usd::text,
                 (xmax = 0) AS inserted`,
      [
        input.workspaceId,
        input.ownerId,
        input.trigger,
        input.idempotencyKey,
        input.budgetLimitUsd ?? process.env.DRAFTING_DEFAULT_BATCH_BUDGET_USD ?? '50.0000',
      ],
    );
    const draftingRunId = run.rows[0].id;
    let remainingBudget =
      Number(run.rows[0].budget_limit_usd)
      - Number(run.rows[0].reserved_cost_usd)
      - Number(run.rows[0].actual_cost_usd);
    const jobs: ReconcileDraftingQueueResult['jobs'] = [];
    let skipped = 0;
    let newlyQueued = 0;

    for (const row of items.rows) {
      if (
        !input.allowEmptyBriefOverride
        && isEmptyBriefQuarantined(
          {
            attempts: Number(row.empty_brief_attempts),
            inputFingerprint: row.empty_brief_input_fingerprint,
            lastErrorCode: row.last_error_code,
          },
          row.input_fingerprint,
        )
      ) {
        skipped += 1;
        continue;
      }
      const delivery = parseDeliverySnapshot(row.delivery_snapshot);
      const action = resolveDraftingEnqueueAction({
        state: row.state,
        snapshot: row.input_snapshot,
        delivery,
        overrides: row.input_overrides,
        mode,
        lastErrorCode: row.last_error_code,
      });
      if (!action) {
        skipped += 1;
        continue;
      }

      const active = await client.query<{ id: string }>(
        `SELECT id FROM outreach.drafting_jobs
          WHERE drafting_item_id = $1
            AND status IN ('pending', 'in_flight')
          LIMIT 1`,
        [row.id],
      );
      if (active.rows[0]) {
        skipped += 1;
        continue;
      }

      const kind: DraftingJobKind = action === 'research' ? 'research' : 'verify_mailbox';
      const nextState: DraftingItemState = action === 'research'
        ? 'queued_research'
        : 'verifying_mailbox';
      const reservation = action === 'research' ? worstCaseResearchReservationUsd() : '0.0000';
      const reservationNum = Number(reservation);

      if (action === 'research' && reservationNum > remainingBudget) {
        await client.query(
          `UPDATE outreach.drafting_items
              SET state = 'budget_paused', updated_at = now()
            WHERE id = $1`,
          [row.id],
        );
        skipped += 1;
        continue;
      }

      const priorJob = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM outreach.drafting_jobs
          WHERE idempotency_key = $1
          LIMIT 1`,
        [`reconcile-${kind}:${row.id}:${row.input_fingerprint}`],
      );
      const priorStatus = priorJob.rows[0]?.status ?? null;
      const willReserve = action === 'research' && (
        !priorStatus
        || ['failed', 'cancelled', 'superseded', 'done'].includes(priorStatus)
      );

      await client.query(
        `UPDATE outreach.drafting_items
            SET state = $2, updated_at = now()
          WHERE id = $1`,
        [row.id, nextState],
      );

      const rampSeconds = campaignRampDelayMs(newlyQueued) / 1000;

      const job = await client.query<{ id: string; attempt_count: number; status: string }>(
        `INSERT INTO outreach.drafting_jobs (
           drafting_run_id, drafting_item_id, kind, idempotency_key,
           expected_input_fingerprint, reserved_cost_usd, priority, usage, status, next_attempt_at
         ) VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8::jsonb, 'pending',
                  now() + make_interval(secs => $9::double precision))
         ON CONFLICT (idempotency_key) DO UPDATE SET
           drafting_run_id = EXCLUDED.drafting_run_id,
           kind = EXCLUDED.kind,
           expected_input_fingerprint = EXCLUDED.expected_input_fingerprint,
           usage = outreach.drafting_jobs.usage || jsonb_build_object(
             'latestRevival', EXCLUDED.usage,
             'revivedAt', now()
           ),
           status = CASE
             WHEN outreach.drafting_jobs.status IN ('failed', 'cancelled', 'superseded', 'done')
               THEN 'pending'
             ELSE outreach.drafting_jobs.status
           END,
           attempt_count = CASE
             WHEN outreach.drafting_jobs.status IN ('failed', 'cancelled', 'superseded', 'done')
               THEN 0
             ELSE outreach.drafting_jobs.attempt_count
           END,
           execution_epoch = CASE
             WHEN outreach.drafting_jobs.status IN ('failed', 'cancelled', 'superseded', 'done')
               THEN outreach.drafting_jobs.execution_epoch + 1
             ELSE outreach.drafting_jobs.execution_epoch
           END,
           claimed_at = CASE
             WHEN outreach.drafting_jobs.status IN ('failed', 'cancelled', 'superseded', 'done')
               THEN NULL
             ELSE outreach.drafting_jobs.claimed_at
           END,
           finished_at = CASE
             WHEN outreach.drafting_jobs.status IN ('failed', 'cancelled', 'superseded', 'done')
               THEN NULL
             ELSE outreach.drafting_jobs.finished_at
           END,
           next_attempt_at = CASE
             WHEN outreach.drafting_jobs.status IN ('failed', 'cancelled', 'superseded', 'done')
               THEN now() + make_interval(secs => $9::double precision)
             ELSE outreach.drafting_jobs.next_attempt_at
           END
         RETURNING id, attempt_count, status`,
        [
          draftingRunId,
          row.id,
          kind,
          `reconcile-${kind}:${row.id}:${row.input_fingerprint}`,
          row.input_fingerprint,
          reservation,
          kind === 'research' ? 2 : 1,
          JSON.stringify(mode === 'human' ? { emptyBriefSurface: 'manual' } : {}),
          rampSeconds,
        ],
      );

      if (!job.rows[0] || job.rows[0].status !== 'pending') {
        skipped += 1;
        continue;
      }

      if (willReserve) {
        await client.query(
          `UPDATE outreach.drafting_runs
              SET reserved_cost_usd = reserved_cost_usd + $2::numeric
            WHERE id = $1`,
          [draftingRunId, reservation],
        );
        remainingBudget -= reservationNum;
      }

      newlyQueued += 1;
      jobs.push({
        id: job.rows[0].id,
        kind,
        attempt_count: Number(job.rows[0].attempt_count ?? 0),
        item_id: row.id,
      });
    }

    if (newlyQueued === 0 && run.rows[0].inserted) {
      // Nothing to do — drop the freshly created run instead of leaking an
      // eternal empty `active` row (reconcile/rescue sweeps used to spam these).
      await client.query(
        `DELETE FROM outreach.drafting_runs
          WHERE id = $1
            AND NOT EXISTS (
              SELECT 1 FROM outreach.drafting_jobs j WHERE j.drafting_run_id = $1
            )
            AND NOT EXISTS (
              SELECT 1 FROM outreach.drafting_run_items ri WHERE ri.drafting_run_id = $1
            )`,
        [draftingRunId],
      );
    } else {
      await client.query(
        `UPDATE outreach.drafting_runs
            SET target_count = target_count + $2
          WHERE id = $1`,
        [draftingRunId, newlyQueued],
      );
    }
    await finalizeIdleDraftingRuns(client, input.workspaceId);

    return {
      drafting_run_id: draftingRunId,
      examined: items.rows.length,
      queued: jobs.length,
      skipped,
      jobs,
    };
  });

  if (result.jobs.length > 0) {
    await dispatchDraftingJobs(result.jobs.map((job) => ({
      id: job.id,
      kind: job.kind,
      attempt_count: job.attempt_count,
    })));
  }

  return result;
}

export async function approveDraftingLeadsBulk(
  campaignId: string,
  ownerId: string,
  input: { itemIds?: string[]; idempotencyKey?: string } = {},
): Promise<ReconcileDraftingQueueResult> {
  await assertCampaignOwned(campaignId, ownerId);
  const workspace = await dbQuery<{ id: string }>(
    `SELECT id FROM outreach.drafting_workspaces WHERE campaign_id = $1`,
    [campaignId],
  );
  if (!workspace.rows[0]) {
    throw new DraftingNotFoundError('Drafting workspace not found');
  }

  return reconcileDraftingWorkspaceQueue({
    workspaceId: workspace.rows[0].id,
    ownerId,
    trigger: 'lead_approval',
    idempotencyKey: input.idempotencyKey ?? `bulk-approve:${workspace.rows[0].id}:${randomUUID()}`,
    itemIds: input.itemIds,
    allowEmptyBriefOverride: true,
  });
}

/**
 * After AgentMail marks a lead valid, refresh idle drafting items' delivery
 * snapshots and queue research for any that are now eligible.
 */
export async function promoteDraftingItemsForVerifiedLead(leadId: string): Promise<number> {
  const items = await dbQuery<{
    id: string;
    workspace_id: string;
    created_by: string;
    email_primary: string | null;
    email_status: string | null;
    email_verification: string | null;
  }>(
    `SELECT di.id, di.workspace_id, dw.created_by::text AS created_by,
            l.email_primary, l.email_status, l.email_verification
       FROM outreach.drafting_items di
       JOIN outreach.drafting_workspaces dw ON dw.id = di.workspace_id
       JOIN outreach.leads l ON l.id = di.lead_id
      WHERE di.lead_id = $1
        AND di.removed_at IS NULL
        AND NOT (
          di.last_error_code = 'empty_research_brief'
          AND di.empty_brief_input_fingerprint = di.input_fingerprint
          AND di.empty_brief_attempts >= 2
        )
        AND di.state IN (
          'needs_lead_review', 'waiting_for_enrichment', 'budget_paused',
          'failed_research', 'failed_write', 'failed_rewrite'
        )`,
    [leadId],
  );
  if (items.rows.length === 0) return 0;

  let queued = 0;
  for (const row of items.rows) {
    const delivery = deliveryFromLeadVerification(
      row.email_primary,
      row.email_verification,
      row.email_status,
    );
    await dbQuery(
      `UPDATE outreach.drafting_items
          SET delivery_snapshot = $2::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [row.id, JSON.stringify(delivery)],
    );

    const reconciled = await reconcileDraftingWorkspaceQueue({
      workspaceId: row.workspace_id,
      ownerId: row.created_by,
      trigger: 'retry',
      idempotencyKey: `mailbox-promote:${row.id}:${Date.now()}`,
      itemIds: [row.id],
    });
    queued += reconciled.queued;
  }
  return queued;
}

/**
 * After AgentMail rate-limits one drafting verify, cancel remaining pending
 * verify_mailbox jobs for the run and fail-open those items into research.
 */
export async function failOpenRemainingDraftingMailboxVerifies(input: {
  workspaceId: string;
  draftingRunId: string;
  excludeItemId?: string;
}): Promise<string[]> {
  await dbQuery(
    `UPDATE outreach.drafting_jobs
        SET status = 'cancelled',
            finished_at = now(),
            last_error_code = 'mailbox_rate_limited',
            last_error_message = 'AgentMail rate limited — skipped remaining probes'
      WHERE drafting_run_id = $1
        AND kind = 'verify_mailbox'
        AND status = 'pending'
        AND ($2::uuid IS NULL OR drafting_item_id <> $2)`,
    [input.draftingRunId, input.excludeItemId ?? null],
  );

  await dbQuery(
    `UPDATE outreach.orchestration_jobs
        SET status = 'cancelled',
            lease_owner = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            finished_at = now(),
            updated_at = now()
      WHERE scope_key = $1
        AND kind = 'drafting.job.verify_mailbox'
        AND status = 'pending'`,
    [input.draftingRunId],
  );

  const { rows } = await dbQuery<{
    id: string;
    lead_id: string;
    delivery_snapshot: DeliverySnapshot | Record<string, unknown> | null;
  }>(
    `SELECT id, lead_id, delivery_snapshot
       FROM outreach.drafting_items
      WHERE workspace_id = $1
        AND removed_at IS NULL
        AND ($2::uuid IS NULL OR id <> $2)
        AND (
          state = 'verifying_mailbox'
          OR coalesce(delivery_snapshot->>'emailVerification', 'pending')
             IN ('pending', 'unknown', 'missing')
        )
        AND coalesce(delivery_snapshot->>'effectiveEmail', '') <> ''`,
    [input.workspaceId, input.excludeItemId ?? null],
  );

  const nextJobIds: string[] = [];
  for (const row of rows) {
    const delivery = parseDeliverySnapshot(row.delivery_snapshot);
    if (!delivery?.effectiveEmailFingerprint) continue;

    const updated = await applyItemScopedMailboxResult({
      itemId: row.id,
      expectedEmailFingerprint: delivery.effectiveEmailFingerprint,
      status: 'rate_limited',
      resultSource: 'agentmail_rate_limited',
    });
    if (!updated) continue;

    await dbTransaction(async (client) => {
      const promoted = await promoteVerifiedItem(client, {
        itemId: row.id,
        runId: input.draftingRunId,
      });
      if (promoted) nextJobIds.push(promoted);
      else await transitionItemState(client, row.id, 'needs_lead_review', false);
      await refreshCompletionTimestamps(client, input.workspaceId);
    });
  }

  return nextJobIds;
}

export async function promoteVerifiedItem(
  client: PoolClient,
  input: { itemId: string; runId: string },
): Promise<string | null> {
  const item = await client.query<DraftingItemRow>(
    `SELECT id, workspace_id, lead_id, ordinal, state, input_snapshot, input_overrides,
            missing_fields, input_fingerprint, input_revision, delivery_snapshot,
            review_status, removed_at, research_revision, draft_revision,
            last_error_code, empty_brief_attempts,
            empty_brief_input_fingerprint, empty_brief_last_at
     FROM outreach.drafting_items WHERE id = $1 FOR UPDATE`,
    [input.itemId],
  );
  const row = item.rows[0];
  if (!row) return null;
  if (
    row.input_fingerprint
    && isEmptyBriefQuarantined(
      {
        attempts: Number(row.empty_brief_attempts),
        inputFingerprint: row.empty_brief_input_fingerprint,
        lastErrorCode: row.last_error_code,
      },
      row.input_fingerprint,
    )
  ) {
    return null;
  }

  const delivery = parseDeliverySnapshot(row.delivery_snapshot);
  if (!isMailboxDraftable(delivery)) return null;

  // Verify → research must pass through queued_research (verifying_mailbox
  // cannot jump straight to researching).
  if (row.state === 'verifying_mailbox' || row.state === 'needs_lead_review') {
    await transitionItemState(client, row.id, 'queued_research', true);
  }

  const reservation = worstCaseResearchReservationUsd();
  return queueJob(client, {
    runId: input.runId,
    itemId: row.id,
    kind: 'research',
    idempotencyKey: `promote-research:${row.id}:${row.input_fingerprint}`,
    expectedInputFingerprint: row.input_fingerprint,
    reservedCostUsd: reservation,
    priority: 2,
  });
}

export async function saveResearchPacket(
  client: PoolClient,
  item: DraftingItemRow,
  packet: Record<string, unknown>,
  meta: {
    packetSha256: string;
    status: 'valid' | 'invalid' | 'stale';
    identityClassification?: string | null;
    resolutionLevel?: string | null;
    modelId?: string;
    promptVersion?: string;
    providerRequestId?: string;
    usage?: Record<string, unknown>;
    temporalAudit: ResearchTimelinessAudit;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO outreach.draft_research_packets (
       drafting_item_id, input_fingerprint, research_revision, schema_version, status,
       identity_classification, resolution_level, packet, packet_sha256, model_id,
       prompt_version, provider_request_id, usage, temporal_status, temporal_audit, researched_at
     ) VALUES ($1, $2, $3, '2', $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12::jsonb, $13, $14::jsonb, now())
     ON CONFLICT (drafting_item_id) DO UPDATE
       SET input_fingerprint = EXCLUDED.input_fingerprint,
           research_revision = EXCLUDED.research_revision,
           status = EXCLUDED.status,
           identity_classification = EXCLUDED.identity_classification,
           resolution_level = EXCLUDED.resolution_level,
           packet = EXCLUDED.packet,
           packet_sha256 = EXCLUDED.packet_sha256,
           model_id = EXCLUDED.model_id,
           prompt_version = EXCLUDED.prompt_version,
           provider_request_id = EXCLUDED.provider_request_id,
           usage = EXCLUDED.usage,
           schema_version = '2',
           temporal_status = EXCLUDED.temporal_status,
           temporal_audit = EXCLUDED.temporal_audit,
           researched_at = now(),
           updated_at = now()`,
    [
      item.id,
      item.input_fingerprint,
      item.research_revision + 1,
      meta.status,
      meta.identityClassification ?? null,
      meta.resolutionLevel ?? null,
      JSON.stringify(packet),
      meta.packetSha256,
      meta.modelId ?? null,
      meta.promptVersion ?? null,
      meta.providerRequestId ?? null,
      JSON.stringify(meta.usage ?? {}),
      meta.temporalAudit.status,
      JSON.stringify(meta.temporalAudit),
    ],
  );
  await client.query(
    `UPDATE outreach.drafting_items
     SET research_revision = research_revision + 1, updated_at = now()
     WHERE id = $1`,
    [item.id],
  );
}

export async function saveEmailDraft(
  client: PoolClient,
  item: DraftingItemRow,
  input: {
    subject: string;
    bodyText: string;
    packetSha256: string;
    generationNumber: number;
    resolutionUsed?: string | null;
    usedFactIds?: string[];
    claimLedger?: Record<string, unknown>;
    askForm?: string | null;
    lintResult: LintResult;
    modelId?: string;
    promptVersion?: string;
    providerRequestId?: string;
    generationMode: Exclude<DraftGenerationMode, 'legacy'>;
    usage?: Record<string, unknown>;
    temporalAudit: ResearchTimelinessAudit;
    grounding: DraftTemporalGrounding;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO outreach.email_drafts (
       drafting_item_id, input_fingerprint, research_packet_sha256, generation_number,
       content_revision, subject, body_text, resolution_used, used_fact_ids, claim_ledger,
       ask_form, lint_result, model_id, prompt_version, provider_request_id, usage,
       generation_mode, temporal_status, temporal_audit, draft_grounding,
       generated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13, $14, $15, $16::jsonb, $17, $18, $19::jsonb, $20::jsonb, now())
     ON CONFLICT (drafting_item_id) DO UPDATE
       SET input_fingerprint = EXCLUDED.input_fingerprint,
           research_packet_sha256 = EXCLUDED.research_packet_sha256,
           generation_number = EXCLUDED.generation_number,
           content_revision = email_drafts.content_revision + 1,
           subject = EXCLUDED.subject,
           body_text = EXCLUDED.body_text,
           resolution_used = EXCLUDED.resolution_used,
           used_fact_ids = EXCLUDED.used_fact_ids,
           claim_ledger = EXCLUDED.claim_ledger,
           ask_form = EXCLUDED.ask_form,
           lint_result = EXCLUDED.lint_result,
           model_id = EXCLUDED.model_id,
           prompt_version = EXCLUDED.prompt_version,
           provider_request_id = EXCLUDED.provider_request_id,
           usage = EXCLUDED.usage,
           generation_mode = EXCLUDED.generation_mode,
           temporal_status = EXCLUDED.temporal_status,
           temporal_audit = EXCLUDED.temporal_audit,
           draft_grounding = EXCLUDED.draft_grounding,
           grounding_status = 'model_validated',
           manually_edited = false,
           generated_at = now(),
           updated_at = now()`,
    [
      item.id,
      item.input_fingerprint,
      input.packetSha256,
      input.generationNumber,
      item.draft_revision + 1,
      input.subject,
      input.bodyText,
      input.resolutionUsed ?? null,
      input.usedFactIds ?? [],
      JSON.stringify(input.claimLedger ?? {}),
      input.askForm ?? null,
      JSON.stringify(input.lintResult),
      input.modelId ?? null,
      input.promptVersion ?? null,
      input.providerRequestId ?? null,
      JSON.stringify(input.usage ?? {}),
      input.generationMode,
      input.temporalAudit.status,
      JSON.stringify(input.temporalAudit),
      JSON.stringify(input.grounding),
    ],
  );
  await client.query(
    `UPDATE outreach.drafting_items
     SET draft_revision = draft_revision + 1, updated_at = now()
     WHERE id = $1`,
    [item.id],
  );
}

export type CancelDraftingCampaignResult = {
  campaign_id: string;
  workspace_id: string;
  orchestration_jobs_cancelled: number;
  drafting_jobs_cancelled: number;
  runs_closed: number;
  items_paused: number;
};

/**
 * Operator stop: cancel all pending/in-flight drafting work for a campaign so
 * infrastructure changes can land without the worker continuing the run.
 */
export async function cancelDraftingCampaign(
  campaignId: string,
  reason = 'cancelled_by_operator',
): Promise<CancelDraftingCampaignResult> {
  return dbTransaction(async (client) => {
    const workspace = await client.query<{ id: string }>(
      `SELECT id FROM outreach.drafting_workspaces WHERE campaign_id = $1 FOR UPDATE`,
      [campaignId],
    );
    if (!workspace.rows[0]) {
      throw new DraftingNotFoundError('Drafting workspace not found');
    }
    const workspaceId = workspace.rows[0].id;

    const runs = await client.query<{ id: string }>(
      `SELECT id FROM outreach.drafting_runs WHERE workspace_id = $1`,
      [workspaceId],
    );
    const runIds = runs.rows.map((row) => row.id);

    let orchestrationCancelled = 0;
    if (runIds.length > 0) {
      const runScopeKeys = runIds.map((id) => String(id));
      const orch = await client.query(
        `UPDATE outreach.orchestration_jobs
            SET status = 'cancelled',
                lease_owner = NULL,
                lease_expires_at = NULL,
                heartbeat_at = NULL,
                finished_at = now(),
                last_error_code = $2,
                last_error_message = 'Drafting run cancelled by operator',
                updated_at = now()
          WHERE status IN ('pending', 'in_flight')
            AND (
              scope_key = ANY($1::text[])
              OR payload->>'campaignId' = $3
            )`,
        [runScopeKeys, reason, campaignId],
      );
      orchestrationCancelled = orch.rowCount ?? 0;
    }

    const jobs = await client.query(
      `UPDATE outreach.drafting_jobs j
          SET status = 'cancelled',
              finished_at = now(),
              last_error_code = $2,
              last_error_message = 'Drafting run cancelled by operator'
        FROM outreach.drafting_runs r
       WHERE j.drafting_run_id = r.id
         AND r.workspace_id = $1
         AND j.status IN ('pending', 'in_flight', 'claimed')`,
      [workspaceId, reason],
    );

    const items = await client.query(
      `UPDATE outreach.drafting_items
          SET state = 'budget_paused',
              last_error_code = $2,
              last_error_message = 'Drafting paused by operator',
              drafting_execution_owner = NULL,
              drafting_execution_expires_at = NULL,
              updated_at = now()
        WHERE workspace_id = $1
          AND removed_at IS NULL
          AND state = ANY($3::text[])`,
      [workspaceId, reason, [...RUNNING_STATES, 'queued_research', 'queued_write', 'queued_rewrite', 'verifying_mailbox', 'waiting_company_research']],
    );

    const closedRuns = await client.query(
      `UPDATE outreach.drafting_runs
          SET status = 'partial',
              finished_at = coalesce(finished_at, now())
        WHERE workspace_id = $1
          AND status = 'active'`,
      [workspaceId],
    );

    await client.query(
      `DELETE FROM outreach.drafting_company_research_leases
        WHERE workspace_id = $1`,
      [workspaceId],
    );

    return {
      campaign_id: campaignId,
      workspace_id: workspaceId,
      orchestration_jobs_cancelled: orchestrationCancelled,
      drafting_jobs_cancelled: jobs.rowCount ?? 0,
      runs_closed: closedRuns.rowCount ?? 0,
      items_paused: items.rowCount ?? 0,
    };
  });
}

export type PauseDraftingWorkspaceResult = {
  campaign_id: string;
  workspace_id: string;
  orchestration_jobs_cancelled: number;
  drafting_jobs_cancelled: number;
  execution_locks_cleared: number;
  already_paused: boolean;
};

export type ResumeDraftingWorkspaceResult = import('@/lib/drafting/rescue').DraftingRescueResult;

/**
 * User pause: stop in-flight work but preserve item FSM positions for resume.
 */
export async function pauseDraftingWorkspace(
  campaignId: string,
  ownerId: string,
): Promise<PauseDraftingWorkspaceResult> {
  await assertCampaignOwned(campaignId, ownerId);

  const paused = await dbTransaction(async (client) => {
    const workspace = await client.query<{ id: string; status: string }>(
      `SELECT w.id, w.status
         FROM outreach.drafting_workspaces w
         JOIN outreach.campaigns c ON c.id = w.campaign_id
        WHERE w.campaign_id = $1
          AND c.owner_id = $2
        FOR UPDATE OF w`,
      [campaignId, ownerId],
    );
    if (!workspace.rows[0]) {
      throw new DraftingNotFoundError('Drafting workspace not found');
    }
    const workspaceId = workspace.rows[0].id;
    if (workspace.rows[0].status === 'paused') {
      return {
        campaign_id: campaignId,
        workspace_id: workspaceId,
        orchestration_jobs_cancelled: 0,
        drafting_jobs_cancelled: 0,
        execution_locks_cleared: 0,
        already_paused: true,
      };
    }
    if (workspace.rows[0].status !== 'active') {
      throw new DraftingValidationError('Only an active drafting workspace can be paused');
    }

    const runs = await client.query<{ id: string }>(
      `SELECT id FROM outreach.drafting_runs WHERE workspace_id = $1`,
      [workspaceId],
    );
    const runIds = runs.rows.map((row) => row.id);

    let orchestrationCancelled = 0;
    if (runIds.length > 0) {
      const orch = await client.query(
        `UPDATE outreach.orchestration_jobs
            SET status = 'cancelled',
                lease_owner = NULL,
                lease_expires_at = NULL,
                heartbeat_at = NULL,
                finished_at = now(),
                last_error_code = 'workspace_paused',
                last_error_message = 'Drafting workspace paused by user',
                updated_at = now()
          WHERE status IN ('pending', 'in_flight')
            AND (
              scope_key = ANY($1::text[])
              OR payload->>'campaignId' = $2
            )`,
        [runIds.map(String), campaignId],
      );
      orchestrationCancelled = orch.rowCount ?? 0;
    }

    const jobs = await client.query(
      `UPDATE outreach.drafting_jobs j
          SET status = 'cancelled',
              finished_at = now(),
              last_error_code = 'workspace_paused',
              last_error_message = 'Drafting workspace paused by user'
        FROM outreach.drafting_runs r
       WHERE j.drafting_run_id = r.id
         AND r.workspace_id = $1
         AND j.status IN ('pending', 'in_flight', 'claimed')`,
      [workspaceId],
    );

    const locks = await client.query(
      `UPDATE outreach.drafting_items
          SET drafting_execution_owner = NULL,
              drafting_execution_expires_at = NULL,
              updated_at = now()
        WHERE workspace_id = $1
          AND removed_at IS NULL
          AND (
            drafting_execution_owner IS NOT NULL
            OR drafting_execution_expires_at IS NOT NULL
          )`,
      [workspaceId],
    );

    await client.query(
      `UPDATE outreach.drafting_workspaces
          SET status = 'paused',
              paused_at = now(),
              paused_by = $2,
              updated_at = now()
        WHERE id = $1`,
      [workspaceId, ownerId],
    );

    return {
      campaign_id: campaignId,
      workspace_id: workspaceId,
      orchestration_jobs_cancelled: orchestrationCancelled,
      drafting_jobs_cancelled: jobs.rowCount ?? 0,
      execution_locks_cleared: locks.rowCount ?? 0,
      already_paused: false,
    };
  });

  return paused;
}

/** User resume: unpause workspace then run the standard rescue/reconcile path. */
export async function resumeDraftingWorkspace(
  campaignId: string,
  ownerId: string,
): Promise<ResumeDraftingWorkspaceResult> {
  await assertCampaignOwned(campaignId, ownerId);

  await dbTransaction(async (client) => {
    const workspace = await client.query<{ id: string; status: string }>(
      `SELECT w.id, w.status
         FROM outreach.drafting_workspaces w
         JOIN outreach.campaigns c ON c.id = w.campaign_id
        WHERE w.campaign_id = $1
          AND c.owner_id = $2
        FOR UPDATE OF w`,
      [campaignId, ownerId],
    );
    if (!workspace.rows[0]) {
      throw new DraftingNotFoundError('Drafting workspace not found');
    }
    if (workspace.rows[0].status === 'paused') {
      await client.query(
        `UPDATE outreach.drafting_workspaces
            SET status = 'active',
                paused_at = NULL,
                paused_by = NULL,
                updated_at = now()
          WHERE id = $1`,
        [workspace.rows[0].id],
      );
    }
  });

  const { rescueDraftingWorkspace } = await import('@/lib/drafting/rescue');
  return rescueDraftingWorkspace(campaignId, ownerId);
}

export type CancelDraftingRunResult = {
  campaign_id: string;
  workspace_id: string;
  orchestration_jobs_cancelled: number;
  items_deleted: number;
  runs_deleted: number;
};

/**
 * User cancel run (while paused): tear down the drafting workspace so the
 * campaign returns to the pre–Go to Drafting state.
 */
export async function cancelDraftingRun(
  campaignId: string,
  ownerId: string,
): Promise<CancelDraftingRunResult> {
  await assertCampaignOwned(campaignId, ownerId);

  return dbTransaction(async (client) => {
    const workspace = await client.query<{ id: string; status: string }>(
      `SELECT w.id, w.status
         FROM outreach.drafting_workspaces w
         JOIN outreach.campaigns c ON c.id = w.campaign_id
        WHERE w.campaign_id = $1
          AND c.owner_id = $2
        FOR UPDATE OF w`,
      [campaignId, ownerId],
    );
    if (!workspace.rows[0]) {
      throw new DraftingNotFoundError('Drafting workspace not found');
    }
    if (workspace.rows[0].status !== 'paused') {
      throw new DraftingValidationError('Cancel Run is only available while drafting is paused');
    }
    const workspaceId = workspace.rows[0].id;

    const runs = await client.query<{ id: string }>(
      `SELECT id FROM outreach.drafting_runs WHERE workspace_id = $1`,
      [workspaceId],
    );
    const runIds = runs.rows.map((row) => row.id);

    let orchestrationCancelled = 0;
    if (runIds.length > 0) {
      const orch = await client.query(
        `UPDATE outreach.orchestration_jobs
            SET status = 'cancelled',
                lease_owner = NULL,
                lease_expires_at = NULL,
                heartbeat_at = NULL,
                finished_at = now(),
                last_error_code = 'drafting_run_cancelled',
                last_error_message = 'Drafting run cancelled by user',
                updated_at = now()
          WHERE status IN ('pending', 'in_flight')
            AND (
              scope_key = ANY($1::text[])
              OR payload->>'campaignId' = $2
            )`,
        [runIds.map(String), campaignId],
      );
      orchestrationCancelled = orch.rowCount ?? 0;
    }

    await client.query(
      `UPDATE outreach.orchestration_jobs
          SET status = 'cancelled',
              lease_owner = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              finished_at = now(),
              last_error_code = 'drafting_run_cancelled',
              last_error_message = 'Drafting run cancelled by user',
              updated_at = now()
        WHERE status IN ('pending', 'in_flight')
          AND (
            scope_key = $1
            OR payload->>'campaignId' = $1
          )`,
      [campaignId],
    );

    await client.query(
      `DELETE FROM outreach.email_drafts ed
        USING outreach.drafting_items di
       WHERE ed.drafting_item_id = di.id
         AND di.workspace_id = $1`,
      [workspaceId],
    );
    await client.query(
      `DELETE FROM outreach.draft_research_packets drp
        USING outreach.drafting_items di
       WHERE drp.drafting_item_id = di.id
         AND di.workspace_id = $1`,
      [workspaceId],
    );
    await client.query(
      `DELETE FROM outreach.drafting_jobs j
        USING outreach.drafting_runs r
       WHERE j.drafting_run_id = r.id
         AND r.workspace_id = $1`,
      [workspaceId],
    );
    await client.query(
      `DELETE FROM outreach.drafting_run_items dri
        USING outreach.drafting_runs r
       WHERE dri.drafting_run_id = r.id
         AND r.workspace_id = $1`,
      [workspaceId],
    );
    const deletedRuns = await client.query(
      `DELETE FROM outreach.drafting_runs WHERE workspace_id = $1`,
      [workspaceId],
    );
    await client.query(
      `DELETE FROM outreach.drafting_company_research_leases WHERE workspace_id = $1`,
      [workspaceId],
    );
    const deletedItems = await client.query(
      `DELETE FROM outreach.drafting_items WHERE workspace_id = $1`,
      [workspaceId],
    );
    await client.query(
      `DELETE FROM outreach.drafting_workspaces WHERE id = $1`,
      [workspaceId],
    );

    return {
      campaign_id: campaignId,
      workspace_id: workspaceId,
      orchestration_jobs_cancelled: orchestrationCancelled,
      items_deleted: deletedItems.rowCount ?? 0,
      runs_deleted: deletedRuns.rowCount ?? 0,
    };
  });
}

