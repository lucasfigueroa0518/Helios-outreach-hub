import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  anthropicFamilyFromModelId,
  priceAnthropicMessages,
  priceAnthropicUsage,
  usageBucketsFromMessage,
} from '@/lib/anthropic-pricing';

const asOf = new Date('2026-07-15T00:00:00.000Z');
const afterChange = new Date('2026-09-01T00:00:00.000Z');

test('cache-read fixture: 100k reads at 0.1× Sonnet input plus 50 uncached', () => {
  const priced = priceAnthropicMessages([
    {
      id: 'msg_cache_hit',
      usage: {
        input_tokens: 50,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 0,
        output_tokens: 10,
      },
    },
  ], { modelId: 'claude-sonnet-5', asOf });

  // 100k * $2/MTok * 0.1 = $0.02; 50 uncached + 10 output are tiny
  assert.equal(priced.pricedWith, 'anthropic_usage');
  assert.equal(priced.uncached_input_tokens, 50);
  assert.equal(priced.cache_read_input_tokens, 100_000);
  assert.equal(priced['cache_creation.ephemeral_1h_input_tokens'], 0);
  assert.equal(priced.providerRequestIds[0], 'msg_cache_hit');
  const cost = Number(priced.costUsd);
  assert.ok(cost > 0.0200 && cost < 0.0204, priced.costUsd);
});

test('mixed 5m and 1h cache writes use Cost API TTL split, not configured TTL', () => {
  const priced = priceAnthropicUsage({
    uncachedInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreation5mInputTokens: 10_000,
    cacheCreation1hInputTokens: 10_000,
    outputTokens: 0,
    webSearchRequests: 0,
  }, { modelId: 'claude-sonnet-5', asOf, fallbackCacheTtl: '5m' });

  // 10k * $2 * 1.25 / 1M = $0.025; 10k * $2 * 2 / 1M = $0.040; total $0.065
  assert.equal(priced.costUsd, '0.0650');
  assert.equal(priced.breakdown['cache_creation.ephemeral_5m_input_tokens'], '0.0250');
  assert.equal(priced.breakdown['cache_creation.ephemeral_1h_input_tokens'], '0.0400');
});

test('nested cache_creation on the message wins over fallback TTL', () => {
  const buckets = usageBucketsFromMessage({
    usage: {
      input_tokens: 20,
      cache_creation_input_tokens: 8_000,
      cache_creation: {
        ephemeral_5m_input_tokens: 3_000,
        ephemeral_1h_input_tokens: 5_000,
      },
      output_tokens: 0,
    },
  }, '5m');
  assert.equal(buckets.cacheCreation5mInputTokens, 3_000);
  assert.equal(buckets.cacheCreation1hInputTokens, 5_000);
});

test('legacy cache_creation_input_tokens without TTL split uses fallback', () => {
  const asFive = usageBucketsFromMessage({
    usage: {
      input_tokens: 0,
      cache_creation_input_tokens: 4_000,
      output_tokens: 0,
    },
  }, '5m');
  assert.equal(asFive.cacheCreation5mInputTokens, 4_000);
  assert.equal(asFive.cacheCreation1hInputTokens, 0);

  const asHour = usageBucketsFromMessage({
    usage: {
      input_tokens: 0,
      cache_creation_input_tokens: 4_000,
      output_tokens: 0,
    },
  }, '1h');
  assert.equal(asHour.cacheCreation1hInputTokens, 4_000);
});

test('Haiku uses $1/$5 and web search is $0.01 each', () => {
  const priced = priceAnthropicUsage({
    uncachedInputTokens: 1_000_000,
    cacheReadInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    outputTokens: 1_000_000,
    webSearchRequests: 3,
  }, { modelId: 'claude-haiku-4-5-20251001', asOf });
  // $1 + $5 + $0.03
  assert.equal(anthropicFamilyFromModelId('claude-haiku-4-5-20251001'), 'haiku');
  assert.equal(priced.costUsd, '6.0300');
  assert.equal(priced.breakdown.web_search, '0.0300');
});

test('Sonnet rates jump on 2026-09-01', () => {
  const before = priceAnthropicUsage({
    uncachedInputTokens: 1_000_000,
    cacheReadInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    outputTokens: 1_000_000,
    webSearchRequests: 0,
  }, { modelId: 'claude-sonnet-5', asOf });
  const after = priceAnthropicUsage({
    uncachedInputTokens: 1_000_000,
    cacheReadInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    outputTokens: 1_000_000,
    webSearchRequests: 0,
  }, { modelId: 'claude-sonnet-5', asOf: afterChange });
  assert.equal(before.costUsd, '12.0000');
  assert.equal(after.costUsd, '18.0000');
});

test('does not treat input_tokens as a total that includes cache buckets', () => {
  const priced = priceAnthropicMessages([
    {
      usage: {
        input_tokens: 50,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
      },
    },
  ], { modelId: 'claude-sonnet-5', asOf });
  // If we subtracted cache from input_tokens, uncached would be 0 and we'd
  // miss the $0.0001 uncached suffix — still ~$0.02. The important check is
  // uncached stays 50, not max(0, 50-100000)=0.
  assert.equal(priced.uncached_input_tokens, 50);
});
