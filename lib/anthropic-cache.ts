import type Anthropic from '@anthropic-ai/sdk';

/**
 * Anthropic prompt-cache helpers.
 *
 * Official behavior: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 * Repo conventions: docs/prompt-caching.md
 *
 * Prefix order is tools → system → messages. Place cache_control on the last
 * block whose prefix is identical across the requests you want to share.
 * This SDK (0.65) has no top-level automatic cache_control, so multi-turn
 * loops must mark the last message block each turn.
 */
export type PromptCacheTtl = '5m' | '1h';

export type EphemeralCacheControl = {
  type: 'ephemeral';
  ttl?: PromptCacheTtl;
};

export function ephemeralCache(ttl: PromptCacheTtl = '1h'): EphemeralCacheControl {
  return { type: 'ephemeral', ttl };
}

/** Static system string as one cached text block. */
export function cachedSystemText(
  text: string,
  ttl: PromptCacheTtl = '1h',
): Anthropic.TextBlockParam[] {
  return [{
    type: 'text',
    text,
    cache_control: ephemeralCache(ttl),
  }];
}

/** Mark the last tool so the whole tools array is a cacheable prefix. */
export function withToolCache(tool: Anthropic.Tool, ttl: PromptCacheTtl = '1h'): Anthropic.Tool {
  return { ...tool, cache_control: ephemeralCache(ttl) };
}

function withoutCacheControl<T extends object>(block: T): T {
  if (!('cache_control' in block)) return block;
  const { cache_control: _ignored, ...rest } = block as T & { cache_control?: unknown };
  return rest as T;
}

/**
 * Clone `messages` and put a 5-minute breakpoint only on the last content
 * block of the last message. Earlier message-level markers are stripped so we
 * do not burn the 4-breakpoint budget as the conversation grows.
 */
export function withConversationCache(
  messages: Anthropic.MessageParam[],
  ttl: PromptCacheTtl = '5m',
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const stripped = messages.map((message) => {
    if (typeof message.content === 'string') return message;
    return {
      ...message,
      content: message.content.map((block) => withoutCacheControl(block)),
    };
  });
  const last = stripped[stripped.length - 1]!;
  const cache = ephemeralCache(ttl);
  if (typeof last.content === 'string') {
    return [
      ...stripped.slice(0, -1),
      {
        ...last,
        content: [{ type: 'text', text: last.content, cache_control: cache }],
      },
    ];
  }
  if (last.content.length === 0) return stripped;
  return [
    ...stripped.slice(0, -1),
    {
      ...last,
      content: last.content.map((block, index, blocks) => (
        index === blocks.length - 1
          ? { ...block, cache_control: cache }
          : block
      )),
    },
  ];
}

export function cacheUsageFromMessage(message: Anthropic.Message) {
  const inputTokens = Math.max(0, Number(message.usage.input_tokens ?? 0));
  const cacheReadTokens = Math.max(0, Number(message.usage.cache_read_input_tokens ?? 0));
  const cacheWriteTokens = Math.max(0, Number(message.usage.cache_creation_input_tokens ?? 0));
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    /** Anthropic total = after-breakpoint + writes + reads. */
    totalInputTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
  };
}
