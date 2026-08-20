import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addDecimal,
  computeSearchCostUsd,
  estimateResearchCost,
  formatUsd,
  releaseReservation,
  subtractDecimal,
  worstCaseResearchReservationUsd,
} from '@/lib/drafting/cost';
import {
  canQueueResearch,
  canQueueWrite,
  computeDraftingCounters,
  countDrafted,
  countMailboxValidTotal,
  isGenerationComplete,
  isLeadComplete,
  isLeadsModeRow,
  isMailboxDraftable,
  isMailboxUnvalidated,
  isMailboxValid,
  isReviewComplete,
} from '@/lib/drafting/eligibility';
import {
  formatHardLintFailuresForRepair,
  hardLintGuidanceForWriter,
  hasBlockingHardLintFailures,
  hasHardLintFailures,
  hasJudgmentHardLintFailures,
  hasMechanicalAutoRepairLintFailures,
  hasRetrySuggestedLint,
  lintDraft,
  mechanicalAutoRepairFindings,
} from '@/lib/drafting/lint';
import {
  buildEffectiveLeadFields,
  canonicalJson,
  emailFingerprint,
  extractFirstName,
  inputFingerprint,
  isPlaceholderValue,
  missingRequiredFields,
  normalizeDraftBody,
  normalizeEmail,
  normalizeRequiredField,
  sha256Fingerprint,
} from '@/lib/drafting/normalize';
import { reconcileResearchPacketForWrite } from '@/lib/drafting/research-reconcile';
import { validateResearchPacket } from '@/lib/drafting/research-validate';
import {
  DRAFTING_INITIAL_STATE,
  assertTransition,
  syncReviewStatus,
  transition,
} from '@/lib/drafting/state';
import type {
  DeliverySnapshot,
  DraftingItemCounterInput,
  DraftingResearchPacket,
  InputSnapshot,
  LintResult,
} from '@/lib/drafting/types';
import { CANONICAL_CAPABILITY_IDS } from '@/lib/drafting/types';

function baseSnapshot(overrides: Partial<InputSnapshot['lead']> = {}): InputSnapshot {
  return {
    schemaVersion: 1,
    lead: {
      fullName: 'Jane Doe',
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane.doe@example.com',
      company: 'Acme Corp',
      title: 'CFO',
      workLocation: 'Boston, MA',
      linkedinUrl: null,
      emailStatus: 'direct',
      emailDecision: 'accepted',
      ...overrides,
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
      sourceRunId: 'run-1',
      profileEnrichment: {},
      emailProvenance: {},
    },
    sender: {
      profileId: 'sender-1',
      profileRevision: 1,
      displayName: 'Alex Sender',
      workEmail: 'alex@embark.com',
      title: 'Director',
      signatureMode: 'name',
      voiceNotes: null,
      professionalContext: {},
    },
    assets: {
      skillVersion: 'v5',
      skillSha256: 'abc',
      subjectLineVersion: 'v1',
      subjectLineSha256: 'subj',
      positioningVersion: 'v1',
      positioningSha256: 'def',
      capabilityCatalogVersion: 'v1',
      capabilityCatalogSha256: 'ghi',
    },
  };
}

function validDelivery(email = 'jane.doe@example.com'): DeliverySnapshot {
  return {
    effectiveEmail: email,
    effectiveEmailFingerprint: emailFingerprint(email),
    emailVerification: 'valid',
    verifiedAt: '2026-07-16T12:00:00.000Z',
    resultSource: 'agentmail',
    providerRequestId: 'req-1',
  };
}

test('normalize treats placeholders and whitespace as missing', () => {
  for (const value of ['N/A', 'n/a', '-', 'unknown', 'none', '   ', '']) {
    assert.equal(isPlaceholderValue(value), true, value);
    assert.equal(normalizeRequiredField(value), null, value);
  }
  assert.equal(normalizeRequiredField('  Acme Corp  '), 'Acme Corp');
});

test('normalize validates email syntax and lowercases', () => {
  assert.equal(normalizeEmail('Jane.Doe@Example.COM'), 'jane.doe@example.com');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizeEmail('N/A'), null);
});

test('extractFirstName returns first token', () => {
  assert.equal(extractFirstName('Jane Marie Doe'), 'Jane');
  assert.equal(extractFirstName('N/A'), null);
});

test('missingRequiredFields flags incomplete lead rows', () => {
  const fields = buildEffectiveLeadFields(baseSnapshot({ title: 'unknown' }));
  assert.deepEqual(missingRequiredFields(fields), ['title']);
});

test('missingRequiredFields does not require workLocation', () => {
  const fields = buildEffectiveLeadFields(baseSnapshot({ workLocation: null }));
  assert.deepEqual(missingRequiredFields(fields), []);
});

test('canonical JSON and fingerprint are stable across key order', () => {
  const a = { b: 2, a: 1, nested: { z: 3, y: 2 } };
  const b = { nested: { y: 2, z: 3 }, a: 1, b: 2 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(sha256Fingerprint(a), sha256Fingerprint(b));
  assert.match(sha256Fingerprint(a), /^[a-f0-9]{64}$/);
});

test('inputFingerprint changes when effective email changes', () => {
  const snapshot = baseSnapshot();
  const before = inputFingerprint(snapshot);
  const after = inputFingerprint(snapshot, { email: 'other@example.com' });
  assert.notEqual(before, after);
});

test('isMailboxValid requires exact valid status and fingerprint', () => {
  assert.equal(isMailboxValid(validDelivery()), true);
  assert.equal(isMailboxValid({ ...validDelivery(), emailVerification: 'invalid' }), false);
  assert.equal(isMailboxValid({ ...validDelivery(), effectiveEmailFingerprint: '' }), false);
  assert.equal(isMailboxValid(null), false);
});

test('rate_limited mailboxes are draftable but unvalidated', () => {
  const rateLimited = { ...validDelivery(), emailVerification: 'rate_limited' as const };
  assert.equal(isMailboxValid(rateLimited), false);
  assert.equal(isMailboxDraftable(rateLimited), true);
  assert.equal(isMailboxUnvalidated(rateLimited), true);
  assert.equal(isLeadsModeRow(baseSnapshot(), rateLimited), false);
  assert.equal(canQueueResearch(baseSnapshot(), rateLimited), true);
  assert.equal(canQueueWrite(baseSnapshot(), rateLimited), true);
});

test('isLeadsModeRow stays true until mailbox draftable and profile complete', () => {
  const snapshot = baseSnapshot();
  assert.equal(isLeadsModeRow(snapshot, null), true);
  assert.equal(isLeadsModeRow(snapshot, { ...validDelivery(), emailVerification: 'pending' }), true);
  assert.equal(isLeadsModeRow(baseSnapshot({ company: '-' }), validDelivery()), true);
  assert.equal(isLeadsModeRow(snapshot, validDelivery()), false);
});

test('canQueueResearch and canQueueWrite require mailbox-draftable complete rows', () => {
  const snapshot = baseSnapshot();
  assert.equal(canQueueResearch(snapshot, validDelivery()), true);
  assert.equal(canQueueWrite(snapshot, validDelivery()), true);
  assert.equal(canQueueResearch(snapshot, null), false);
  assert.equal(canQueueWrite(baseSnapshot({ workLocation: 'unknown' }), validDelivery()), true);
  assert.equal(canQueueWrite(baseSnapshot({ workLocation: null }), validDelivery()), true);
  assert.equal(isLeadComplete(snapshot), true);
});

test('counter helpers use mailbox_valid_total as generation denominator', () => {
  const items: DraftingItemCounterInput[] = [
    { state: 'ready_for_review', deliverySnapshot: validDelivery(), removedAt: null },
    { state: 'approved', deliverySnapshot: validDelivery('a@example.com'), removedAt: null },
    { state: 'needs_lead_review', deliverySnapshot: { ...validDelivery('b@example.com'), emailVerification: 'invalid' }, removedAt: null },
    { state: 'queued_research', deliverySnapshot: validDelivery('c@example.com'), removedAt: null },
    { state: 'queued_research', deliverySnapshot: { ...validDelivery('e@example.com'), emailVerification: 'rate_limited' }, removedAt: null },
    { state: 'removed', deliverySnapshot: validDelivery('d@example.com'), removedAt: '2026-07-16T00:00:00.000Z' },
  ];

  assert.equal(countMailboxValidTotal(items), 4);
  assert.equal(countDrafted(items), 2);
  assert.equal(isGenerationComplete(4, 2), false);
  assert.equal(isGenerationComplete(4, 4), true);
  assert.equal(isReviewComplete(4, 2), false);
  assert.equal(isReviewComplete(4, 4), true);

  const counters = computeDraftingCounters(items);
  assert.equal(counters.mailboxValidTotal, 4);
  assert.equal(counters.drafted, 2);
  assert.equal(counters.generated, 2);
  assert.equal(counters.approved, 1);
});

test('state transitions reject illegal moves and sync review status', () => {
  assert.equal(syncReviewStatus('approved'), 'approved');
  assert.equal(syncReviewStatus('ready_for_review'), 'unreviewed');

  const ok = assertTransition('queued_research', 'researching', { mailboxValid: true });
  assert.equal(ok.reviewStatus, 'unreviewed');

  const conflict = transition('ready_for_review', 'researching');
  assert.equal(conflict.ok, false);
  if (!conflict.ok) {
    assert.equal(conflict.conflict, true);
  }

  const mailboxConflict = transition('needs_lead_review', 'queued_research', { mailboxValid: false });
  assert.equal(mailboxConflict.ok, false);

  const initial = transition(DRAFTING_INITIAL_STATE, 'needs_lead_review');
  assert.equal(initial.ok, true);
});

test('lint warns when subject exceeds sixty characters', () => {
  const short = lintDraft('Website conversion', 'Hi Jane,\n\nI saw your recent filing.');
  assert.equal(short.warnings.some((finding) => finding.code === 'OVERLONG_SUBJECT'), false);

  const longSubject = 'A somewhat longer subject about website conversion rates today';
  assert.ok(longSubject.length >= 61);
  const long = lintDraft(longSubject, 'Hi Jane,\n\nI saw your recent filing.');
  assert.ok(long.warnings.some((finding) => finding.code === 'OVERLONG_SUBJECT'));
});

test('opening greeting must sit on its own line', () => {
  const broken = 'Blane, your work negotiating contracts probably runs through a lot of review.';
  assert.equal(normalizeDraftBody(broken, 'Blane'), [
    'Blane,',
    '',
    'Your work negotiating contracts probably runs through a lot of review.',
  ].join('\n'));
  assert.equal(
    normalizeDraftBody('Hi Jane, I saw the filing.', 'Jane'),
    'Hi Jane,\n\nI saw the filing.',
  );
  assert.equal(
    normalizeDraftBody('Blane,\nyour work', 'Blane'),
    'Blane,\n\nYour work',
  );
  assert.equal(
    normalizeDraftBody('Blane,\n\nyour work', 'Blane'),
    'Blane,\n\nYour work',
  );
  assert.equal(
    normalizeDraftBody('Given your years leading Kean Miller, I wanted to write.'),
    'Given your years leading Kean Miller, I wanted to write.',
  );
  assert.equal(
    normalizeDraftBody('Contract, I wanted to write.', 'Blane'),
    'Contract, I wanted to write.',
  );

  const dirty = lintDraft('Contract review', broken);
  assert.ok(dirty.hard.some((finding) => finding.code === 'GREETING_LINE_BREAK'));
  const clean = lintDraft('Contract review', normalizeDraftBody(broken, 'Blane'));
  assert.equal(clean.hard.some((finding) => finding.code === 'GREETING_LINE_BREAK'), false);
  assert.equal(clean.hard.some((finding) => finding.code === 'GREETING_BODY_CAPITALIZATION'), false);

  const lowercaseOpen = 'Steve,\n\nyour remit as COO covers information technology.';
  assert.ok(lintDraft('IT remit', lowercaseOpen).hard.some(
    (finding) => finding.code === 'GREETING_BODY_CAPITALIZATION',
  ));
  assert.equal(
    lintDraft('IT remit', normalizeDraftBody(lowercaseOpen, 'Steve')).hard.some(
      (finding) => finding.code === 'GREETING_BODY_CAPITALIZATION',
    ),
    false,
  );
});

test('lint warns when body exceeds 120 words or a paragraph has more than three sentences', () => {
  const short = lintDraft('Website conversion', 'Hi Jane,\n\nI saw your recent filing.');
  assert.equal(short.warnings.some((finding) => finding.code === 'OVERLONG_BODY'), false);
  assert.equal(short.warnings.some((finding) => finding.code === 'OVERLONG_PARAGRAPH'), false);

  const longBody = Array.from({ length: 121 }, (_, index) => `word${index}`).join(' ');
  const long = lintDraft('Website conversion', longBody);
  assert.ok(long.warnings.some((finding) => finding.code === 'OVERLONG_BODY'));

  const longParagraph = 'One. Two. Three. Four.';
  const paragraph = lintDraft('Website conversion', longParagraph);
  assert.ok(paragraph.warnings.some((finding) => finding.code === 'OVERLONG_PARAGRAPH'));
});

test('lint flags banned phrases and em dashes as hard failures', () => {
  const clean = lintDraft('Quick follow-up', 'Hi Jane,\n\nI saw your recent filing.');
  assert.equal(hasHardLintFailures(clean), false);

  const dirty = lintDraft(
    'Quick question about finance',
    'Hope this finds you well — I wanted to compare notes.',
  );
  assert.equal(hasHardLintFailures(dirty), true);
  assert.ok(dirty.hard.some((finding) => finding.code === 'BANNED_PHRASE'));
  assert.ok(dirty.hard.some((finding) => finding.code === 'EM_DASH'));
});

test('lint catches markdown, html, calendar links, and unsubscribe language', () => {
  const result = lintDraft(
    'Subject',
    '<b>Hello</b>\n- bullet\nhttps://calendly.com/me\nUnsubscribe here',
  );
  const codes = new Set(result.hard.map((finding) => finding.code));
  assert.ok(codes.has('HTML_TAG'));
  assert.ok(codes.has('MARKDOWN_BULLET'));
  assert.ok(codes.has('CALENDAR_LINK'));
  assert.ok(codes.has('UNSUBSCRIBE'));
});

test('writer lint guidance and repair formatting are available offline', () => {
  const guide = hardLintGuidanceForWriter();
  assert.ok(guide.includes('Hard skill lint'));
  assert.ok(guide.includes('em dashes'));
  assert.ok(guide.includes('[First name],'));
  const dirty = lintDraft(
    'Quick question about finance',
    'Hope this finds you well — I wanted to compare notes.',
  );
  const formatted = formatHardLintFailuresForRepair(dirty.hard);
  assert.ok(formatted.includes('[BANNED_PHRASE]'));
  assert.ok(formatted.includes('matched:'));
});

test('lint hard-fails humility theater, track-record disclaimers, and overloaded sentences', () => {
  const humility = lintDraft(
    'Finance support',
    'I do not know the specifics of how your team is set up today, so I will not guess.',
  );
  assert.ok(humility.hard.some((finding) => finding.code === 'HUMILITY_THEATER'));

  const track = lintDraft(
    'Finance support',
    "We don't have a hospitality track record to point to, so I'll say that plainly rather than imply otherwise.",
  );
  assert.ok(track.hard.some((finding) => finding.code === 'TRACK_RECORD_DISCLAIMER'));

  const overloaded = lintDraft(
    'Capital plan',
    "I've been following the scope of Boca West's capital plan, the golf course reconstruction now underway alongside the pickleball center, on top of the earlier lifestyle and aquatics work.",
  );
  assert.ok(overloaded.hard.some((finding) => finding.code === 'OVERLOADED_SENTENCE'));
  assert.equal(hasRetrySuggestedLint(overloaded), true);
  assert.equal(hasBlockingHardLintFailures(overloaded), false);

  // Serial lists of examples are normal prose — comma density alone is not overload.
  const listed = lintDraft(
    'Portfolio support',
    'Over the past two years we have supported sponsors through diligence support, '
      + 'interim finance leadership, and post-close operating cadence across software, '
      + 'healthcare, and industrial platforms.',
  );
  assert.equal(listed.hard.some((finding) => finding.code === 'OVERLOADED_SENTENCE'), false);
  assert.equal(hasRetrySuggestedLint(listed), false);
});

test('blocking hard lint still fails approve gate; overloaded alone does not', () => {
  const banned = lintDraft(
    'Quick question about finance',
    'Hope this finds you well — I wanted to compare notes.',
  );
  assert.equal(hasBlockingHardLintFailures(banned), true);
  assert.equal(hasMechanicalAutoRepairLintFailures(banned), true);
  assert.ok(mechanicalAutoRepairFindings(banned).every((finding) =>
    ['BANNED_PHRASE', 'EM_DASH'].includes(finding.code)));

  const humility = lintDraft(
    'Finance support',
    'I do not know the specifics of how your team is set up today, so I will not guess.',
  );
  assert.equal(hasBlockingHardLintFailures(humility), true);
  assert.equal(hasMechanicalAutoRepairLintFailures(humility), false);

  const softOnly = lintDraft(
    'Capital plan',
    "I've been following the scope of Boca West's capital plan, the golf course reconstruction now underway alongside the pickleball center, on top of the earlier lifestyle and aquatics work.",
  );
  assert.equal(hasHardLintFailures(softOnly), true);
  assert.equal(hasBlockingHardLintFailures(softOnly), false);
  assert.equal(hasMechanicalAutoRepairLintFailures(softOnly), false);
});

test('em dash plus temporal lint is mixed: mechanical repair, leftover judgment stays reviewable', () => {
  const mixed: LintResult = {
    hard: [
      { code: 'EM_DASH', message: 'em dash', field: 'body', span: { start: 0, end: 1, text: '—' } },
      {
        code: 'RESEARCH_TIMELINESS_BLOCKED',
        message: 'blocked',
        field: 'combined',
        span: { start: 0, end: 0, text: '' },
      },
    ],
    warnings: [],
  };
  assert.equal(hasMechanicalAutoRepairLintFailures(mixed), true);
  assert.equal(hasJudgmentHardLintFailures(mixed), true);
  assert.equal(hasBlockingHardLintFailures(mixed), true);

  const temporalOnly: LintResult = {
    hard: [{
      code: 'TEMPORAL_LEDGER_TEXT_MISSING',
      message: 'ledger',
      field: 'combined',
      span: { start: 0, end: 4, text: 'body' },
    }],
    warnings: [],
  };
  assert.equal(hasMechanicalAutoRepairLintFailures(temporalOnly), false);
  assert.equal(hasJudgmentHardLintFailures(temporalOnly), true);

  const mechanicalOnly: LintResult = {
    hard: [{ code: 'EM_DASH', message: 'em dash', field: 'body', span: { start: 0, end: 1, text: '—' } }],
    warnings: [],
  };
  assert.equal(hasMechanicalAutoRepairLintFailures(mechanicalOnly), true);
  assert.equal(hasJudgmentHardLintFailures(mechanicalOnly), false);
});

test('peer-benchmark / value-commitment closes hard-fail and block approve', () => {
  const closes = [
    'If it would be useful to talk through how other finance organizations have managed similar turnover, I would welcome a short call whenever it makes sense on your end.',
    "I'd welcome a short call if it would be useful to trade perspective on how other finance teams are handling similar transitions right now.",
    'Would it be useful to trade a few thoughts on how other large-scale developments have staged their finance readiness ahead of opening?',
    'If it would be useful to trade perspectives on how finance teams typically hold up under that kind of expansion, I would welcome a short call.',
    "I'd like to send a short reply your way if it's useful to hear how other multi-unit restaurant finance teams are approaching this stage.",
    "If it would be useful to trade notes on where Nautical Ventures' finance function is headed, I would welcome a short call whenever it suits you.",
    "If it would be useful to compare where Trividia stands against what we're seeing across similar manufacturers, I'd welcome a short reply to say so.",
    'If it would be useful to trade perspectives on how finance is structured across the STS companies, I\'d welcome the conversation.',
    'If it would be useful to trade perspectives on how finance teams in ground handling and aviation services are managing that load, I would welcome a reply.',
    "If it would be useful to trade perspectives on how other finance leaders are handling this kind of growth, I'd welcome a short call.",
    "If it would be useful to compare where Embark has helped similar operators, I'd welcome a short reply to see if a conversation makes sense.",
  ];
  for (const close of closes) {
    const result = lintDraft('Finance support', `Hi there.\n\n${close}`);
    assert.ok(
      result.hard.some((finding) => finding.code === 'PEER_BENCHMARK_CLAIM'),
      `expected PEER_BENCHMARK_CLAIM for: ${close.slice(0, 60)}`,
    );
    assert.equal(hasBlockingHardLintFailures(result), true);
    assert.equal(hasMechanicalAutoRepairLintFailures(result), false);
  }

  const grounded = lintDraft(
    'Following up on your Q3 close',
    'I saw the note on your Q3 close timeline and wanted to reach out directly. Would a short call this week work?',
  );
  assert.equal(grounded.hard.some((finding) => finding.code === 'PEER_BENCHMARK_CLAIM'), false);
});

test('cost helpers price searches at $0.01 and preserve decimal strings', () => {
  assert.equal(formatUsd(0.03), '0.0300');
  assert.equal(computeSearchCostUsd(3), 0.03);
  assert.equal(addDecimal('1.2500', '0.7500'), '2.0000');
  assert.equal(subtractDecimal('2.0000', '0.5000'), '1.5000');
  assert.equal(releaseReservation('0.0900', '0.0600'), '0.0300');

  const estimate = estimateResearchCost();
  assert.ok(Number(estimate.lowUsd) > 0);
  assert.ok(Number(estimate.highUsd) >= Number(estimate.lowUsd));
  assert.ok(Number(worstCaseResearchReservationUsd()) >= Number(estimate.highUsd));
});

function minimalPacket(overrides: Partial<DraftingResearchPacket> = {}): DraftingResearchPacket {
  return {
    schemaVersion: '2',
    asOf: new Date().toISOString(),
    leadIdentity: {
      classification: 'verified',
      suppliedSummary: 'Jane Doe at Acme',
      currentSummary: 'Jane Doe is CFO at Acme',
      conflictSummary: null,
      supportingSourceIds: ['s1', 's2'],
    },
    freshness: {
      employer: { status: 'current', sourceIds: ['s1'], summary: 'Current employer' },
      title: { status: 'current', sourceIds: ['s1'], summary: 'Current title' },
      location: { status: 'recent', sourceIds: ['s2'], summary: 'Boston' },
    },
    prospectWorld: {
      roleReality: 'Finance leader',
      pressures: [],
      contactNorm: {
        form: 'reply',
        statement: 'Prefers email',
        sourceIds: ['s2'],
        confidence: 'supported',
      },
      registerNotes: [],
      commonVendorPatterns: [],
    },
    personFacts: [],
    companyFacts: [{
      id: 'f1',
      normalizedClaim: 'Acme filed an 8-K',
      sourceIds: ['s1'],
      quote: 'Acme filed an 8-K on June 1, 2026',
      family: 'regulator_filing',
      confidence: 'supported',
      freshness: 'recent',
      weight: 'anchor',
      significanceReason: 'Recent filing creates timing',
      temporal: {
        kind: 'event', eventClass: 'announcement',
        eventStart: '2026-06-01T00:00:00.000Z', eventEnd: null, relevanceEnd: null,
        durationBasis: 'policy_default', durationSourceIds: [], durationEvidence: null,
        discourse: 'ongoing',
      },
    }],
    roleSegmentFacts: [],
    structuralRelation: {
      relation: 'complementary',
      recipientConstraint: null,
      embarkCapabilityId: 'financial_reporting_advisory',
      supportedReason: 'Reporting pressure',
      tensionToName: null,
      sourceIds: ['s1'],
    },
    statusGeometry: {
      classification: 'peer',
      safePosture: 'Peer outreach',
      basis: 'Titles suggest peers',
    },
    resolution: {
      level: 'company',
      selectedFactIds: ['f1'],
      reasonForWriting: 'Recent filing',
      whyNow: 'June 2026 filing',
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
    sources: [
      {
        id: 's1',
        url: 'https://sec.gov/example',
        title: 'SEC filing',
        family: 'regulator_filing',
        trustTier: 'high',
        publishedOrUpdated: '2026-06-01',
        accessedAt: '2026-07-16T12:00:00.000Z',
        quote: 'Acme filed an 8-K on June 1, 2026',
        bindsPerson: false,
      },
      {
        id: 's2',
        url: 'https://acme.com/team',
        title: 'Leadership',
        family: 'first_party_company',
        trustTier: 'high',
        publishedOrUpdated: null,
        accessedAt: '2026-07-16T12:00:00.000Z',
        quote: 'Jane Doe, CFO',
        bindsPerson: true,
      },
    ],
    ...overrides,
  };
}

test('research validation flags unknown capability IDs; reconcile clears unwritable identity', () => {
  const unknownCapability = validateResearchPacket(
    minimalPacket({
      structuralRelation: {
        ...minimalPacket().structuralRelation,
        embarkCapabilityId: 'not_a_real_capability',
      },
    }),
    { allowedCapabilityIds: CANONICAL_CAPABILITY_IDS },
  );
  assert.ok(unknownCapability.some((issue) => issue.code === 'UNKNOWN_CAPABILITY_ID'));

  const reconciled = reconcileResearchPacketForWrite(
    minimalPacket({
      leadIdentity: {
        ...minimalPacket().leadIdentity,
        classification: 'conflicted',
        conflictSummary: 'Employer mismatch',
      },
      personFacts: [{
        id: 'pf1',
        normalizedClaim: 'Jane Doe is CFO',
        sourceIds: ['s2'],
        quote: 'Jane Doe, CFO',
        family: 'first_party_company',
        confidence: 'supported',
        freshness: 'current',
        weight: 'seasoning',
        significanceReason: 'Person claim',
        temporal: {
          kind: 'current_state', eventClass: 'structural',
          eventStart: null, eventEnd: null, relevanceEnd: null,
          durationBasis: 'unknown', durationSourceIds: [], durationEvidence: null,
          discourse: 'ongoing',
        },
      }],
      resolution: {
        ...minimalPacket().resolution,
        level: 'person',
        selectedFactIds: ['pf1', 'f1'],
      },
    }),
    { allowedCapabilityIds: CANONICAL_CAPABILITY_IDS },
  );
  assert.equal(reconciled.packet.leadIdentity.classification, 'usable_at_lower_resolution');
  assert.equal(reconciled.packet.leadIdentity.conflictSummary, null);
  assert.ok(!reconciled.packet.resolution.selectedFactIds.includes('pf1'));
  assert.ok(reconciled.packet.resolution.selectedFactIds.includes('f1'));
  assert.equal(reconciled.packet.resolution.level, 'company');
  assert.ok(reconciled.actions.some((action) => action.code === 'IDENTITY_NOT_WRITABLE'));
});

test('reconcile drops trash and still produces a write-safe empty brief', () => {
  const reconciled = reconcileResearchPacketForWrite(
    minimalPacket({
      resolution: {
        ...minimalPacket().resolution,
        level: 'true_zero',
        selectedFactIds: [],
        whyNow: null,
        reasonForWriting: null,
      },
    }),
    { allowedCapabilityIds: CANONICAL_CAPABILITY_IDS },
  );
  assert.equal(reconciled.packet.resolution.level, 'company');
  assert.equal(reconciled.packet.resolution.selectedFactIds.length, 0);
  assert.equal(reconciled.needsResearchUpgrade, true);
  assert.ok(reconciled.actions.some((action) => action.code === 'TRUE_ZERO_NOT_WRITABLE'));
});

test('reconcile clears invented industry-gap tension and normalizes safePosture coaching', () => {
  const reconciled = reconcileResearchPacketForWrite(
    minimalPacket({
      structuralRelation: {
        ...minimalPacket().structuralRelation,
        relation: 'potential_tension',
        tensionToName: 'Embark should not imply hospitality-sector expertise; no demonstrated track record.',
        supportedReason: 'Fit on finance capacity even though Embark has no demonstrated hospitality-specific track record to lean on.',
        recipientConstraint: 'Hospitality ops are not among Embark\'s named core industries.',
      },
      statusGeometry: {
        classification: 'sender_junior',
        safePosture: 'Write deferentially and do not presume; I don\'t know the internals so I won\'t guess at pressure.',
        basis: 'BD associate to controller',
      },
    }),
    { allowedCapabilityIds: CANONICAL_CAPABILITY_IDS },
  );
  assert.equal(reconciled.packet.structuralRelation.tensionToName, null);
  assert.equal(reconciled.packet.structuralRelation.recipientConstraint, null);
  assert.equal(reconciled.packet.structuralRelation.relation, 'adjacent');
  assert.ok(
    !reconciled.packet.structuralRelation.supportedReason
    || !/track record/i.test(reconciled.packet.structuralRelation.supportedReason),
  );
  assert.equal(reconciled.packet.statusGeometry.safePosture, 'junior_to_senior_small_ask');
  assert.ok(reconciled.actions.some((action) => action.code === 'INDUSTRY_GAP_TENSION_CLEARED'));
});

test('research validation rejects low-only anchors and undated why-now', () => {
  const lowOnly = validateResearchPacket(
    minimalPacket({
      sources: [{
        id: 's1',
        url: 'https://broker.example/person',
        title: 'Directory',
        family: 'data_broker',
        trustTier: 'low',
        publishedOrUpdated: null,
        accessedAt: '2026-07-16T12:00:00.000Z',
        quote: 'Jane Doe at Acme',
        bindsPerson: true,
      }],
      companyFacts: [{
        id: 'f1',
        normalizedClaim: 'Jane Doe at Acme',
        sourceIds: ['s1'],
        quote: 'Jane Doe at Acme',
        family: 'data_broker',
        confidence: 'tentative',
        freshness: 'undated',
        weight: 'anchor',
        significanceReason: 'Directory listing',
        temporal: {
          kind: 'evergreen', eventClass: 'structural',
          eventStart: null, eventEnd: null, relevanceEnd: null,
          durationBasis: 'unknown', durationSourceIds: [], durationEvidence: null,
          discourse: 'timeless',
        },
      }],
      leadIdentity: {
        classification: 'usable_at_lower_resolution',
        suppliedSummary: 'Jane Doe at Acme',
        currentSummary: null,
        conflictSummary: null,
        supportingSourceIds: ['s1'],
      },
      resolution: {
        level: 'role_segment',
        selectedFactIds: ['f1'],
        reasonForWriting: 'Directory listing',
        whyNow: 'Recent activity',
        prohibitedAssumptions: [],
      },
    }),
    { allowedCapabilityIds: CANONICAL_CAPABILITY_IDS },
  );
  assert.ok(lowOnly.some((issue) => issue.code === 'LOW_ONLY_ANCHOR'));
  assert.ok(lowOnly.some((issue) => issue.code === 'UNDATED_WHY_NOW'));

  const sameFamily = validateResearchPacket(
    minimalPacket({
      leadIdentity: {
        ...minimalPacket().leadIdentity,
        supportingSourceIds: ['s1', 's3'],
      },
      sources: [
        ...minimalPacket().sources,
        {
          id: 's3',
          url: 'https://mirror.example/sec',
          title: 'Mirror',
          family: 'regulator_filing',
          trustTier: 'medium',
          publishedOrUpdated: '2026-06-01',
          accessedAt: '2026-07-16T12:00:00.000Z',
          quote: 'Same filing mirrored',
          bindsPerson: false,
        },
      ],
    }),
    {
      allowedCapabilityIds: CANONICAL_CAPABILITY_IDS,
      requireIndependentSourcesForIdentity: true,
    },
  );
  assert.ok(sameFamily.some((issue) => issue.code === 'SAME_FAMILY_INDEPENDENCE'));
});
