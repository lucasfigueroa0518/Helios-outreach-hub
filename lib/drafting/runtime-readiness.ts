import { dbQuery } from '@/lib/db';
import { hasHealthyWorker } from '@/lib/orchestration/repository';

/** Go-to-Drafting requires a healthy durable Postgres orchestration worker. */
export type DraftingRuntimeReadiness = {
  ready: boolean;
  orchestrator: 'postgres';
  worker_healthy: boolean;
  schema_compatible: boolean;
  batch_budget_usd: string;
  draft_research_concurrency: number;
  mode: string;
  blockers: string[];
};

async function hasCompatibleDraftingSchema(): Promise<boolean> {
  const { rows } = await dbQuery<{ present: number }>(
    `SELECT count(*)::int AS present
       FROM information_schema.columns
      WHERE table_schema = 'outreach'
        AND (table_name, column_name) IN (
          ('draft_research_packets', 'temporal_status'),
          ('draft_research_packets', 'temporal_audit'),
          ('email_drafts', 'temporal_status'),
          ('email_drafts', 'temporal_audit'),
          ('email_drafts', 'draft_grounding'),
          ('email_drafts', 'generation_mode')
        )`,
  );
  return rows[0]?.present === 6;
}

export async function getDraftingRuntimeReadiness(): Promise<DraftingRuntimeReadiness> {
  const batchBudget = process.env.DRAFTING_DEFAULT_BATCH_BUDGET_USD ?? '50.0000';
  const concurrency = Math.max(1, Number(process.env.ORG_DRAFT_RESEARCH_CONCURRENCY ?? 4));
  const mode = process.env.DRAFTING_MODE ?? 'stub';
  const orchestrator = process.env.ORCHESTRATOR?.trim().toLowerCase() || 'postgres';
  const blockers: string[] = [];
  let workerHealthy = false;
  let schemaCompatible = false;

  if (orchestrator !== 'postgres') {
    blockers.push(`ORCHESTRATOR must be postgres, not ${orchestrator}`);
  }
  try {
    schemaCompatible = await hasCompatibleDraftingSchema();
  } catch {
    schemaCompatible = false;
  }
  if (!schemaCompatible) {
    blockers.push('Drafting database schema is incomplete; apply the drafting migrations');
  }
  try {
    workerHealthy = await hasHealthyWorker();
  } catch {
    blockers.push('Postgres orchestration schema is not installed');
  }
  if (!workerHealthy && blockers.length === 0) {
    blockers.push('No healthy orchestration worker is running');
  }
  if (mode !== 'live') {
    blockers.push('DRAFTING_MODE must be live for real drafting');
  }

  return {
    ready: blockers.length === 0,
    orchestrator: 'postgres',
    worker_healthy: workerHealthy,
    schema_compatible: schemaCompatible,
    batch_budget_usd: batchBudget,
    draft_research_concurrency: concurrency,
    mode,
    blockers,
  };
}
