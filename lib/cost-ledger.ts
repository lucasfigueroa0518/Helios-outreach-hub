import { dbQuery } from '@/lib/db';
import { formatUsd } from '@/lib/drafting/cost';
import { estimateEnrichmentJobCostUsd } from '@/lib/cost-ledger-pricing';
import {
  estimateCampaignCostFlatFallback,
  estimateCampaignCostFromLeads,
  type CostLeadInput,
  type PathCostEstimate,
} from '@/lib/path-cost-estimate';
import { normalizeCompanyName } from '@/lib/research-types';

/** @deprecated Retired for estimates — ledger still records actuals. Kept for callers/scripts. */
export const COST_LEDGER_WINDOW = 100;

export type CostPhase = 'enrichment' | 'drafting';

export type CampaignCostEstimate = PathCostEstimate;

export { estimateEnrichmentJobCostUsd };

export async function recordLeadCostEvent(input: {
  leadId: string;
  campaignId?: string | null;
  phase: CostPhase;
  actualCostUsd: string | number;
  sourceKind: string;
  sourceId: string;
  usage?: Record<string, unknown>;
}): Promise<boolean> {
  const cost = formatUsd(Number(input.actualCostUsd));
  if (!(Number(cost) >= 0)) return false;
  const { rowCount } = await dbQuery(
    `INSERT INTO outreach.lead_cost_events (
       lead_id, campaign_id, phase, actual_cost_usd, usage, source_kind, source_id
     ) VALUES ($1, $2, $3, $4::numeric, $5::jsonb, $6, $7)
     ON CONFLICT (phase, source_kind, source_id, lead_id) DO UPDATE SET
       actual_cost_usd = greatest(
         outreach.lead_cost_events.actual_cost_usd,
         EXCLUDED.actual_cost_usd
       ),
       usage = EXCLUDED.usage,
       campaign_id = coalesce(EXCLUDED.campaign_id, outreach.lead_cost_events.campaign_id)`,
    [
      input.leadId,
      input.campaignId ?? null,
      input.phase,
      cost,
      JSON.stringify(input.usage ?? {}),
      input.sourceKind,
      input.sourceId,
    ],
  );
  return (rowCount ?? 0) > 0;
}

/** Sum immutable drafting spend events for an item into its analytics summary. */
export async function recordDraftingItemCost(itemId: string): Promise<void> {
  const { rows } = await dbQuery<{
    lead_id: string;
    campaign_id: string;
    cost_usd: string;
  }>(
    `SELECT i.lead_id, w.campaign_id,
            coalesce(sum(e.actual_cost_usd), 0)::text AS cost_usd
     FROM outreach.drafting_items i
     JOIN outreach.drafting_workspaces w ON w.id = i.workspace_id
     LEFT JOIN outreach.drafting_job_cost_events e
       ON e.drafting_item_id = i.id
     WHERE i.id = $1
     GROUP BY i.lead_id, w.campaign_id`,
    [itemId],
  );
  const row = rows[0];
  if (!row || Number(row.cost_usd) <= 0) return;
  await recordLeadCostEvent({
    leadId: row.lead_id,
    campaignId: row.campaign_id,
    phase: 'drafting',
    actualCostUsd: row.cost_usd,
    sourceKind: 'drafting_item',
    sourceId: itemId,
    usage: { aggregatedFromJobs: true },
  });
}

/**
 * Attribute one finished company-research job cost across leads in the requesting runs
 * that belong to that company.
 */
export async function recordEnrichmentJobCost(input: {
  jobId: string;
  companyKey: string;
  runIds: string[];
  searchesUsed: number;
  inputTokens?: number;
  outputTokens?: number;
}): Promise<void> {
  if (!input.runIds.length) return;
  const priced = estimateEnrichmentJobCostUsd({
    searchesUsed: input.searchesUsed,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
  });

  await dbQuery(
    `UPDATE outreach.company_research_jobs
     SET actual_cost_usd = $2::numeric,
         usage = coalesce(usage, '{}'::jsonb) || $3::jsonb,
         updated_at = now()
     WHERE id = $1`,
    [input.jobId, priced.costUsd, JSON.stringify(priced.usage)],
  );

  const { rows: runLeads } = await dbQuery<{
    lead_id: string;
    campaign_id: string;
    company_name: string | null;
  }>(
    `SELECT DISTINCT l.id AS lead_id, r.campaign_id, l.company_name
     FROM outreach.runs r
     JOIN outreach.campaign_leads cl ON cl.campaign_id = r.campaign_id AND cl.run_id = r.id
     JOIN outreach.leads l ON l.id = cl.lead_id
     WHERE r.id = ANY($1::uuid[])`,
    [input.runIds],
  );

  const matched = runLeads.filter((row) =>
    `company:${normalizeCompanyName(row.company_name ?? '')}` === input.companyKey,
  );
  // Fallback: all leads on the requesting runs if company-key match is empty.
  const targets = matched.length ? matched : runLeads;

  if (!targets.length) return;
  const share = formatUsd(Number(priced.costUsd) / targets.length);
  for (const target of targets) {
    await recordLeadCostEvent({
      leadId: target.lead_id,
      campaignId: target.campaign_id,
      phase: 'enrichment',
      actualCostUsd: share,
      sourceKind: 'company_research_job',
      sourceId: input.jobId,
      usage: {
        ...priced.usage,
        allocatedShareUsd: share,
        allocatedAcrossLeads: targets.length,
        companyKey: input.companyKey,
      },
    });
  }
}

async function loadCampaignCostLeads(campaignId: string): Promise<CostLeadInput[]> {
  const { rows } = await dbQuery<{
    id: string;
    full_name: string | null;
    email_primary: string | null;
    company_name: string | null;
    title: string | null;
    location: string | null;
    email_status: string | null;
  }>(
    `SELECT l.id,
            l.full_name,
            l.email_primary,
            l.company_name,
            l.title,
            l.location,
            l.email_status
     FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     WHERE cl.campaign_id = $1
     ORDER BY l.id`,
    [campaignId],
  );

  return rows.map((row) => {
    const hasIdentity =
      Boolean(row.company_name?.trim())
      && Boolean(row.title?.trim())
      && Boolean(row.email_primary?.trim());
    const skipEnrichment = hasIdentity
      && (row.email_status === 'direct' || row.email_status === 'from_embark_db');
    return {
      id: row.id,
      fullName: row.full_name,
      email: row.email_primary,
      companyName: row.company_name,
      title: row.title,
      location: row.location,
      skipEnrichment,
    };
  });
}

/**
 * Pre-run USD estimate for a campaign.
 * Prefers path-bucket composition from loaded leads; falls back to flat model × count
 * when only an upload people_found count is available.
 */
export async function getCampaignCostEstimate(input: {
  campaignId: string;
  fallbackLeadCount?: number;
}): Promise<CampaignCostEstimate> {
  const leads = await loadCampaignCostLeads(input.campaignId);
  if (leads.length > 0) {
    return estimateCampaignCostFromLeads(leads);
  }
  return estimateCampaignCostFlatFallback(input.fallbackLeadCount ?? 0);
}

/** One-time bootstrap from immutable drafting cost events (idempotent). */
export async function backfillDraftingCostsFromJobs(): Promise<number> {
  const { rows } = await dbQuery<{ item_id: string }>(
    `SELECT DISTINCT e.drafting_item_id AS item_id
     FROM outreach.drafting_job_cost_events e
     WHERE e.actual_cost_usd > 0`,
  );
  let written = 0;
  for (const row of rows) {
    const before = await dbQuery<{ id: string }>(
      `SELECT id FROM outreach.lead_cost_events
       WHERE phase = 'drafting' AND source_kind = 'drafting_item' AND source_id = $1
       LIMIT 1`,
      [row.item_id],
    );
    if (before.rows[0]) continue;
    await recordDraftingItemCost(row.item_id);
    written += 1;
  }
  return written;
}
