import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Resend } from 'resend';

import { dbQuery } from '@/lib/db';
import {
  appendPlainTextSignature,
  buildOutreachEmailHtml,
  isLucasSenderEmail,
  LUCAS_SIGNATURE_DEFAULTS,
  resolveEmailSignature,
  SIGNATURE_HEADSHOT_CID,
  type EmailSignatureFields,
} from '@/lib/drafting/email-signature';
import {
  EmailSendConfigurationError,
  EmailSendProviderError,
} from '@/lib/drafting/errors';
import { normalizeDraftText } from '@/lib/drafting/normalize';
import { downloadStoredObject } from '@/lib/storage';

export { EmailSendConfigurationError, EmailSendProviderError } from '@/lib/drafting/errors';

export type SendEmailInput = {
  fromName: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  bodyText: string;
  itemId?: string;
  campaignId?: string;
  /** Optional overrides; otherwise resolved from fromEmail (Lucas hardcoded). */
  title?: string | null;
  companyName?: string | null;
  senderProfileId?: string | null;
  headshotStoragePath?: string | null;
};

/**
 * TEMP signature QA redirect — Campaign #3 only.
 * Remove after the HTML signature looks good in a real inbox.
 */
export const SIGNATURE_TEST_TO_EMAIL = 'lafballsports@gmail.com';

/** Hardcode all outbound sends to lafballsports@gmail.com for testing/QA. */
export function resolveSendToEmail(_campaignId: string | null | undefined, _toEmail: string): string {
  return SIGNATURE_TEST_TO_EMAIL;
}

export type SendEmailResult = {
  provider: 'resend';
  providerMessageId: string;
};

/** True when Resend can be invoked (API key present). Does not call the API. */
export function isEmailSendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

export function resendReplyDomain(): string {
  return (process.env.RESEND_REPLY_DOMAIN?.trim() || 'replies.heliosgroup.ai').toLowerCase();
}

/** Plus-address used as Reply-To so inbound replies map to a drafting item. */
export function replyToAddressForItem(itemId: string): string {
  const clean = itemId.trim().toLowerCase();
  return `reply+${clean}@${resendReplyDomain()}`;
}

export function parseReplyPlusItemId(
  addresses: string | string[] | null | undefined,
): string | null {
  const list = Array.isArray(addresses) ? addresses : addresses ? [addresses] : [];
  const domain = resendReplyDomain().replace(/\./g, '\\.');
  const pattern = new RegExp(`^reply\\+([0-9a-f-]{36})@${domain}$`, 'i');
  for (const raw of list) {
    const addr = raw.trim().toLowerCase().replace(/^.*</, '').replace(/>.*$/, '');
    const match = addr.match(pattern);
    if (match?.[1]) return match[1].toLowerCase();
  }
  return null;
}

function resolvedFromAddress(input: SendEmailInput): string {
  const override = process.env.RESEND_FROM_EMAIL?.trim();
  const email = override || input.fromEmail.trim();
  const name = input.fromName.trim() || email;
  return `${name} <${email}>`;
}

export function createResendClient(): Resend {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new EmailSendConfigurationError('RESEND_API_KEY is not configured');
  }
  return new Resend(apiKey);
}

type InlineHeadshot = {
  content: Buffer;
  filename: string;
  contentType: string;
  contentId: string;
};

/** Resolve storage path from payload, then live sender_profiles (id or email). */
async function resolveHeadshotStoragePath(input: SendEmailInput): Promise<string | null> {
  const direct = input.headshotStoragePath?.trim();
  if (direct) return direct;

  const profileId = input.senderProfileId?.trim();
  if (profileId && /^[0-9a-f-]{36}$/i.test(profileId)) {
    const { rows } = await dbQuery<{ headshot_storage_path: string | null }>(
      `SELECT headshot_storage_path
         FROM outreach.sender_profiles
        WHERE id = $1`,
      [profileId],
    );
    const fromId = rows[0]?.headshot_storage_path?.trim();
    if (fromId) return fromId;
  }

  const workEmail = input.fromEmail.trim().toLowerCase();
  if (!workEmail) return null;
  const { rows } = await dbQuery<{ headshot_storage_path: string | null }>(
    `SELECT headshot_storage_path
       FROM outreach.sender_profiles
      WHERE lower(work_email) = $1
        AND headshot_storage_path IS NOT NULL
        AND length(trim(headshot_storage_path)) > 0
      ORDER BY is_default DESC, updated_at DESC
      LIMIT 1`,
    [workEmail],
  );
  return rows[0]?.headshot_storage_path?.trim() || null;
}

/**
 * Load headshot bytes for EVERY sender and inline as a CID attachment.
 * Never rely on remote http(s) image URLs in outbound email HTML.
 */
async function loadInlineHeadshot(input: SendEmailInput): Promise<InlineHeadshot | null> {
  try {
    if (isLucasSenderEmail(input.fromEmail)) {
      const filePath = path.join(
        process.cwd(),
        'public',
        LUCAS_SIGNATURE_DEFAULTS.headshotPublicPath.replace(/^\//, ''),
      );
      const content = await readFile(filePath);
      return {
        content,
        filename: 'lucas-figueroa.jpg',
        contentType: 'image/jpeg',
        contentId: SIGNATURE_HEADSHOT_CID,
      };
    }

    const storagePath = await resolveHeadshotStoragePath(input);
    if (!storagePath) return null;

    const content = await downloadStoredObject(storagePath);
    const isPng = storagePath.toLowerCase().endsWith('.png');
    return {
      content,
      filename: isPng ? 'headshot.png' : 'headshot.jpg',
      contentType: isPng ? 'image/png' : 'image/jpeg',
      contentId: SIGNATURE_HEADSHOT_CID,
    };
  } catch (error) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      component: 'email-signature',
      message: 'headshot_inline_load_failed',
      fromEmail: input.fromEmail,
      error: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}

function resolveSendSignature(
  input: SendEmailInput,
  headshotUrlOverride: string | null,
): EmailSignatureFields {
  return resolveEmailSignature({
    workEmail: input.fromEmail,
    displayName: input.fromName,
    title: input.title,
    companyName: input.companyName,
    profileId: input.senderProfileId,
    headshotStoragePath: input.headshotStoragePath,
    headshotUrlOverride,
  });
}

/** Send one outreach email through Resend (HTML signature + plain-text fallback). */
export async function sendOutreachEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const toEmail = resolveSendToEmail(input.campaignId, input.toEmail);
  if (!toEmail || !toEmail.includes('@')) {
    throw new EmailSendProviderError('Recipient email is missing or invalid');
  }

  const subject = normalizeDraftText(input.subject).replace(/\n/g, ' ').trim();
  const bodyText = normalizeDraftText(input.bodyText);
  if (!subject || !bodyText) {
    throw new EmailSendProviderError('Subject and body are required to send');
  }

  // Inline EVERY sender headshot as a CID attachment (no remote image fetches in Gmail).
  const headshot = await loadInlineHeadshot(input);
  const signature = resolveSendSignature(
    input,
    headshot ? `cid:${headshot.contentId}` : null,
  );
  if (signature.headshotUrl && !signature.headshotUrl.startsWith('cid:')) {
    // Hard guard: never ship http(s) signature images.
    signature.headshotUrl = null;
  }
  const text = appendPlainTextSignature(bodyText, signature);
  const html = buildOutreachEmailHtml(bodyText, signature);

  const tags: Array<{ name: string; value: string }> = [];
  if (input.itemId?.trim()) tags.push({ name: 'item_id', value: input.itemId.trim() });
  if (input.campaignId?.trim()) tags.push({ name: 'campaign_id', value: input.campaignId.trim() });

  const replyTo = input.itemId?.trim()
    ? replyToAddressForItem(input.itemId)
    : (input.fromEmail.trim() || undefined);

  const client = createResendClient();
  const response = await client.emails.send({
    from: resolvedFromAddress(input),
    to: [toEmail],
    subject,
    text,
    html,
    replyTo: replyTo || undefined,
    tags: tags.length > 0 ? tags : undefined,
    attachments: headshot
      ? [{
          content: headshot.content,
          filename: headshot.filename,
          contentType: headshot.contentType,
          contentId: headshot.contentId,
        }]
      : undefined,
  });

  if (response.error) {
    throw new EmailSendProviderError(
      response.error.message || 'Resend rejected the send request',
      response.error.message,
    );
  }

  const providerMessageId = response.data?.id?.trim();
  if (!providerMessageId) {
    throw new EmailSendProviderError('Resend accepted the request but returned no message id');
  }

  return {
    provider: 'resend',
    providerMessageId,
  };
}
