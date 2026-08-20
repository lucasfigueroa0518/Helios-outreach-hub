import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  agentMailReplyOutreach,
  agentMailSendOutreach,
  ensureOutreachInboxDisplayName,
} from '@/lib/agentmail';
import {
  assertOutreachInbox,
  formatAgentMailDisplayName,
  isBlockedOutreachFrom,
  type SenderIdentitySlug,
} from '@/lib/agentmail-inboxes';
import { dbQuery } from '@/lib/db';
import {
  appendPlainTextSignature,
  buildOutreachEmailHtml,
  identitySlugFromSender,
  LUCAS_SIGNATURE_DEFAULTS,
  resolveEmailSignature,
  SIGNATURE_HEADSHOT_CID,
  TOMMY_SIGNATURE_DEFAULTS,
  type EmailSignatureFields,
} from '@/lib/drafting/email-signature';
import { replyPlainTextBodyToHtml } from '@/lib/drafting/reply-linkify';
import {
  EmailSendConfigurationError,
  EmailSendProviderError,
} from '@/lib/drafting/errors';
import { normalizeDraftBody, normalizeDraftText } from '@/lib/drafting/normalize';
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
  title?: string | null;
  companyName?: string | null;
  senderProfileId?: string | null;
  headshotStoragePath?: string | null;
  identitySlug?: SenderIdentitySlug | null;
  headers?: Record<string, string>;
  linkifyReplyBody?: boolean;
  inReplyToMessageId?: string | null;
  firstName?: string | null;
};

export function resolveSendToEmail(_campaignId: string | null | undefined, toEmail: string): string {
  return toEmail.trim().toLowerCase();
}

export type SendEmailResult = {
  provider: 'agentmail';
  providerMessageId: string;
  providerThreadId: string;
};

export function isEmailSendConfigured(): boolean {
  return Boolean(process.env.AGENT_MAIL_API?.trim());
}

export function outboundReplyToAddress(fromEmail: string): string | undefined {
  const email = fromEmail.trim().toLowerCase();
  return email || undefined;
}

type InlineHeadshot = {
  content: Buffer;
  filename: string;
  contentType: string;
  contentId: string;
};

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
  return null;
}

async function loadInlineHeadshot(input: SendEmailInput): Promise<InlineHeadshot | null> {
  const slug = identitySlugFromSender({
    identitySlug: input.identitySlug,
    workEmail: input.fromEmail,
    displayName: input.fromName,
  });
  const defaults = slug === 'tommy' ? TOMMY_SIGNATURE_DEFAULTS : LUCAS_SIGNATURE_DEFAULTS;
  try {
    const filePath = path.join(
      process.cwd(),
      'public',
      defaults.headshotPublicPath.replace(/^\//, ''),
    );
    const content = await readFile(filePath);
    return {
      content,
      filename: path.basename(defaults.headshotPublicPath),
      contentType: defaults.headshotPublicPath.endsWith('.png') ? 'image/png' : 'image/jpeg',
      contentId: SIGNATURE_HEADSHOT_CID,
    };
  } catch {
    // Fall through to uploaded storage headshot.
  }

  try {
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
    identitySlug: input.identitySlug,
    displayName: input.fromName,
    title: input.title,
    companyName: input.companyName,
    profileId: input.senderProfileId,
    headshotStoragePath: input.headshotStoragePath,
    headshotUrlOverride,
  });
}

/** Send one outreach email through Agent Mail (HTML signature + plain-text fallback). */
export async function sendOutreachEmail(input: SendEmailInput): Promise<SendEmailResult> {
  if (!isEmailSendConfigured()) {
    throw new EmailSendConfigurationError('AGENT_MAIL_API is not configured');
  }

  const toEmail = resolveSendToEmail(input.campaignId, input.toEmail);
  if (!toEmail || !toEmail.includes('@')) {
    throw new EmailSendProviderError('Recipient email is missing or invalid');
  }

  const fromEmail = assertOutreachInbox(input.fromEmail);
  if (isBlockedOutreachFrom(fromEmail)) {
    throw new EmailSendProviderError(`Outreach cannot send from ${input.fromEmail}`);
  }

  const subject = normalizeDraftText(input.subject).replace(/\n/g, ' ').trim();
  const bodyText = normalizeDraftBody(input.bodyText, input.firstName);
  if (!subject || !bodyText) {
    throw new EmailSendProviderError('Subject and body are required to send');
  }

  const headshot = await loadInlineHeadshot(input);
  const signature = resolveSendSignature(
    input,
    headshot ? `cid:${headshot.contentId}` : null,
  );
  if (signature.headshotUrl && !signature.headshotUrl.startsWith('cid:')) {
    signature.headshotUrl = null;
  }
  const text = appendPlainTextSignature(bodyText, signature);
  const html = buildOutreachEmailHtml(
    bodyText,
    signature,
    input.linkifyReplyBody ? { bodyToHtml: replyPlainTextBodyToHtml } : undefined,
  );

  const labels = ['helios-outreach'];
  if (input.itemId?.trim()) labels.push(`item-${input.itemId.trim().slice(0, 8)}`);
  if (input.campaignId?.trim()) labels.push(`campaign-${input.campaignId.trim().slice(0, 8)}`);
  const fromHeader = formatAgentMailDisplayName(input.fromName, fromEmail);
  try {
    await ensureOutreachInboxDisplayName(fromEmail, input.fromName);
  } catch (error) {
    console.warn(
      `[agentmail] failed to set inbox display name for ${fromEmail}:`,
      error instanceof Error ? error.message : error,
    );
  }

  try {
    const result = input.inReplyToMessageId
      ? await agentMailReplyOutreach({
          inboxId: fromEmail,
          messageId: input.inReplyToMessageId,
          text,
          html,
          labels,
          attachments: headshot
            ? [{
                filename: headshot.filename,
                contentType: headshot.contentType,
                content: headshot.content,
                contentId: headshot.contentId,
                inline: true,
              }]
            : undefined,
        })
      : await agentMailSendOutreach({
          inboxId: fromEmail,
          to: toEmail,
          subject,
          text,
          html,
          replyTo: fromEmail,
          labels,
          headers: {
            ...(input.headers ?? {}),
            From: fromHeader,
          },
          attachments: headshot
            ? [{
                filename: headshot.filename,
                contentType: headshot.contentType,
                content: headshot.content,
                contentId: headshot.contentId,
                inline: true,
              }]
            : undefined,
        });

    return {
      provider: 'agentmail',
      providerMessageId: result.message_id,
      providerThreadId: result.thread_id,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new EmailSendProviderError(message || 'Agent Mail rejected the send request', message);
  }
}
