/**
 * User-facing drafting workspace pause/resume — shared copy and guards.
 * Dual-port: lucas-outreach-hub ↔ backend/src/services/outreach/drafting/workspace-pause.ts
 */

export const WORKSPACE_PAUSED_MESSAGE =
  'Drafting is paused. Click Resume to continue where you left off.';

export const WORKSPACE_CANCEL_RUN_MESSAGE =
  'Cancel Run discards this drafting session and returns you to Review (before Go to Drafting).';

export function isDraftingWorkspacePaused(status: string | null | undefined): boolean {
  return status === 'paused';
}

export function canPauseDraftingWorkspace(status: string | null | undefined): boolean {
  return status === 'active';
}
