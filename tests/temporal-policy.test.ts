import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDraftingResearchPacket } from '@/lib/drafting/provider-parse';
import { reconcileResearchPacketAfterAdversarialQa } from '@/lib/drafting/research-reconcile';
import {
  assessResearchTimeliness,
  findDraftTimelinessFailures,
  reconcileManualDraftGrounding,
} from '@/lib/drafting/temporal-policy';
import type { DraftingResearchPacket, ResearchFact } from '@/lib/drafting/types';

const NOW = new Date('2026-07-22T15:00:00.000Z');

function packet(
  temporal: NonNullable<ResearchFact['temporal']> | null,
  options: { claim?: string; quote?: string; published?: string | null; asOf?: string } = {},
): DraftingResearchPacket {
  const claim = options.claim ?? 'Acme is executing a finance project.';
  return {
    schemaVersion: '2',
    asOf: options.asOf ?? NOW.toISOString(),
    leadIdentity: {
      classification: 'verified',
      suppliedSummary: 'Alex at Acme',
      currentSummary: 'Alex works at Acme',
      conflictSummary: null,
      supportingSourceIds: ['s1'],
    },
    freshness: {
      employer: { status: 'current', sourceIds: ['s1'], summary: null },
      title: { status: 'current', sourceIds: ['s1'], summary: null },
      location: { status: 'undated', sourceIds: [], summary: null },
    },
    prospectWorld: {
      roleReality: '',
      pressures: [],
      contactNorm: {
        form: 'unknown',
        statement: '',
        sourceIds: [],
        confidence: 'tentative',
      },
      registerNotes: [],
      commonVendorPatterns: [],
    },
    personFacts: [],
    companyFacts: [{
      id: 'f1',
      normalizedClaim: claim,
      sourceIds: ['s1'],
      quote: options.quote ?? claim,
      family: 'reputable_news',
      confidence: 'supported',
      freshness: 'current',
      weight: 'anchor',
      significanceReason: claim,
      temporal,
    }],
    roleSegmentFacts: [],
    structuralRelation: {
      relation: 'adjacent',
      recipientConstraint: null,
      embarkCapabilityId: null,
      supportedReason: null,
      tensionToName: null,
      sourceIds: [],
    },
    statusGeometry: { classification: 'peer', safePosture: 'measured_small_ask', basis: '' },
    resolution: {
      level: 'company',
      selectedFactIds: ['f1'],
      reasonForWriting: claim,
      whyNow: claim,
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
      url: 'https://example.com/news',
      title: 'News',
      family: 'reputable_news',
      trustTier: 'high',
      publishedOrUpdated: options.published ?? '2026-06-01T00:00:00.000Z',
      accessedAt: NOW.toISOString(),
      quote: options.quote ?? claim,
      bindsPerson: false,
    }],
  };
}

function event(
  overrides: Partial<NonNullable<ResearchFact['temporal']>> = {},
): NonNullable<ResearchFact['temporal']> {
  return {
    kind: 'event',
    eventClass: 'project',
    eventStart: '2026-06-01T00:00:00.000Z',
    eventEnd: null,
    relevanceEnd: null,
    durationBasis: 'policy_default',
    durationSourceIds: [],
    durationEvidence: null,
    discourse: 'ongoing',
    ...overrides,
  };
}

test('classifies ongoing old project, expired event, upcoming, appointment, delayed, and recent completion', () => {
  const cases: Array<[string, DraftingResearchPacket, string, string[]]> = [
    ['old annual project', packet(event({
      eventStart: '2025-11-01T00:00:00.000Z',
      eventEnd: '2026-11-01T00:00:00.000Z',
      relevanceEnd: '2026-12-01T00:00:00.000Z',
      durationBasis: 'explicit_source',
      durationSourceIds: ['s1'],
      durationEvidence: 'year-long',
    }), { claim: 'Acme began a year-long project.', quote: 'Acme began a year-long project.' }), 'ongoing', ['active']],
    ['expired week', packet(event({
      eventClass: 'short_lived',
      eventStart: '2026-04-01T00:00:00.000Z',
      eventEnd: '2026-04-08T00:00:00.000Z',
      relevanceEnd: '2026-04-08T00:00:00.000Z',
      durationBasis: 'explicit_source',
      durationSourceIds: ['s1'],
      durationEvidence: 'one-week',
    }), { claim: 'Acme ran a one-week cutover.' }), 'expired', []],
    ['upcoming', packet(event({
      eventStart: '2027-06-01T00:00:00.000Z',
      eventEnd: '2027-07-15T00:00:00.000Z',
      relevanceEnd: '2027-07-22T00:00:00.000Z',
      durationBasis: 'explicit_source',
      durationSourceIds: ['s1'],
      durationEvidence: '2027',
    }), { claim: 'Acme will host the event in 2027.' }), 'upcoming', ['anticipatory']],
    ['appointment', packet(event({
      eventClass: 'appointment',
      eventStart: '2026-07-01T00:00:00.000Z',
      durationBasis: 'policy_default',
    }), { claim: 'Alex was appointed CFO.' }), 'ongoing', ['retrospective']],
    ['delayed', packet(event({
      eventStart: '2026-10-01T00:00:00.000Z',
      eventEnd: '2027-03-31T00:00:00.000Z',
      relevanceEnd: '2027-04-30T00:00:00.000Z',
      durationBasis: 'explicit_source',
      durationSourceIds: ['s1'],
      durationEvidence: 'until October',
    }), { claim: 'Acme delayed its rollout until October.' }), 'upcoming', ['anticipatory']],
    ['recent completion', packet(event({
      eventStart: '2025-07-01T00:00:00.000Z',
      eventEnd: '2026-07-01T00:00:00.000Z',
      relevanceEnd: '2026-07-31T00:00:00.000Z',
      durationBasis: 'explicit_source',
      durationSourceIds: ['s1'],
      durationEvidence: 'completed',
    }), { claim: 'Acme completed its project.' }), 'recently_completed', ['retrospective']],
  ];
  for (const [name, value, lifecycle, framing] of cases) {
    const fact = assessResearchTimeliness(value, NOW).facts[0];
    assert.equal(fact?.lifecycle, lifecycle, name);
    assert.deepEqual(fact?.permittedFraming, framing, name);
  }
});

test('blocks unknown duration, contradictory windows, unsupported evidence, and v1 packets', () => {
  const unknown = assessResearchTimeliness(packet(event({ durationBasis: 'unknown' })), NOW);
  assert.ok(unknown.codes.includes('EVENT_DURATION_UNKNOWN'));
  const contradictory = assessResearchTimeliness(packet(event({
    eventStart: '2026-08-10T00:00:00.000Z',
    eventEnd: '2026-08-01T00:00:00.000Z',
    relevanceEnd: '2026-08-01T00:00:00.000Z',
    durationBasis: 'explicit_source',
    durationSourceIds: ['s1'],
    durationEvidence: 'project',
  })), NOW);
  assert.ok(contradictory.codes.includes('INVALID_EVENT_WINDOW'));
  const unsupported = assessResearchTimeliness(packet(event({
    eventEnd: '2027-06-01T00:00:00.000Z',
    relevanceEnd: '2027-07-01T00:00:00.000Z',
    durationBasis: 'explicit_source',
    durationSourceIds: ['s1'],
    durationEvidence: 'not quoted',
  })), NOW);
  assert.ok(unsupported.codes.includes('UNSUPPORTED_EXPLICIT_DURATION'));
  const legacy = { ...packet(event()), schemaVersion: '1' } as unknown as DraftingResearchPacket;
  assert.ok(assessResearchTimeliness(legacy, NOW).codes.includes('LEGACY_PACKET_SCHEMA'));
});

test('uses bounded policy defaults and rejects missing v2 temporal metadata', () => {
  const audit = assessResearchTimeliness(packet(event()), NOW);
  assert.equal(audit.facts[0]?.relevanceEnd, '2026-11-28T00:00:00.000Z');
  assert.throws(
    () => parseDraftingResearchPacket(packet(null)),
    /Temporal metadata is required/,
  );
});

test('rejects framing mismatch, omitted ledger, and partial used-fact ledger', () => {
  const value = packet(event());
  const audit = assessResearchTimeliness(value, NOW);
  const sentence = 'Acme is currently executing its finance project.';
  const mismatch = findDraftTimelinessFailures('Project', sentence, audit, {
    usedFactIds: ['f1'],
    claimLedger: [{
      exactText: sentence,
      factIds: ['f1'],
      claimType: 'prospect_fact',
      temporalFraming: 'retrospective',
    }],
  });
  assert.ok(mismatch.some((finding) => finding.code === 'TEMPORAL_FRAMING_NOT_PERMITTED'));
  const omitted = findDraftTimelinessFailures('Project', sentence, audit, {
    usedFactIds: [],
    claimLedger: [],
  });
  assert.ok(omitted.some((finding) => finding.code === 'TEMPORAL_SENTENCE_GROUNDING_MISSING'));
  const partial = findDraftTimelinessFailures('Project', sentence, audit, {
    usedFactIds: ['f1'],
    claimLedger: [{
      exactText: sentence,
      factIds: [],
      claimType: 'sender_fact',
      temporalFraming: 'none',
    }],
    prospectTerms: ['Acme'],
  });
  assert.ok(partial.some((finding) => finding.code === 'TEMPORAL_GROUNDING_INCOMPLETE'));
});

test('catches prospect paraphrase but exempts asks and sender prose', () => {
  const audit = assessResearchTimeliness(packet(event()), NOW);
  const prospect = 'Your ERP rollout is moving forward.';
  const findings = findDraftTimelinessFailures('ERP', prospect, audit, {
    usedFactIds: [],
    claimLedger: [{
      exactText: prospect,
      factIds: [],
      claimType: 'relationship_fact',
      temporalFraming: 'none',
    }],
  });
  assert.ok(findings.some((finding) => finding.code === 'TEMPORAL_PROSPECT_SENTENCE_MISCLASSIFIED'));

  const sender = 'We tend to step in and do the work alongside your team rather than advise from the sidelines.';
  const ask = "If it would be useful to talk through where Acme's finance function is headed, I'd welcome a short call.";
  assert.deepEqual(findDraftTimelinessFailures('Project', `${sender} ${ask}`, audit, {
    usedFactIds: [],
    claimLedger: [
      { exactText: sender, factIds: [], claimType: 'sender_fact', temporalFraming: 'none' },
      { exactText: ask, factIds: [], claimType: 'relationship_fact', temporalFraming: 'none' },
    ],
    prospectTerms: ['Acme'],
  }), []);
});

test('manual benign CTA edit remains approval and export eligible after grounding reconciliation', () => {
  const audit = assessResearchTimeliness(packet(event()), NOW);
  const prospect = 'Acme is currently executing its finance project.';
  const originalAsk = 'Would you be open to a quick chat?';
  const changedAsk = 'Could we find 15 minutes to connect next week?';
  const grounding = reconcileManualDraftGrounding(`${prospect} ${changedAsk}`, {
    usedFactIds: ['f1'],
    claimLedger: [
      {
        exactText: prospect,
        factIds: ['f1'],
        claimType: 'prospect_fact',
        temporalFraming: 'active',
      },
      {
        exactText: originalAsk,
        factIds: [],
        claimType: 'relationship_fact',
        temporalFraming: 'none',
      },
    ],
    prospectTerms: ['Acme'],
  });

  assert.deepEqual(grounding.prospectTerms, ['Acme']);
  assert.deepEqual(grounding.usedFactIds, ['f1']);
  assert.deepEqual(grounding.claimLedger, [
    {
      exactText: prospect,
      factIds: ['f1'],
      claimType: 'prospect_fact',
      temporalFraming: 'active',
    },
    {
      exactText: changedAsk,
      factIds: [],
      claimType: 'relationship_fact',
      temporalFraming: 'none',
    },
  ]);
  assert.deepEqual(
    findDraftTimelinessFailures('Project', `${prospect} ${changedAsk}`, audit, grounding),
    [],
  );
});

test('manual prospect temporal edit remains ungrounded and blocks approval and export', () => {
  const audit = assessResearchTimeliness(packet(event()), NOW);
  const original = 'Acme is currently executing its finance project.';
  const changed = 'Acme is now accelerating its finance transformation.';
  const ask = 'Would you be open to a quick chat?';
  const grounding = reconcileManualDraftGrounding(`${changed} ${ask}`, {
    usedFactIds: ['f1'],
    claimLedger: [
      {
        exactText: original,
        factIds: ['f1'],
        claimType: 'prospect_fact',
        temporalFraming: 'active',
      },
      {
        exactText: ask,
        factIds: [],
        claimType: 'relationship_fact',
        temporalFraming: 'none',
      },
    ],
    prospectTerms: ['Acme'],
  });

  assert.deepEqual(grounding.prospectTerms, ['Acme']);
  assert.deepEqual(grounding.usedFactIds, []);
  assert.equal(grounding.claimLedger.some((entry) => entry.exactText === changed), false);
  const findings = findDraftTimelinessFailures('Project', `${changed} ${ask}`, audit, grounding);
  assert.ok(findings.some((finding) =>
    finding.code === 'TEMPORAL_SENTENCE_GROUNDING_MISSING' && finding.matchedText === changed));
});

test('duplicate grounded recency sentences bind to their matching occurrences', () => {
  const value = packet(event({
    eventStart: '2025-07-01T00:00:00.000Z',
    eventEnd: '2026-07-01T00:00:00.000Z',
    relevanceEnd: '2026-07-31T00:00:00.000Z',
    durationBasis: 'explicit_source',
    durationSourceIds: ['s1'],
    durationEvidence: 'completed',
  }), { claim: 'Acme recently completed its finance project.' });
  const audit = assessResearchTimeliness(value, NOW);
  const sentence = 'Acme recently completed its finance project.';
  const entry = {
    exactText: sentence,
    factIds: ['f1'],
    claimType: 'prospect_fact' as const,
    temporalFraming: 'retrospective' as const,
  };

  assert.deepEqual(findDraftTimelinessFailures('Project', `${sentence} ${sentence}`, audit, {
    usedFactIds: ['f1'],
    claimLedger: [entry, { ...entry }],
    prospectTerms: ['Acme'],
  }), []);
});

test('sentence partition preserves common abbreviations', () => {
  const value = packet(event(), { claim: 'Acme is executing a U.S. rollout.' });
  const sentence = "Dr. Smith is currently executing Acme's U.S. ERP rollout.";
  assert.deepEqual(findDraftTimelinessFailures('U.S. rollout', sentence, assessResearchTimeliness(value, NOW), {
    usedFactIds: ['f1'],
    claimLedger: [{
      exactText: sentence,
      factIds: ['f1'],
      claimType: 'prospect_fact',
      temporalFraming: 'active',
    }],
    prospectTerms: ['Acme', 'Dr. Smith'],
  }), []);
});

test('sentence partition excludes bare salutations and signature blocks', () => {
  const value = packet(event());
  const prospect = 'Acme is currently executing its finance project.';
  const ask = 'Would you be open to a quick chat?';
  const body = [
    'Xavier,',
    '',
    prospect,
    '',
    ask,
    '',
    'Lucas',
    'Business Development Associate, Embark',
  ].join('\n');

  assert.deepEqual(findDraftTimelinessFailures('Finance project', body, assessResearchTimeliness(value, NOW), {
    usedFactIds: ['f1'],
    claimLedger: [
      {
        exactText: prospect,
        factIds: ['f1'],
        claimType: 'prospect_fact',
        temporalFraming: 'active',
      },
      {
        exactText: ask,
        factIds: [],
        claimType: 'relationship_fact',
        temporalFraming: 'none',
      },
    ],
    prospectTerms: ['Acme', 'Xavier'],
  }), []);
});

test('skipped adversarial QA removes current triggers and clears whyNow', () => {
  const value = packet(event());
  const reconciled = reconcileResearchPacketAfterAdversarialQa(value, true, { now: NOW });

  assert.deepEqual(reconciled.packet.resolution.selectedFactIds, []);
  assert.equal(reconciled.packet.resolution.whyNow, null);
  assert.ok(reconciled.actions.some((action) =>
    action.code === 'ADVERSARIAL_QA_REQUIRED_FOR_CURRENT_TRIGGER'
    && action.detail === 'f1'));
});

test('honors adversarial duration verdict over strict temporal metadata gaps', () => {
  const value = packet(event({
    eventEnd: '2026-08-01T00:00:00.000Z',
    durationBasis: 'explicit_source',
    durationSourceIds: [],
    durationEvidence: 'through August 1, 2026',
  }));
  const withoutAdversarial = reconcileResearchPacketAfterAdversarialQa(value, false, { now: NOW });
  assert.deepEqual(withoutAdversarial.packet.resolution.selectedFactIds, []);
  assert.equal(withoutAdversarial.writeBlocked, true);

  const withAdversarial = reconcileResearchPacketAfterAdversarialQa(value, false, {
    now: NOW,
    adversarialVerdicts: [{
      claimId: 'fact:f1',
      decision: 'keep',
      durationSupported: true,
    }],
  });
  assert.deepEqual(withAdversarial.packet.resolution.selectedFactIds, ['f1']);
  assert.equal(withAdversarial.writeBlocked, false);
  assert.ok(withAdversarial.actions.some((action) => action.code === 'ADVERSARIAL_DURATION_OVERRIDE'));
});

test('empty brief blocks write instead of proceeding with EMPTY_BRIEF_OK', () => {
  const value = packet(event({
    eventEnd: '2026-08-01T00:00:00.000Z',
    durationBasis: 'explicit_source',
    durationSourceIds: [],
    durationEvidence: 'through August 1, 2026',
  }));
  const reconciled = reconcileResearchPacketAfterAdversarialQa(value, false, { now: NOW });

  assert.equal(reconciled.writeBlocked, true);
  assert.equal(reconciled.needsResearchUpgrade, true);
  assert.ok(reconciled.actions.some((action) => action.code === 'EMPTY_BRIEF_WRITE_BLOCKED'));
  assert.ok(!reconciled.actions.some((action) => action.code === 'EMPTY_BRIEF_OK'));
});
