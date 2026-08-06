import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  buildWriterResearchBrief,
  selectWriterBoundResearch,
} from '@/lib/drafting/writer-research-brief';
import type { DraftingResearchPacket } from '@/lib/drafting/types';

function loadRachelPacket(): DraftingResearchPacket {
  const fixturePath = path.join(
    process.cwd(),
    'fixtures/drafting-debug/rachel-barron-research-packet.json',
  );
  const packet = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as DraftingResearchPacket;
  const normalizeFacts = (facts: DraftingResearchPacket['companyFacts']) =>
    facts.map((fact) => ({
      ...fact,
      temporal: {
        kind: 'evergreen' as const,
        eventClass: 'structural' as const,
        eventStart: null,
        eventEnd: null,
        relevanceEnd: null,
        durationBasis: 'unknown' as const,
        durationSourceIds: [],
        durationEvidence: null,
        discourse: 'timeless' as const,
      },
    }));
  return {
    ...packet,
    personFacts: normalizeFacts(packet.personFacts),
    companyFacts: normalizeFacts(packet.companyFacts),
    roleSegmentFacts: normalizeFacts(packet.roleSegmentFacts),
  };
}

test('buildWriterResearchBrief removes tracking metadata and low-confidence material', () => {
  const brief = buildWriterResearchBrief(loadRachelPacket());
  const serialized = JSON.stringify(brief);

  assert.equal('sources' in brief, false);
  assert.equal('freshness' in brief, false);
  assert.equal('leadIdentity' in brief, false);
  assert.equal('resolutionUpgrade' in brief, false);
  assert.equal(serialized.includes('"sourceIds"'), false);
  assert.equal(serialized.includes('"embarkCapabilityId"'), false);
  assert.equal(serialized.includes('"significanceReason"'), false);
  assert.equal(serialized.includes('"weight"'), false);
  assert.equal(serialized.includes('"confidence"'), false);

  // Toxic fields must never reach the writer (Issues A/B).
  assert.equal(serialized.includes('"tensionToName"'), false);
  assert.equal(serialized.includes('"recipientConstraint"'), false);
  assert.equal(serialized.includes('"supportedReason"'), false);
  assert.equal(serialized.includes('"safePosture"'), false);
  assert.equal(serialized.includes('"basis"'), false);
  assert.equal(serialized.includes('"prohibitedAssumptions"'), false);
  assert.equal('prohibitedAssumptions' in brief.resolution, false);

  assert.equal(brief.personFacts.length, 0);
  assert.equal(brief.roleSegmentFacts.length, 0);
  assert.ok(brief.companyFacts.length <= 2);
  assert.ok(brief.prospectWorld.pressures.length <= 2);
  assert.equal('contactNorm' in brief.prospectWorld, false);
  assert.equal('whyNow' in brief.resolution, false);

  for (const fact of brief.companyFacts) {
    assert.ok(fact.claim);
    assert.ok(fact.factId);
    assert.ok(fact.permittedFraming.length > 0);
    assert.ok(fact.claim.length <= 120);
  }
  assert.equal(brief.companyFacts[0]?.role, 'primary');
  for (const fact of brief.companyFacts.slice(1)) {
    assert.equal(fact.role, 'seasoning');
  }

  assert.equal(brief.resolution.level, 'company');
  assert.ok(brief.resolution.reasonForWriting);
  assert.deepEqual(Object.keys(brief.structuralRelation), ['relation']);
  assert.deepEqual(Object.keys(brief.statusGeometry), ['classification']);
});

test('buildWriterResearchBrief keeps supported contact norm and non-ambient whyNow', () => {
  const packet = loadRachelPacket();
  packet.prospectWorld.contactNorm = {
    form: 'call',
    statement: 'Finance leaders at similar operators accept direct calls.',
    sourceIds: ['s6'],
    confidence: 'supported',
  };
  packet.resolution.whyNow = 'The company published audited annual results last week.';

  const brief = buildWriterResearchBrief(packet);

  assert.ok(brief.prospectWorld.contactNorm);
  assert.equal(brief.prospectWorld.contactNorm?.form, 'call');
  assert.equal(brief.resolution.whyNow, packet.resolution.whyNow);
});

test('buildWriterResearchBrief includes only selected supported facts and caps count', () => {
  const packet = loadRachelPacket();
  packet.companyFacts = packet.companyFacts.map((fact) =>
    fact.id === 'c7'
      ? { ...fact, confidence: 'supported' as const }
      : fact,
  );

  const brief = buildWriterResearchBrief(packet);

  assert.ok(brief.companyFacts.length <= 2);
  assert.equal(
    brief.companyFacts.some((fact) => fact.claim.includes('Controller')),
    false,
  );
});

test('selectWriterBoundResearch keeps a wider QA window than the writer brief', () => {
  const packet = loadRachelPacket();
  const bound = selectWriterBoundResearch(packet);
  const brief = buildWriterResearchBrief(packet);
  const boundIds = new Set(bound.companyFacts.map((fact) => fact.id));

  // QA must score a superset of what can reach the writer.
  assert.ok(bound.companyFacts.length >= brief.companyFacts.length);
  for (const claim of brief.companyFacts) {
    assert.ok(boundIds.has(claim.factId));
  }
});

test('buildWriterResearchBrief ranks anchors first and clips on word boundaries', () => {
  const packet = loadRachelPacket();
  const longClaim = 'Acme Manufacturing operates fourteen production facilities across the '
    + 'midwest and is consolidating its regional finance teams into a single shared '
    + 'services centre in Columbus this year';
  const [template] = packet.companyFacts;
  assert.ok(template);
  packet.companyFacts = [
    { ...template, id: 'rank-1', normalizedClaim: 'Seasoning claim', weight: 'seasoning', confidence: 'supported', freshness: 'current' },
    { ...template, id: 'rank-2', normalizedClaim: longClaim, weight: 'anchor', confidence: 'supported', freshness: 'current' },
  ];
  packet.resolution.selectedFactIds = ['rank-1', 'rank-2'];

  const brief = buildWriterResearchBrief(packet);

  assert.deepEqual(brief.companyFacts.map((fact) => fact.factId), ['rank-2', 'rank-1']);
  assert.deepEqual(brief.companyFacts.map((fact) => fact.role), ['primary', 'seasoning']);

  const clipped = brief.companyFacts[0]?.claim ?? '';
  assert.ok(clipped.length <= 120);
  assert.ok(clipped.endsWith('…'));
  const survivingWords = clipped.replace(/…$/, '').trim().split(' ');
  assert.deepEqual(survivingWords, longClaim.split(' ').slice(0, survivingWords.length));
});
