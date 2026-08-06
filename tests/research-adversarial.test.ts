import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyAdversarialVerdicts,
  buildAdversarialClaims,
  computeAdversarialDecision,
  planAdversarialAudit,
  runResearchAdversarialVerify,
} from '@/lib/drafting/research-adversarial';
import {
  buildAdversarialSourceStubs,
  buildAdversarialUserPrompt,
} from '@/lib/drafting/research-adversarial-prompt';
import type { DraftingResearchPacket, InputSnapshot } from '@/lib/drafting/types';

function samplePacket(): DraftingResearchPacket {
  return {
    schemaVersion: '2',
    asOf: '2026-07-20T12:00:00.000Z',
    leadIdentity: {
      classification: 'usable_at_lower_resolution',
      suppliedSummary: 'Jane Doe, CFO, Acme',
      currentSummary: 'Jane Doe appears to be CFO at Acme',
      conflictSummary: null,
      supportingSourceIds: ['s1'],
    },
    freshness: {
      employer: { status: 'current', sourceIds: ['s1'], summary: 'Acme' },
      title: { status: 'current', sourceIds: ['s1'], summary: 'CFO' },
      location: { status: 'undated', sourceIds: [], summary: null },
    },
    prospectWorld: {
      roleReality: 'CFO',
      pressures: [{
        statement: 'Acme is expanding rapidly',
        sourceIds: ['s1'],
        confidence: 'supported',
      }],
      contactNorm: {
        form: 'reply',
        statement: 'Short reply preferred',
        sourceIds: ['s1'],
        confidence: 'supported',
      },
      registerNotes: [],
      commonVendorPatterns: [],
    },
    personFacts: [{
      id: 'pf1',
      normalizedClaim: 'Jane Doe is CFO of Acme',
      sourceIds: ['s1'],
      quote: 'Jane Doe, CFO',
      family: 'first_party_company',
      confidence: 'supported',
      freshness: 'current',
      weight: 'seasoning',
      significanceReason: 'Role',
      temporal: {
        kind: 'current_state', eventClass: 'structural', eventStart: null, eventEnd: null,
        relevanceEnd: null, durationBasis: 'unknown', durationSourceIds: [],
        durationEvidence: null, discourse: 'ongoing',
      },
    }],
    companyFacts: [{
      id: 'cf1',
      normalizedClaim: 'Acme celebrated a 20th anniversary',
      sourceIds: ['s1'],
      quote: '20th anniversary',
      family: 'reputable_news',
      confidence: 'supported',
      freshness: 'recent',
      weight: 'anchor',
      significanceReason: 'Timing',
      temporal: {
        kind: 'evergreen', eventClass: 'structural', eventStart: null, eventEnd: null,
        relevanceEnd: null, durationBasis: 'unknown', durationSourceIds: [],
        durationEvidence: null, discourse: 'timeless',
      },
    }],
    roleSegmentFacts: [],
    structuralRelation: {
      relation: 'adjacent',
      recipientConstraint: null,
      embarkCapabilityId: 'office_of_the_cfo',
      supportedReason: 'Finance growth',
      tensionToName: null,
      sourceIds: ['s1'],
    },
    statusGeometry: {
      classification: 'peer',
      safePosture: 'Peer',
      basis: 'Titles',
    },
    resolution: {
      level: 'person',
      selectedFactIds: ['pf1', 'cf1'],
      reasonForWriting: 'Anniversary year growth',
      whyNow: '20th anniversary in 2026',
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
      resolvedDomain: 'acme.com',
      validUntil: null,
    },
    sources: [{
      id: 's1',
      url: 'https://example.com/acme',
      title: 'Acme news',
      family: 'reputable_news',
      trustTier: 'high',
      publishedOrUpdated: '2026-05-01',
      accessedAt: '2026-07-20T12:00:00.000Z',
      quote: '20th anniversary',
      bindsPerson: false,
    }],
  };
}

const snapshot: InputSnapshot = {
  schemaVersion: 1,
  lead: {
    fullName: 'Jane Doe',
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@acme.com',
    company: 'Acme',
    title: 'CFO',
    workLocation: 'Dallas, TX',
    linkedinUrl: null,
    emailStatus: 'direct',
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
    profileId: '00000000-0000-0000-0000-000000000001',
    profileRevision: 1,
    displayName: 'Jordan Lee',
    workEmail: 'jordan.lee@embarkwithus.com',
    title: 'Director',
    signatureMode: 'name_and_role',
    voiceNotes: null,
    professionalContext: {},
  },
  assets: {
    skillVersion: 'v5',
    skillSha256: 'a'.repeat(64),
    subjectLineVersion: 'v1',
    subjectLineSha256: 'd'.repeat(64),
    positioningVersion: 'v1',
    positioningSha256: 'b'.repeat(64),
    capabilityCatalogVersion: 'v1',
    capabilityCatalogSha256: 'c'.repeat(64),
  },
};

test('computeAdversarialDecision requires bind and rejects disproof', () => {
  assert.equal(computeAdversarialDecision({ truth: 'supported', bindsToLead: true, durationSupported: true }), 'keep');
  assert.equal(computeAdversarialDecision({ truth: 'inconclusive', bindsToLead: true, durationSupported: true }), 'keep');
  assert.equal(computeAdversarialDecision({ truth: 'supported', bindsToLead: false, durationSupported: true }), 'drop');
  assert.equal(computeAdversarialDecision({ truth: 'disproved', bindsToLead: true, durationSupported: true }), 'drop');
  assert.equal(computeAdversarialDecision({ truth: 'inconclusive', bindsToLead: false, durationSupported: true }), 'drop');
  assert.equal(computeAdversarialDecision({ truth: 'supported', bindsToLead: true, durationSupported: false }), 'drop');
});

test('buildAdversarialClaims tags person vs company bindScope', () => {
  const claims = buildAdversarialClaims(samplePacket());
  const person = claims.find((claim) => claim.claimId === 'fact:pf1');
  const company = claims.find((claim) => claim.claimId === 'fact:cf1');
  assert.equal(person?.bindScope, 'person');
  assert.equal(company?.bindScope, 'company');
  assert.ok(claims.some((claim) => claim.claimId === 'identity:classification'));
});

test('true-but-unbound person fact is dropped; bound company fact can keep', () => {
  const next = applyAdversarialVerdicts(samplePacket(), [
    {
      claimId: 'fact:pf1',
      truth: 'supported',
      bindsToLead: false,
      durationSupported: true,
      decision: 'drop',
      disproofFound: false,
      supportingEvidenceFound: true,
      rationale: 'true about a different Jane Doe',
    },
    {
      claimId: 'fact:cf1',
      truth: 'supported',
      bindsToLead: true,
      durationSupported: true,
      decision: 'keep',
      disproofFound: false,
      supportingEvidenceFound: true,
      rationale: 'anniversary is about lead company',
    },
    {
      claimId: 'pressure:0',
      truth: 'inconclusive',
      bindsToLead: true,
      durationSupported: true,
      decision: 'keep',
      disproofFound: false,
      supportingEvidenceFound: false,
      rationale: 'unable to disprove for this company',
    },
    {
      claimId: 'whyNow',
      truth: 'supported',
      bindsToLead: false,
      durationSupported: true,
      decision: 'drop',
      disproofFound: false,
      supportingEvidenceFound: true,
      rationale: 'true timing but wrong org entity',
    },
    {
      claimId: 'reasonForWriting',
      truth: 'inconclusive',
      bindsToLead: true,
      durationSupported: true,
      decision: 'keep',
      disproofFound: false,
      supportingEvidenceFound: false,
      rationale: 'ok',
    },
    {
      claimId: 'identity:classification',
      truth: 'inconclusive',
      bindsToLead: false,
      durationSupported: true,
      decision: 'drop',
      disproofFound: false,
      supportingEvidenceFound: false,
      rationale: 'person not bound',
    },
    {
      claimId: 'identity:currentSummary',
      truth: 'supported',
      bindsToLead: false,
      durationSupported: true,
      decision: 'drop',
      disproofFound: false,
      supportingEvidenceFound: true,
      rationale: 'summary is about lookalike',
    },
    {
      claimId: 'contactNorm',
      truth: 'inconclusive',
      bindsToLead: false,
      durationSupported: true,
      decision: 'drop',
      disproofFound: false,
      supportingEvidenceFound: false,
      rationale: 'unbound',
    },
  ], 'verified');

  assert.deepEqual(next.resolution.selectedFactIds, ['cf1']);
  assert.equal(next.resolution.level, 'company');
  assert.equal(next.resolution.whyNow, null);
  assert.equal(next.leadIdentity.currentSummary, null);
  // verified suggestion rejected because identity classification was not kept/bound
  assert.equal(next.leadIdentity.classification, 'usable_at_lower_resolution');
  assert.equal(next.prospectWorld.contactNorm.form, 'unknown');
  assert.equal(next.prospectWorld.pressures.length, 1);
});

test('stub adversarial verify keeps claims as bound without calling the API', async () => {
  const prior = process.env.DRAFTING_MODE;
  process.env.DRAFTING_MODE = 'stub';
  try {
    const result = await runResearchAdversarialVerify({
      inputSnapshot: snapshot,
      packet: samplePacket(),
    });
    assert.equal(result.skipped, false);
    assert.equal(result.auditMode, 'full');
    assert.ok(result.verdicts.every((verdict) => (
      verdict.decision === 'keep'
      && verdict.bindsToLead === true
    )));
    assert.ok(result.packet.resolution.selectedFactIds.includes('pf1'));
    assert.equal(result.usage.costUsd, '0.0000');
    assert.equal(result.promptVersion, 'drafting-adversarial-v4-duration');
  } finally {
    if (prior === undefined) delete process.env.DRAFTING_MODE;
    else process.env.DRAFTING_MODE = prior;
  }
});

test('adversarial user prompt is slim (claims + source stubs, not full packet)', () => {
  const packet = samplePacket();
  const claims = buildAdversarialClaims(packet);
  const stubs = buildAdversarialSourceStubs(packet, claims);
  assert.ok(stubs.length >= 1);
  const prompt = buildAdversarialUserPrompt({
    inputSnapshot: snapshot,
    packet,
    claims,
    maxSearches: 2,
  });
  assert.ok(prompt.includes('## Source stubs for claim-referenced ids only'));
  assert.ok(prompt.includes('## Packet metadata'));
  assert.ok(!prompt.includes('"personFacts"'));
  assert.ok(!prompt.includes('"prospectWorld"'));
  assert.ok(!prompt.includes('## Current research packet'));
});

test('planAdversarialAudit skips true_zero and lightens high-trust company-only', () => {
  const trueZero: DraftingResearchPacket = {
    ...samplePacket(),
    personFacts: [],
    companyFacts: [],
    roleSegmentFacts: [],
    prospectWorld: {
      ...samplePacket().prospectWorld,
      pressures: [],
      contactNorm: {
        form: 'unknown',
        statement: '',
        sourceIds: [],
        confidence: 'tentative',
      },
    },
    resolution: {
      ...samplePacket().resolution,
      level: 'true_zero',
      selectedFactIds: [],
      whyNow: null,
      reasonForWriting: null,
    },
    leadIdentity: {
      ...samplePacket().leadIdentity,
      currentSummary: null,
    },
  };
  const trueZeroPlan = planAdversarialAudit(trueZero, buildAdversarialClaims(trueZero), 2);
  assert.equal(trueZeroPlan.mode, 'skip');

  const companyOnly: DraftingResearchPacket = {
    ...samplePacket(),
    personFacts: [],
    leadIdentity: {
      ...samplePacket().leadIdentity,
      classification: 'usable_at_lower_resolution',
      currentSummary: null,
    },
    prospectWorld: {
      ...samplePacket().prospectWorld,
      pressures: [],
      contactNorm: {
        form: 'unknown',
        statement: '',
        sourceIds: [],
        confidence: 'tentative',
      },
    },
    resolution: {
      ...samplePacket().resolution,
      level: 'company',
      selectedFactIds: ['cf1'],
      whyNow: null,
      reasonForWriting: null,
    },
    sources: [{
      ...samplePacket().sources[0],
      family: 'first_party_company',
      trustTier: 'high',
    }],
    companyFacts: [{
      ...samplePacket().companyFacts[0],
      family: 'first_party_company',
      confidence: 'supported',
      sourceIds: ['s1'],
    }],
  };
  const lightPlan = planAdversarialAudit(companyOnly, buildAdversarialClaims(companyOnly), 2);
  assert.equal(lightPlan.mode, 'light');
  assert.equal(lightPlan.maxSearches, 0);

  const enrichmentIdentity: DraftingResearchPacket = {
    ...companyOnly,
    leadIdentity: {
      ...companyOnly.leadIdentity,
      classification: 'verified',
      currentSummary: 'Jane Smith is CFO at Acme',
      suppliedSummary: 'Jane Smith at Acme',
    },
  };
  const enrichmentPlan = planAdversarialAudit(
    enrichmentIdentity,
    buildAdversarialClaims(enrichmentIdentity),
    1,
  );
  assert.equal(enrichmentPlan.mode, 'light');
  assert.equal(enrichmentPlan.maxSearches, 0);

  const withPerson: DraftingResearchPacket = {
    ...companyOnly,
    personFacts: [{
      ...companyOnly.companyFacts[0],
      id: 'pf1',
      normalizedClaim: 'Jane recently spoke at a conference',
    }],
    resolution: {
      ...companyOnly.resolution,
      selectedFactIds: ['pf1', 'cf1'],
    },
  };
  const personPlan = planAdversarialAudit(withPerson, buildAdversarialClaims(withPerson), 1);
  assert.equal(personPlan.mode, 'full');
  assert.equal(personPlan.maxSearches, 1);
});
