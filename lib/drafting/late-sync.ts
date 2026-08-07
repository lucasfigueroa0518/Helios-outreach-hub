import type { DraftingItemState } from '@/lib/drafting/types';

/** Idle states the lead-sync upsert may promote to queued_research. */
export const IDLE_STATES_PROMOTABLE_ON_SYNC = [
  'needs_lead_review',
  'waiting_for_enrichment',
  'budget_paused',
  'failed_research',
  'failed_write',
  'failed_rewrite',
] as const satisfies readonly DraftingItemState[];

/**
 * Mirrors the ON CONFLICT state CASE in syncCampaignLeadsIntoDraftingWorkspace:
 * never clobber in-flight / already-generated states; only promote idle → queued_research.
 */
export function resolveItemStateAfterLeadSync(
  existingState: DraftingItemState | null,
  desiredState: DraftingItemState,
): DraftingItemState {
  if (!existingState) return desiredState;
  if (
    (IDLE_STATES_PROMOTABLE_ON_SYNC as readonly string[]).includes(existingState)
    && desiredState === 'queued_research'
  ) {
    return desiredState;
  }
  return existingState;
}

export function lateSyncIdempotencyKey(workspaceId: string, sourceRunId: string): string {
  return `late-sync:${workspaceId}:${sourceRunId}`;
}

/** Paused workspaces still upsert items but must not dispatch research jobs. */
export function shouldDispatchJobsAfterLeadSync(workspaceStatus: string): boolean {
  return workspaceStatus !== 'paused';
}

/**
 * Control-flow for pre-enriched ingest when late uploads may already have a workspace.
 * requireUploads is false when prior complete pre-enriched leads exist (re-Go to Draft
 * with no new staging run); late staging runs are still processed when present.
 */
export function preEnrichedIngestPlan(input: {
  workspaceExists: boolean;
  hasExistingLeads: boolean;
  hasCompletePreEnrichedRun: boolean;
}): {
  requireUploads: boolean;
  useSyncHelper: boolean;
} {
  return {
    requireUploads: !(input.hasExistingLeads && input.hasCompletePreEnrichedRun),
    useSyncHelper: input.workspaceExists,
  };
}
