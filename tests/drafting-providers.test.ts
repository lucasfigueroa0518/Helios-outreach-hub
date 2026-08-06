import assert from 'node:assert/strict';
import test from 'node:test';

import { hasHardLintFailures, lintDraft } from '@/lib/drafting/lint';
import { runDraftingResearch } from '@/lib/drafting/research-provider';
import { validateResearchPacket } from '@/lib/drafting/research-validate';
import { CANONICAL_CAPABILITY_IDS, type InputSnapshot } from '@/lib/drafting/types';
import { runDraftingWrite } from '@/lib/drafting/writer-provider';

const snapshot: InputSnapshot = {
  schemaVersion: 1,
  lead: {
    fullName: 'Alex Rivera',
    firstName: 'Alex',
    lastName: 'Rivera',
    email: 'alex@example.com',
    company: 'Example Co',
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

test('stub research packet validates cleanly for offline write path', async () => {
  const research = await runDraftingResearch({
    itemId: '00000000-0000-0000-0000-000000000099',
    inputSnapshot: snapshot,
    inputFingerprint: 'fp',
    researchRevision: 1,
    skillContent: 'skill',
    positioningText: 'positioning',
    maxSearches: 3,
  });

  const issues = validateResearchPacket(research.packet, {
    allowedCapabilityIds: CANONICAL_CAPABILITY_IDS,
  });
  assert.equal(issues.length, 0, issues.map((issue) => issue.code).join(', '));

  const write = await runDraftingWrite({
    itemId: '00000000-0000-0000-0000-000000000099',
    inputSnapshot: snapshot,
    packet: research.packet,
    packetSha256: research.packetSha256,
    draftRevision: 1,
    generationNumber: 1,
    skillContent: 'skill',
    subjectLineContent: 'subject doctrine',
    positioningText: 'positioning',
  });

  const lint = lintDraft(write.draft.subject, write.draft.bodyText);
  assert.equal(hasHardLintFailures(lint), false, lint.hard.map((item) => item.code).join(', '));
  assert.equal(write.generationMode, 'stub');
  assert.ok(write.draft.subject.trim());
  assert.ok(write.draft.bodyText.trim());
});
