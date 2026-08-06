import type Anthropic from '@anthropic-ai/sdk';

import {
  formatHardLintFailuresForRepair,
  hardLintGuidanceForWriter,
} from '@/lib/drafting/lint';
import {
  WRITER_RESEARCH_PREAMBLE,
  buildWriterResearchBrief,
} from '@/lib/drafting/writer-research-brief';
import type {
  DraftingResearchPacket,
  InputSnapshot,
  LintFinding,
} from '@/lib/drafting/types';

export const DRAFTING_WRITER_PROMPT_VERSION = 'drafting-writer-v14-subject-identity';

/** Dedicated system instruction — stacked clauses are banned on first write. */
export const WRITER_NO_STACKED_CLAUSES_SYSTEM_BLOCK = `## Absolute rule: no stacked clauses

This rule is mandatory on the first write. Do not violate it.

1. Write one idea per sentence.
2. Do not join multiple project facts, appositions, or qualifying clauses in a single sentence.
3. If a sentence has three or more commas, or uses two or more clause-joining phrases such as "alongside," "on top of," "as well as," "in addition to," or "while also," split that sentence before you finish the draft.
4. Prefer two or three short sentences over one long sentence that carries several facts.
5. Self-introductions must use one sentence for who you are and where you work. Do not chain titles, employers, and qualifiers with commas.
6. Before you call the output tool, re-read every sentence. If any sentence requires a second read to parse, split it and rewrite.`;

export const reportDraftOutputTool: Anthropic.Tool = {
  name: 'report_draft_output',
  description: 'Report the finished first-contact email and operational metadata.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'schemaVersion', 'subject', 'bodyText', 'resolutionUsed',
      'usedFactIds', 'claimLedger', 'askForm', 'checks',
    ],
    properties: {
      schemaVersion: { type: 'string', enum: ['1'] },
      subject: { type: 'string' },
      bodyText: { type: 'string' },
      resolutionUsed: {
        type: 'string',
        enum: ['person', 'company', 'role_segment', 'moment', 'structure'],
      },
      usedFactIds: { type: 'array', items: { type: 'string' } },
      claimLedger: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['exactText', 'factIds', 'claimType', 'temporalFraming'],
          properties: {
            exactText: {
              type: 'string',
              description: 'One complete verbatim prose sentence from bodyText.',
            },
            factIds: { type: 'array', items: { type: 'string' } },
            claimType: {
              type: 'string',
              enum: ['prospect_fact', 'sender_fact', 'relationship_fact'],
            },
            temporalFraming: {
              type: 'string',
              enum: [
                'none', 'anticipatory', 'active', 'retrospective',
                'current_context', 'historical_context', 'timeless',
              ],
            },
          },
        },
      },
      askForm: { type: 'string', enum: ['call', 'meal', 'reply'] },
      checks: {
        type: 'object',
        additionalProperties: false,
        required: [
          'reasonClearInFirstThreeSentences', 'oneIdea', 'oneReason', 'oneAsk',
          'noInventedSpecifics', 'noVendorPattern', 'noEmDash',
          'noMarketingFormatting', 'senderFactsFromProvidedSourcesOnly',
          'noStackedClauses', 'everySentenceParsesOnFirstRead',
        ],
        properties: {
          reasonClearInFirstThreeSentences: { type: 'boolean' },
          oneIdea: { type: 'boolean' },
          noStackedClauses: {
            type: 'boolean',
            description:
              'True only if no sentence joins several facts, appositions, or qualifying clauses.',
          },
          everySentenceParsesOnFirstRead: {
            type: 'boolean',
            description:
              'True only if you re-read every sentence and none needed a second read to parse.',
          },
          oneReason: { type: 'boolean' },
          oneAsk: { type: 'boolean' },
          noInventedSpecifics: { type: 'boolean' },
          noVendorPattern: { type: 'boolean' },
          noEmDash: { type: 'boolean' },
          noMarketingFormatting: { type: 'boolean' },
          senderFactsFromProvidedSourcesOnly: { type: 'boolean' },
        },
      },
    },
  },
};

/** Static system prefix with prompt cache on the final static block. */
export function buildWriterSystemBlocks(input: {
  skillContent: string;
  subjectLineContent: string;
  positioningText: string;
  cacheTtl?: '5m' | '1h';
}): Anthropic.TextBlockParam[] {
  return [
    {
      type: 'text',
      text: `## First-contact skill (verbatim)\n\n${input.skillContent}`,
    },
    {
      type: 'text',
      text: `## Subject line (verbatim)\n\n${input.subjectLineContent}`,
    },
    {
      type: 'text',
      text: WRITER_NO_STACKED_CLAUSES_SYSTEM_BLOCK,
    },
    {
      type: 'text',
      text: `## Helios positioning (sender-org facts only)\n\n${input.positioningText}`,
      cache_control: { type: 'ephemeral', ttl: input.cacheTtl ?? '1h' },
    },
  ];
}

/**
 * Writer-facing view of the input snapshot. Asset versions/hashes and the
 * provenance blob carry no prose value, so they are withheld rather than spent
 * as tokens the writer can mine for extra clauses. This is a prompt-only
 * projection: the stored snapshot and its input fingerprint are untouched.
 *
 * New snapshot fields are opt-in — add them here only when the writer needs
 * them for prose.
 */
function writerFacingSnapshot(snapshot: InputSnapshot): Record<string, unknown> {
  return {
    schemaVersion: snapshot.schemaVersion,
    lead: snapshot.lead,
    relationship: snapshot.relationship,
    connectingContext: snapshot.connectingContext,
    customContext: snapshot.customContext,
    sender: snapshot.sender,
  };
}

export function buildWriterUserPrompt(input: {
  inputSnapshot: InputSnapshot;
  packet: DraftingResearchPacket;
  feedback?: string | null;
  previousSubject?: string | null;
  previousBodyText?: string | null;
  hardLintFindings?: LintFinding[] | null;
  isRewrite?: boolean;
  isRepair?: boolean;
}): string {
  const mode = input.isRepair
    ? 'Repair the previous draft against the named hard skill lint failures. Produce a complete replacement email, not patch fragments. Preserve grounded prospect content.'
    : input.isRewrite
      ? 'Rewrite using the user feedback. Reuse the prospect research below; do not invent new prospect facts.'
      : 'Write one first-contact email at the packet resolution.';

  const previous = input.previousSubject || input.previousBodyText
    ? `\n## Previous draft\nSubject: ${input.previousSubject ?? ''}\n\n${input.previousBodyText ?? ''}\n`
    : '';
  const feedback = input.feedback?.trim()
    ? `\n## User rewrite feedback\n${input.feedback.trim()}\n`
    : '';
  const repairLint = input.isRepair && input.hardLintFindings?.length
    ? `\n## Hard lint failures to fix\n${formatHardLintFailuresForRepair(input.hardLintFindings)}\n`
    : '';
  const lintGuide = `\n## ${hardLintGuidanceForWriter()}\n`;

  return `${mode}

## Sender / lead / relationship snapshot
${JSON.stringify(writerFacingSnapshot(input.inputSnapshot), null, 2)}

The customContext object above holds caller-supplied per-lead facts (e.g. LinkedIn relationship status, and any columns the sender added to the sheet). Treat these as trusted, factual context about the prospect or your existing relationship. Use them naturally where they strengthen the reason for writing; never print raw column names, and omit any that don't help.

## Prospect research (use for writing)

${WRITER_RESEARCH_PREAMBLE}

${JSON.stringify(buildWriterResearchBrief(input.packet), null, 2)}
${previous}${repairLint}${feedback}${lintGuide}
Grounding requirements:
- usedFactIds lists every research fact used in the email.
- claimLedger has one entry for every complete prose sentence except the greeting, signoff, and signature name.
- exactText is the complete verbatim sentence from bodyText, including temporal words such as "recently", "upcoming", or "new role".
- Every prospect_fact entry lists the exact research fact IDs supporting that sentence.
- Sentences naming the prospect or company are prospect_fact, never sender_fact or relationship_fact.
- temporalFraming declares how the sentence uses time. It must match the fact's permittedFraming from the research brief; use none only for sender/relationship claims.

Last check before you answer: re-read every sentence you wrote. One idea per sentence. Any sentence that joins several facts, appositions, or qualifying clauses must be split now, and checks.noStackedClauses must report honestly.
Call report_draft_output with the finished email and complete grounding metadata.`;
}
