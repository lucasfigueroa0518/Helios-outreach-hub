import assert from 'node:assert/strict';
import test from 'node:test';

import { trustedLeadEmailFields } from '@/lib/identity';
import { isSheetUploadKind, sniffUpload } from '@/lib/upload-types';
import { isMailboxDraftable, isLeadComplete } from '@/lib/drafting/eligibility';
import { emailFingerprint } from '@/lib/drafting/normalize';
import type { DeliverySnapshot, InputSnapshot } from '@/lib/drafting/types';

test('trustedLeadEmailFields marks present emails as valid/direct', () => {
  const withEmail = trustedLeadEmailFields('  alex@example.com ');
  assert.equal(withEmail.email, 'alex@example.com');
  assert.equal(withEmail.email_status, 'direct');
  assert.equal(withEmail.email_verification, 'valid');
  assert.match(withEmail.email_source_note, /pre-enriched/);

  const withoutEmail = trustedLeadEmailFields('');
  assert.equal(withoutEmail.email, null);
  assert.equal(withoutEmail.email_status, 'not_found');
  assert.equal(withoutEmail.email_verification, null);
});

test('isSheetUploadKind accepts only csv/xlsx kinds', () => {
  assert.equal(isSheetUploadKind('csv'), true);
  assert.equal(isSheetUploadKind('xlsx'), true);
  assert.equal(isSheetUploadKind('pdf'), false);
  assert.equal(isSheetUploadKind('image'), false);
  assert.equal(isSheetUploadKind('docx'), false);
});

test('sniffUpload recognizes sheet extensions for pre-enriched uploads', () => {
  const csv = sniffUpload('leads.csv', new TextEncoder().encode('name,email\n'));
  assert.equal(csv?.kind, 'csv');
  assert.ok(csv && isSheetUploadKind(csv.kind));

  const xlsx = sniffUpload('leads.xlsx', new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
  assert.equal(xlsx?.kind, 'xlsx');
  assert.ok(xlsx && isSheetUploadKind(xlsx.kind));

  const pdf = sniffUpload('scan.pdf', new TextEncoder().encode('%PDF-1.4'));
  assert.equal(pdf?.kind, 'pdf');
  assert.ok(pdf && !isSheetUploadKind(pdf.kind));
});

test('trusted valid delivery is mailbox-draftable for drafting queue', () => {
  const email = 'alex@example.com';
  const delivery: DeliverySnapshot = {
    effectiveEmail: email,
    effectiveEmailFingerprint: emailFingerprint(email),
    emailVerification: 'valid',
    verifiedAt: new Date().toISOString(),
    resultSource: 'enrichment',
    providerRequestId: null,
  };
  assert.equal(isMailboxDraftable(delivery), true);
});

test('complete trusted lead snapshot passes drafting completeness checks', () => {
  const snapshot: InputSnapshot = {
    schemaVersion: 1,
    lead: {
      fullName: 'Alex Rivera',
      firstName: 'Alex',
      lastName: 'Rivera',
      email: 'alex@example.com',
      company: 'Helios',
      title: 'Founder',
      workLocation: null,
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
    provenance: { sourceRunId: null, profileEnrichment: {}, emailProvenance: {} },
    sender: {
      profileId: '00000000-0000-0000-0000-000000000001',
      profileRevision: 1,
      displayName: 'Sender',
      workEmail: 'sender@example.com',
      title: '',
      signatureMode: 'name',
      voiceNotes: null,
      professionalContext: {},
    },
    assets: {
      skillVersion: 'v1',
      skillSha256: 'a',
      subjectLineVersion: 'v1',
      subjectLineSha256: 's',
      positioningVersion: 'v1',
      positioningSha256: 'b',
      capabilityCatalogVersion: 'v1',
      capabilityCatalogSha256: 'c',
    },
  };

  assert.equal(isLeadComplete(snapshot), true);
});
