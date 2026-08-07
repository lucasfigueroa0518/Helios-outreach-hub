import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDraftOutput, parseDraftingResearchPacket } from '@/lib/drafting/provider-parse';

test('parseDraftingResearchPacket accepts a minimal valid packet', () => {
  const packet = parseDraftingResearchPacket({
    schemaVersion: '2',
    asOf: '2026-07-16T00:00:00.000Z',
    leadIdentity: {
      classification: 'usable_at_lower_resolution',
      suppliedSummary: 'Alex at Example',
      currentSummary: null,
      conflictSummary: null,
      supportingSourceIds: ['s1'],
    },
    freshness: {
      employer: { status: 'current', sourceIds: ['s1'], summary: 'Example' },
      title: { status: 'recent', sourceIds: ['s1'], summary: 'CFO' },
      location: { status: 'undated', sourceIds: [], summary: null },
    },
    prospectWorld: {
      roleReality: 'Finance leadership',
      pressures: [],
      contactNorm: {
        form: 'reply',
        statement: 'Email reply is normal',
        sourceIds: ['s1'],
        confidence: 'tentative',
      },
      registerNotes: [],
      commonVendorPatterns: [],
    },
    personFacts: [],
    companyFacts: [],
    roleSegmentFacts: [],
    structuralRelation: {
      relation: 'complementary',
      recipientConstraint: null,
      embarkCapabilityId: 'office_of_the_cfo',
      supportedReason: 'Office of the CFO support',
      tensionToName: null,
      sourceIds: ['s1'],
    },
    statusGeometry: {
      classification: 'uncertain',
      safePosture: 'Modest professional ask',
      basis: 'Limited public footprint',
    },
    resolution: {
      level: 'structure',
      selectedFactIds: [],
      reasonForWriting: 'Structural fit',
      whyNow: null,
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
      id: 's1',
      url: 'https://example.com',
      title: 'Example',
      family: 'first_party_company',
      trustTier: 'high',
      publishedOrUpdated: null,
      accessedAt: '2026-07-16T00:00:00.000Z',
      quote: 'Example Co leadership',
      bindsPerson: false,
    }],
  });

  assert.equal(packet.structuralRelation.embarkCapabilityId, 'office_of_the_cfo');
});

test('parseDraftOutput rejects missing subject', () => {
  assert.throws(() => parseDraftOutput({
    schemaVersion: '1',
    bodyText: 'Hi',
    resolutionUsed: 'company',
    usedFactIds: [],
    claimLedger: [],
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
    },
  }), /subject/);
});

test('parseDraftOutput coerces resolution-shaped claimType to prospect_fact', () => {
  const draft = parseDraftOutput({
    schemaVersion: '1',
    subject: 'Quick note',
    bodyText: 'Hi Sam. Congrats on the listing.',
    resolutionUsed: 'role_segment',
    usedFactIds: ['f1'],
    claimLedger: [{
      exactText: 'Congrats on the listing.',
      factIds: ['f1'],
      claimType: 'role_segment',
      temporalFraming: 'none',
    }],
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
    },
  });
  assert.equal(draft.claimLedger[0]?.claimType, 'prospect_fact');
});
