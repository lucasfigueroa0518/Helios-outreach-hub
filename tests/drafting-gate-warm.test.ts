import assert from 'node:assert/strict';
import test from 'node:test';

import {
  asResearchTimelinessAudit,
  isFreshTemporalAudit,
  TEMPORAL_AUDIT_TTL_MS,
} from '@/lib/drafting/gate-warm';
import type { ResearchTimelinessAudit } from '@/lib/drafting/temporal-policy';

function audit(overrides: Partial<ResearchTimelinessAudit> = {}): ResearchTimelinessAudit {
  return {
    policyVersion: 'outreach-timeliness-v2',
    auditedAt: new Date().toISOString(),
    packetAsOf: '2026-08-06T01:00:00.000Z',
    status: 'verified',
    packetAgeMs: 1000,
    currentTriggerFactIds: [],
    blockedFactIds: [],
    codes: [],
    facts: [],
    ...overrides,
  };
}

test('isFreshTemporalAudit accepts matching recent audits', () => {
  const now = Date.parse('2026-08-06T01:03:00.000Z');
  const fresh = audit({
    auditedAt: '2026-08-06T01:02:00.000Z',
    packetAsOf: '2026-08-06T01:00:00.000Z',
  });
  assert.equal(isFreshTemporalAudit(fresh, '2026-08-06T01:00:00.000Z', now), true);
});

test('isFreshTemporalAudit rejects stale or mismatched packetAsOf', () => {
  const now = Date.parse('2026-08-06T01:10:00.000Z');
  const stale = audit({
    auditedAt: new Date(now - TEMPORAL_AUDIT_TTL_MS - 1).toISOString(),
    packetAsOf: '2026-08-06T01:00:00.000Z',
  });
  assert.equal(isFreshTemporalAudit(stale, '2026-08-06T01:00:00.000Z', now), false);
  assert.equal(
    isFreshTemporalAudit(audit(), '2026-08-06T02:00:00.000Z', now),
    false,
  );
  assert.equal(isFreshTemporalAudit(null, '2026-08-06T01:00:00.000Z', now), false);
});

test('asResearchTimelinessAudit validates required fields', () => {
  assert.equal(asResearchTimelinessAudit(null), null);
  assert.equal(asResearchTimelinessAudit({ auditedAt: 'x' }), null);
  assert.ok(asResearchTimelinessAudit(audit()));
});
