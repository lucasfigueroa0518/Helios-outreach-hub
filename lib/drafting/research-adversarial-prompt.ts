import type Anthropic from '@anthropic-ai/sdk';

import type { DraftingResearchPacket, InputSnapshot } from '@/lib/drafting/types';

export const DRAFTING_ADVERSARIAL_PROMPT_VERSION = 'drafting-adversarial-v4-duration';

export type AdversarialBindScope = 'person' | 'company' | 'identity' | 'context';

export type AdversarialClaim = {
  claimId: string;
  kind: 'fact' | 'pressure' | 'whyNow' | 'reasonForWriting' | 'identity' | 'contactNorm';
  bindScope: AdversarialBindScope;
  text: string;
  notes: string[];
};

export type AdversarialSourceStub = {
  id: string;
  url: string;
  title: string;
  family: string;
  trustTier: string;
  bindsPerson: boolean;
  quote: string;
};

export const reportAdversarialVerdictsTool = {
  name: 'report_adversarial_verdicts',
  description:
    'Report truth + entity-binding verdicts after adversarially testing research claims. Call only after searches are done.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdicts'],
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'claimId',
            'truth',
            'bindsToLead',
            'durationSupported',
            'disproofFound',
            'supportingEvidenceFound',
            'rationale',
          ],
          properties: {
            claimId: { type: 'string' },
            /** Is the claim factually true in the world (independent of who it is about)? */
            truth: {
              type: 'string',
              enum: ['supported', 'disproved', 'inconclusive'],
            },
            /**
             * Does evidence attach this claim to THIS supplied lead's entity?
             * - person/identity scope: the named person is the supplied lead
             * - company scope: the org is the lead's stated company (same entity)
             * - context scope: the claim is about this lead's situation, not a lookalike
             */
            bindsToLead: { type: 'boolean' },
            durationSupported: { type: 'boolean' },
            disproofFound: { type: 'boolean' },
            supportingEvidenceFound: { type: 'boolean' },
            rationale: { type: 'string' },
          },
        },
      },
      identityClassification: {
        type: ['string', 'null'],
        enum: [
          'verified',
          'usable_at_lower_resolution',
          'ambiguous',
          'conflicted',
          'not_found',
          null,
        ],
      },
      notes: { type: ['string', 'null'] },
    },
  },
} satisfies Anthropic.Tool;

export function buildAdversarialSystemPrompt(): string {
  return `You are an adversarial research auditor for outbound email drafting.

Your job is NOT to invent marketing angles. Your job is to DOUBT every claim on three axes:
1) TRUTH — is the statement factually true in the world?
2) BINDING — does it belong to THIS supplied lead entity (the person and/or their company)?
3) DURATION — do the cited sources actually support the event start, end, and relevance window?

Entity binding is mandatory. A true fact about the wrong person or a same-named lookalike must be dropped.

Binding rules:
- Always start from the lead snapshot (fullName, title, company, email domain, linkedinUrl).
- For bindScope=person or identity: bindsToLead=true ONLY if evidence co-locates this same person with the supplied company/title/email-domain/LinkedIn. Name match alone is NOT enough.
- For bindScope=company: bindsToLead=true ONLY if the organization in the claim is the lead's stated company (same entity), not a similarly named org.
- For bindScope=context: bindsToLead=true only if the situation is about this lead's company/role world, not a generic or lookalike context.
- Search to DISPROVE binding: other people with the same name, wrong employer, wrong email domain, outdated role, different company with a similar name.
- For temporal facts, verify the underlying event duration separately from article publication time. A source date alone does not prove a project is ongoing.
- Treat explicit duration as unsupported when the cited source does not state the duration, completion date, deadline, or equivalent event window.
- truth=supported means corroborating evidence the statement is true.
- truth=disproved means you found clear contradiction.
- truth=inconclusive means you could neither corroborate nor disprove after a serious attempt.
- durationSupported=true only when no duration is asserted or the cited source explicitly supports the event/relevance window.
- Prefer thinner true briefs. Zero kept claims is acceptable.
- Do not invent new prospect facts. Only score the provided claimIds.
- When finished, call report_adversarial_verdicts once with truth, binding, and duration support for EVERY candidate claimId.

Keep policy (applied in code, but score honestly):
- Drop if truth=disproved.
- Drop if bindsToLead=false.
- Person/identity-scoped claims require bindsToLead=true; "sounds true on the internet" is not enough.`;
}

/** Slim source stubs referenced by candidate claims — never the full research packet. */
export function buildAdversarialSourceStubs(
  packet: DraftingResearchPacket,
  claims: AdversarialClaim[],
): AdversarialSourceStub[] {
  const needed = new Set<string>();
  for (const claim of claims) {
    for (const note of claim.notes) {
      const match = /^sources=(.+)$/.exec(note);
      if (!match || match[1] === 'none') continue;
      for (const id of match[1].split(',')) {
        const trimmed = id.trim();
        if (trimmed) needed.add(trimmed);
      }
    }
  }
  for (const id of packet.leadIdentity.supportingSourceIds) needed.add(id);

  return packet.sources
    .filter((source) => needed.has(source.id))
    .map((source) => ({
      id: source.id,
      url: source.url,
      title: source.title,
      family: source.family,
      trustTier: source.trustTier,
      bindsPerson: source.bindsPerson,
      quote: source.quote.slice(0, 180),
    }));
}

export function buildAdversarialUserPrompt(input: {
  inputSnapshot: InputSnapshot;
  packet: DraftingResearchPacket;
  claims: AdversarialClaim[];
  maxSearches: number;
}): string {
  const lead = input.inputSnapshot.lead;
  const emailDomain = lead.email?.includes('@')
    ? lead.email.split('@')[1]?.toLowerCase() ?? null
    : null;

  const claimBlock = input.claims.map((claim) => ({
    claimId: claim.claimId,
    kind: claim.kind,
    bindScope: claim.bindScope,
    text: claim.text,
    notes: claim.notes,
  }));

  const sourceStubs = buildAdversarialSourceStubs(input.packet, input.claims);
  const packetMeta = {
    resolutionLevel: input.packet.resolution.level,
    identityClassification: input.packet.leadIdentity.classification,
    selectedFactIds: input.packet.resolution.selectedFactIds,
  };

  return [
    '## Lead entity to bind against (supplied — ground truth for identity)',
    JSON.stringify({
      fullName: lead.fullName,
      title: lead.title,
      company: lead.company,
      workLocation: lead.workLocation,
      email: lead.email,
      emailDomain,
      linkedinUrl: lead.linkedinUrl,
    }, null, 2),
    '',
    '## Packet metadata (not the full packet — do not invent missing fields)',
    JSON.stringify(packetMeta, null, 2),
    '',
    '## Source stubs for claim-referenced ids only',
    JSON.stringify(sourceStubs, null, 2),
    '',
    '## Candidate claims to score (truth + bindsToLead)',
    JSON.stringify(claimBlock, null, 2),
    '',
    '## Budget',
    input.maxSearches > 0
      ? `You may use at most ${input.maxSearches} web_search queries total.`
      : 'No web_search budget — score from the supplied lead, claims, and source stubs only.',
    'Prioritize identity/binding disproof for person-scoped claims, then company-entity binding, then generic truth checks.',
    '',
    'When done, call report_adversarial_verdicts with truth + bindsToLead for every claimId listed above.',
  ].join('\n');
}
