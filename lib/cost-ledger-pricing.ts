import {
  computeSearchCostUsd,
  computeTokenCostUsd,
  formatUsd,
} from '@/lib/drafting/cost';

/** Conservative default tokens for pre-run campaign estimates only — not actuals. */
export const ENRICHMENT_DEFAULT_INPUT_TOKENS = 10_000;
export const ENRICHMENT_DEFAULT_OUTPUT_TOKENS = 1_800;

/** Planning estimate: Sonnet research + searches. Never used as a stand-in for live usage. */
export function estimateEnrichmentJobCostUsd(input: {
  searchesUsed: number;
  inputTokens?: number;
  outputTokens?: number;
}): { costUsd: string; usage: Record<string, unknown> } {
  const searches = Math.max(0, input.searchesUsed);
  const inputTokens = input.inputTokens ?? ENRICHMENT_DEFAULT_INPUT_TOKENS;
  const outputTokens = input.outputTokens ?? ENRICHMENT_DEFAULT_OUTPUT_TOKENS;
  const searchCost = computeSearchCostUsd(searches);
  const tokenCost = computeTokenCostUsd(inputTokens, outputTokens);
  const costUsd = formatUsd(searchCost + tokenCost);
  return {
    costUsd,
    usage: {
      searches,
      inputTokens,
      outputTokens,
      searchCostUsd: formatUsd(searchCost),
      tokenCostUsd: formatUsd(tokenCost),
      costUsd,
      pricedWith: 'planning_estimate',
    },
  };
}

/** Actuals fallback when a stub/offline job has no Messages usage — search fees only. */
export function enrichmentSearchOnlyCostUsd(searchesUsed: number): {
  costUsd: string;
  usage: Record<string, unknown>;
} {
  const searches = Math.max(0, searchesUsed);
  const searchCost = computeSearchCostUsd(searches);
  const costUsd = formatUsd(searchCost);
  return {
    costUsd,
    usage: {
      searches,
      searchCostUsd: formatUsd(searchCost),
      costUsd,
      pricedWith: 'search_only',
    },
  };
}
