import Anthropic from '@anthropic-ai/sdk';

import { withDraftingAnthropicSlot } from '@/lib/drafting/anthropic-semaphore';
import {
  cachedSystemText,
  withConversationCache,
  withToolCache,
} from '@/lib/anthropic-cache';
import { priceAnthropicMessages, toProviderUsage } from '@/lib/anthropic-pricing';
import { loadReplyAssets } from '@/lib/drafting/reply-assets';
import {
  REPLY_CALENDLY_URL,
  type ReplyDisposition,
} from '@/lib/drafting/reply-constants';
import {
  REPLY_PROMPT_VERSION,
  buildReplySystemPrompt,
  buildReplyUserPrompt,
  isReplyDisposition,
  lookupHeliosPositioningTool,
  referHeliosWebsiteTool,
  reportReplyOutputTool,
  type ReplyPromptContext,
} from '@/lib/drafting/reply-prompt';
import {
  DRAFTING_WRITER_MODEL,
  assertLiveDraftingAllowed,
  getDraftingMode,
  resolvedDraftingPromptCacheTtl,
  resolvedDraftingWriterMaxTokens,
} from '@/lib/models';

export type ReplyWriteInput = Omit<ReplyPromptContext, 'skillContent'> & {
  replySendId: string;
};

export type ReplyWriteOutput = {
  disposition: ReplyDisposition;
  bodyText: string;
  includeCalendly: boolean;
  deferUntil: string | null;
  deferReason: string | null;
  usedTools: string[];
  notes: string | null;
  usage: { inputTokens: number; outputTokens: number; costUsd: string };
  providerRequestId: string;
  modelId: string;
  promptVersion: string;
  skillVersion: string;
  skillSha256: string;
  generationMode: 'live' | 'stub';
};

const MAX_TOOL_ROUNDS = 6;

function stubReply(input: ReplyWriteInput): ReplyWriteOutput {
  const first = (input.leadName ?? 'there').split(/\s+/)[0] || 'there';
  const inbound = input.inboundBody.trim().toLowerCase();
  const mode = input.mode ?? 'immediate';

  if (mode === 'followup') {
    return {
      disposition: 'reply_now',
      bodyText: [
        `${first},`,
        '',
        'Checking back as you asked. If useful, grab a time here:',
        REPLY_CALENDLY_URL,
      ].join('\n'),
      includeCalendly: true,
      deferUntil: null,
      deferReason: null,
      usedTools: [],
      notes: 'stub_followup',
      usage: { inputTokens: 0, outputTokens: 0, costUsd: '0.0000' },
      providerRequestId: `stub-reply-${input.replySendId.slice(0, 8)}`,
      modelId: DRAFTING_WRITER_MODEL,
      promptVersion: REPLY_PROMPT_VERSION,
      skillVersion: 'v1',
      skillSha256: 'stub',
      generationMode: 'stub',
    };
  }

  if (/\b(stop|unsubscribe|remove me|do not contact|don't contact)\b/.test(inbound)) {
    return {
      disposition: 'suppress',
      bodyText: 'Understood. No further emails from me.',
      includeCalendly: false,
      deferUntil: null,
      deferReason: null,
      usedTools: [],
      notes: 'stub_suppress',
      usage: { inputTokens: 0, outputTokens: 0, costUsd: '0.0000' },
      providerRequestId: `stub-reply-${input.replySendId.slice(0, 8)}`,
      modelId: DRAFTING_WRITER_MODEL,
      promptVersion: REPLY_PROMPT_VERSION,
      skillVersion: 'v1',
      skillSha256: 'stub',
      generationMode: 'stub',
    };
  }

  if (/\b(later this quarter|mid[\s-]?month|ping me then|reconnect|after the \d+|hit me (back )?later)\b/.test(inbound)) {
    return {
      disposition: 'defer',
      bodyText: `Sounds good, ${first}. I'll check back then.`,
      includeCalendly: false,
      deferUntil: null,
      deferReason: input.inboundBody.trim().slice(0, 200),
      usedTools: [],
      notes: 'stub_defer',
      usage: { inputTokens: 0, outputTokens: 0, costUsd: '0.0000' },
      providerRequestId: `stub-reply-${input.replySendId.slice(0, 8)}`,
      modelId: DRAFTING_WRITER_MODEL,
      promptVersion: REPLY_PROMPT_VERSION,
      skillVersion: 'v1',
      skillSha256: 'stub',
      generationMode: 'stub',
    };
  }

  const short = inbound.length < 80 && !/\?/.test(inbound);
  const bodyText = short
    ? [`Sounds good, ${first}.`, '', `Grab a time here: ${REPLY_CALENDLY_URL}`].join('\n')
    : [
      `Thanks for the note, ${first}.`,
      '',
      'Happy to dig into this on a quick call.',
      `Book a time here: ${REPLY_CALENDLY_URL}`,
    ].join('\n');

  return {
    disposition: 'reply_now',
    bodyText,
    includeCalendly: true,
    deferUntil: null,
    deferReason: null,
    usedTools: [],
    notes: 'stub',
    usage: { inputTokens: 0, outputTokens: 0, costUsd: '0.0000' },
    providerRequestId: `stub-reply-${input.replySendId.slice(0, 8)}`,
    modelId: DRAFTING_WRITER_MODEL,
    promptVersion: REPLY_PROMPT_VERSION,
    skillVersion: 'v1',
    skillSha256: 'stub',
    generationMode: 'stub',
  };
}

function parseReportOutput(input: unknown): {
  disposition: ReplyDisposition;
  bodyText: string;
  includeCalendly: boolean;
  deferUntil: string | null;
  deferReason: string | null;
  usedTools: string[];
  notes: string | null;
} | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  if (!isReplyDisposition(record.disposition)) return null;
  const bodyText = typeof record.bodyText === 'string' ? record.bodyText.trim() : '';
  if (!bodyText) return null;
  const includeCalendly = Boolean(record.includeCalendly);
  const deferUntil = typeof record.deferUntil === 'string' && record.deferUntil.trim()
    ? record.deferUntil.trim()
    : null;
  const deferReason = typeof record.deferReason === 'string' ? record.deferReason : null;
  const usedTools = Array.isArray(record.usedTools)
    ? record.usedTools.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const notes = typeof record.notes === 'string' ? record.notes : null;
  return {
    disposition: record.disposition,
    bodyText,
    includeCalendly,
    deferUntil,
    deferReason,
    usedTools,
    notes,
  };
}

async function writeLive(input: ReplyWriteInput): Promise<ReplyWriteOutput> {
  assertLiveDraftingAllowed();
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const assets = await loadReplyAssets();
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const cacheTtl = resolvedDraftingPromptCacheTtl();
  const system = cachedSystemText(buildReplySystemPrompt(assets.skill.content), cacheTtl);
  const userPrompt = buildReplyUserPrompt({ ...input, skillContent: assets.skill.content });
  const tools = [
    lookupHeliosPositioningTool,
    referHeliosWebsiteTool,
    withToolCache(reportReplyOutputTool, cacheTtl),
  ];

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userPrompt }];
  const billedMessages: Anthropic.Message[] = [];
  let lastMessageId = '';
  const usedToolNames = new Set<string>();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const message = await client.messages.create({
      model: DRAFTING_WRITER_MODEL,
      max_tokens: resolvedDraftingWriterMaxTokens(),
      system,
      messages: withConversationCache(messages),
      tools,
    });
    lastMessageId = message.id;
    billedMessages.push(message);

    const toolUses = message.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );
    const report = toolUses.find((block) => block.name === 'report_reply_output');
    if (report) {
      const parsed = parseReportOutput(report.input);
      if (!parsed) throw new Error('report_reply_output missing disposition/bodyText');
      for (const name of parsed.usedTools) usedToolNames.add(name);
      return {
        ...parsed,
        usedTools: [...usedToolNames],
        usage: toProviderUsage(priceAnthropicMessages(billedMessages, {
          modelId: DRAFTING_WRITER_MODEL,
          fallbackCacheTtl: cacheTtl,
        })),
        providerRequestId: lastMessageId,
        modelId: DRAFTING_WRITER_MODEL,
        promptVersion: REPLY_PROMPT_VERSION,
        skillVersion: assets.skill.version,
        skillSha256: assets.skill.sha256,
        generationMode: 'live',
      };
    }

    if (toolUses.length === 0) {
      throw new Error('Reply writer finished without report_reply_output');
    }

    messages.push({ role: 'assistant', content: message.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tool of toolUses) {
      usedToolNames.add(tool.name);
      if (tool.name === 'lookup_helios_positioning') {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: [
            'Helios positioning document (minimal). Prefer website referral when this does not clearly answer.',
            '',
            assets.positioning.text,
          ].join('\n'),
        });
      } else if (tool.name === 'refer_helios_website') {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: assets.websiteBrief.content,
        });
      } else {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: 'Unknown tool',
          is_error: true,
        });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  throw new Error('Reply writer exceeded tool rounds without report_reply_output');
}

/** Draft an auto-response. Stub in non-live drafting mode; live uses Claude with tools. */
export async function runReplyWrite(input: ReplyWriteInput): Promise<ReplyWriteOutput> {
  if (getDraftingMode() === 'live') {
    return withDraftingAnthropicSlot(() => writeLive(input));
  }
  const stub = stubReply(input);
  try {
    const assets = await loadReplyAssets();
    stub.skillVersion = assets.skill.version;
    stub.skillSha256 = assets.skill.sha256;
  } catch {
    // Offline tests may run without full drafting asset gate; keep stub hashes.
  }
  return stub;
}
