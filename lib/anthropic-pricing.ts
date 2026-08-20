import {
  DRAFTING_PRICE_SNAPSHOT,
  HAIKU_PRICE_SNAPSHOT,
  formatUsd,
  selectPriceSnapshot,
} from '@/lib/drafting/cost';

/** Shared usage jsonb persisted on work rows. Keys match Cost API token_type names. */
export type AnthropicUsageContract = {
  pricedWith: 'anthropic_usage';
  modelId: string;
  costUsd: string;
  pricedAt: string;
  uncached_input_tokens: number;
  cache_read_input_tokens: number;
  'cache_creation.ephemeral_5m_input_tokens': number;
  'cache_creation.ephemeral_1h_input_tokens': number;
  output_tokens: number;
  web_search_requests: number;
  providerRequestIds: string[];
  breakdown: {
    uncached_input_tokens: string;
    cache_read_input_tokens: string;
    'cache_creation.ephemeral_5m_input_tokens': string;
    'cache_creation.ephemeral_1h_input_tokens': string;
    output_tokens: string;
    web_search: string;
  };
};

export type AnthropicUsageBuckets = {
  uncachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheCreation5mInputTokens: number;
  cacheCreation1hInputTokens: number;
  outputTokens: number;
  webSearchRequests: number;
};

export type MessageUsageLike = {
  id?: string | null;
  usage: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    cache_creation?: {
      ephemeral_5m_input_tokens?: number | null;
      ephemeral_1h_input_tokens?: number | null;
    } | null;
    server_tool_use?: { web_search_requests?: number } | null;
  };
};

export type PriceAnthropicOptions = {
  modelId: string;
  asOf?: Date;
  /** Used only when the response omits cache_creation TTL split. */
  fallbackCacheTtl?: '5m' | '1h';
};

function nonNeg(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function anthropicFamilyFromModelId(modelId: string): 'haiku' | 'sonnet' {
  return modelId.toLowerCase().includes('haiku') ? 'haiku' : 'sonnet';
}

export function ratesForModel(modelId: string, asOf: Date = new Date()) {
  if (anthropicFamilyFromModelId(modelId) === 'haiku') {
    return {
      inputPerMtokUsd: HAIKU_PRICE_SNAPSHOT.inputPerMtokUsd,
      outputPerMtokUsd: HAIKU_PRICE_SNAPSHOT.outputPerMtokUsd,
    };
  }
  const snapshot = selectPriceSnapshot(asOf);
  return {
    inputPerMtokUsd: snapshot.inputPerMtokUsd,
    outputPerMtokUsd: snapshot.outputPerMtokUsd,
  };
}

export function emptyUsageBuckets(): AnthropicUsageBuckets {
  return {
    uncachedInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    outputTokens: 0,
    webSearchRequests: 0,
  };
}

export function addUsageBuckets(
  target: AnthropicUsageBuckets,
  add: AnthropicUsageBuckets,
): AnthropicUsageBuckets {
  target.uncachedInputTokens += add.uncachedInputTokens;
  target.cacheReadInputTokens += add.cacheReadInputTokens;
  target.cacheCreation5mInputTokens += add.cacheCreation5mInputTokens;
  target.cacheCreation1hInputTokens += add.cacheCreation1hInputTokens;
  target.outputTokens += add.outputTokens;
  target.webSearchRequests += add.webSearchRequests;
  return target;
}

/**
 * Anthropic reports input_tokens as the uncached suffix after the last
 * cache breakpoint. Cache read/write are separate buckets.
 */
export function usageBucketsFromMessage(
  message: MessageUsageLike,
  fallbackCacheTtl: '5m' | '1h' = '1h',
): AnthropicUsageBuckets {
  const usage = message.usage;
  const creation = usage.cache_creation;
  let cache5m = nonNeg(creation?.ephemeral_5m_input_tokens);
  let cache1h = nonNeg(creation?.ephemeral_1h_input_tokens);
  const totalWrite = nonNeg(usage.cache_creation_input_tokens);
  if (cache5m === 0 && cache1h === 0 && totalWrite > 0) {
    if (fallbackCacheTtl === '5m') cache5m = totalWrite;
    else cache1h = totalWrite;
  }

  return {
    uncachedInputTokens: nonNeg(usage.input_tokens),
    cacheReadInputTokens: nonNeg(usage.cache_read_input_tokens),
    cacheCreation5mInputTokens: cache5m,
    cacheCreation1hInputTokens: cache1h,
    outputTokens: nonNeg(usage.output_tokens),
    webSearchRequests: nonNeg(usage.server_tool_use?.web_search_requests),
  };
}

function tokenUsd(tokens: number, perMtok: number): number {
  return (tokens / 1_000_000) * perMtok;
}

export function priceAnthropicUsage(
  buckets: AnthropicUsageBuckets,
  options: PriceAnthropicOptions,
): AnthropicUsageContract {
  const asOf = options.asOf ?? new Date();
  const rates = ratesForModel(options.modelId, asOf);
  const input = rates.inputPerMtokUsd;
  const output = rates.outputPerMtokUsd;
  const uncached = tokenUsd(buckets.uncachedInputTokens, input);
  const cacheRead = tokenUsd(
    buckets.cacheReadInputTokens,
    input * DRAFTING_PRICE_SNAPSHOT.cacheReadMultiplier,
  );
  const cache5m = tokenUsd(
    buckets.cacheCreation5mInputTokens,
    input * DRAFTING_PRICE_SNAPSHOT.cacheWrite5MinMultiplier,
  );
  const cache1h = tokenUsd(
    buckets.cacheCreation1hInputTokens,
    input * DRAFTING_PRICE_SNAPSHOT.cacheWrite1HourMultiplier,
  );
  const outputCost = tokenUsd(buckets.outputTokens, output);
  const searchCost = buckets.webSearchRequests * DRAFTING_PRICE_SNAPSHOT.webSearchPerSearchUsd;
  const total = uncached + cacheRead + cache5m + cache1h + outputCost + searchCost;

  return {
    pricedWith: 'anthropic_usage',
    modelId: options.modelId,
    costUsd: formatUsd(total),
    pricedAt: asOf.toISOString(),
    uncached_input_tokens: buckets.uncachedInputTokens,
    cache_read_input_tokens: buckets.cacheReadInputTokens,
    'cache_creation.ephemeral_5m_input_tokens': buckets.cacheCreation5mInputTokens,
    'cache_creation.ephemeral_1h_input_tokens': buckets.cacheCreation1hInputTokens,
    output_tokens: buckets.outputTokens,
    web_search_requests: buckets.webSearchRequests,
    providerRequestIds: [],
    breakdown: {
      uncached_input_tokens: formatUsd(uncached),
      cache_read_input_tokens: formatUsd(cacheRead),
      'cache_creation.ephemeral_5m_input_tokens': formatUsd(cache5m),
      'cache_creation.ephemeral_1h_input_tokens': formatUsd(cache1h),
      output_tokens: formatUsd(outputCost),
      web_search: formatUsd(searchCost),
    },
  };
}

export function priceAnthropicMessages(
  messages: readonly MessageUsageLike[],
  options: PriceAnthropicOptions,
): AnthropicUsageContract {
  const buckets = emptyUsageBuckets();
  const ids: string[] = [];
  const ttl = options.fallbackCacheTtl ?? '1h';
  for (const message of messages) {
    addUsageBuckets(buckets, usageBucketsFromMessage(message, ttl));
    const id = message.id?.trim();
    if (id) ids.push(id);
  }
  return {
    ...priceAnthropicUsage(buckets, options),
    providerRequestIds: [...new Set(ids)],
  };
}

export class AnthropicUsageCollector {
  private readonly messages: MessageUsageLike[] = [];

  record(message: MessageUsageLike): void {
    this.messages.push(message);
  }

  get size(): number {
    return this.messages.length;
  }

  price(options: PriceAnthropicOptions): AnthropicUsageContract | null {
    if (this.messages.length === 0) return null;
    return priceAnthropicMessages(this.messages, options);
  }
}

export function usageContractToJson(usage: AnthropicUsageContract): Record<string, unknown> {
  return { ...usage };
}

export function actualCostFromUsage(usage: AnthropicUsageContract | null | undefined): string {
  return usage?.costUsd ?? '0.0000';
}

/** Flatten the contract onto the usage blobs providers already persist. */
export function toProviderUsage<T extends Record<string, unknown> = Record<string, never>>(
  priced: AnthropicUsageContract,
  extra?: T,
): T & {
  costUsd: string;
  inputTokens: number;
  outputTokens: number;
  searches: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  const cacheWrite = priced['cache_creation.ephemeral_5m_input_tokens']
    + priced['cache_creation.ephemeral_1h_input_tokens'];
  return {
    ...priced,
    inputTokens: priced.uncached_input_tokens + priced.cache_read_input_tokens + cacheWrite,
    outputTokens: priced.output_tokens,
    searches: priced.web_search_requests,
    cacheReadTokens: priced.cache_read_input_tokens,
    cacheWriteTokens: cacheWrite,
    costUsd: priced.costUsd,
    ...(extra ?? ({} as T)),
  };
}
