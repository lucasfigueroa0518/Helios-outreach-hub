export const DRAFTING_PRICE_SNAPSHOT = {
  version: '2026-07-15',
  effectiveThrough: '2026-08-31',
  sonnetInputPerMtokUsd: 2,
  sonnetOutputPerMtokUsd: 10,
  sonnetInputPerMtokUsdAfter: 3,
  sonnetOutputPerMtokUsdAfter: 15,
  pricingChangeDate: '2026-09-01',
  webSearchPerSearchUsd: 0.01,
  cacheReadMultiplier: 0.1,
  cacheWrite5MinMultiplier: 1.25,
  cacheWrite1HourMultiplier: 2,
} as const;

export const HAIKU_PRICE_SNAPSHOT = {
  inputPerMtokUsd: 1,
  outputPerMtokUsd: 5,
} as const;

export const DRAFTING_COST_DEFAULTS = {
  researchSearchesLow: 2,
  researchSearchesHigh: 3,
  researchInputTokensLow: 8_000,
  researchInputTokensHigh: 15_000,
  researchOutputTokensLow: 1_000,
  researchOutputTokensHigh: 2_500,
  writeInputTokensLow: 6_000,
  writeInputTokensHigh: 12_000,
  writeOutputTokensLow: 400,
  writeOutputTokensHigh: 1_200,
  maxResearchSearches: 3,
} as const;

const FOUR_PLACES = 4;

function toNumber(value: string | number): number {
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value: ${value}`);
  }
  return parsed;
}

export function formatUsd(value: number): string {
  return value.toFixed(FOUR_PLACES);
}

export function addDecimal(a: string | number, b: string | number): string {
  return formatUsd(toNumber(a) + toNumber(b));
}

export function subtractDecimal(a: string | number, b: string | number): string {
  return formatUsd(toNumber(a) - toNumber(b));
}

export function compareDecimal(a: string | number, b: string | number): number {
  return toNumber(a) - toNumber(b);
}

export function canReserve(budgetRemaining: string | number, amount: string | number): boolean {
  return compareDecimal(budgetRemaining, amount) >= 0;
}

export function selectPriceSnapshot(asOf: Date = new Date()) {
  const afterChange = asOf >= new Date(`${DRAFTING_PRICE_SNAPSHOT.pricingChangeDate}T00:00:00.000Z`);
  return {
    version: DRAFTING_PRICE_SNAPSHOT.version,
    inputPerMtokUsd: afterChange
      ? DRAFTING_PRICE_SNAPSHOT.sonnetInputPerMtokUsdAfter
      : DRAFTING_PRICE_SNAPSHOT.sonnetInputPerMtokUsd,
    outputPerMtokUsd: afterChange
      ? DRAFTING_PRICE_SNAPSHOT.sonnetOutputPerMtokUsdAfter
      : DRAFTING_PRICE_SNAPSHOT.sonnetOutputPerMtokUsd,
    webSearchPerSearchUsd: DRAFTING_PRICE_SNAPSHOT.webSearchPerSearchUsd,
  };
}

export function computeTokenCostUsd(
  inputTokens: number,
  outputTokens: number,
  asOf: Date = new Date(),
): number {
  const prices = selectPriceSnapshot(asOf);
  const inputCost = (inputTokens / 1_000_000) * prices.inputPerMtokUsd;
  const outputCost = (outputTokens / 1_000_000) * prices.outputPerMtokUsd;
  return inputCost + outputCost;
}

export function computeHaikuTokenCostUsd(
  inputTokens: number,
  outputTokens: number,
): number {
  const inputCost = (inputTokens / 1_000_000) * HAIKU_PRICE_SNAPSHOT.inputPerMtokUsd;
  const outputCost = (outputTokens / 1_000_000) * HAIKU_PRICE_SNAPSHOT.outputPerMtokUsd;
  return inputCost + outputCost;
}

export function computeSearchCostUsd(searches: number): number {
  return searches * DRAFTING_PRICE_SNAPSHOT.webSearchPerSearchUsd;
}

export function computeCacheAdjustedInputCostUsd(
  inputTokens: number,
  options: {
    cacheHitTokens?: number;
    cacheWriteTokens?: number;
    cacheTtl?: '5m' | '1h';
    asOf?: Date;
  } = {},
): number {
  const prices = selectPriceSnapshot(options.asOf);
  const cacheHitTokens = options.cacheHitTokens ?? 0;
  const cacheWriteTokens = options.cacheWriteTokens ?? 0;
  const regularInputTokens = Math.max(0, inputTokens - cacheHitTokens - cacheWriteTokens);
  const writeMultiplier = options.cacheTtl === '1h'
    ? DRAFTING_PRICE_SNAPSHOT.cacheWrite1HourMultiplier
    : DRAFTING_PRICE_SNAPSHOT.cacheWrite5MinMultiplier;

  const regularCost = (regularInputTokens / 1_000_000) * prices.inputPerMtokUsd;
  const hitCost = (cacheHitTokens / 1_000_000) * prices.inputPerMtokUsd * DRAFTING_PRICE_SNAPSHOT.cacheReadMultiplier;
  const writeCost = (cacheWriteTokens / 1_000_000) * prices.inputPerMtokUsd * writeMultiplier;
  return regularCost + hitCost + writeCost;
}

export type CostEstimate = {
  lowUsd: string;
  highUsd: string;
};

export function estimateResearchCost(
  overrides: Partial<{
    searchesLow: number;
    searchesHigh: number;
    inputTokensLow: number;
    inputTokensHigh: number;
    outputTokensLow: number;
    outputTokensHigh: number;
    asOf: Date;
  }> = {},
): CostEstimate {
  const searchesLow = overrides.searchesLow ?? DRAFTING_COST_DEFAULTS.researchSearchesLow;
  const searchesHigh = overrides.searchesHigh ?? DRAFTING_COST_DEFAULTS.researchSearchesHigh;
  const inputTokensLow = overrides.inputTokensLow ?? DRAFTING_COST_DEFAULTS.researchInputTokensLow;
  const inputTokensHigh = overrides.inputTokensHigh ?? DRAFTING_COST_DEFAULTS.researchInputTokensHigh;
  const outputTokensLow = overrides.outputTokensLow ?? DRAFTING_COST_DEFAULTS.researchOutputTokensLow;
  const outputTokensHigh = overrides.outputTokensHigh ?? DRAFTING_COST_DEFAULTS.researchOutputTokensHigh;
  const asOf = overrides.asOf;

  const low = computeSearchCostUsd(searchesLow)
    + computeTokenCostUsd(inputTokensLow, outputTokensLow, asOf);
  const high = computeSearchCostUsd(searchesHigh)
    + computeTokenCostUsd(inputTokensHigh, outputTokensHigh, asOf);

  return { lowUsd: formatUsd(low), highUsd: formatUsd(high) };
}

export function estimateWriteCost(
  overrides: Partial<{
    inputTokensLow: number;
    inputTokensHigh: number;
    outputTokensLow: number;
    outputTokensHigh: number;
    cacheHitRatioLow: number;
    cacheHitRatioHigh: number;
    asOf: Date;
  }> = {},
): CostEstimate {
  const inputTokensLow = overrides.inputTokensLow ?? DRAFTING_COST_DEFAULTS.writeInputTokensLow;
  const inputTokensHigh = overrides.inputTokensHigh ?? DRAFTING_COST_DEFAULTS.writeInputTokensHigh;
  const outputTokensLow = overrides.outputTokensLow ?? DRAFTING_COST_DEFAULTS.writeOutputTokensLow;
  const outputTokensHigh = overrides.outputTokensHigh ?? DRAFTING_COST_DEFAULTS.writeOutputTokensHigh;
  const cacheHitRatioLow = overrides.cacheHitRatioLow ?? 0;
  const cacheHitRatioHigh = overrides.cacheHitRatioHigh ?? 0.7;
  const asOf = overrides.asOf;

  const lowInputCost = computeCacheAdjustedInputCostUsd(inputTokensLow, {
    cacheHitTokens: Math.floor(inputTokensLow * cacheHitRatioLow),
    asOf,
  });
  const highInputCost = computeCacheAdjustedInputCostUsd(inputTokensHigh, {
    cacheHitTokens: Math.floor(inputTokensHigh * cacheHitRatioHigh),
    asOf,
  });
  const prices = selectPriceSnapshot(asOf);
  const lowOutputCost = (outputTokensLow / 1_000_000) * prices.outputPerMtokUsd;
  const highOutputCost = (outputTokensHigh / 1_000_000) * prices.outputPerMtokUsd;

  return {
    lowUsd: formatUsd(lowInputCost + lowOutputCost),
    highUsd: formatUsd(highInputCost + highOutputCost),
  };
}

export function estimateLeadCost(): CostEstimate {
  const research = estimateResearchCost();
  const write = estimateWriteCost();
  return {
    lowUsd: addDecimal(research.lowUsd, write.lowUsd),
    highUsd: addDecimal(research.highUsd, write.highUsd),
  };
}

export function worstCaseResearchReservationUsd(): string {
  return estimateResearchCost({
    searchesLow: DRAFTING_COST_DEFAULTS.maxResearchSearches,
    searchesHigh: DRAFTING_COST_DEFAULTS.maxResearchSearches,
    inputTokensLow: DRAFTING_COST_DEFAULTS.researchInputTokensHigh,
    inputTokensHigh: DRAFTING_COST_DEFAULTS.researchInputTokensHigh,
    outputTokensLow: DRAFTING_COST_DEFAULTS.researchOutputTokensHigh,
    outputTokensHigh: DRAFTING_COST_DEFAULTS.researchOutputTokensHigh,
  }).highUsd;
}

export function worstCaseWriteReservationUsd(): string {
  return estimateWriteCost({
    inputTokensLow: DRAFTING_COST_DEFAULTS.writeInputTokensHigh,
    inputTokensHigh: DRAFTING_COST_DEFAULTS.writeInputTokensHigh,
    outputTokensLow: DRAFTING_COST_DEFAULTS.writeOutputTokensHigh,
    outputTokensHigh: DRAFTING_COST_DEFAULTS.writeOutputTokensHigh,
    cacheHitRatioLow: 0,
    cacheHitRatioHigh: 0,
  }).highUsd;
}

export function releaseReservation(
  reservedUsd: string | number,
  actualUsd: string | number,
): string {
  const delta = subtractDecimal(reservedUsd, actualUsd);
  return compareDecimal(delta, 0) < 0 ? '0.0000' : delta;
}

export function sumDecimals(values: readonly (string | number)[]): string {
  return values.reduce<string>((total, value) => addDecimal(total, value), '0.0000');
}
