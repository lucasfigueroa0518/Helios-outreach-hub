import {
  computeHaikuTokenCostUsd,
  computeSearchCostUsd,
  formatUsd,
} from '@/lib/drafting/cost';

/** Conservative default tokens when the enrichment provider only reports search count. */
export const ENRICHMENT_DEFAULT_INPUT_TOKENS = 10_000;
export const ENRICHMENT_DEFAULT_OUTPUT_TOKENS = 1_800;

export function estimateEnrichmentJobCostUsd(input: {
  searchesUsed: number;
  inputTokens?: number;
  outputTokens?: number;
}): { costUsd: string; usage: Record<string, unknown> } {
  const searches = Math.max(0, input.searchesUsed);
  const inputTokens = input.inputTokens ?? ENRICHMENT_DEFAULT_INPUT_TOKENS;
  const outputTokens = input.outputTokens ?? ENRICHMENT_DEFAULT_OUTPUT_TOKENS;
  const searchCost = computeSearchCostUsd(searches);
  const tokenCost = computeHaikuTokenCostUsd(inputTokens, outputTokens);
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
      pricedWith: input.inputTokens != null ? 'reported_tokens' : 'default_token_estimate',
    },
  };
}
