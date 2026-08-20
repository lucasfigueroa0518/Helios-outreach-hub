# Prompt caching

Official Anthropic guide (source of truth for API behavior):
[Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

Use this document when adding or changing any Claude `messages.create` call.
Helpers live in `lib/anthropic-cache.ts`. Default TTL for static prefixes is
`DRAFTING_PROMPT_CACHE_TTL` (`1h` unless set to `5m`).

## Why it matters here

Outreach Hub spends most Claude money on **repeated prefixes**: skills,
positioning, capability catalogs, report-tool JSON schemas, and web_search
definitions. Those are identical across leads in a campaign and across turns
inside one research/reply session. Cache hits are **0.1×** base input; 5-minute
writes are **1.25×**; 1-hour writes are **2×**. After the first lead (or first
turn), the shared prefix should be a read, not a full input charge.

## Standing rule

**Every live Claude call must use prompt caching whenever a stable prefix
exists.** Do not add a new `messages.create` that sends a large system prompt,
tool schema, skill, or positioning block without `cache_control`.

The installed SDK (`@anthropic-ai/sdk` 0.65) does **not** support top-level
automatic `cache_control`. Use **explicit breakpoints** on content blocks.

## How it works (short)

1. Cache prefixes are hashed in order: **tools → system → messages**.
2. Writes happen **only** at a `cache_control` breakpoint. Lookback finds
   earlier writes (20 blocks), not “whatever looks static.”
3. Put the breakpoint on the **last block that stays identical** across the
   requests you want to share. Never put it only on a timestamp, lead payload,
   or the incoming user message if that is the part that changes.
4. Shorter than the model minimum is silently skipped (no error). Check
   `cache_creation_input_tokens` / `cache_read_input_tokens`. Sonnet 5 minimum
   is 1,024 tokens; Haiku 4.5 is 4,096.
5. Up to **4** breakpoints per request. Longer TTL must appear **before**
   shorter TTL (`1h` system, then `5m` conversation).
6. Changing tool definitions invalidates **tools + system + messages**.
   Changing `tool_choice` invalidates **messages only**.
7. Enabling/disabling web search, citations, or thinking invalidates system
   and messages.
8. Default TTL is 5 minutes, refreshed on use. Batch / multi-lead runs should
   use `1h` on the static prefix (`DRAFTING_PROMPT_CACHE_TTL`).
9. Caches are workspace-isolated. Exact byte-for-byte match required.

## What to cache vs not

| Cache (stable prefix) | Do not cache (varies every request) |
|---|---|
| Tool definitions | Lead/company payload |
| System rules, skills, positioning, catalogs | Authoritative `now` timestamp |
| Shared report schemas | Per-tile images / per-PDF bytes |
| Prior turns in a **growing** conversation | Automatic breakpoint on a one-shot user message that will never repeat |

Single-shot per-lead calls (writer, vision tile, PDF chunk): cache tools +
system only. Do **not** mark the user message — that pays a cache write for a
prefix that will not hit on the next lead.

Multi-turn calls (research search loop, forced report, reply tools, dashboard
JSON retry): keep tools/system cached at `1h`, and mark the **last message
block** each turn at `5m` via `withConversationCache`.

## Code conventions

```ts
import {
  cachedSystemText,
  withConversationCache,
  withToolCache,
} from '@/lib/anthropic-cache';
import { resolvedDraftingPromptCacheTtl } from '@/lib/models';

const ttl = resolvedDraftingPromptCacheTtl();

await client.messages.create({
  model,
  max_tokens,
  system: cachedSystemText(STATIC_INSTRUCTIONS, ttl),
  tools: [webSearchTool, withToolCache(reportTool, ttl)],
  messages: withConversationCache(messages), // last block only; 5m
  tool_choice: { type: 'tool', name: 'report_…' }, // ok — does not bust tools/system
});
```

- Keep the **same `tools` array** on follow-up turns. Dropping `web_search` to
  force a report busts the entire cache. Force the report with `tool_choice`
  instead.
- `max_uses` on `web_search` is part of the tool definition. A different
  budget is a different tools prefix (expected for reuse vs fresh research).
- Log `cache_read_input_tokens` and `cache_creation_input_tokens`. Anthropic
  `usage.input_tokens` is **only the suffix after the last breakpoint**. Total
  input = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
  Pass that total into `computeCacheAdjustedInputCostUsd`.

## Call-site map

| Path | Pattern | Status |
|---|---|---|
| `lib/drafting/research-prompt.ts` `buildResearchSystemBlocks` | Explicit `1h` on last static system block | Cached |
| `lib/drafting/research-provider.ts` | Same tools on auto + forced report; conversation cache on last turn | Cached |
| `lib/drafting/writer-prompt.ts` `buildWriterSystemBlocks` | Explicit `1h` on positioning block; no user-message cache | Cached |
| `lib/drafting/writer-provider.ts` | Tool breakpoint + cache-adjusted cost | Cached |
| `lib/drafting/research-adversarial.ts` | System `1h`; same tools on force; conversation cache | Cached |
| `lib/drafting/reply-provider.ts` | Cached skill system + last tool; conversation cache across tool rounds | Cached |
| `lib/research-provider.ts` (enrichment) | Cached system + last tool; same tools on search and report turns | Cached |
| `lib/vision-extraction.ts` | Static count/extract rules in system; image in user (uncached) | Cached prefix |
| `lib/pdf-vision.ts` | Static extract rules in system; PDF bytes in user (uncached) | Cached prefix |
| `lib/dashboards/ai.ts` | Voice/rules as cached system; events in user; retry uses conversation cache | Cached |
| `scripts/smoke_live_integrations.ts` | Probe only | Leave uncached |

Vision/PDF prefixes may sit under the 1,024-token floor until tools+instructions
grow; `cache_control` is still required so they start hitting as soon as they
qualify. Haiku 4.5 (adversarial, profile/email rescue) needs 4,096 tokens
before a prefix caches.

## Pricing snapshot (multipliers)

These stack with batch discounts. Confirm current rows on the official page.

- 5-minute cache write: **1.25×** base input
- 1-hour cache write: **2×** base input
- Cache read / refresh: **0.1×** base input
- Output tokens: unchanged

Use the 5-minute cache when the same prefix is reused more often than every
five minutes (a live campaign batch). Use 1-hour when the next hit may be
later than five minutes (worker gaps, slow tool loops, sparse batches).

## Common mistakes in this repo

1. **Breakpoint on the varying suffix** — timestamps in
   `buildResearchUserPrompt`, lead JSON, tile images. Cache the system/tools
   prefix, not that block.
2. **Dropping `web_search` on the forced-report turn** — tool definitions
   change, so the system cache never hits. Keep the tool; set `tool_choice`.
3. **Leaving `cache_control` on every historical message** — burns the 4
   breakpoint slots. `withConversationCache` strips older message markers.
4. **Cost using only `usage.input_tokens`** — undercounts once caching works.
5. **Automatic top-level `cache_control`** — not in SDK 0.65; TypeScript will
   reject it. Stay on explicit block markers until the SDK is upgraded.

## Pre-warming

`max_tokens: 0` can write a cache before real traffic. Only useful if we add
a worker heartbeat that shares a stable prefix and would otherwise miss on
the first lead after idle. Do not pre-warm from tests or agent sessions
(CLAUDE.md spend ceiling). If added, put the breakpoint on the shared system
or tools, never on a `"warmup"` user string.
