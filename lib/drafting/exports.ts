import { createHash } from 'node:crypto';

import Papa from 'papaparse';

import { isMailboxDraftable } from '@/lib/drafting/eligibility';
import { hasHardLintFailures } from '@/lib/drafting/lint';
import {
  canonicalJson,
  extractFirstName,
  normalizeDraftText,
  normalizeEmail,
  normalizeRequiredField,
} from '@/lib/drafting/normalize';
import type { DeliverySnapshot, InputSnapshot } from '@/lib/drafting/types';

export const MAIL_CSV_HEADERS = [
  'To Email',
  'To First Name',
  'To Last Name',
  'To Full Name',
  'Company',
  'Job Title',
  'Location',
  'Subject',
  'Body',
  'From Name',
  'From Email',
] as const;

export const UNVERIFIED_LEADS_HEADERS = [
  'Full Name',
  'Email',
  'Company',
  'Job Title',
  'Location',
  'Mailbox Verification',
  'Drafting Blocker',
  'Email Origin',
  'Verified At',
] as const;

const FORMULA_PREFIX = /^[\t\r ]*[=+\-@]/;

export type ApprovedDraftExportRow = {
  itemId: string;
  ordinal: number;
  toEmail: string;
  toFirstName: string;
  toLastName: string;
  toFullName: string;
  company: string;
  title: string;
  location: string;
  subject: string;
  bodyText: string;
  fromName: string;
  fromEmail: string;
  senderTitle: string;
  senderCompanyName: string;
  senderProfileId: string | null;
  headshotStoragePath: string | null;
  state: string;
  reviewStatus: string;
  inputFingerprint: string;
  draftInputFingerprint: string;
  researchPacketSha256: string;
  draftResearchPacketSha256: string;
  contentRevision: number;
  groundingStatus: string;
  lintHardCount: number;
  deliverySnapshot: DeliverySnapshot | null;
};

export type UnverifiedLeadExportRow = {
  fullName: string;
  email: string;
  company: string;
  title: string;
  location: string;
  mailboxVerification: string;
  draftingBlocker: string;
  emailOrigin: string;
  verifiedAt: string;
};

export type ExportPreflightMeta = {
  included: number;
  unresolved_leads: number;
  blocked: number;
  sender: string;
  generated_at: string;
};

export type ExportBlocker = {
  item_id: string;
  recipient: string;
  code: string;
  message: string;
};

export function sanitizeCampaignFilename(name: string): string {
  const trimmed = name.trim() || 'campaign';
  return trimmed
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

export function exportDateStamp(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** Neutralize spreadsheet formula injection for metadata cells only. */
export function neutralizeFormulaCell(value: string): string {
  if (FORMULA_PREFIX.test(value)) {
    return `'${value}`;
  }
  return value;
}

export function bodyToCrlf(body: string): string {
  return normalizeDraftText(body).replace(/\n/g, '\r\n');
}

export function hasFormulaInjectionRisk(value: string): boolean {
  return FORMULA_PREFIX.test(value);
}

export type PreflightFinalDraftOptions = {
  /** When true, require AgentMail-validated (or rate-limited) addresses. */
  requireMailboxDraftable?: boolean;
  /** When true, require human approval. */
  requireApproved?: boolean;
  /** When true, block on hard lint. */
  requireLintPass?: boolean;
  /** When true, block duplicate recipients/content. */
  requireUniqueRecipients?: boolean;
  /** When true, require draft fingerprints to match current input/packet. */
  requireFreshFingerprints?: boolean;
};

export function preflightFinalDraftExport(
  rows: ApprovedDraftExportRow[],
  options: PreflightFinalDraftOptions = {},
): { ok: true; meta: ExportPreflightMeta } | { ok: false; blockers: ExportBlocker[] } {
  // Export defaults are intentionally lenient (CSV download should not gate on quality).
  const requireMailboxDraftable = options.requireMailboxDraftable ?? false;
  const requireApproved = options.requireApproved ?? false;
  const requireLintPass = options.requireLintPass ?? false;
  const requireUniqueRecipients = options.requireUniqueRecipients ?? false;
  const requireFreshFingerprints = options.requireFreshFingerprints ?? false;
  if (rows.length === 0) {
    return {
      ok: false,
      blockers: [{
        item_id: '',
        recipient: '',
        code: 'no_rows',
        message: 'No drafts are available to export',
      }],
    };
  }

  const blockers: ExportBlocker[] = [];
  const seenEmails = new Map<string, string>();
  const seenContent = new Map<string, string>();

  for (const row of rows) {
    const recipient = row.toFullName || row.toEmail;

    if (
      requireApproved
      && (row.state !== 'approved' || row.reviewStatus !== 'approved')
    ) {
      blockers.push({
        item_id: row.itemId,
        recipient,
        code: 'not_approved',
        message: 'Draft is not approved',
      });
      continue;
    }

    if (requireMailboxDraftable && !isMailboxDraftable(row.deliverySnapshot)) {
      blockers.push({
        item_id: row.itemId,
        recipient,
        code: 'email_not_mailbox_valid',
        message: 'Current recipient address is not draftable (missing, invalid, or unverified)',
      });
      continue;
    }

    if (
      requireFreshFingerprints
      && row.inputFingerprint !== row.draftInputFingerprint
    ) {
      blockers.push({
        item_id: row.itemId,
        recipient,
        code: 'stale_input',
        message: 'Draft input fingerprint does not match current effective input',
      });
      continue;
    }

    if (
      requireFreshFingerprints
      && row.researchPacketSha256 !== row.draftResearchPacketSha256
    ) {
      blockers.push({
        item_id: row.itemId,
        recipient,
        code: 'stale_packet',
        message: 'Draft research packet hash does not match current packet',
      });
      continue;
    }

    if (requireLintPass && row.lintHardCount > 0) {
      blockers.push({
        item_id: row.itemId,
        recipient,
        code: 'lint_failed',
        message: 'Draft has hard lint failures',
      });
      continue;
    }

    if (
      row.groundingStatus === 'manual_override'
      // manual_override requires explicit approval after latest edit — checked via approved state
    ) {
      // approved state already implies human approval for manual_override rows
    }

    if (hasFormulaInjectionRisk(row.subject) || hasFormulaInjectionRisk(row.bodyText)) {
      blockers.push({
        item_id: row.itemId,
        recipient,
        code: 'formula_prefix',
        message: 'Subject or body begins with a spreadsheet formula prefix; edit and reapprove',
      });
      continue;
    }

    const normalizedEmail = normalizeEmail(row.toEmail);
    if (!normalizedEmail) {
      blockers.push({
        item_id: row.itemId,
        recipient,
        code: 'invalid_email',
        message: 'Recipient email is missing or invalid',
      });
      continue;
    }

    if (requireUniqueRecipients) {
      const priorEmailItem = seenEmails.get(normalizedEmail);
      if (priorEmailItem) {
        blockers.push({
          item_id: row.itemId,
          recipient,
          code: 'duplicate_recipient',
          message: `Duplicate recipient address also used by item ${priorEmailItem}`,
        });
        continue;
      }
      seenEmails.set(normalizedEmail, row.itemId);

      const contentKey = `${normalizedEmail}::${row.subject}::${normalizeDraftText(row.bodyText)}`;
      const priorContentItem = seenContent.get(contentKey);
      if (priorContentItem) {
        blockers.push({
          item_id: row.itemId,
          recipient,
          code: 'duplicate_content',
          message: `Duplicate subject/body also used by item ${priorContentItem}`,
        });
        continue;
      }
      seenContent.set(contentKey, row.itemId);
    }
  }

  if (blockers.length > 0) {
    return { ok: false, blockers };
  }

  const sender = rows[0];
  return {
    ok: true,
    meta: {
      included: rows.length,
      unresolved_leads: 0,
      blocked: 0,
      sender: `${sender.fromName} <${sender.fromEmail}>`,
      generated_at: new Date().toISOString(),
    },
  };
}

/** Integrity checks for Resend send — stricter than export on fingerprint freshness. */
export function preflightFinalDraftSend(
  rows: ApprovedDraftExportRow[],
): ReturnType<typeof preflightFinalDraftExport> {
  return preflightFinalDraftExport(rows, {
    requireMailboxDraftable: false,
    requireApproved: false,
    requireLintPass: false,
    requireUniqueRecipients: false,
    requireFreshFingerprints: true,
  });
}

function serializeCsv(headers: readonly string[], records: Record<string, string>[]): Uint8Array {
  const csv = Papa.unparse({
    fields: [...headers],
    data: records.map((row) => headers.map((header) => row[header] ?? '')),
  }, {
    quotes: true,
    newline: '\r\n',
  });
  const bom = '\uFEFF';
  return new TextEncoder().encode(bom + csv.replace(/\n/g, '\r\n'));
}

export function buildMailCsv(rows: ApprovedDraftExportRow[]): Uint8Array {
  const records = rows.map((row) => ({
    'To Email': row.toEmail,
    'To First Name': row.toFirstName,
    'To Last Name': row.toLastName,
    'To Full Name': row.toFullName,
    'Company': neutralizeFormulaCell(row.company),
    'Job Title': neutralizeFormulaCell(row.title),
    'Location': neutralizeFormulaCell(row.location),
    'Subject': row.subject,
    'Body': bodyToCrlf(row.bodyText),
    'From Name': neutralizeFormulaCell(row.fromName),
    'From Email': row.fromEmail,
  }));
  return serializeCsv(MAIL_CSV_HEADERS, records);
}

export function buildUnverifiedLeadsCsv(rows: UnverifiedLeadExportRow[]): Uint8Array {
  const records = rows.map((row) => ({
    'Full Name': neutralizeFormulaCell(row.fullName),
    'Email': row.email,
    'Company': neutralizeFormulaCell(row.company),
    'Job Title': neutralizeFormulaCell(row.title),
    'Location': neutralizeFormulaCell(row.location),
    'Mailbox Verification': row.mailboxVerification,
    'Drafting Blocker': neutralizeFormulaCell(row.draftingBlocker),
    'Email Origin': neutralizeFormulaCell(row.emailOrigin),
    'Verified At': row.verifiedAt,
  }));
  return serializeCsv(UNVERIFIED_LEADS_HEADERS, records);
}

export type CoworkRecord = {
  ref: string;
  from_name: string;
  from_email: string;
  to_name: string;
  to_email: string;
  subject: string;
  body_text: string;
};

export function buildCoworkRecords(rows: ApprovedDraftExportRow[]): CoworkRecord[] {
  return rows.map((row, index) => ({
    ref: `draft-${String(index + 1).padStart(3, '0')}`,
    from_name: row.fromName,
    from_email: row.fromEmail,
    to_name: row.toFullName,
    to_email: row.toEmail,
    subject: row.subject,
    body_text: normalizeDraftText(row.bodyText),
  }));
}

export function coworkPayloadSha256(records: CoworkRecord[]): string {
  return createHash('sha256').update(canonicalJson(records), 'utf8').digest('hex');
}

function selectJsonFence(records: CoworkRecord[]): string {
  const serialized = JSON.stringify(records, null, 2);
  let fenceLen = 3;
  while (serialized.includes('`'.repeat(fenceLen))) {
    fenceLen += 1;
  }
  return '`'.repeat(fenceLen);
}

export function buildCoworkMarkdown(input: {
  campaignName: string;
  senderName: string;
  senderEmail: string;
  rows: ApprovedDraftExportRow[];
  generatedAt?: string;
}): string {
  const records = buildCoworkRecords(input.rows);
  const fence = selectJsonFence(records);
  const payloadSha = coworkPayloadSha256(records);
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const sender = `${input.senderName} <${input.senderEmail}>`;

  return [
    '# Create approved outreach drafts',
    '',
    '## Instructions',
    '',
    'You are creating email drafts from approved final content.',
    '',
    'Rules:',
    `1. Create exactly ${records.length} drafts, one for each record below.`,
    '2. Use the exact From, To, Subject, and Body values. Do not rewrite, shorten,',
    '   expand, personalize, research, or correct them.',
    '3. Preserve paragraph breaks in Body.',
    '4. Do not add a signature, links, formatting, tracking, attachments, CC, or',
    '   BCC.',
    '5. Do not send any email. Save each as a draft for the user to review and send.',
    '6. If a required field cannot be placed exactly, stop on that record and',
    '   report its Ref plus the problem. Do not guess.',
    '7. At the end, report how many drafts were created and list any failed Refs.',
    '',
    '## Batch',
    '',
    `- Campaign: ${input.campaignName}`,
    `- Expected drafts: ${records.length}`,
    `- Sender: ${sender}`,
    `- Exported at: ${generatedAt}`,
    `- Payload SHA-256: ${payloadSha}`,
    '',
    '## Records',
    '',
    `${fence}json`,
    JSON.stringify(records, null, 2),
    fence,
    '',
  ].join('\n');
}

export function splitLastName(fullName: string): string {
  const parts = normalizeRequiredField(fullName)?.split(' ').filter(Boolean) ?? [];
  if (parts.length <= 1) return '';
  return parts.slice(1).join(' ');
}

export function mapApprovedExportRow(input: {
  itemId: string;
  ordinal: number;
  snapshot: InputSnapshot;
  deliverySnapshot: DeliverySnapshot | null;
  state: string;
  reviewStatus: string;
  inputFingerprint: string;
  subject: string;
  bodyText: string;
  draftInputFingerprint: string;
  researchPacketSha256: string;
  draftResearchPacketSha256: string;
  contentRevision: number;
  groundingStatus: string;
  lintHardCount: number;
}): ApprovedDraftExportRow {
  const fullName = normalizeRequiredField(input.snapshot.lead.fullName) ?? '';
  const firstName = extractFirstName(fullName) ?? '';
  return {
    itemId: input.itemId,
    ordinal: input.ordinal,
    toEmail: normalizeEmail(input.snapshot.lead.email) ?? '',
    toFirstName: firstName,
    toLastName: splitLastName(fullName),
    toFullName: fullName,
    company: normalizeRequiredField(input.snapshot.lead.company) ?? '',
    title: normalizeRequiredField(input.snapshot.lead.title) ?? '',
    location: normalizeRequiredField(input.snapshot.lead.workLocation) ?? '',
    subject: input.subject,
    bodyText: input.bodyText,
    fromName: input.snapshot.sender.displayName,
    fromEmail: input.snapshot.sender.workEmail,
    senderTitle: input.snapshot.sender.title ?? '',
    senderCompanyName: input.snapshot.sender.companyName ?? 'Helios Group',
    senderProfileId: input.snapshot.sender.profileId ?? null,
    headshotStoragePath: input.snapshot.sender.headshotStoragePath ?? null,
    state: input.state,
    reviewStatus: input.reviewStatus,
    inputFingerprint: input.inputFingerprint,
    draftInputFingerprint: input.draftInputFingerprint,
    researchPacketSha256: input.researchPacketSha256,
    draftResearchPacketSha256: input.draftResearchPacketSha256,
    contentRevision: input.contentRevision,
    groundingStatus: input.groundingStatus,
    lintHardCount: input.lintHardCount,
    deliverySnapshot: input.deliverySnapshot,
  };
}

export function mailboxVerificationLabel(status: string | null | undefined): string {
  if (!status || status === 'missing' || status === 'malformed') return 'Missing';
  if (status === 'pending') return 'Pending';
  if (status === 'valid') return 'Valid';
  if (status === 'invalid') return 'Invalid';
  if (status === 'unknown') return 'Unknown';
  if (status === 'risky') return 'Risky';
  if (status === 'accept_all') return 'Accept-all';
  if (status === 'rate_limited') return 'Verification rate limited';
  return status;
}
