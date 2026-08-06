import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeHaikuTokenCostUsd,
  computeTokenCostUsd,
} from '@/lib/drafting/cost';
import { resolveCompanyResearchKey } from '@/lib/drafting/company-research-key';
import { runWithLeaseHeartbeat } from '@/lib/drafting/lease-heartbeat';
import { buildEffectiveInputSnapshot } from '@/lib/drafting/normalize';
import { parseDraftingResearchPacket } from '@/lib/drafting/provider-parse';
import {
  COMPANY_VERDICT_CACHE_POLICY_VERSION,
  buildAdversarialClaims,
  buildCachedCompanyAdversarialVerdicts,
  buildCompanyVerdictOrigins,
} from '@/lib/drafting/research-adversarial';
import { DRAFTING_ADVERSARIAL_PROMPT_VERSION } from '@/lib/drafting/research-adversarial-prompt';
import {
  assemblePacketFromReusableContext,
  buildReusableCompanyResearchContext,
  canSkipSiblingResearch,
} from '@/lib/drafting/research-company-reuse';
import { prefilterResearchPacketForAdversarial } from '@/lib/drafting/research-reconcile';
import { resolveResearchProtocolBudget } from '@/lib/drafting/research-provider';
import {
  buildResearchSystemBlocks,
  buildResearchUserPrompt,
  reportDraftingResearchTool,
} from '@/lib/drafting/research-prompt';
import type { InputSnapshot } from '@/lib/drafting/types';
import {
  DRAFTING_ADVERSARIAL_MODEL,
  resolvedDraftingResearchMaxCalls,
} from '@/lib/models';

const inputSnapshot: InputSnapshot = {
  schemaVersion: 1,
  lead: {
    fullName: 'Jane Smith',
    firstName: 'Jane',
    lastName: 'Smith',
    email: 'jane@acme.com',
    company: 'Acme',
    title: 'Chief Financial Officer',
    workLocation: 'Dallas, TX',
    linkedinUrl: null,
    emailStatus: 'verified',
    emailDecision: 'valid',
  },
  relationship: {
    pastWork: null,
    priorRelationshipActivity: null,
    lastContacted: null,
    lastContactedBy: null,
    relationshipTier: null,
    reusedFromPriorLead: false,
    capturedAt: null,
  },
  connectingContext: {
    mode: 'cold',
    introducerName: null,
    suppliedContext: null,
    linkedinConnectionDegree: null,
    rawCrmIndicator: null,
  },
  customContext: {},
  provenance: {
    sourceRunId: null,
    profileEnrichment: {},
    emailProvenance: {},
  },
  sender: {
    profileId: 'profile-1',
    profileRevision: 1,
    displayName: 'Lucas',
    workEmail: 'lucas@example.com',
    title: 'Director',
    signatureMode: 'name',
    voiceNotes: null,
    professionalContext: {},
  },
  assets: {
    skillVersion: 'v1',
    skillSha256: 'a',
    subjectLineVersion: 'v1',
    subjectLineSha256: 's',
    positioningVersion: 'v1',
    positioningSha256: 'b',
    capabilityCatalogVersion: 'v1',
    capabilityCatalogSha256: 'c',
  },
};

function compactPacket() {
  return {
    schemaVersion: '2',
    asOf: '2026-07-21T00:00:00.000Z',
    leadIdentity: {
      classification: 'verified',
      suppliedSummary: 'Jane Smith at Acme',
      currentSummary: 'Jane Smith is CFO at Acme',
      conflictSummary: null,
      supportingSourceIds: ['s1'],
    },
    prospectWorld: {
      roleReality: 'Owns finance and reporting',
      pressures: [
        { statement: 'Acme is scaling reporting', sourceIds: ['s2'], confidence: 'supported' },
        { statement: 'Acme has a new filing', sourceIds: ['s2'], confidence: 'supported' },
        { statement: 'This third pressure cannot reach the writer', sourceIds: ['s2'], confidence: 'supported' },
      ],
      contactNorm: {
        form: 'reply',
        statement: 'A direct reply is appropriate',
        sourceIds: ['s1'],
        confidence: 'supported',
      },
      registerNotes: ['Keep it direct'],
    },
    personFacts: [
      { id: 'p1', normalizedClaim: 'Jane leads finance', sourceIds: ['s1'], confidence: 'supported', freshness: 'current', weight: 'anchor', temporal: { kind: 'current_state', eventClass: 'structural', eventStart: null, eventEnd: null, relevanceEnd: null, durationBasis: 'unknown', durationSourceIds: [], durationEvidence: null, discourse: 'ongoing' } },
      { id: 'p2', normalizedClaim: 'Jane joined recently', sourceIds: ['s1'], confidence: 'supported', freshness: 'recent', weight: 'seasoning', temporal: { kind: 'event', eventClass: 'appointment', eventStart: '2026-07-20', eventEnd: null, relevanceEnd: null, durationBasis: 'policy_default', durationSourceIds: [], durationEvidence: null, discourse: 'current_trigger' } },
      { id: 'p3', normalizedClaim: 'Third person fact', sourceIds: ['s1'], confidence: 'supported', freshness: 'current', weight: 'seasoning', temporal: { kind: 'evergreen', eventClass: 'structural', eventStart: null, eventEnd: null, relevanceEnd: null, durationBasis: 'unknown', durationSourceIds: [], durationEvidence: null, discourse: 'timeless' } },
    ],
    companyFacts: [
      { id: 'c1', normalizedClaim: 'Acme is expanding', sourceIds: ['s2'], confidence: 'supported', freshness: 'current', weight: 'anchor', temporal: { kind: 'current_state', eventClass: 'structural', eventStart: null, eventEnd: null, relevanceEnd: null, durationBasis: 'unknown', durationSourceIds: [], durationEvidence: null, discourse: 'ongoing' } },
      { id: 'c2', normalizedClaim: 'Unsupported company claim', sourceIds: ['s2'], confidence: 'tentative', freshness: 'undated', weight: 'seasoning', temporal: { kind: 'evergreen', eventClass: 'structural', eventStart: null, eventEnd: null, relevanceEnd: null, durationBasis: 'unknown', durationSourceIds: [], durationEvidence: null, discourse: 'timeless' } },
    ],
    roleSegmentFacts: [],
    structuralRelation: {
      relation: 'complementary',
      embarkCapabilityId: 'financial_reporting_advisory',
      sourceIds: ['s1'],
    },
    statusGeometry: { classification: 'peer' },
    resolution: {
      level: 'person',
      selectedFactIds: ['p1', 'p2', 'p3', 'c1', 'c2'],
      reasonForWriting: 'Acme is scaling',
      whyNow: 'Acme filed an update this month',
    },
    sources: [{
      id: 's1',
      url: 'https://acme.example/news',
      family: 'first_party_company',
      trustTier: 'high',
      publishedOrUpdated: '2026-07-20',
      quote: 'Acme is expanding and Jane Smith leads finance.',
      bindsPerson: true,
    }, {
      id: 's2',
      url: 'https://acme.example/company-news',
      family: 'first_party_company',
      trustTier: 'high',
      publishedOrUpdated: '2026-07-20',
      quote: 'Acme is expanding its reporting organization.',
      bindsPerson: false,
    }],
  };
}

test('research call budget defaults to two total provider calls', () => {
  const previous = process.env.DRAFT_RESEARCH_MAX_CALLS;
  delete process.env.DRAFT_RESEARCH_MAX_CALLS;
  try {
    assert.equal(resolvedDraftingResearchMaxCalls(), 2);
  } finally {
    if (previous === undefined) delete process.env.DRAFT_RESEARCH_MAX_CALLS;
    else process.env.DRAFT_RESEARCH_MAX_CALLS = previous;
  }
});

test('research call budget cannot be configured above three calls', () => {
  const previous = process.env.DRAFT_RESEARCH_MAX_CALLS;
  process.env.DRAFT_RESEARCH_MAX_CALLS = '99';
  try {
    assert.equal(resolvedDraftingResearchMaxCalls(), 3);
  } finally {
    if (previous === undefined) delete process.env.DRAFT_RESEARCH_MAX_CALLS;
    else process.env.DRAFT_RESEARCH_MAX_CALLS = previous;
  }
});

test('singleflight heartbeat renews during work and stops afterward', async () => {
  let heartbeats = 0;
  let scheduledHeartbeat: (() => void) | null = null;
  let timerCleared = false;
  let finishOperation: (() => void) | undefined;
  const running = runWithLeaseHeartbeat({
    heartbeat: async () => {
      heartbeats += 1;
    },
    operation: async () => {
      await new Promise<void>((resolve) => { finishOperation = resolve; });
      return 'done';
    },
    intervalMs: 10,
    scheduler: {
      setInterval: (callback) => {
        scheduledHeartbeat = callback;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {
        timerCleared = true;
        scheduledHeartbeat = null;
      },
    },
  });
  await Promise.resolve();
  assert.equal(heartbeats, 1);
  for (let index = 0; index < 3; index += 1) {
    const tick = scheduledHeartbeat;
    if (!tick) throw new Error('Expected scheduled heartbeat');
    tick();
    await Promise.resolve();
  }
  finishOperation?.();
  const result = await running;
  assert.equal(result, 'done');
  assert.equal(heartbeats, 4);
  assert.equal(timerCleared, true);
  const completedHeartbeats = heartbeats;
  assert.equal(scheduledHeartbeat, null);
  assert.equal(heartbeats, completedHeartbeats);
});

test('company coordination keys only on exact non-generic email domains', () => {
  assert.equal(resolveCompanyResearchKey(' Jane@Acme.COM '), 'acme.com');
  assert.equal(resolveCompanyResearchKey('jane@gmail.com'), null);
  assert.equal(resolveCompanyResearchKey('invalid'), null);
});

test('reused research collapses to one forced report at 4096 tokens', () => {
  assert.deepEqual(resolveResearchProtocolBudget({
    hasReusableCompanyContext: true,
    configuredMaxCalls: 3,
    configuredMaxTokens: 8_192,
  }), {
    maxCalls: 1,
    autoMaxTokens: 4_096,
    reportMaxTokens: 4_096,
  });
  assert.equal(resolveResearchProtocolBudget({
    hasReusableCompanyContext: false,
    maxSearches: 0,
    configuredMaxCalls: 2,
  }).maxCalls, 1);
  assert.equal(resolveResearchProtocolBudget({
    hasReusableCompanyContext: false,
    maxSearches: 3,
    configuredMaxCalls: 2,
  }).maxCalls, 2);
});

test('research snapshot materializes corrected company and identity fields', () => {
  const effective = buildEffectiveInputSnapshot(inputSnapshot, {
    fullName: 'Janet Jones',
    company: 'Corrected Co',
    title: 'Controller',
  });
  assert.equal(effective.lead.fullName, 'Janet Jones');
  assert.equal(effective.lead.firstName, 'Janet');
  assert.equal(effective.lead.lastName, 'Jones');
  assert.equal(effective.lead.company, 'Corrected Co');
  assert.equal(effective.lead.title, 'Controller');
});

test('compact research report hydrates legacy-safe internal defaults', () => {
  const packet = parseDraftingResearchPacket(compactPacket());
  assert.equal(packet.freshness.employer.status, 'undated');
  assert.equal(packet.personFacts[0].quote, packet.sources[0].quote);
  assert.equal(packet.personFacts[0].family, 'first_party_company');
  assert.equal(packet.structuralRelation.recipientConstraint, null);
  assert.equal(packet.statusGeometry.safePosture, 'measured_small_ask');
  assert.deepEqual(packet.resolution.prohibitedAssumptions, []);
  assert.equal(packet.companyContextProvenance.origin, 'fresh');

  const required = reportDraftingResearchTool.input_schema.required as string[];
  assert.equal(required.includes('freshness'), false);
  assert.equal(required.includes('resolutionUpgrade'), false);
  assert.equal(required.includes('companyContextProvenance'), false);
});

test('static positioning and capability catalog sit behind the cache breakpoint', () => {
  const system = buildResearchSystemBlocks({
    positioningText: 'positioning body',
    capabilityCatalog: [{
      id: 'financial_reporting_advisory',
      category: 'strategic_finance_advisory',
      label: 'Financial reporting',
      exactSourceText: 'Financial reporting',
      sourcePage: 1,
      allowedSummary: 'Reporting support',
    }],
    cacheTtl: '1h',
  });
  assert.match(system.map((block) => block.text).join('\n'), /Five readings research must serve/);
  assert.doesNotMatch(system.map((block) => block.text).join('\n'), /skill body/);
  assert.match(system.at(-1)?.text ?? '', /positioning body/);
  assert.match(system.at(-1)?.text ?? '', /Reporting support/);
  assert.deepEqual(system.at(-1)?.cache_control, { type: 'ephemeral', ttl: '1h' });

  const user = buildResearchUserPrompt({ inputSnapshot, maxSearches: 2 });
  assert.doesNotMatch(user, /positioning body|Reporting support/);
  assert.doesNotMatch(user, /capabilityCatalogSha256|sourceRunId/);
});

test('company reuse carries only supported writer-relevant company evidence', () => {
  const packet = parseDraftingResearchPacket(compactPacket());
  const reused = buildReusableCompanyResearchContext({
    sourceDraftingItemId: 'item-1',
    company: 'Acme',
    packet,
    now: new Date('2026-07-21T00:00:00.000Z'),
  });
  assert.ok(reused);
  assert.deepEqual(reused.companyFacts.map((fact) => fact.id), ['c1']);
  assert.equal(reused.sources.length, 1);
  assert.equal(reused.validUntil, '2026-07-24T00:00:00.000Z');
  assert.equal(reused.sources.every((source) => !source.bindsPerson), true);
  assert.equal(canSkipSiblingResearch(inputSnapshot, reused, new Date('2026-07-21T00:00:00.000Z')), true);
  assert.equal(canSkipSiblingResearch({
    ...inputSnapshot,
    lead: { ...inputSnapshot.lead, title: null },
  }, reused, new Date('2026-07-21T00:00:00.000Z')), false);
  const assembled = assemblePacketFromReusableContext({
    inputSnapshot,
    reusable: reused,
    now: new Date('2026-07-21T00:00:00.000Z'),
  });
  assert.equal(assembled.companyContextProvenance.origin, 'reused_within_workspace');
  assert.equal(assembled.personFacts.length, 0);
  assert.deepEqual(assembled.companyFacts.map((fact) => fact.id), ['c1']);

  const user = buildResearchUserPrompt({
    inputSnapshot,
    maxSearches: 1,
    reusableCompanyContext: reused,
  });
  assert.match(user, /Do not spend a web search rediscovering these company facts/);
  assert.match(user, /sourceDraftingItemId/);
});

test('company reuse rejects facts backed by person-bound sources', () => {
  const packet = parseDraftingResearchPacket(compactPacket());
  packet.companyFacts = [{
    ...packet.companyFacts[0],
    sourceIds: ['s1'],
  }];
  packet.roleSegmentFacts = [];
  packet.prospectWorld.pressures = [];
  assert.equal(buildReusableCompanyResearchContext({
    sourceDraftingItemId: 'item-1',
    company: 'Acme',
    packet,
  }), null);
});

test('adversarial QA receives only evidence that can reach the writer', () => {
  const claims = buildAdversarialClaims(parseDraftingResearchPacket(compactPacket()));
  const ids = claims.map((claim) => claim.claimId);
  assert.equal(ids.includes('fact:p1'), true);
  assert.equal(ids.includes('fact:p2'), true);
  assert.equal(ids.includes('fact:p3'), false);
  assert.equal(ids.includes('fact:c1'), true);
  assert.equal(ids.includes('fact:c2'), false);
  assert.equal(ids.includes('pressure:0'), true);
  assert.equal(ids.includes('pressure:1'), true);
  assert.equal(ids.includes('pressure:2'), false);
});

test('pre-adversarial filter drops deterministic junk but preserves temporal disputes', () => {
  const packet = parseDraftingResearchPacket(compactPacket());
  const filtered = prefilterResearchPacketForAdversarial(packet);
  assert.equal(filtered.packet.resolution.selectedFactIds.includes('c2'), false);
  assert.equal(filtered.packet.resolution.selectedFactIds.includes('p2'), true);
  assert.equal(
    filtered.actions.some((action) => action.code === 'PREFILTER_UNSUPPORTED_FACT'),
    true,
  );
});

test('company QA cache requires exact evidence, model, prompt, and fresh timestamp', () => {
  const sourcePacket = parseDraftingResearchPacket(compactPacket());
  const currentPacket = structuredClone(sourcePacket);
  currentPacket.companyFacts[0].id = 'current-company-fact';
  currentPacket.resolution.selectedFactIds = ['current-company-fact'];
  const sourceUsage = {
    adversarial: {
      modelId: DRAFTING_ADVERSARIAL_MODEL,
      promptVersion: DRAFTING_ADVERSARIAL_PROMPT_VERSION,
      companyVerdictCachePolicyVersion: COMPANY_VERDICT_CACHE_POLICY_VERSION,
      companyVerdictOrigins: {
        'fact:c1': '2026-07-21T00:00:00.000Z',
      },
      verdicts: [{
        claimId: 'fact:c1',
        truth: 'supported',
        bindsToLead: true,
        durationSupported: true,
        decision: 'keep',
      }],
    },
  };
  const cached = buildCachedCompanyAdversarialVerdicts({
    currentPacket,
    sourcePacket,
    sourceUsage,
    now: new Date('2026-07-22T00:00:00.000Z'),
  });
  assert.deepEqual(
    cached.verdicts.map((verdict) => verdict.claimId),
    ['fact:current-company-fact'],
  );
  assert.deepEqual(buildCompanyVerdictOrigins({
    packet: currentPacket,
    verdicts: cached.verdicts,
    cachedOriginsByClaimId: cached.originsByClaimId,
    now: new Date('2026-07-22T00:00:00.000Z'),
  }), {
    'fact:current-company-fact': '2026-07-21T00:00:00.000Z',
  });

  currentPacket.sources[1].quote = 'Evidence changed';
  assert.deepEqual(buildCachedCompanyAdversarialVerdicts({
    currentPacket,
    sourcePacket,
    sourceUsage,
    now: new Date('2026-07-22T00:00:00.000Z'),
  }).verdicts, []);

  currentPacket.sources[1].quote = sourcePacket.sources[1].quote;
  assert.deepEqual(buildCachedCompanyAdversarialVerdicts({
    currentPacket,
    sourcePacket,
    sourceUsage,
    now: new Date('2026-07-25T00:00:00.000Z'),
  }).verdicts, []);

  sourceUsage.adversarial.companyVerdictCachePolicyVersion = 'older-policy';
  assert.deepEqual(buildCachedCompanyAdversarialVerdicts({
    currentPacket,
    sourcePacket,
    sourceUsage,
    now: new Date('2026-07-22T00:00:00.000Z'),
  }).verdicts, []);
});

test('Haiku adversarial usage is priced below Sonnet usage', () => {
  const haiku = computeHaikuTokenCostUsd(100_000, 10_000);
  const sonnet = computeTokenCostUsd(100_000, 10_000);
  assert.equal(haiku.toFixed(2), '0.15');
  assert.equal(sonnet.toFixed(2), '0.30');
});
