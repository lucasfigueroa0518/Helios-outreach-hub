/**
 * Structured pipeline telemetry for Campaign cost / inefficiency analysis.
 *
 * Enrichment writes:
 *   - runs.stats.enrichment.insight  (counters)
 *   - company_research_jobs.usage.insight  (per-job decision trail)
 *   - lead_cost_events.usage.insight       (when cost is attributed)
 *
 * Drafting writes:
 *   - drafting_jobs.usage.insight / research packet usage.insight
 */

export const PIPELINE_TELEMETRY_VERSION = 'campaign-insight-v1';

export type EnrichmentPathKind =
  | 'research_enqueued'
  | 'cache_hit'
  | 'known_domain_skip'
  | 'scrape_preflight_resolved'
  | 'i4_not_found'
  | 'profile_rescue'
  | 'email_rescue';

export type EnrichmentJobInsight = {
  telemetryVersion: typeof PIPELINE_TELEMETRY_VERSION;
  phase: 'enrichment';
  capturedAt: string;
  jobKind: string;
  companyKey: string | null;
  path: EnrichmentPathKind | null;
  hardGaps: string[];
  softGaps: string[];
  requestedFields: string[];
  opportunisticFields: string[];
  leadCount: number;
  budget: {
    assigned: number;
    used: number | null;
    remainingBefore: number | null;
    floorApplied: boolean;
    hardUnresolvedBeforeBudget: number;
  };
  decisions: {
    needsHardProfileResearch: boolean;
    scrapePreflightCompleted: boolean;
    knownDomainSkipResearch: boolean;
    profileRescueEnqueued: number;
    profileRescueSkipped: number;
    profileRescueSkipReasons: string[];
    emailRescueEnqueued: number;
    followupsEnqueued: number;
  };
  provider: {
    modelId: string | null;
    promptVersion: string | null;
    searchesUsed: number | null;
    costUsd: string | null;
  };
  timingsMs: {
    researchMs: number | null;
    totalMs: number | null;
  };
};

export type DraftingItemInsight = {
  telemetryVersion: typeof PIPELINE_TELEMETRY_VERSION;
  phase: 'drafting';
  capturedAt: string;
  researchPath: 'sibling_skip' | 'company_reuse' | 'fresh' | 'fresh_after_reuse_miss';
  siblingSkip: boolean;
  companyReuse: {
    attempted: boolean;
    hit: boolean;
    sourceDraftingItemId: string | null;
    missReason: string | null;
  };
  protocolBudget: {
    maxCalls: number;
    maxSearches: number | null;
    cheapPath: boolean;
    reportMaxTokens: number | null;
  };
  adversarial: {
    mode: 'full' | 'light' | 'skip';
    reason: string;
    searchesUsed: number;
    keep: number;
    drop: number;
  };
  write: {
    writeBlocked: boolean;
    needsResearchUpgrade: boolean;
    repairClass: 'none' | 'mechanical' | 'judgment' | 'mixed' | 'skipped_judgment';
    lintBlockingCodes: string[];
    autoRepairAttempted: boolean;
  };
  stagesMs: Record<string, number>;
  costs: {
    researchUsd: string | null;
    adversarialUsd: string | null;
    writeUsd: string | null;
    totalUsd: string | null;
  };
};

export function emptyEnrichmentInsightCounters(): Record<string, number> {
  return {
    telemetry_version: 1,
    path_research_enqueued: 0,
    path_cache_hit: 0,
    path_known_domain_skip: 0,
    path_scrape_preflight_resolved: 0,
    path_i4_not_found: 0,
    path_i4_retry_missing_email: 0,
    hard_gap_batches: 0,
    soft_only_gap_batches: 0,
    budget_floor_applied: 0,
    research_jobs_started: 0,
    research_jobs_done: 0,
    research_jobs_failed: 0,
    profile_rescue_enqueued: 0,
    profile_rescue_skipped: 0,
    email_rescue_enqueued: 0,
    followups_enqueued: 0,
    sibling_draft_skip: 0,
    drafting_company_reuse_hit: 0,
    drafting_company_reuse_miss: 0,
    drafting_fresh_research: 0,
    drafting_adversarial_full: 0,
    drafting_adversarial_light: 0,
    drafting_adversarial_skip: 0,
    drafting_mechanical_repair: 0,
    drafting_judgment_no_repair: 0,
    drafting_write_blocked: 0,
  };
}

export function buildEnrichmentJobInsight(
  partial: Omit<EnrichmentJobInsight, 'telemetryVersion' | 'phase' | 'capturedAt'> & {
    capturedAt?: string;
  },
): EnrichmentJobInsight {
  return {
    telemetryVersion: PIPELINE_TELEMETRY_VERSION,
    phase: 'enrichment',
    capturedAt: partial.capturedAt ?? new Date().toISOString(),
    ...partial,
  };
}

export function buildDraftingItemInsight(
  partial: Omit<DraftingItemInsight, 'telemetryVersion' | 'phase' | 'capturedAt'> & {
    capturedAt?: string;
  },
): DraftingItemInsight {
  return {
    telemetryVersion: PIPELINE_TELEMETRY_VERSION,
    phase: 'drafting',
    capturedAt: partial.capturedAt ?? new Date().toISOString(),
    ...partial,
  };
}

export function logPipelineInsight(
  scope: 'enrich' | 'draft' | 'write',
  summary: string,
  payload: Record<string, unknown>,
): void {
  console.warn(`[pipeline-insight:${scope}] ${summary} ${JSON.stringify(payload)}`);
}
