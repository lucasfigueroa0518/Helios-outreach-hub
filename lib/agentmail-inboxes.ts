/**
 * Hard split: mailbox-verify probes vs outreach sends.
 * Probe mail must never leave the throwaway verify inbox.
 */

export const AGENTMAIL_VERIFY_INBOX = 'abcdefg@agentmail.to';

export type SenderIdentitySlug = 'lucas' | 'tommy';

export type OutreachInboxSeed = {
  email: string;
  identity: SenderIdentitySlug;
  sortOrder: number;
  isPrimary: boolean;
};

export const OUTREACH_INBOX_SEEDS: readonly OutreachInboxSeed[] = [
  { email: 'lucas@heliosgroup.email', identity: 'lucas', sortOrder: 1, isPrimary: true },
  { email: 'lucas@heliosgroup.online', identity: 'lucas', sortOrder: 2, isPrimary: false },
  { email: 'l.figueroa@heliosgroup.email', identity: 'lucas', sortOrder: 3, isPrimary: false },
  { email: 'lfigueroa@heliosgroup.email', identity: 'lucas', sortOrder: 4, isPrimary: false },
  { email: 'thomas@heliosgroup.email', identity: 'tommy', sortOrder: 1, isPrimary: true },
  { email: 'tommy@heliosgroup.email', identity: 'tommy', sortOrder: 2, isPrimary: false },
  { email: 'thomas@heliosgroup.online', identity: 'tommy', sortOrder: 3, isPrimary: false },
] as const;

export const OUTREACH_INBOX_EMAILS: readonly string[] = OUTREACH_INBOX_SEEDS.map((row) => row.email);

const OUTREACH_INBOX_SET = new Set(OUTREACH_INBOX_EMAILS);

export const BLOCKED_OUTREACH_FROM_DOMAINS = ['heliosgroup.ai'] as const;

/** Personal mailboxes that receive a copy of every inbound lead reply. */
export const PERSONAL_FORWARD_EMAILS: Record<SenderIdentitySlug, string> = {
  lucas: 'lucas@heliosgroup.ai',
  tommy: 'tommy@heliosgroup.ai',
};

export const INBOUND_FORWARD_LABEL = 'helios-inbound-forward';

export function personalForwardEmailForInbox(inboxEmail: string | null | undefined): string {
  return PERSONAL_FORWARD_EMAILS[inferIdentitySlug({ workEmail: inboxEmail })];
}

export const SENDER_IDENTITY_DEFAULTS: Record<
  SenderIdentitySlug,
  {
    displayName: string;
    title: string;
    companyName: string;
    headshotPublicPath: string;
  }
> = {
  lucas: {
    displayName: 'Lucas Figueroa',
    title: 'President',
    companyName: 'Helios Group',
    headshotPublicPath: '/signatures/lucas-figueroa.jpg',
  },
  tommy: {
    displayName: 'Thomas Pozo',
    title: 'Partner',
    companyName: 'Helios Group',
    headshotPublicPath: '/signatures/thomas-pozo.jpg',
  },
};

export function parseSenderIdentitySlug(value: unknown): SenderIdentitySlug | null {
  const slug = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (slug === 'lucas' || slug === 'tommy') return slug;
  return null;
}

/** Auto campaigns with a null column (legacy) pack onto Lucas. */
export function campaignSenderIdentity(value: unknown): SenderIdentitySlug {
  return parseSenderIdentitySlug(value) ?? 'lucas';
}

export const SENDER_IDENTITY_LABELS: Record<SenderIdentitySlug, string> = {
  lucas: 'Lucas',
  tommy: 'Tommy',
};

export function primaryInboxEmailForIdentity(slug: SenderIdentitySlug): string {
  const seed = OUTREACH_INBOX_SEEDS.find((row) => row.identity === slug && row.isPrimary);
  if (!seed) throw new Error(`No primary inbox seeded for ${slug}`);
  return seed.email;
}

export function inboxCountForIdentity(slug: SenderIdentitySlug): number {
  return OUTREACH_INBOX_SEEDS.filter((row) => row.identity === slug).length;
}

export function normalizeEmailAddress(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export function extractEmailAddress(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const match = raw.trim().match(/<([^>]+)>/);
  const addr = (match?.[1] ?? raw).trim().toLowerCase();
  return addr.includes('@') ? addr : null;
}

export function isVerifyInbox(inboxId: string | null | undefined): boolean {
  return normalizeEmailAddress(inboxId) === AGENTMAIL_VERIFY_INBOX;
}

export function isOutreachInbox(email: string | null | undefined): boolean {
  return OUTREACH_INBOX_SET.has(normalizeEmailAddress(email));
}

export function isBlockedOutreachFrom(email: string | null | undefined): boolean {
  const normalized = normalizeEmailAddress(email);
  if (!normalized.includes('@')) return true;
  const domain = normalized.split('@')[1] ?? '';
  if ((BLOCKED_OUTREACH_FROM_DOMAINS as readonly string[]).includes(domain)) return true;
  return !isOutreachInbox(normalized);
}

export function assertOutreachInbox(email: string): string {
  const normalized = normalizeEmailAddress(email);
  if (!isOutreachInbox(normalized)) {
    throw new Error(`AgentMail outreach inbox is not allowlisted: ${email}`);
  }
  return normalized;
}

export function assertVerifyInbox(inboxId: string): string {
  const normalized = normalizeEmailAddress(inboxId);
  if (normalized !== AGENTMAIL_VERIFY_INBOX) {
    throw new Error(
      `Mailbox verification must use ${AGENTMAIL_VERIFY_INBOX}; refused ${inboxId}`,
    );
  }
  return normalized;
}

export function resolveConfiguredVerifyInbox(): string {
  const configured = normalizeEmailAddress(process.env.AGENTMAIL_INBOX_ID);
  if (!configured) return AGENTMAIL_VERIFY_INBOX;
  if (configured !== AGENTMAIL_VERIFY_INBOX) {
    throw new Error(
      `AGENTMAIL_INBOX_ID must be ${AGENTMAIL_VERIFY_INBOX} (verify-only); got ${configured}`,
    );
  }
  return AGENTMAIL_VERIFY_INBOX;
}

export function inferIdentitySlug(input: {
  identitySlug?: string | null;
  workEmail?: string | null;
  displayName?: string | null;
}): SenderIdentitySlug {
  const slug = (input.identitySlug ?? '').trim().toLowerCase();
  if (slug === 'lucas' || slug === 'tommy') return slug;

  const email = normalizeEmailAddress(input.workEmail);
  const seed = OUTREACH_INBOX_SEEDS.find((row) => row.email === email);
  if (seed) return seed.identity;

  if (email.includes('tommy') || email.includes('thomas') || email.includes('pozo')) {
    return 'tommy';
  }
  const name = (input.displayName ?? '').trim().toLowerCase();
  if (name.includes('tommy') || name.includes('thomas') || name.includes('pozo')) {
    return 'tommy';
  }
  return 'lucas';
}

/** Person name for AgentMail inbox display_name. Empty / "AgentMail" fall back. */
export function resolveAgentMailSenderName(
  displayName: string | null | undefined,
  email: string,
): string {
  const address = assertOutreachInbox(email);
  const stripped = (displayName ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/[<>@]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const fallback = SENDER_IDENTITY_DEFAULTS[inferIdentitySlug({
    workEmail: address,
    displayName: stripped,
  })].displayName;
  return !stripped || /^agentmail$/i.test(stripped) ? fallback : stripped;
}

/** RFC 5322 From line. Inbox PATCH cannot use this — AgentMail rejects < @ >. */
export function formatAgentMailDisplayName(
  displayName: string | null | undefined,
  email: string,
): string {
  const address = assertOutreachInbox(email);
  return `${resolveAgentMailSenderName(displayName, address)} <${address}>`;
}
