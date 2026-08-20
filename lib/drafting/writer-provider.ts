import Anthropic from '@anthropic-ai/sdk';

import { withToolCache } from '@/lib/anthropic-cache';
import { priceAnthropicMessages, toProviderUsage } from '@/lib/anthropic-pricing';
import { buildEffectiveLeadFields } from '@/lib/drafting/normalize';
import { assessResearchTimeliness } from '@/lib/drafting/temporal-policy';
import { parseDraftOutput } from '@/lib/drafting/provider-parse';
import type {
  DraftOutput,
  DraftingResearchPacket,
  InputSnapshot,
  LintFinding,
} from '@/lib/drafting/types';
import {
  DRAFTING_WRITER_PROMPT_VERSION,
  buildWriterSystemBlocks,
  buildWriterUserPrompt,
  reportDraftOutputTool,
} from '@/lib/drafting/writer-prompt';
import { withDraftingAnthropicSlot } from '@/lib/drafting/anthropic-semaphore';
import {
  DRAFTING_WRITER_MODEL,
  assertLiveDraftingAllowed,
  getDraftingMode,
  type DraftingMode,
  resolvedDraftingPromptCacheTtl,
  resolvedDraftingWriterMaxTokens,
} from '@/lib/models';

export type DraftingWriteInput = {
  itemId: string;
  inputSnapshot: InputSnapshot;
  packet: DraftingResearchPacket;
  packetSha256: string;
  draftRevision: number;
  generationNumber: number;
  skillContent: string;
  subjectLineContent: string;
  positioningText: string;
  previousSubject?: string | null;
  previousBodyText?: string | null;
  hardLintFindings?: LintFinding[] | null;
  feedback?: string | null;
  isRewrite?: boolean;
  isRepair?: boolean;
};

export type DraftingWriteResult = {
  draft: DraftOutput;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: string;
  };
  providerRequestId: string;
  modelId: string;
  promptVersion: string;
  generationMode: DraftingMode;
};

function stubDraftOutput(input: DraftingWriteInput): DraftOutput {
  const fields = buildEffectiveLeadFields(input.inputSnapshot);
  const firstName = fields.firstName ?? 'there';
  const company = fields.company ?? 'your organization';
  const reason = input.packet.resolution.reasonForWriting ?? `recent context at ${company}`;
  const reasonSentence = `I wanted to reach out given ${reason.toLowerCase()}.`;
  const contextSentence = input.isRewrite && input.feedback
    ? `I reworked the note with your feedback: ${input.feedback.trim()}`
    : 'This is a stub draft for offline development.';
  const askSentence = 'Would a brief reply work if this is relevant on your side?';
  const audit = assessResearchTimeliness(input.packet);
  const firstFact = audit.facts.find((fact) => fact.disposition !== 'blocked');
  const usedFactIds = firstFact ? [firstFact.factId] : [];
  // Never append a text signature — the send path adds the HTML headshot signature.
  const bodyText = [
    `Hi ${firstName},`,
    '',
    reasonSentence,
    contextSentence,
    '',
    askSentence,
  ].join('\n');

  return {
    schemaVersion: '1',
    subject: `${company} planning`,
    bodyText,
    resolutionUsed: input.packet.resolution.level === 'true_zero'
      ? 'company'
      : input.packet.resolution.level,
    usedFactIds,
    claimLedger: [
      {
        exactText: reasonSentence,
        factIds: usedFactIds,
        claimType: firstFact ? 'prospect_fact' : 'relationship_fact',
        temporalFraming: firstFact?.permittedFraming[0] ?? 'none',
      },
      {
        exactText: contextSentence,
        factIds: [],
        claimType: 'sender_fact',
        temporalFraming: 'none',
      },
      {
        exactText: askSentence,
        factIds: [],
        claimType: 'relationship_fact',
        temporalFraming: 'none',
      },
    ],
    askForm: 'reply',
    checks: {
      reasonClearInFirstThreeSentences: true,
      oneIdea: true,
      oneReason: true,
      oneAsk: true,
      noInventedSpecifics: true,
      noVendorPattern: true,
      noEmDash: true,
      noMarketingFormatting: true,
      senderFactsFromProvidedSourcesOnly: true,
      noStackedClauses: true,
      everySentenceParsesOnFirstRead: true,
    },
  };
}

function draftFromMessage(message: Anthropic.Message): DraftOutput | null {
  const block = message.content.find(
    (content) => content.type === 'tool_use' && content.name === 'report_draft_output',
  );
  if (!block || block.type !== 'tool_use') return null;
  return parseDraftOutput(block.input);
}

async function writeLive(input: DraftingWriteInput): Promise<DraftingWriteResult> {
  assertLiveDraftingAllowed();
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const cacheTtl = resolvedDraftingPromptCacheTtl();
  const system = buildWriterSystemBlocks({
    skillContent: input.skillContent,
    subjectLineContent: input.subjectLineContent,
    positioningText: input.positioningText,
    cacheTtl,
  });
  const userPrompt = buildWriterUserPrompt({
    inputSnapshot: input.inputSnapshot,
    packet: input.packet,
    feedback: input.feedback,
    previousSubject: input.previousSubject,
    previousBodyText: input.previousBodyText,
    hardLintFindings: input.hardLintFindings,
    isRewrite: input.isRewrite,
    isRepair: input.isRepair,
  });

  const message = await client.messages.create({
    model: DRAFTING_WRITER_MODEL,
    max_tokens: resolvedDraftingWriterMaxTokens(),
    system,
    messages: [{ role: 'user', content: userPrompt }],
    tools: [withToolCache(reportDraftOutputTool, cacheTtl)],
    tool_choice: { type: 'tool', name: 'report_draft_output' },
  });

  const draft = draftFromMessage(message);
  if (!draft) {
    throw new Error('Drafting writer finished without report_draft_output');
  }

  const priced = priceAnthropicMessages([message], {
    modelId: DRAFTING_WRITER_MODEL,
    fallbackCacheTtl: cacheTtl,
  });

  return {
    draft,
    usage: toProviderUsage(priced),
    providerRequestId: message.id,
    modelId: DRAFTING_WRITER_MODEL,
    promptVersion: DRAFTING_WRITER_PROMPT_VERSION,
    generationMode: 'live',
  };
}

/** Run drafting write/repair/rewrite. Stub returns canned text; live calls Claude with no web tools. */
export async function runDraftingWrite(input: DraftingWriteInput): Promise<DraftingWriteResult> {
  if (getDraftingMode() === 'live') {
    return withDraftingAnthropicSlot(() => writeLive(input));
  }

  const draft = stubDraftOutput(input);
  return {
    draft,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: '0.0000',
    },
    providerRequestId: `stub-write-${input.itemId.slice(0, 8)}-${input.generationNumber}`,
    modelId: DRAFTING_WRITER_MODEL,
    promptVersion: DRAFTING_WRITER_PROMPT_VERSION,
    generationMode: 'stub',
  };
}

/** True when live drafting writer can be invoked (mode + API key). Does not call the API. */
export function isLiveDraftingWriterReady(): boolean {
  return getDraftingMode() === 'live' && Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}
