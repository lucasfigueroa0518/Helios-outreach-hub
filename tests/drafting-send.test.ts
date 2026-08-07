import assert from 'node:assert/strict';
import test from 'node:test';

import type { ApprovedDraftExportRow } from '@/lib/drafting/exports';
import { preflightFinalDraftExport, preflightFinalDraftSend } from '@/lib/drafting/exports';
import { deriveEmailEngagementLifecycle } from '@/lib/drafting/repository';
import {
  isEmailSendConfigured,
  parseReplyPlusItemId,
  replyToAddressForItem,
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
    fromEmail: 'sender@heliosgroup.ai',
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

test('isEmailSendConfigured reflects RESEND_API_KEY presence', () => {
  const original = process.env.RESEND_API_KEY;
  try {
    delete process.env.RESEND_API_KEY;
    assert.equal(isEmailSendConfigured(), false);
    process.env.RESEND_API_KEY = 're_test_key';
    assert.equal(isEmailSendConfigured(), true);
    process.env.RESEND_API_KEY = '   ';
    assert.equal(isEmailSendConfigured(), false);
  } finally {
    if (original === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = original;
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

test('reply plus-address parses item id for inbound matching', () => {
  const original = process.env.RESEND_REPLY_DOMAIN;
  try {
    process.env.RESEND_REPLY_DOMAIN = 'replies.heliosgroup.ai';
    const itemId = '4755aa7b-cee3-4794-bf73-143cb3fabd06';
    const address = replyToAddressForItem(itemId);
    assert.equal(address, `reply+${itemId}@replies.heliosgroup.ai`);
    assert.equal(parseReplyPlusItemId([address]), itemId);
    assert.equal(parseReplyPlusItemId([`Name <${address}>`]), itemId);
    assert.equal(parseReplyPlusItemId(['other@example.com']), null);
  } finally {
    if (original === undefined) delete process.env.RESEND_REPLY_DOMAIN;
    else process.env.RESEND_REPLY_DOMAIN = original;
  }
});

test('deriveEmailEngagementLifecycle prefers reply over open over delivered', () => {
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
