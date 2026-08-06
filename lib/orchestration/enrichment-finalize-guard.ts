import { dbQuery } from '@/lib/db';

/**
 * Orch kinds that mean enrichment is still preparing or researching.
 * Presence of any pending/in_flight job in this set must block run.finalize.
 * (run.finalize / mailbox / domain.verify are intentionally excluded.)
 */
export const OPEN_ENRICHMENT_ORCH_KINDS = [
  'run.enrich',
  'run.prepare',
  'run.process',
  'upload.extract',
  'research.company',
  'research.profile_rescue',
  'research.email_rescue',
] as const;

export type OpenEnrichmentWork = {
  researchJobs: number;
  orchJobs: number;
};

/** Pure predicate — used by reconcile + finalize + unit tests. */
export function canFinalizeEnrichingRun(work: OpenEnrichmentWork): boolean {
  return work.researchJobs <= 0 && work.orchJobs <= 0;
}

export async function countOpenEnrichmentWork(runId: string): Promise<OpenEnrichmentWork> {
  const { rows } = await dbQuery<{ research_jobs: number; orch_jobs: number }>(
    `SELECT
       (
         SELECT count(*)::int
           FROM outreach.company_research_jobs research
          WHERE $1::uuid = ANY(research.requested_by_runs)
            AND research.status IN ('pending', 'in_flight')
       ) AS research_jobs,
       (
         SELECT count(*)::int
           FROM outreach.orchestration_jobs oj
          WHERE oj.scope_key = $1::text
            AND oj.kind = ANY($2::text[])
            AND oj.status IN ('pending', 'in_flight')
       ) AS orch_jobs`,
    [runId, [...OPEN_ENRICHMENT_ORCH_KINDS]],
  );
  return {
    researchJobs: rows[0]?.research_jobs ?? 0,
    orchJobs: rows[0]?.orch_jobs ?? 0,
  };
}
