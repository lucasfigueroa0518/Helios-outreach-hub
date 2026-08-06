import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canApproveIdleDraftingItem,
  isQueueableIdleState,
  resolveDraftingEnqueueAction,
  shouldAutoQueueDraftingItem,
} from '@/lib/drafting/queue-orchestration';
import type { DeliverySnapshot, InputSnapshot } from '@/lib/drafting/types';

function delivery(status: DeliverySnapshot['emailVerification'] = 'valid'): DeliverySnapshot {
  return {
    effectiveEmail: 'a@example.com',
    effectiveEmailFingerprint: 'fp',
    emailVerification: status,
    verifiedAt: null,
    resultSource: 'test',
    providerRequestId: null,
  };
}

function snapshot(overrides: Partial<InputSnapshot['lead']> = {}): InputSnapshot {
  return {
    schemaVersion: 1,
    lead: {
      email: 'a@example.com',
      fullName: 'Ada Lovelace',
      firstName: 'Ada',
      lastName: 'Lovelace',
      company: 'Analytical Engines',
      title: 'Mathematician',
      workLocation: 'London',
      linkedinUrl: null,
      emailStatus: 'direct',
      emailDecision: 'valid',
      ...overrides,
    },
    sender: {
      profileId: 'p',
      profileRevision: 1,
      displayName: 'Lucas',
      workEmail: 'l@example.com',
      title: 'BD',
      signatureMode: 'name',
      voiceNotes: null,
      professionalContext: {},
    },
    assets: {
      skillVersion: 'v5',
      skillSha256: 's',
      subjectLineVersion: 'v1',
      subjectLineSha256: 'sl',
      positioningVersion: 'v1',
      positioningSha256: 'p',
      capabilityCatalogVersion: 'v1',
      capabilityCatalogSha256: 'c',
    },
    connectingContext: {
      mode: 'cold',
      introducerName: null,
      linkedinConnectionDegree: null,
      rawCrmIndicator: null,
      suppliedContext: null,
    },
    relationship: {
      relationshipTier: 'cold',
      lastContacted: null,
      lastContactedBy: null,
      pastWork: '',
      priorRelationshipActivity: null,
      reusedFromPriorLead: false,
      capturedAt: null,
    },
    provenance: {
      sourceRunId: null,
      emailProvenance: {},
      profileEnrichment: {},
    },
    customContext: {},
  };
}

test('queueable idle states cover leads-mode terminals', () => {
  assert.equal(isQueueableIdleState('needs_lead_review'), true);
  assert.equal(isQueueableIdleState('waiting_for_enrichment'), true);
  assert.equal(isQueueableIdleState('failed_research'), true);
  assert.equal(isQueueableIdleState('failed_write'), true);
  assert.equal(isQueueableIdleState('ready_for_review'), false);
  assert.equal(isQueueableIdleState('queued_research'), false);
});

test('shouldAutoQueueDraftingItem requires idle + draftable + complete', () => {
  assert.equal(shouldAutoQueueDraftingItem({
    state: 'needs_lead_review',
    snapshot: snapshot(),
    delivery: delivery('valid'),
  }), true);
  assert.equal(shouldAutoQueueDraftingItem({
    state: 'needs_lead_review',
    snapshot: snapshot(),
    delivery: delivery('rate_limited'),
  }), true);
  assert.equal(shouldAutoQueueDraftingItem({
    state: 'needs_lead_review',
    snapshot: snapshot({ title: null }),
    delivery: delivery('valid'),
  }), false);
  assert.equal(shouldAutoQueueDraftingItem({
    state: 'ready_for_review',
    snapshot: snapshot(),
    delivery: delivery('valid'),
  }), false);
  assert.equal(shouldAutoQueueDraftingItem({
    state: 'needs_lead_review',
    snapshot: snapshot(),
    delivery: delivery('pending'),
  }), false);
});

test('auto mode does not requeue hard write failures or quarantined research', () => {
  assert.equal(resolveDraftingEnqueueAction({
    state: 'failed_write',
    snapshot: snapshot(),
    delivery: delivery('valid'),
    mode: 'auto',
  }), null);
  assert.equal(resolveDraftingEnqueueAction({
    state: 'failed_research',
    snapshot: snapshot(),
    delivery: delivery('valid'),
    mode: 'auto',
    lastErrorCode: 'empty_research_brief',
  }), null);
  assert.equal(resolveDraftingEnqueueAction({
    state: 'failed_research',
    snapshot: snapshot(),
    delivery: delivery('valid'),
    mode: 'auto',
    lastErrorCode: 'transient_provider',
  }), 'research');
});

test('human approve queues verify for pending mailbox and research for write fails', () => {
  assert.equal(resolveDraftingEnqueueAction({
    state: 'needs_lead_review',
    snapshot: snapshot(),
    delivery: delivery('pending'),
    mode: 'human',
  }), 'verify_mailbox');
  assert.equal(resolveDraftingEnqueueAction({
    state: 'failed_write',
    snapshot: snapshot(),
    delivery: delivery('valid'),
    mode: 'human',
  }), 'research');
  assert.equal(resolveDraftingEnqueueAction({
    state: 'needs_lead_review',
    snapshot: snapshot(),
    delivery: delivery('invalid'),
    mode: 'human',
  }), null);
});

test('waiting_for_enrichment can auto-queue once draftable', () => {
  assert.equal(resolveDraftingEnqueueAction({
    state: 'waiting_for_enrichment',
    snapshot: snapshot(),
    delivery: delivery('valid'),
    mode: 'auto',
  }), 'research');
});

test('canApproveIdleDraftingItem allows draftable stranded leads', () => {
  assert.equal(canApproveIdleDraftingItem({
    state: 'needs_lead_review',
    missingFieldCount: 0,
  }), true);
  assert.equal(canApproveIdleDraftingItem({
    state: 'failed_write',
    missingFieldCount: 0,
  }), true);
  assert.equal(canApproveIdleDraftingItem({
    state: 'waiting_for_enrichment',
    missingFieldCount: 0,
  }), true);
  assert.equal(canApproveIdleDraftingItem({
    state: 'needs_lead_review',
    missingFieldCount: 1,
  }), false);
  assert.equal(canApproveIdleDraftingItem({
    state: 'verifying_mailbox',
    missingFieldCount: 0,
  }), false);
});
