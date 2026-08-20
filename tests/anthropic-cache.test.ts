import assert from 'node:assert/strict';
import test from 'node:test';

import type Anthropic from '@anthropic-ai/sdk';

import {
  cacheUsageFromMessage,
  cachedSystemText,
  ephemeralCache,
  withConversationCache,
  withToolCache,
} from '@/lib/anthropic-cache';
import { computeCacheAdjustedInputCostUsd } from '@/lib/drafting/cost';

test('cachedSystemText marks the static system block with the requested TTL', () => {
  const blocks = cachedSystemText('stable instructions', '1h');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, 'stable instructions');
  assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('withToolCache marks the last tool without mutating the original', () => {
  const tool: Anthropic.Tool = {
    name: 'report',
    description: 'Report',
    input_schema: { type: 'object', properties: {} },
  };
  const cached = withToolCache(tool, '1h');
  assert.deepEqual(cached.cache_control, ephemeralCache('1h'));
  assert.equal(tool.cache_control, undefined);
});

test('withConversationCache only marks the last block of the last message', () => {
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: 'first' },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok', cache_control: ephemeralCache('5m') }],
    },
    { role: 'user', content: 'follow up' },
  ];
  const cached = withConversationCache(messages);
  const first = cached[0];
  const middle = cached[1];
  const last = cached[2];
  assert.equal(typeof first?.content, 'string');
  assert.ok(Array.isArray(middle?.content));
  assert.equal(
    (middle?.content as Anthropic.ContentBlockParam[])[0] &&
      'cache_control' in (middle.content as Anthropic.TextBlockParam[])[0]
        ? (middle.content as Anthropic.TextBlockParam[])[0].cache_control
        : undefined,
    undefined,
  );
  assert.ok(Array.isArray(last?.content));
  const lastBlock = (last?.content as Anthropic.TextBlockParam[])[0];
  assert.equal(lastBlock.text, 'follow up');
  assert.deepEqual(lastBlock.cache_control, { type: 'ephemeral', ttl: '5m' });
});

test('cache-adjusted cost treats Anthropic input_tokens as the uncached suffix', () => {
  const usage = cacheUsageFromMessage({
    usage: {
      input_tokens: 50,
      cache_read_input_tokens: 100_000,
      cache_creation_input_tokens: 0,
      output_tokens: 10,
    },
  } as Anthropic.Message);
  assert.equal(usage.totalInputTokens, 100_050);
  const cost = computeCacheAdjustedInputCostUsd(usage.totalInputTokens, {
    cacheHitTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    cacheTtl: '1h',
    asOf: new Date('2026-07-15T00:00:00.000Z'),
  });
  // 100k cache reads at $2/MTok * 0.1 = $0.02; 50 regular = negligible
  assert.ok(cost > 0.019 && cost < 0.021);
});
