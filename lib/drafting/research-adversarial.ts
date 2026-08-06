import Anthropic from '@anthropic-ai/sdk';

import {
  computeHaikuTokenCostUsd,
  computeSearchCostUsd,
  formatUsd,
} from '@/lib/drafting/cost';
import { sha256Fingerprint } from '@/lib/drafting/normalize';
import {
  DRAFTING_ADVERSARIAL_PROMPT_VERSION,
  buildAdversarialSystemPrompt,
  buildAdversarialUserPrompt,
  reportAdversarialVerdictsTool,
  type AdversarialBindScope,
  type AdversarialClaim,
} from '@/lib/drafting/research-adversarial-prompt';
import type {
  DraftingResearchPacket,
  InputSnapshot,
  LeadIdentityClassification,
} from '@/lib/drafting/types';
import { LEAD_IDENTITY_CLASSIFICATIONS } from '@/lib/drafting/types';
import { selectWriterBoundResearch } from '@/lib/drafting/writer-research-brief';
import { withDraftingAnthropicSlot } from '@/lib/drafting/anthropic-semaphore';
import {
  DRAFTING_ADVERSARIAL_MODEL,
  assertLiveDraftingAllowed,
  getDraftingMode,
  resolvedDraftingAdversarialMaxSearches,
  resolvedDraftingAdversarialMaxTurns,
  resolvedDraftingPromptCacheTtl,
} from '@/lib/models';

export type AdversarialTruth = 'supported' | 'disproved' | 'inconclusive';

export type AdversarialVerdict = {
  claimId: string;
  truth: AdversarialTruth;
  bindsToLead: boolean;
  durationSupported: boolean;
  /** Derived keep/drop after truth + binding policy. */
  decision: 'keep' | 'drop';
  disproofFound: boolean;
  supportingEvidenceFound: boolean;
  rationale: string;
};

export type AdversarialAuditMode = 'skip' | 'light' | 'full';

export type AdversarialAuditPlan = {
  mode: AdversarialAuditMode;
  reason: string;
  maxSearches: number;
};

export type AdversarialVerifyResult = {
  verdicts: AdversarialVerdict[];
  identityClassification: LeadIdentityClassification | null;
  notes: string | null;
  packet: DraftingResearchPacket;
  skipped: boolean;
  auditMode: AdversarialAuditMode;
  usage: {
    inputTokens: number;
    outputTokens: number;
    searches: number;
    costUsd: string;
  };
  providerRequestId: string;
  modelId: string;
  promptVersion: string;
};

type CompanyVerdictCacheInput = {
  currentPacket: DraftingResearchPacket;
  sourcePacket: DraftingResearchPacket;
  sourceUsage: Record<string, unknown>;
  now?: Date;
};

export const COMPANY_VERDICT_CACHE_POLICY_VERSION = 'duration-aware-v2';
export type CachedCompanyAdversarialVerdicts = {
  verdicts: AdversarialVerdict[];
  originsByClaimId: Record<string, string>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function companyFactDigest(
  packet: DraftingResearchPacket,
  factId: string,
): string | null {
  const fact = [...packet.companyFacts, ...packet.roleSegmentFacts]
    .find((candidate) => candidate.id === factId);
  if (!fact || fact.sourceIds.length === 0) return null;
  const sources = fact.sourceIds
    .map((sourceId) => packet.sources.find((source) => source.id === sourceId))
    .filter((source) => source != null)
    .filter((source) =>
      !source.bindsPerson
      && source.trustTier !== 'low'
      && /^https?:\/\//i.test(source.url)
      && source.quote.trim().length > 0,
    );
  if (sources.length !== fact.sourceIds.length) return null;
  return sha256Fingerprint({
    policyVersion: COMPANY_VERDICT_CACHE_POLICY_VERSION,
    modelId: DRAFTING_ADVERSARIAL_MODEL,
    promptVersion: DRAFTING_ADVERSARIAL_PROMPT_VERSION,
    fact: {
      normalizedClaim: fact.normalizedClaim,
      quote: fact.quote,
      family: fact.family,
      confidence: fact.confidence,
      freshness: fact.freshness,
      weight: fact.weight,
      temporal: fact.temporal,
    },
    sources: sources
      .map((source) => ({
        url: source.url,
        title: source.title,
        family: source.family,
        trustTier: source.trustTier,
        publishedOrUpdated: source.publishedOrUpdated,
        quote: source.quote,
        bindsPerson: source.bindsPerson,
      }))
      .sort((left, right) => left.url.localeCompare(right.url)),
  });
}

/**
 * Reuse only positive company verdicts whose evidence, temporal metadata,
 * model, prompt, and policy fingerprints are unchanged and at most 72h old.
 * Person, identity, pressure, why-now, and negative verdicts are never cached.
 */
export function buildCachedCompanyAdversarialVerdicts(
  input: CompanyVerdictCacheInput,
): CachedCompanyAdversarialVerdicts {
  const now = input.now ?? new Date();
  const adversarial = asRecord(input.sourceUsage.adversarial);
  if (
    adversarial?.modelId !== DRAFTING_ADVERSARIAL_MODEL
    || adversarial.promptVersion !== DRAFTING_ADVERSARIAL_PROMPT_VERSION
    || adversarial.companyVerdictCachePolicyVersion
      !== COMPANY_VERDICT_CACHE_POLICY_VERSION
    || !Array.isArray(adversarial.verdicts)
  ) return { verdicts: [], originsByClaimId: {} };
  const sourceOrigins = asRecord(adversarial.companyVerdictOrigins);
  if (!sourceOrigins) return { verdicts: [], originsByClaimId: {} };

  const sourceDigestByClaimId = new Map<string, string>();
  for (const fact of [...input.sourcePacket.companyFacts, ...input.sourcePacket.roleSegmentFacts]) {
    if (!input.sourcePacket.resolution.selectedFactIds.includes(fact.id)) continue;
    const digest = companyFactDigest(input.sourcePacket, fact.id);
    if (digest) sourceDigestByClaimId.set(`fact:${fact.id}`, digest);
  }
  const currentClaimByDigest = new Map<string, string>();
  for (const fact of [...input.currentPacket.companyFacts, ...input.currentPacket.roleSegmentFacts]) {
    if (!input.currentPacket.resolution.selectedFactIds.includes(fact.id)) continue;
    const digest = companyFactDigest(input.currentPacket, fact.id);
    if (digest) currentClaimByDigest.set(digest, `fact:${fact.id}`);
  }

  const cached: AdversarialVerdict[] = [];
  const originsByClaimId: Record<string, string> = {};
  for (const rawVerdict of adversarial.verdicts) {
    const verdict = asRecord(rawVerdict);
    if (
      typeof verdict?.claimId !== 'string'
      || verdict.truth !== 'supported'
      || verdict.bindsToLead !== true
      || verdict.durationSupported !== true
      || verdict.decision !== 'keep'
    ) continue;
    const originValue = sourceOrigins[verdict.claimId];
    if (typeof originValue !== 'string') continue;
    const origin = new Date(originValue);
    if (
      !Number.isFinite(origin.getTime())
      || origin.getTime() > now.getTime()
      || now.getTime() - origin.getTime() > 72 * 60 * 60 * 1_000
    ) continue;
    const digest = sourceDigestByClaimId.get(verdict.claimId);
    const currentClaimId = digest ? currentClaimByDigest.get(digest) : null;
    if (!currentClaimId) continue;
    originsByClaimId[currentClaimId] = origin.toISOString();
    cached.push({
      claimId: currentClaimId,
      truth: 'supported',
      bindsToLead: true,
      durationSupported: true,
      decision: 'keep',
      disproofFound: false,
      supportingEvidenceFound: true,
      rationale: 'Reused exact company evidence verdict from this workspace (≤72h)',
    });
  }
  return { verdicts: cached, originsByClaimId };
}

export function buildCompanyVerdictOrigins(input: {
  packet: DraftingResearchPacket;
  verdicts: readonly AdversarialVerdict[];
  cachedOriginsByClaimId?: Readonly<Record<string, string>>;
  now?: Date;
}): Record<string, string> {
  const companyClaimIds = new Set(
    [...input.packet.companyFacts, ...input.packet.roleSegmentFacts]
      .filter((fact) => input.packet.resolution.selectedFactIds.includes(fact.id))
      .map((fact) => `fact:${fact.id}`),
  );
  const now = (input.now ?? new Date()).toISOString();
  const origins: Record<string, string> = {};
  for (const verdict of input.verdicts) {
    if (
      !companyClaimIds.has(verdict.claimId)
      || verdict.truth !== 'supported'
      || !verdict.bindsToLead
      || !verdict.durationSupported
      || verdict.decision !== 'keep'
    ) continue;
    origins[verdict.claimId] = input.cachedOriginsByClaimId?.[verdict.claimId] ?? now;
  }
  return origins;
}

/** Keep only if not disproved AND bound to this lead's entity. */
export function computeAdversarialDecision(input: {
  truth: AdversarialTruth;
  bindsToLead: boolean;
  durationSupported: boolean;
}): 'keep' | 'drop' {
  if (input.truth === 'disproved') return 'drop';
  if (!input.bindsToLead) return 'drop';
  if (!input.durationSupported) return 'drop';
  return 'keep';
}

/** Build the claim set Haiku must score for truth + entity binding. */
export function buildAdversarialClaims(packet: DraftingResearchPacket): AdversarialClaim[] {
  const claims: AdversarialClaim[] = [];
  const bound = selectWriterBoundResearch(packet);
  const boundFacts = [
    ...bound.personFacts.map((fact) => ({ fact, bindScope: 'person' as const })),
    ...bound.companyFacts.map((fact) => ({ fact, bindScope: 'company' as const })),
    ...bound.roleSegmentFacts.map((fact) => ({ fact, bindScope: 'company' as const })),
  ];

  for (const { fact, bindScope } of boundFacts) {
    claims.push({
      claimId: `fact:${fact.id}`,
      kind: 'fact',
      bindScope,
      text: fact.normalizedClaim,
      notes: [
        `bindScope=${bindScope}`,
        `confidence=${fact.confidence}`,
        `weight=${fact.weight}`,
        `freshness=${fact.freshness}`,
        `temporal=${JSON.stringify(fact.temporal ?? null)}`,
        `sources=${fact.sourceIds.join(',') || 'none'}`,
        fact.quote ? `quote=${fact.quote.slice(0, 180)}` : 'quote=empty',
      ],
    });
  }

  bound.pressures.forEach(({ pressure, index }) => {
    claims.push({
      claimId: `pressure:${index}`,
      kind: 'pressure',
      bindScope: 'context',
      text: pressure.statement,
      notes: [
        'bindScope=context — must be about THIS lead company/role world',
        `confidence=${pressure.confidence}`,
        `sources=${pressure.sourceIds.join(',') || 'none'}`,
      ],
    });
  });

  if (bound.includeWhyNow && packet.resolution.whyNow?.trim()) {
    claims.push({
      claimId: 'whyNow',
      kind: 'whyNow',
      bindScope: 'context',
      text: packet.resolution.whyNow,
      notes: ['bindScope=context'],
    });
  }

  if (packet.resolution.reasonForWriting?.trim()) {
    claims.push({
      claimId: 'reasonForWriting',
      kind: 'reasonForWriting',
      bindScope: 'context',
      text: packet.resolution.reasonForWriting,
      notes: ['bindScope=context'],
    });
  }

  if (bound.personFacts.length > 0) {
    claims.push({
      claimId: 'identity:classification',
      kind: 'identity',
      bindScope: 'identity',
      text: `Identity classification: ${packet.leadIdentity.classification}`,
      notes: [
        'bindScope=identity — verified only if this exact lead is bound to the stated company',
        `supplied=${packet.leadIdentity.suppliedSummary}`,
        `current=${packet.leadIdentity.currentSummary ?? 'null'}`,
        `conflict=${packet.leadIdentity.conflictSummary ?? 'null'}`,
      ],
    });
    if (packet.leadIdentity.currentSummary?.trim()) {
      claims.push({
        claimId: 'identity:currentSummary',
        kind: 'identity',
        bindScope: 'identity',
        text: packet.leadIdentity.currentSummary,
        notes: [
          'bindScope=identity — drop unless summary is about THIS lead, not a lookalike',
        ],
      });
    }
  }

  const contactNorm = packet.prospectWorld.contactNorm;
  if (bound.contactNorm) {
    claims.push({
      claimId: 'contactNorm',
      kind: 'contactNorm',
      bindScope: 'context',
      text: `${contactNorm.form}: ${contactNorm.statement}`,
      notes: [
        'bindScope=context',
        `confidence=${contactNorm.confidence}`,
      ],
    });
  }

  return claims;
}

function sourceById(packet: DraftingResearchPacket) {
  return new Map(packet.sources.map((source) => [source.id, source]));
}

function selectedFactsAreCompanyOnly(
  packet: DraftingResearchPacket,
  claims: AdversarialClaim[],
): boolean {
  const selected = new Set(
    claims
      .filter((claim) => claim.kind === 'fact' && claim.claimId.startsWith('fact:'))
      .map((claim) => claim.claimId.slice('fact:'.length)),
  );
  if (selected.size === 0) return false;
  const personIds = new Set(packet.personFacts.map((fact) => fact.id));
  for (const factId of selected) {
    if (personIds.has(factId)) return false;
    const fact = [...packet.companyFacts, ...packet.roleSegmentFacts]
      .find((entry) => entry.id === factId);
    if (!fact) return false;
  }
  return true;
}

function selectedFactsAreHighTrustCompanyOnly(
  packet: DraftingResearchPacket,
  claims: AdversarialClaim[],
): boolean {
  if (!selectedFactsAreCompanyOnly(packet, claims)) return false;
  const selected = new Set(
    claims
      .filter((claim) => claim.kind === 'fact' && claim.claimId.startsWith('fact:'))
      .map((claim) => claim.claimId.slice('fact:'.length)),
  );
  const sources = sourceById(packet);

  for (const factId of selected) {
    const fact = [...packet.companyFacts, ...packet.roleSegmentFacts]
      .find((entry) => entry.id === factId);
    if (!fact) return false;
    if (fact.confidence !== 'supported') return false;
    const tiers = fact.sourceIds.map((id) => sources.get(id)?.trustTier);
    if (tiers.length === 0 || tiers.some((tier) => tier !== 'high')) return false;
    if (!fact.sourceIds.every((id) => {
      const family = sources.get(id)?.family;
      return family === 'first_party_company' || family === 'first_party_personal';
    })) {
      return false;
    }
  }
  return true;
}

/**
 * Decide whether adversarial QA can skip, run without search, or run full.
 * Skip thin / true-zero packets; lighten company-only packets (incl. enrichment
 * identity claims). Full search only when researched person facts are on the table.
 */
export function planAdversarialAudit(
  packet: DraftingResearchPacket,
  claims: AdversarialClaim[],
  fullMaxSearches: number,
): AdversarialAuditPlan {
  if (claims.length === 0) {
    return { mode: 'skip', reason: 'No candidate claims to audit', maxSearches: 0 };
  }
  if (packet.resolution.level === 'true_zero') {
    return { mode: 'skip', reason: 'true_zero resolution — nothing substantive to audit', maxSearches: 0 };
  }

  const substantive = claims.filter((claim) => (
    claim.kind === 'fact'
    || claim.kind === 'pressure'
    || claim.kind === 'whyNow'
    || claim.kind === 'reasonForWriting'
  ));
  if (substantive.length === 0 && !claims.some((claim) => claim.kind === 'fact')) {
    return {
      mode: 'skip',
      reason: 'Thin packet — no selected facts or substantive claims',
      maxSearches: 0,
    };
  }

  // Researched person facts force a full audit. Enrichment-backed identity claims
  // (title/company already on the lead) do not — those stay light with company facts.
  const hasResearchedPersonFacts = claims.some((claim) => claim.bindScope === 'person');

  if (!hasResearchedPersonFacts && selectedFactsAreCompanyOnly(packet, claims)) {
    const highTrust = selectedFactsAreHighTrustCompanyOnly(packet, claims);
    return {
      mode: 'light',
      reason: highTrust
        ? 'High-trust company-only packet — score without web_search'
        : 'Company-only facts with enrichment identity — score without web_search',
      maxSearches: 0,
    };
  }

  return {
    mode: 'full',
    reason: hasResearchedPersonFacts
      ? 'Full adversarial audit — researched person facts present'
      : 'Full adversarial audit',
    maxSearches: fullMaxSearches,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTruth(value: unknown): AdversarialTruth | null {
  if (value === 'supported' || value === 'disproved' || value === 'inconclusive') return value;
  return null;
}

function parseVerdicts(raw: unknown, expectedIds: Set<string>): {
  verdicts: AdversarialVerdict[];
  identityClassification: LeadIdentityClassification | null;
  notes: string | null;
} {
  if (!isRecord(raw)) throw new Error('Adversarial verdicts must be an object');
  if (!Array.isArray(raw.verdicts)) throw new Error('verdicts must be an array');

  const byId = new Map<string, AdversarialVerdict>();
  for (const [index, item] of raw.verdicts.entries()) {
    if (!isRecord(item)) throw new Error(`Invalid verdict at ${index}`);
    const claimId = String(item.claimId ?? '');
    if (!claimId) throw new Error(`Missing claimId at verdict ${index}`);

    // Prefer explicit truth; fall back from legacy booleans if a model omits truth.
    let truth = parseTruth(item.truth);
    if (!truth) {
      if (item.disproofFound) truth = 'disproved';
      else if (item.supportingEvidenceFound) truth = 'supported';
      else truth = 'inconclusive';
    }

    const bindsToLead = Boolean(item.bindsToLead);
    const disproofFound = Boolean(item.disproofFound) || truth === 'disproved';
    const supportingEvidenceFound = Boolean(item.supportingEvidenceFound) || truth === 'supported';
    const durationSupported = item.durationSupported === true;
    const decision = computeAdversarialDecision({ truth, bindsToLead, durationSupported });

    byId.set(claimId, {
      claimId,
      truth,
      bindsToLead,
      durationSupported,
      decision,
      disproofFound,
      supportingEvidenceFound,
      rationale: String(item.rationale ?? ''),
    });
  }

  const verdicts: AdversarialVerdict[] = [];
  for (const claimId of expectedIds) {
    const existing = byId.get(claimId);
    if (existing) {
      verdicts.push(existing);
      continue;
    }
    verdicts.push({
      claimId,
      truth: 'inconclusive',
      bindsToLead: false,
      durationSupported: false,
      decision: 'drop',
      disproofFound: false,
      supportingEvidenceFound: false,
      rationale: 'No verdict returned — dropped (no bind)',
    });
  }

  let identityClassification: LeadIdentityClassification | null = null;
  if (typeof raw.identityClassification === 'string'
    && (LEAD_IDENTITY_CLASSIFICATIONS as readonly string[]).includes(raw.identityClassification)) {
    identityClassification = raw.identityClassification as LeadIdentityClassification;
  }

  return {
    verdicts,
    identityClassification,
    notes: typeof raw.notes === 'string' ? raw.notes : null,
  };
}

/** Apply keep/drop verdicts onto a packet. Dropped material is removed, not paused. */
export function applyAdversarialVerdicts(
  packet: DraftingResearchPacket,
  verdicts: AdversarialVerdict[],
  identityClassification: LeadIdentityClassification | null,
): DraftingResearchPacket {
  const drop = new Set(
    verdicts.filter((verdict) => verdict.decision === 'drop').map((verdict) => verdict.claimId),
  );

  const selectedFactIds = packet.resolution.selectedFactIds.filter(
    (factId) => !drop.has(`fact:${factId}`),
  );

  const pressures = packet.prospectWorld.pressures.filter(
    (_pressure, index) => !drop.has(`pressure:${index}`),
  );

  let whyNow = packet.resolution.whyNow;
  if (drop.has('whyNow')) whyNow = null;

  let reasonForWriting = packet.resolution.reasonForWriting;
  if (drop.has('reasonForWriting')) reasonForWriting = null;

  let contactNorm = packet.prospectWorld.contactNorm;
  if (drop.has('contactNorm')) {
    contactNorm = {
      form: 'unknown',
      statement: '',
      sourceIds: [],
      confidence: 'tentative',
    };
  }

  let leadIdentity = packet.leadIdentity;
  if (drop.has('identity:currentSummary')) {
    leadIdentity = { ...leadIdentity, currentSummary: null, conflictSummary: null };
  }

  const identityClassVerdict = verdicts.find((verdict) => verdict.claimId === 'identity:classification');
  if (identityClassification) {
    // Model may suggest a class, but never allow verified without a keep+bind on identity.
    if (
      identityClassification === 'verified'
      && identityClassVerdict
      && identityClassVerdict.decision !== 'keep'
    ) {
      leadIdentity = {
        ...leadIdentity,
        classification: 'usable_at_lower_resolution',
        conflictSummary: null,
      };
    } else {
      leadIdentity = { ...leadIdentity, classification: identityClassification };
    }
  } else if (drop.has('identity:classification')) {
    leadIdentity = {
      ...leadIdentity,
      classification: 'usable_at_lower_resolution',
      conflictSummary: null,
    };
  }

  // If any person fact was dropped for bind failure, never stay at person resolution.
  const personFactIds = new Set(packet.personFacts.map((fact) => fact.id));
  const keptPersonFacts = selectedFactIds.filter((factId) => personFactIds.has(factId));
  let resolutionLevel = packet.resolution.level;
  if (resolutionLevel === 'person' && keptPersonFacts.length === 0) {
    resolutionLevel = selectedFactIds.some((id) => packet.companyFacts.some((f) => f.id === id))
      ? 'company'
      : selectedFactIds.some((id) => packet.roleSegmentFacts.some((f) => f.id === id))
        ? 'role_segment'
        : 'company';
  }

  return {
    ...packet,
    leadIdentity,
    prospectWorld: {
      ...packet.prospectWorld,
      pressures,
      contactNorm,
    },
    resolution: {
      ...packet.resolution,
      level: resolutionLevel,
      selectedFactIds,
      whyNow,
      reasonForWriting,
    },
  };
}

function webSearchRequests(message: Anthropic.Message) {
  const usage = message.usage as Anthropic.Message['usage'] & {
    server_tool_use?: { web_search_requests?: number };
  };
  return Math.max(0, Number(usage.server_tool_use?.web_search_requests ?? 0));
}

function toolUseBlock(message: Anthropic.Message, name: string) {
  const block = message.content.find(
    (content) => content.type === 'tool_use' && content.name === name,
  );
  return block && block.type === 'tool_use' ? block : null;
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

function stubAdversarial(
  packet: DraftingResearchPacket,
  claims: AdversarialClaim[],
  plan: AdversarialAuditPlan,
): AdversarialVerifyResult {
  if (plan.mode === 'skip') {
    return {
      verdicts: [],
      identityClassification: null,
      notes: plan.reason,
      packet,
      skipped: true,
      auditMode: 'skip',
      usage: { inputTokens: 0, outputTokens: 0, searches: 0, costUsd: '0.0000' },
      providerRequestId: 'adversarial-skipped',
      modelId: DRAFTING_ADVERSARIAL_MODEL,
      promptVersion: DRAFTING_ADVERSARIAL_PROMPT_VERSION,
    };
  }

  const verdicts = claims.map((claim) => ({
    claimId: claim.claimId,
    truth: 'supported' as const,
    bindsToLead: true,
    durationSupported: true,
    decision: 'keep' as const,
    disproofFound: false,
    supportingEvidenceFound: true,
    rationale: 'stub: keep with assumed bind (no live adversarial search)',
  }));
  return {
    verdicts,
    identityClassification: null,
    notes: plan.mode === 'light' ? `stub:${plan.reason}` : 'stub',
    packet: applyAdversarialVerdicts(packet, verdicts, null),
    skipped: false,
    auditMode: plan.mode,
    usage: { inputTokens: 0, outputTokens: 0, searches: 0, costUsd: '0.0000' },
    providerRequestId: 'stub-adversarial',
    modelId: DRAFTING_ADVERSARIAL_MODEL,
    promptVersion: DRAFTING_ADVERSARIAL_PROMPT_VERSION,
  };
}

async function adversarialLive(
  inputSnapshot: InputSnapshot,
  packet: DraftingResearchPacket,
  claims: AdversarialClaim[],
  plan: AdversarialAuditPlan,
): Promise<AdversarialVerifyResult> {
  assertLiveDraftingAllowed();
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const cacheTtl = resolvedDraftingPromptCacheTtl();
  const system: Anthropic.TextBlockParam[] = [{
    type: 'text',
    text: buildAdversarialSystemPrompt(),
    cache_control: { type: 'ephemeral', ttl: cacheTtl },
  }];
  const userPrompt = buildAdversarialUserPrompt({
    inputSnapshot,
    packet,
    claims,
    maxSearches: plan.maxSearches,
  });
  const maxTurns = resolvedDraftingAdversarialMaxTurns();
  const expectedIds = new Set(claims.map((claim) => claim.claimId));
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userPrompt }];
  const messagesUsed: Anthropic.Message[] = [];
  let parsed: ReturnType<typeof parseVerdicts> | null = null;
  let parseError: string | null = null;

  const forceVerdicts = async () => {
    messages.push({
      role: 'user',
      content: parseError
        ? `Previous report_adversarial_verdicts was invalid (${parseError}). Call it again with truth + bindsToLead + durationSupported for every claimId.`
        : 'Call report_adversarial_verdicts now with truth + bindsToLead + durationSupported for every claimId. Do not narrate.',
    });
    const forced = await client.messages.create({
      model: DRAFTING_ADVERSARIAL_MODEL,
      max_tokens: 2_048,
      system,
      messages,
      tools: [reportAdversarialVerdictsTool],
      tool_choice: { type: 'tool', name: 'report_adversarial_verdicts' },
    });
    messagesUsed.push(forced);
    const forcedBlock = toolUseBlock(forced, 'report_adversarial_verdicts');
    if (!forcedBlock) return;
    parsed = parseVerdicts(forcedBlock.input, expectedIds);
  };

  // Light / no-search path: single forced report — no multi-turn search loop.
  if (plan.maxSearches === 0) {
    await forceVerdicts();
  } else {
    const webSearchTool: Anthropic.WebSearchTool20250305 = {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: plan.maxSearches,
    };

    for (let turn = 0; turn < maxTurns; turn += 1) {
      const response = await client.messages.create({
        model: DRAFTING_ADVERSARIAL_MODEL,
        max_tokens: 2_048,
        system,
        messages,
        tools: [webSearchTool, reportAdversarialVerdictsTool],
        tool_choice: { type: 'auto' },
      });
      messagesUsed.push(response);

      const block = toolUseBlock(response, 'report_adversarial_verdicts');
      if (block) {
        try {
          parsed = parseVerdicts(block.input, expectedIds);
          break;
        } catch (error) {
          parseError = error instanceof Error ? error.message : String(error);
        }
      }

      messages.push({ role: 'assistant', content: response.content as Anthropic.ContentBlockParam[] });

      const pendingClient = pendingClientToolUses(response.content);
      if (pendingClient.length > 0) {
        messages.push({
          role: 'user',
          content: pendingClient.map((tool) => ({
            type: 'tool_result' as const,
            tool_use_id: tool.id,
            content: tool.name === 'report_adversarial_verdicts'
              ? parseError
                ?? 'Invalid verdicts payload. Call report_adversarial_verdicts again with truth + bindsToLead for every claimId.'
              : 'Tool unavailable.',
            is_error: true,
          })),
        });
        continue;
      }

      if (hasPendingServerToolUse(response.content) || response.stop_reason === 'pause_turn') {
        continue;
      }

      const searchesUsed = messagesUsed.reduce((sum, message) => sum + webSearchRequests(message), 0);
      const searchesExhausted = searchesUsed >= plan.maxSearches;
      if (
        searchesExhausted
        || response.stop_reason === 'end_turn'
        || response.stop_reason === 'max_tokens'
        || response.stop_reason === 'tool_use'
        || turn >= maxTurns - 1
      ) {
        await forceVerdicts();
        break;
      }

      break;
    }
  }

  if (!parsed) {
    throw new Error(parseError ?? 'Adversarial verify finished without verdicts');
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let searches = 0;
  for (const message of messagesUsed) {
    inputTokens += message.usage.input_tokens ?? 0;
    outputTokens += message.usage.output_tokens ?? 0;
    searches += webSearchRequests(message);
  }

  const nextPacket = applyAdversarialVerdicts(
    packet,
    parsed.verdicts,
    parsed.identityClassification,
  );

  return {
    verdicts: parsed.verdicts,
    identityClassification: parsed.identityClassification,
    notes: parsed.notes ?? plan.reason,
    packet: nextPacket,
    skipped: false,
    auditMode: plan.mode,
    usage: {
      inputTokens,
      outputTokens,
      searches,
      costUsd: formatUsd(
        computeHaikuTokenCostUsd(inputTokens, outputTokens) + computeSearchCostUsd(searches),
      ),
    },
    providerRequestId: messagesUsed[0]?.id ?? 'unknown',
    modelId: DRAFTING_ADVERSARIAL_MODEL,
    promptVersion: DRAFTING_ADVERSARIAL_PROMPT_VERSION,
  };
}

/**
 * Adversarial QA pass: score truth + entity binding with Haiku + web_search.
 * Skips thin/true-zero packets; lightens high-trust company-only packets.
 */
export async function runResearchAdversarialVerify(input: {
  inputSnapshot: InputSnapshot;
  packet: DraftingResearchPacket;
  maxSearches?: number;
  cachedCompanyVerdicts?: readonly AdversarialVerdict[];
}): Promise<AdversarialVerifyResult> {
  const allClaims = buildAdversarialClaims(input.packet);
  const cacheableClaimIds = new Set(
    allClaims
      .filter((claim) => claim.kind === 'fact' && claim.bindScope === 'company')
      .map((claim) => claim.claimId),
  );
  const cachedCompanyVerdicts = (input.cachedCompanyVerdicts ?? [])
    .filter((verdict) =>
      cacheableClaimIds.has(verdict.claimId)
      && verdict.truth === 'supported'
      && verdict.bindsToLead
      && verdict.durationSupported
      && verdict.decision === 'keep',
    );
  const cachedClaimIds = new Set(cachedCompanyVerdicts.map((verdict) => verdict.claimId));
  const claims = allClaims.filter((claim) => !cachedClaimIds.has(claim.claimId));
  const fullMaxSearches = Math.max(
    0,
    Math.min(
      resolvedDraftingAdversarialMaxSearches(),
      input.maxSearches ?? resolvedDraftingAdversarialMaxSearches(),
    ),
  );
  const plan = planAdversarialAudit(input.packet, claims, fullMaxSearches);

  if (claims.length === 0 && cachedCompanyVerdicts.length > 0) {
    return {
      verdicts: [...cachedCompanyVerdicts],
      identityClassification: null,
      notes: `company_verdict_cache_hits=${cachedCompanyVerdicts.length}`,
      packet: applyAdversarialVerdicts(input.packet, cachedCompanyVerdicts, null),
      skipped: false,
      auditMode: 'light',
      usage: { inputTokens: 0, outputTokens: 0, searches: 0, costUsd: '0.0000' },
      providerRequestId: 'adversarial-company-cache',
      modelId: DRAFTING_ADVERSARIAL_MODEL,
      promptVersion: DRAFTING_ADVERSARIAL_PROMPT_VERSION,
    };
  }

  if (plan.mode === 'skip') {
    return {
      verdicts: [],
      identityClassification: null,
      notes: plan.reason,
      packet: input.packet,
      skipped: true,
      auditMode: 'skip',
      usage: { inputTokens: 0, outputTokens: 0, searches: 0, costUsd: '0.0000' },
      providerRequestId: 'adversarial-skipped',
      modelId: DRAFTING_ADVERSARIAL_MODEL,
      promptVersion: DRAFTING_ADVERSARIAL_PROMPT_VERSION,
    };
  }

  const liveResult = getDraftingMode() !== 'live'
    ? stubAdversarial(input.packet, claims, plan)
    : await withDraftingAnthropicSlot(() =>
      adversarialLive(input.inputSnapshot, input.packet, claims, plan),
    );
  if (cachedCompanyVerdicts.length === 0) return liveResult;
  const verdicts = [...cachedCompanyVerdicts, ...liveResult.verdicts];
  return {
    ...liveResult,
    verdicts,
    notes: [
      liveResult.notes,
      `company_verdict_cache_hits=${cachedCompanyVerdicts.length}`,
    ].filter(Boolean).join('; '),
    packet: applyAdversarialVerdicts(
      input.packet,
      verdicts,
      liveResult.identityClassification,
    ),
  };
}

export type { AdversarialBindScope };
