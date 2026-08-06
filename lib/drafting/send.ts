import { Resend } from 'resend';

import { normalizeDraftText } from '@/lib/drafting/normalize';

export type SendEmailInput = {
  fromName: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  bodyText: string;
  itemId?: string;
  campaignId?: string;
};

export type SendEmailResult = {
  provider: 'resend';
  providerMessageId: string;
};

export class EmailSendConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailSendConfigurationError';
  }
}

export class EmailSendProviderError extends Error {
  readonly providerMessage: string;

  constructor(message: string, providerMessage?: string) {
    super(message);
    this.name = 'EmailSendProviderError';
    this.providerMessage = providerMessage ?? message;
  }
}

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

/** Send one plain-text outreach email through Resend. */
export async function sendOutreachEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const toEmail = input.toEmail.trim().toLowerCase();
  if (!toEmail || !toEmail.includes('@')) {
    throw new EmailSendProviderError('Recipient email is missing or invalid');
  }

  const subject = normalizeDraftText(input.subject).replace(/\n/g, ' ').trim();
  const bodyText = normalizeDraftText(input.bodyText);
  if (!subject || !bodyText) {
    throw new EmailSendProviderError('Subject and body are required to send');
  }

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
    text: bodyText,
    replyTo: replyTo || undefined,
    tags: tags.length > 0 ? tags : undefined,
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
