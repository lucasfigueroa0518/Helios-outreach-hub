import assert from 'node:assert/strict';
import test from 'node:test';

import type { ApprovedDraftExportRow } from '@/lib/drafting/exports';
import { preflightFinalDraftExport, preflightFinalDraftSend } from '@/lib/drafting/exports';
import { deriveEmailEngagementLifecycle } from '@/lib/drafting/repository';
import { isDuplicateSentConstraintError } from '@/lib/drafting/agentmail-send-errors';
import {
  isEmailSendConfigured,
  outboundReplyToAddress,
} from '@/lib/drafting/send';

function sendReadyRow(overrides: Partial<ApprovedDraftExportRow> = {}): ApprovedDraftExportRow {
  return {
    itemId: 'item-1',
    ordinal: 1,
    toEmail: 'lead@example.com',
    toFirstName: 'Lead',
    toLastName: 'Example',
    toFullName: 'Lead Example',
    company: 'Example Co',
    title: 'CEO',
    location: 'NYC',
    subject: 'Quick note',
    bodyText: 'Hello there.',
    fromName: 'Sender',
    fromEmail: 'lucas@heliosgroup.email',
    senderTitle: 'Associate',
    senderCompanyName: 'Helios Group',
    senderProfileId: null,
    headshotStoragePath: null,
    state: 'approved',
    reviewStatus: 'approved',
    inputFingerprint: 'fp-1',
    draftInputFingerprint: 'fp-1',
    researchPacketSha256: 'sha-1',
    draftResearchPacketSha256: 'sha-1',
    contentRevision: 1,
    groundingStatus: 'ok',
    lintHardCount: 0,
    retrySuggested: false,
    deliverySnapshot: {
      effectiveEmail: 'lead@example.com',
      effectiveEmailFingerprint: 'fp-email',
      emailVerification: 'pending',
      verifiedAt: null,
      resultSource: 'enrichment',
      providerRequestId: null,
    },
    ...overrides,
  };
}

test('isEmailSendConfigured reflects AGENT_MAIL_API presence', () => {
  const original = process.env.AGENT_MAIL_API;
  try {
    delete process.env.AGENT_MAIL_API;
    assert.equal(isEmailSendConfigured(), false);
    process.env.AGENT_MAIL_API = 'am_test_key';
    assert.equal(isEmailSendConfigured(), true);
    process.env.AGENT_MAIL_API = '   ';
    assert.equal(isEmailSendConfigured(), false);
  } finally {
    if (original === undefined) delete process.env.AGENT_MAIL_API;
    else process.env.AGENT_MAIL_API = original;
  }
});

test('preflightFinalDraftExport is lenient on mailbox, approval, and lint', () => {
  const row = sendReadyRow({
    state: 'ready_for_review',
    reviewStatus: 'pending',
    lintHardCount: 3,
  });
  assert.equal(preflightFinalDraftExport([row]).ok, true);
  assert.equal(preflightFinalDraftSend([row]).ok, true);
});

test('preflightFinalDraftSend still requires fresh fingerprints; export does not', () => {
  const row = sendReadyRow({
    state: 'ready_for_review',
    reviewStatus: 'pending',
    draftInputFingerprint: 'stale-fp',
  });
  assert.equal(preflightFinalDraftExport([row]).ok, true);
  assert.equal(preflightFinalDraftSend([row]).ok, false);
});

test('outbound Reply-To helper returns the sending inbox', () => {
  assert.equal(outboundReplyToAddress('tommy@heliosgroup.email'), 'tommy@heliosgroup.email');
  assert.equal(outboundReplyToAddress('  lucas@heliosgroup.email  '), 'lucas@heliosgroup.email');
  assert.equal(outboundReplyToAddress(''), undefined);
  assert.equal(outboundReplyToAddress('   '), undefined);
});

test('deriveEmailEngagementLifecycle prefers reply over delivered', () => {
  assert.equal(deriveEmailEngagementLifecycle(null), 'unsent');
  assert.equal(
    deriveEmailEngagementLifecycle({
      status: 'sent',
      delivered_at: '2026-01-01T00:00:00Z',
      opened_at: '2026-01-01T01:00:00Z',
      clicked_at: null,
      bounced_at: null,
      complained_at: null,
      replied_at: '2026-01-01T02:00:00Z',
    }),
    'replied',
  );
  assert.equal(
    deriveEmailEngagementLifecycle({
      status: 'sent',
      delivered_at: '2026-01-01T00:00:00Z',
      opened_at: null,
      clicked_at: null,
      bounced_at: '2026-01-01T03:00:00Z',
      complained_at: null,
      replied_at: null,
    }),
    'bounced',
  );
});

test('duplicate sent unique-index errors are treated as already sent, not a failed send', () => {
  assert.equal(
    isDuplicateSentConstraintError(
      'duplicate key value violates unique constraint "idx_email_sends_item_sent"',
    ),
    true,
  );
  assert.equal(
    isDuplicateSentConstraintError(new Error('idx_email_sends_item_sent')),
    true,
  );
  assert.equal(
    isDuplicateSentConstraintError('AGENT_MAIL_API is not configured'),
    false,
  );
});
