/**
 * Path-bucket campaign cost estimation.
 *
 * Replaces flat trailing-ledger averages with composition-aware pricing:
 * enrichment amortizes unique company research; drafting buckets leads by
 * email-domain reuse path (fresh / company_reuse / sibling_skip).
 */

import {
  estimateEnrichmentJobCostUsd,
} from '@/lib/cost-ledger-pricing';
import {
  addDecimal,
  estimateResearchCost,
  estimateWriteCost,
  formatUsd,
  sumDecimals,
} from '@/lib/drafting/cost';
import { resolveCompanyResearchKey } from '@/lib/drafting/company-research-key';
import { buildRequestedProfileFields } from '@/lib/enrichment-fields';
import { normalizeCompanyName } from '@/lib/research-types';

export type CostLeadInput = {
  id: string;
  fullName?: string | null;
  email?: string | null;
  companyName?: string | null;
  title?: string | null;
  location?: string | null;
  /** When true, enrichment web research is expected to be skipped for this lead. */
  skipEnrichment?: boolean;
};

export type PathBucketId =
  | 'enrichment_skip'
  | 'enrichment_company_job'
  | 'enrichment_hard_rescue'
  | 'draft_fresh'
  | 'draft_company_reuse'
  | 'draft_sibling_skip'
  | 'flat_fallback';

export type PathBucket = {
  path: PathBucketId;
  phase: 'enrichment' | 'drafting' | 'fallback';
  count: number;
  unit_usd: string;
  total_usd: string;
  source: 'model';
};

export type PathCostEstimate = {
  lead_count: number;
  method: 'path_bucket' | 'flat_fallback';
  buckets: PathBucket[];
  enrichment_total_usd: string;
  drafting_total_usd: string;
  per_lead_usd: string;
  campaign_total_usd: string;
  note: string;
  /** Rollups kept for compact UI / backward-compatible consumers. */
  enrichment: { avg_usd: string; sample_size: number; source: 'path_bucket' | 'model_fallback' };
  drafting: { avg_usd: string; sample_size: number; source: 'path_bucket' | 'model_fallback' };
};

export type PathUnitCosts = {
  enrichmentSkipUsd: string;
  enrichmentCompanyJobUsd: string;
  enrichmentHardRescueUsd: string;
  draftFreshUsd: string;
  draftCompanyReuseUsd: string;
  draftSiblingSkipUsd: string;
  flatPerLeadUsd: string;
};

function hasCompleteDraftIdentity(lead: CostLeadInput): boolean {
  return Boolean(
    lead.fullName?.trim()
    && lead.email?.trim()
    && lead.companyName?.trim()
    && lead.title?.trim(),
  );
}

function enrichmentCompanyKey(lead: CostLeadInput): string {
  const company = lead.companyName?.trim();
  if (!company) return `lead:${lead.id}`;
  return `company:${normalizeCompanyName(company)}`;
}

/** Model unit costs used when the ledger has no path-tagged history. */
export function buildPathUnitCosts(): PathUnitCosts {
  const enrichmentCompanyJobUsd = estimateEnrichmentJobCostUsd({ searchesUsed: 5 }).costUsd;
  const enrichmentHardRescueUsd = estimateEnrichmentJobCostUsd({ searchesUsed: 1 }).costUsd;

  const freshResearch = estimateResearchCost();
  const reuseResearch = estimateResearchCost({
    searchesLow: 0,
    searchesHigh: 0,
    inputTokensLow: 4_000,
    inputTokensHigh: 8_000,
    outputTokensLow: 800,
    outputTokensHigh: 2_000,
  });
  const write = estimateWriteCost();

  const typical = (low: string, high: string) =>
    formatUsd((Number(low) + Number(high)) / 2);

  const draftFreshUsd = addDecimal(
    typical(freshResearch.lowUsd, freshResearch.highUsd),
    typical(write.lowUsd, write.highUsd),
  );
  const draftCompanyReuseUsd = addDecimal(
    typical(reuseResearch.lowUsd, reuseResearch.highUsd),
    typical(write.lowUsd, write.highUsd),
  );
  const draftSiblingSkipUsd = typical(write.lowUsd, write.highUsd);

  // Flat fallback assumes one company job + one fresh draft per lead (worst-ish composition).
  const flatPerLeadUsd = addDecimal(enrichmentCompanyJobUsd, draftFreshUsd);

  return {
    enrichmentSkipUsd: '0.0000',
    enrichmentCompanyJobUsd,
    enrichmentHardRescueUsd,
    draftFreshUsd,
    draftCompanyReuseUsd,
    draftSiblingSkipUsd,
    flatPerLeadUsd,
  };
}

function bucket(
  path: PathBucketId,
  phase: PathBucket['phase'],
  count: number,
  unitUsd: string,
): PathBucket | null {
  if (count <= 0) return null;
  return {
    path,
    phase,
    count,
    unit_usd: unitUsd,
    total_usd: formatUsd(count * Number(unitUsd)),
    source: 'model',
  };
}

export type PathCounts = {
  enrichment_skip: number;
  enrichment_company_job: number;
  enrichment_hard_rescue: number;
  draft_fresh: number;
  draft_company_reuse: number;
  draft_sibling_skip: number;
};

/** Pure classifier — no I/O. */
export function classifyCampaignCostPaths(leads: readonly CostLeadInput[]): PathCounts {
  const counts: PathCounts = {
    enrichment_skip: 0,
    enrichment_company_job: 0,
    enrichment_hard_rescue: 0,
    draft_fresh: 0,
    draft_company_reuse: 0,
    draft_sibling_skip: 0,
  };

  const byCompany = new Map<string, CostLeadInput[]>();
  for (const lead of leads) {
    const key = enrichmentCompanyKey(lead);
    const group = byCompany.get(key);
    if (group) group.push(lead);
    else byCompany.set(key, [lead]);
  }

  for (const group of byCompany.values()) {
    const active = group.filter((lead) => !lead.skipEnrichment);
    counts.enrichment_skip += group.length - active.length;
    if (active.length === 0) continue;
    counts.enrichment_company_job += 1;
    for (const lead of active) {
      const fields = buildRequestedProfileFields({
        company_name: lead.companyName,
        title: lead.title,
        location: lead.location,
      });
      if (fields.requested_fields.length > 0) {
        counts.enrichment_hard_rescue += 1;
      }
    }
  }

  const byDomain = new Map<string | null, CostLeadInput[]>();
  for (const lead of leads) {
    const key = resolveCompanyResearchKey(lead.email ?? null);
    const group = byDomain.get(key);
    if (group) group.push(lead);
    else byDomain.set(key, [lead]);
  }

  for (const [domainKey, group] of byDomain) {
    const ordered = [...group].sort((a, b) => a.id.localeCompare(b.id));
    if (domainKey == null) {
      counts.draft_fresh += ordered.length;
      continue;
    }
    const [first, ...rest] = ordered;
    if (first) counts.draft_fresh += 1;
    for (const sibling of rest) {
      if (hasCompleteDraftIdentity(sibling)) counts.draft_sibling_skip += 1;
      else counts.draft_company_reuse += 1;
    }
  }

  return counts;
}

function assembleEstimate(
  leadCount: number,
  method: PathCostEstimate['method'],
  buckets: PathBucket[],
  note: string,
): PathCostEstimate {
  const enrichmentTotal = sumDecimals(
    buckets.filter((b) => b.phase === 'enrichment').map((b) => b.total_usd),
  );
  const draftingTotal = sumDecimals(
    buckets.filter((b) => b.phase === 'drafting').map((b) => b.total_usd),
  );
  const fallbackTotal = sumDecimals(
    buckets.filter((b) => b.phase === 'fallback').map((b) => b.total_usd),
  );
  const campaignTotal = method === 'flat_fallback'
    ? fallbackTotal
    : addDecimal(enrichmentTotal, draftingTotal);
  const perLead = leadCount > 0
    ? formatUsd(Number(campaignTotal) / leadCount)
    : '0.0000';
  const enrichmentAvg = leadCount > 0
    ? formatUsd(Number(enrichmentTotal) / leadCount)
    : '0.0000';
  const draftingAvg = leadCount > 0
    ? formatUsd(Number(draftingTotal) / leadCount)
    : '0.0000';

  return {
    lead_count: leadCount,
    method,
    buckets,
    enrichment_total_usd: method === 'flat_fallback' ? '0.0000' : enrichmentTotal,
    drafting_total_usd: method === 'flat_fallback' ? '0.0000' : draftingTotal,
    per_lead_usd: perLead,
    campaign_total_usd: campaignTotal,
    note,
    enrichment: {
      avg_usd: method === 'flat_fallback' ? perLead : enrichmentAvg,
      sample_size: leadCount,
      source: method === 'path_bucket' ? 'path_bucket' : 'model_fallback',
    },
    drafting: {
      avg_usd: method === 'flat_fallback' ? '0.0000' : draftingAvg,
      sample_size: leadCount,
      source: method === 'path_bucket' ? 'path_bucket' : 'model_fallback',
    },
  };
}

export function estimateCampaignCostFromLeads(
  leads: readonly CostLeadInput[],
  unitCosts: PathUnitCosts = buildPathUnitCosts(),
): PathCostEstimate {
  const leadCount = leads.length;
  const counts = classifyCampaignCostPaths(leads);
  const buckets = [
    bucket('enrichment_skip', 'enrichment', counts.enrichment_skip, unitCosts.enrichmentSkipUsd),
    bucket('enrichment_company_job', 'enrichment', counts.enrichment_company_job, unitCosts.enrichmentCompanyJobUsd),
    bucket('enrichment_hard_rescue', 'enrichment', counts.enrichment_hard_rescue, unitCosts.enrichmentHardRescueUsd),
    bucket('draft_fresh', 'drafting', counts.draft_fresh, unitCosts.draftFreshUsd),
    bucket('draft_company_reuse', 'drafting', counts.draft_company_reuse, unitCosts.draftCompanyReuseUsd),
    bucket('draft_sibling_skip', 'drafting', counts.draft_sibling_skip, unitCosts.draftSiblingSkipUsd),
  ].filter((b): b is PathBucket => b != null);

  const companyJobs = counts.enrichment_company_job;
  const siblingSkips = counts.draft_sibling_skip;
  const reuses = counts.draft_company_reuse;
  const note = `Path-bucket estimate from ${leadCount} lead(s): ${companyJobs} company research job(s), `
    + `${counts.draft_fresh} fresh draft research, ${reuses} company-reuse, ${siblingSkips} sibling-skip.`;

  return assembleEstimate(leadCount, 'path_bucket', buckets, note);
}

export function estimateCampaignCostFlatFallback(
  leadCount: number,
  unitCosts: PathUnitCosts = buildPathUnitCosts(),
): PathCostEstimate {
  const safeLeads = Math.max(0, Math.floor(leadCount));
  const buckets = [
    bucket('flat_fallback', 'fallback', safeLeads, unitCosts.flatPerLeadUsd),
  ].filter((b): b is PathBucket => b != null);

  return assembleEstimate(
    safeLeads,
    'flat_fallback',
    buckets,
    `Flat fallback (no lead rows loaded yet): model unit cost × ${safeLeads} lead(s). `
      + 'Path buckets apply once leads are extracted.',
  );
}
