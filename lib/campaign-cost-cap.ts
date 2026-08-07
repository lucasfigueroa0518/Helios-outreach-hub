/**
 * Hard $50 campaign cost gate — estimate before Enrich / Go to Draft,
 * block late uploads when at or over cap.
 */

import { dbQuery } from '@/lib/db';
import {
  getCampaignCostEstimate,
  type CampaignCostEstimate,
} from '@/lib/cost-ledger';
import { formatUsd } from '@/lib/drafting/cost';

export const CAMPAIGN_COST_CAP_USD = 50;

const MIN_HISTORICAL_SAMPLE = 20;

export type HistoricalLeadAverages = {
  enrichment_avg_usd: number | null;
  drafting_avg_usd: number | null;
  enrichment_sample: number;
  drafting_sample: number;
};

export type CampaignCostGate = {
  cap_usd: number;
  lead_count: number;
  estimated_total_usd: number;
  per_lead_usd: number;
  remaining_usd: number;
  over_cap: boolean;
  at_or_over_cap: boolean;
  leads_to_remove: number;
  method: 'historical_avg' | CampaignCostEstimate['method'];
  note: string;
  estimate: CampaignCostEstimate;
};

export function leadsToRemoveForCap(input: {
  estimatedTotalUsd: number;
  perLeadUsd: number;
  capUsd?: number;
}): number {
  const cap = input.capUsd ?? CAMPAIGN_COST_CAP_USD;
  if (!(input.estimatedTotalUsd > cap)) return 0;
  const perLead = Math.max(input.perLeadUsd, 0.0001);
  return Math.max(1, Math.ceil((input.estimatedTotalUsd - cap) / perLead));
}

export async function loadHistoricalLeadAverages(): Promise<HistoricalLeadAverages> {
  const { rows } = await dbQuery<{
    phase: string;
    avg_usd: string;
    sample_size: string;
  }>(
    `SELECT phase,
            avg(actual_cost_usd)::text AS avg_usd,
            count(*)::text AS sample_size
       FROM outreach.lead_cost_events
      WHERE actual_cost_usd > 0
        AND phase IN ('enrichment', 'drafting')
      GROUP BY phase`,
  );
  const enrichment = rows.find((row) => row.phase === 'enrichment');
  const drafting = rows.find((row) => row.phase === 'drafting');
  return {
    enrichment_avg_usd: enrichment ? Number(enrichment.avg_usd) : null,
    drafting_avg_usd: drafting ? Number(drafting.avg_usd) : null,
    enrichment_sample: enrichment ? Number(enrichment.sample_size) : 0,
    drafting_sample: drafting ? Number(drafting.sample_size) : 0,
  };
}

export async function buildCampaignCostGate(input: {
  campaignId: string;
  needsEnrichment: boolean;
  fallbackLeadCount?: number;
}): Promise<CampaignCostGate> {
  const estimate = await getCampaignCostEstimate({
    campaignId: input.campaignId,
    fallbackLeadCount: input.fallbackLeadCount,
  });
  const historical = await loadHistoricalLeadAverages();

  let method: CampaignCostGate['method'] = estimate.method;
  let perLead = Number(estimate.per_lead_usd);
  let total = Number(estimate.campaign_total_usd);
  let note = estimate.note;
  const leadCount = estimate.lead_count;

  const draftingOk = historical.drafting_sample >= MIN_HISTORICAL_SAMPLE
    && historical.drafting_avg_usd != null
    && Number.isFinite(historical.drafting_avg_usd);
  const enrichmentOk = historical.enrichment_sample >= MIN_HISTORICAL_SAMPLE
    && historical.enrichment_avg_usd != null
    && Number.isFinite(historical.enrichment_avg_usd);

  if (leadCount > 0 && draftingOk && (!input.needsEnrichment || enrichmentOk)) {
    const draftAvg = historical.drafting_avg_usd!;
    const enrichAvg = input.needsEnrichment ? historical.enrichment_avg_usd! : 0;
    perLead = draftAvg + enrichAvg;
    total = perLead * leadCount;
    method = 'historical_avg';
    note = input.needsEnrichment
      ? `Historical avg $${formatUsd(enrichAvg)} enrichment + $${formatUsd(draftAvg)} drafting per lead `
        + `(n=${historical.enrichment_sample}/${historical.drafting_sample}).`
      : `Historical avg $${formatUsd(draftAvg)} drafting per lead (n=${historical.drafting_sample}).`;
  }

  const remaining = CAMPAIGN_COST_CAP_USD - total;
  const overCap = total > CAMPAIGN_COST_CAP_USD;
  const atOrOver = total >= CAMPAIGN_COST_CAP_USD;
  const toRemove = leadsToRemoveForCap({
    estimatedTotalUsd: total,
    perLeadUsd: perLead,
  });

  return {
    cap_usd: CAMPAIGN_COST_CAP_USD,
    lead_count: leadCount,
    estimated_total_usd: Number(total.toFixed(4)),
    per_lead_usd: Number(perLead.toFixed(4)),
    remaining_usd: Number(remaining.toFixed(4)),
    over_cap: overCap,
    at_or_over_cap: atOrOver,
    leads_to_remove: toRemove,
    method,
    note,
    estimate: {
      ...estimate,
      method: method === 'historical_avg' ? estimate.method : estimate.method,
      per_lead_usd: formatUsd(perLead),
      campaign_total_usd: formatUsd(total),
      note,
    },
  };
}

export function costCapBlockMessage(gate: CampaignCostGate): string {
  if (!gate.over_cap) return '';
  return `Estimated campaign cost $${gate.estimated_total_usd.toFixed(2)} exceeds the $${gate.cap_usd.toFixed(0)} cap. `
    + `Remove at least ${gate.leads_to_remove} lead${gate.leads_to_remove === 1 ? '' : 's'} to continue.`;
}

export class CampaignCostCapError extends Error {
  readonly status = 402;
  readonly code = 'campaign_cost_cap' as const;
  readonly gate: CampaignCostGate;

  constructor(gate: CampaignCostGate) {
    super(costCapBlockMessage(gate));
    this.name = 'CampaignCostCapError';
    this.gate = gate;
  }
}

export async function assertCampaignUnderCostCap(input: {
  campaignId: string;
  needsEnrichment: boolean;
  fallbackLeadCount?: number;
}): Promise<CampaignCostGate> {
  const gate = await buildCampaignCostGate(input);
  if (gate.over_cap) throw new CampaignCostCapError(gate);
  return gate;
}
