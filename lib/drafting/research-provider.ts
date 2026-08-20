import Anthropic from '@anthropic-ai/sdk';

import { loadDraftingAssets } from '@/lib/drafting/assets';
import { priceAnthropicMessages, toProviderUsage } from '@/lib/anthropic-pricing';
import { sha256Fingerprint } from '@/lib/drafting/normalize';
import { parseDraftingResearchPacket } from '@/lib/drafting/provider-parse';
import {
  DRAFTING_RESEARCH_PROMPT_VERSION,
  buildResearchSystemBlocks,
  buildResearchUserPrompt,
  reportDraftingResearchTool,
} from '@/lib/drafting/research-prompt';
import type {
  DraftingResearchPacket,
  InputSnapshot,
  ReusableCompanyResearchContext,
} from '@/lib/drafting/types';
import { withDraftingAnthropicSlot } from '@/lib/drafting/anthropic-semaphore';
import {
  cacheUsageFromMessage,
  withConversationCache,
  withToolCache,
} from '@/lib/anthropic-cache';
import {
  DRAFTING_RESEARCH_FORCED_REPORT_MAX_TOKENS,
  DRAFTING_RESEARCH_MODEL,
  assertLiveDraftingAllowed,
  getDraftingMode,
  resolvedDraftingMaxSearches,
  resolvedDraftingPromptCacheTtl,
  resolvedDraftingResearchMaxCalls,
} from '@/lib/models';

export type DraftingResearchInput = {
  itemId: string;
  inputSnapshot: InputSnapshot;
  inputFingerprint: string;
  researchRevision: number;
  skillContent: string;
  positioningText: string;
  maxSearches: number;
  reusableCompanyContext?: ReusableCompanyResearchContext | null;
};

export type DraftingResearchResult = {
  packet: DraftingResearchPacket;
  packetSha256: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    searches: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: string;
    calls: number;
    turns: number;
    protocolBudget?: {
      maxCalls: number;
      maxSearches: number;
      cheapPath: boolean;
      reportMaxTokens: number;
      autoMaxTokens: number;
    };
  };
  providerRequestId: string;
  modelId: string;
  promptVersion: string;
};

export const DRAFTING_RESEARCH_AUTO_MAX_TOKENS = 4_096;

export function resolveResearchProtocolBudget(input: {
  hasReusableCompanyContext: boolean;
  maxSearches?: number;
  configuredMaxCalls?: number;
  configuredMaxTokens?: number;
}): { maxCalls: number; autoMaxTokens: number; reportMaxTokens: number } {
  const configuredMaxCalls = input.configuredMaxCalls ?? resolvedDraftingResearchMaxCalls();
  const cheapPath = input.hasReusableCompanyContext || (input.maxSearches ?? 1) === 0;
  return {
    // Reuse / zero-search: one forced report only. Fresh: default 2 (1 auto + 1 force).
    maxCalls: cheapPath ? 1 : configuredMaxCalls,
    autoMaxTokens: DRAFTING_RESEARCH_AUTO_MAX_TOKENS,
    reportMaxTokens: cheapPath
      ? DRAFTING_RESEARCH_AUTO_MAX_TOKENS
      : (input.configuredMaxTokens ?? DRAFTING_RESEARCH_FORCED_REPORT_MAX_TOKENS),
  };
}

function stubResearchPacket(input: DraftingResearchInput): DraftingResearchPacket {
  const lead = input.inputSnapshot.lead;
  const company = lead.company ?? 'the company';
  const now = new Date().toISOString();
  return {
    schemaVersion: '2',
    asOf: now,
    leadIdentity: {
      classification: 'verified',
      suppliedSummary: `${lead.fullName ?? 'Lead'} at ${company}`,
      currentSummary: `${lead.fullName ?? 'Lead'} serves as ${lead.title ?? 'an executive'} at ${company}`,
      conflictSummary: null,
      supportingSourceIds: ['stub-s1'],
    },
    freshness: {
      employer: { status: 'current', sourceIds: ['stub-s1'], summary: `Current employer ${company}` },
      title: { status: 'current', sourceIds: ['stub-s1'], summary: lead.title ?? 'Current title' },
      location: { status: 'recent', sourceIds: ['stub-s1'], summary: lead.workLocation ?? 'Location on file' },
    },
    prospectWorld: {
      roleReality: `${lead.title ?? 'Executive'} responsibilities at ${company}`,
      pressures: [],
      contactNorm: {
        form: 'reply',
        statement: 'Professional email reply is appropriate',
        sourceIds: ['stub-s1'],
        confidence: 'supported',
      },
      registerNotes: ['Stub research packet for offline development'],
      commonVendorPatterns: [],
    },
    personFacts: [],
    companyFacts: [{
      id: 'stub-f1',
      normalizedClaim: `${company} operates in a regulated professional environment`,
      sourceIds: ['stub-s1'],
      quote: `${company} leadership page lists ${lead.fullName ?? 'the contact'}`,
      family: 'first_party_company',
      confidence: 'supported',
      freshness: 'current',
      weight: 'anchor',
      significanceReason: 'Stub anchor fact for offline drafting',
      temporal: {
        kind: 'evergreen',
        eventClass: 'structural',
        eventStart: null,
        eventEnd: null,
        relevanceEnd: null,
        durationBasis: 'unknown',
        durationSourceIds: [],
        durationEvidence: null,
        discourse: 'timeless',
      },
    }],
    roleSegmentFacts: [],
    structuralRelation: {
      relation: 'complementary',
      recipientConstraint: null,
      embarkCapabilityId: 'financial_reporting_advisory',
      supportedReason: 'Stub structural relation',
      tensionToName: null,
      sourceIds: ['stub-s1'],
    },
    statusGeometry: {
      classification: 'peer',
      safePosture: 'Peer professional outreach',
      basis: 'Stub status geometry',
    },
    resolution: {
      level: 'company',
      selectedFactIds: ['stub-f1'],
      reasonForWriting: `Recent context at ${company}`,
      whyNow: 'Stub timing rationale',
      prohibitedAssumptions: [],
    },
    resolutionUpgrade: {
      obtainableFact: null,
      whyItWouldRaiseResolution: null,
      howToObtainWithoutGuessing: null,
    },
    companyContextProvenance: {
      origin: 'fresh',
      sourceDraftingItemId: null,
      resolvedDomain: null,
      validUntil: null,
    },
    sources: [{
      id: 'stub-s1',
      url: 'https://example.com/stub',
      title: 'Stub source',
      family: 'first_party_company',
      trustTier: 'high',
      publishedOrUpdated: now,
      accessedAt: now,
      quote: `${lead.fullName ?? 'Contact'} at ${company}`,
      bindsPerson: true,
    }],
  };
}

function webSearchRequests(message: Anthropic.Message) {
  const usage = message.usage as Anthropic.Message['usage'] & {
    server_tool_use?: { web_search_requests?: number };
  };
  return Math.max(0, Number(usage.server_tool_use?.web_search_requests ?? 0));
}

function cacheTokens(message: Anthropic.Message) {
  return cacheUsageFromMessage(message);
}

function toolUseBlock(message: Anthropic.Message, name: string) {
  const block = message.content.find(
    (content) => content.type === 'tool_use' && content.name === name,
  );
  return block && block.type === 'tool_use' ? block : null;
}

function describePacketParseFailure(message: Anthropic.Message, error: unknown): string {
  const block = toolUseBlock(message, 'report_drafting_research');
  const keys = block && typeof block.input === 'object' && block.input
    ? Object.keys(block.input as Record<string, unknown>).join(',')
    : '(no tool input)';
  const detail = error instanceof Error ? error.message : String(error);
  return `${detail} (stop_reason=${message.stop_reason ?? 'unknown'}; keys=${keys})`;
}

function tryPacketFromMessage(message: Anthropic.Message): {
  packet: DraftingResearchPacket | null;
  parseError: string | null;
} {
  const block = toolUseBlock(message, 'report_drafting_research');
  if (!block) return { packet: null, parseError: null };
  try {
    return { packet: parseDraftingResearchPacket(block.input), parseError: null };
  } catch (error) {
    return { packet: null, parseError: describePacketParseFailure(message, error) };
  }
}

function sumUsage(messages: Anthropic.Message[]) {
  let inputTokens = 0;
  let outputTokens = 0;
  let searches = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalInputTokens = 0;
  for (const message of messages) {
    outputTokens += message.usage.output_tokens ?? 0;
    searches += webSearchRequests(message);
    const cache = cacheTokens(message);
    inputTokens += cache.inputTokens;
    cacheReadTokens += cache.cacheReadTokens;
    cacheWriteTokens += cache.cacheWriteTokens;
    totalInputTokens += cache.totalInputTokens;
  }
  return {
    inputTokens,
    outputTokens,
    searches,
    cacheReadTokens,
    cacheWriteTokens,
    totalInputTokens,
  };
}

function pendingClientToolUses(content: Anthropic.ContentBlock[]): Anthropic.ToolUseBlock[] {
  return content.filter(
    (block): block is Anthropic.ToolUseBlock =>
      block.type === 'tool_use',
  );
}

function hasPendingServerToolUse(content: Anthropic.ContentBlock[]): boolean {
  const resolved = new Set<string>();
  for (const block of content) {
    if (block.type === 'web_search_tool_result') resolved.add(block.tool_use_id);
  }
  return content.some(
    (block) => block.type === 'server_tool_use' && !resolved.has(block.id),
  );
}

async function forceResearchReport(input: {
  client: Anthropic;
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  messagesUsed: Anthropic.Message[];
  tools: Anthropic.MessageCreateParams['tools'];
  maxTokens: number;
  parseError: string | null;
  searchesExhausted: boolean;
}): Promise<{ packet: DraftingResearchPacket | null; parseError: string | null }> {
  let parseError = input.parseError;
  let packet: DraftingResearchPacket | null = null;
  // One forced report + one truncation retry. 4096 routinely cut sources mid-schema.
  const tokenBudgets = [
    input.maxTokens,
    Math.max(input.maxTokens, DRAFTING_RESEARCH_FORCED_REPORT_MAX_TOKENS),
  ];

  for (let attempt = 0; attempt < tokenBudgets.length; attempt += 1) {
    const repairHint = parseError
      ? `Your previous report_drafting_research call was incomplete or invalid (${parseError}). `
        + 'Call report_drafting_research again with the FULL required schema, including schemaVersion="2", '
        + 'prospectWorld, structuralRelation, resolution, and sources (array). Keep arrays short if needed.'
      : input.searchesExhausted
        ? 'Search budget is spent. Call report_drafting_research now with only supported findings. Do not narrate.'
        : 'Searching is finished. Call report_drafting_research now with only supported findings.';
    input.messages.push({ role: 'user', content: repairHint });

    const forced = await input.client.messages.create({
      model: DRAFTING_RESEARCH_MODEL,
      max_tokens: tokenBudgets[attempt],
      system: input.system,
      messages: withConversationCache(input.messages),
      tools: input.tools,
      tool_choice: { type: 'tool', name: 'report_drafting_research' },
    });
    input.messagesUsed.push(forced);
    input.messages.push({ role: 'assistant', content: forced.content as Anthropic.ContentBlockParam[] });
    const repaired = tryPacketFromMessage(forced);
    if (repaired.packet) {
      packet = repaired.packet;
      parseError = null;
      break;
    }
    parseError = repaired.parseError ?? parseError;
    const truncated = forced.stop_reason === 'max_tokens';
    if (!truncated && attempt === 0) break;
  }

  return { packet, parseError };
}

async function researchLive(input: DraftingResearchInput): Promise<DraftingResearchResult> {
  assertLiveDraftingAllowed();
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const assets = await loadDraftingAssets();
  const configuredSearches = Math.max(
    0,
    Math.min(3, input.maxSearches || resolvedDraftingMaxSearches()),
  );
  // Reused company evidence leaves one search for lead identity/freshness.
  const maxSearches = input.reusableCompanyContext
    ? Math.min(1, configuredSearches)
    : configuredSearches;
  const protocolBudget = resolveResearchProtocolBudget({
    hasReusableCompanyContext: Boolean(input.reusableCompanyContext),
    maxSearches,
  });
  const maxCalls = protocolBudget.maxCalls;
  const autoCallBudget = Math.max(0, maxCalls - 1);
  const researchMaxTokens = protocolBudget.autoMaxTokens;
  const reportMaxTokens = protocolBudget.reportMaxTokens;
  const cacheTtl = resolvedDraftingPromptCacheTtl();
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const system = buildResearchSystemBlocks({
    positioningText: input.positioningText || assets.positioning.text,
    capabilityCatalog: assets.capabilities.catalog,
    cacheTtl,
  });
  const userPrompt = buildResearchUserPrompt({
    inputSnapshot: input.inputSnapshot,
    maxSearches,
    reusableCompanyContext: input.reusableCompanyContext,
  });

  const webSearchTool: Anthropic.WebSearchTool20250305 = {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: maxSearches,
  };
  // Keep web_search on the forced-report turn so the tools prefix stays
  // cacheable. Force the report with tool_choice instead of dropping the tool.
  const tools: Anthropic.MessageCreateParams['tools'] = maxSearches > 0
    ? [webSearchTool, withToolCache(reportDraftingResearchTool, cacheTtl)]
    : [withToolCache(reportDraftingResearchTool, cacheTtl)];

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userPrompt }];
  const messagesUsed: Anthropic.Message[] = [];
  let packet: DraftingResearchPacket | null = null;
  let parseError: string | null = null;

  for (let callIndex = 0; callIndex < autoCallBudget; callIndex += 1) {
    const response = await client.messages.create({
      model: DRAFTING_RESEARCH_MODEL,
      max_tokens: researchMaxTokens,
      system,
      messages: withConversationCache(messages),
      tools,
      tool_choice: { type: 'auto' },
    });
    messagesUsed.push(response);

    const attempt = tryPacketFromMessage(response);
    if (attempt.packet) {
      packet = attempt.packet;
      break;
    }
    parseError = attempt.parseError ?? parseError;

    messages.push({ role: 'assistant', content: response.content as Anthropic.ContentBlockParam[] });

    const pendingClient = pendingClientToolUses(response.content);
    if (pendingClient.length > 0) {
      messages.push({
        role: 'user',
        content: pendingClient.map((tool) => ({
          type: 'tool_result' as const,
          tool_use_id: tool.id,
          content: tool.name === 'report_drafting_research'
            ? parseError
              ?? 'Incomplete research packet. Finish searching if needed, then call report_drafting_research with the full schema.'
            : 'This tool is not available during the search phase.',
          is_error: true,
        })),
      });
      continue;
    }

    if (hasPendingServerToolUse(response.content) || response.stop_reason === 'pause_turn') {
      continue;
    }

    const searchesUsed = sumUsage(messagesUsed).searches;
    const searchesExhausted = maxSearches === 0 || searchesUsed >= maxSearches;
    const lastAutoCall = callIndex >= autoCallBudget - 1;
    const idleStop = response.stop_reason === 'end_turn'
      || response.stop_reason === 'max_tokens'
      || response.stop_reason === 'tool_use';

    // Reserve the final provider call for one forced, compact packet report.
    if (searchesExhausted || idleStop || lastAutoCall) break;

    break;
  }

  if (!packet) {
    const searchesUsed = sumUsage(messagesUsed).searches;
    const forced = await forceResearchReport({
      client,
      system,
      messages,
      messagesUsed,
      tools,
      maxTokens: reportMaxTokens,
      parseError,
      searchesExhausted: maxSearches === 0 || searchesUsed >= maxSearches,
    });
    packet = forced.packet;
    parseError = forced.parseError;
  }

  if (!packet) {
    throw new Error(
      parseError
        ?? 'Drafting research finished without report_drafting_research output',
    );
  }

  if (input.reusableCompanyContext) {
    packet = {
      ...packet,
      companyContextProvenance: {
        origin: 'reused_within_workspace',
        sourceDraftingItemId: input.reusableCompanyContext.sourceDraftingItemId,
        resolvedDomain: null,
        validUntil: input.reusableCompanyContext.validUntil,
      },
    };
  }

  const priced = priceAnthropicMessages(messagesUsed, {
    modelId: DRAFTING_RESEARCH_MODEL,
    fallbackCacheTtl: resolvedDraftingPromptCacheTtl(),
  });

  return {
    packet,
    packetSha256: sha256Fingerprint(packet),
    usage: {
      ...toProviderUsage(priced, {
        calls: messagesUsed.length,
        turns: messagesUsed.length,
      }),
      protocolBudget: {
        maxCalls,
        maxSearches,
        cheapPath: Boolean(input.reusableCompanyContext) || maxSearches === 0,
        reportMaxTokens,
        autoMaxTokens: researchMaxTokens,
      },
    },
    providerRequestId: messagesUsed[0]?.id ?? 'unknown',
    modelId: DRAFTING_RESEARCH_MODEL,
    promptVersion: DRAFTING_RESEARCH_PROMPT_VERSION,
  };
}

/** Run drafting research. Stub mode returns a deterministic canned packet; live mode calls Claude + web_search. */
export async function runDraftingResearch(input: DraftingResearchInput): Promise<DraftingResearchResult> {
  if (getDraftingMode() === 'live') {
    return withDraftingAnthropicSlot(() => researchLive(input));
  }

  const packet = stubResearchPacket(input);
  return {
    packet,
    packetSha256: sha256Fingerprint(packet),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      searches: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: '0.0000',
      calls: 0,
      turns: 0,
    },
    providerRequestId: `stub-research-${input.itemId.slice(0, 8)}`,
    modelId: DRAFTING_RESEARCH_MODEL,
    promptVersion: DRAFTING_RESEARCH_PROMPT_VERSION,
  };
}

/** True when live drafting research can be invoked (mode + API key). Does not call the API. */
export function isLiveDraftingResearchReady(): boolean {
  return getDraftingMode() === 'live' && Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}
