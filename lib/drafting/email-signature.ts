/**
 * HTML email signature: headshot left, Full Name / Position / Company on the right.
 */

export type EmailSignatureFields = {
  displayName: string;
  title: string;
  companyName: string;
  /** Absolute HTTPS URL for the headshot (email clients cannot load relative paths). */
  headshotUrl: string | null;
};

const LUCAS_EMAIL = 'lucas@heliosgroup.ai';

/** Hardcoded signature defaults for lucas@heliosgroup.ai. */
export const LUCAS_SIGNATURE_DEFAULTS = {
  displayName: 'Lucas Figueroa',
  title: 'President',
  companyName: 'Helios Group',
  /** Served from Next.js public/ — keep under ~50KB for email clients. */
  headshotPublicPath: '/signatures/lucas-figueroa.jpg',
} as const;

/** Content-ID used when the headshot is inlined via Resend attachments. */
export const SIGNATURE_HEADSHOT_CID = 'helios-signature-headshot';

function isLocalOrigin(url: string): boolean {
  return /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url.trim());
}

/**
 * Public HTTPS origin for hosted assets.
 * Never falls back to localhost — Gmail cannot fetch local URLs from a sent email.
 */
export function publicAppOrigin(): string {
  const explicit = process.env.HELIOS_PUBLIC_URL?.trim();
  if (explicit && !isLocalOrigin(explicit)) return explicit.replace(/\/$/, '');

  const auth = process.env.AUTH_URL?.trim() || process.env.NEXTAUTH_URL?.trim();
  if (auth && !isLocalOrigin(auth)) return auth.replace(/\/$/, '');

  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;

  return 'https://www.heliosgroup.tech';
}

export function absolutePublicUrl(pathname: string): string {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${publicAppOrigin()}${path}`;
}

export function isLucasSenderEmail(email: string | null | undefined): boolean {
  return (email ?? '').trim().toLowerCase() === LUCAS_EMAIL;
}

/**
 * Resolve signature fields for a send. Lucas is hardcoded (headshot + company + name fallbacks).
 * Headshot URLs for outbound email must be cid:… (inline attachment) — never remote http(s).
 */
export function resolveEmailSignature(input: {
  workEmail: string;
  displayName?: string | null;
  title?: string | null;
  companyName?: string | null;
  /** Profile id (UI / lookup only). */
  profileId?: string | null;
  headshotStoragePath?: string | null;
  /** Required for email HTML: cid:… from an inline Resend attachment. */
  headshotUrlOverride?: string | null;
  /**
   * When true, may emit hosted https URLs (UI preview only).
   * Outbound sends must leave this false and pass a cid: override.
   */
  allowRemoteHeadshot?: boolean;
}): EmailSignatureFields {
  const workEmail = input.workEmail.trim().toLowerCase();
  const override = input.headshotUrlOverride?.trim() || null;
  const allowRemote = Boolean(input.allowRemoteHeadshot);

  if (isLucasSenderEmail(workEmail)) {
    // Hardcoded visual identity for Lucas; profile title may override position only.
    let headshotUrl = override;
    if (!headshotUrl && allowRemote) {
      headshotUrl = absolutePublicUrl(LUCAS_SIGNATURE_DEFAULTS.headshotPublicPath);
    }
    return {
      displayName: LUCAS_SIGNATURE_DEFAULTS.displayName,
      title: (input.title?.trim() || LUCAS_SIGNATURE_DEFAULTS.title),
      companyName: LUCAS_SIGNATURE_DEFAULTS.companyName,
      headshotUrl,
    };
  }

  let headshotUrl = override;
  if (!headshotUrl && allowRemote && input.profileId && input.headshotStoragePath) {
    headshotUrl = absolutePublicUrl(`/api/public/sender-headshots/${input.profileId}`);
  }

  return {
    displayName: (input.displayName ?? '').trim() || workEmail,
    title: (input.title ?? '').trim(),
    companyName: (input.companyName ?? '').trim() || 'Helios Group',
    headshotUrl,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Convert plain-text body to simple HTML paragraphs / breaks. */
export function plainTextBodyToHtml(bodyText: string): string {
  const normalized = bodyText.replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => {
      const withBreaks = escapeHtml(paragraph).replace(/\n/g, '<br>\n');
      return `<p style="margin:0 0 1em 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111111;">${withBreaks}</p>`;
    })
    .join('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function firstNameFromDisplay(displayName: string): string | null {
  const first = displayName.trim().split(/\s+/)[0];
  return first && first.length > 1 ? first : null;
}

/**
 * Remove any trailing plain-text signature / sign-off so the HTML headshot block is the only one.
 * Catches name, title, company, "Title, Company", first name alone, and Best,/Regards, closings.
 */
export function stripTrailingTextSignature(
  bodyText: string,
  signature: Pick<EmailSignatureFields, 'displayName' | 'title' | 'companyName'>,
): string {
  let text = bodyText.replace(/\r\n/g, '\n').replace(/\s+$/u, '');
  const displayName = signature.displayName.trim();
  const title = signature.title.trim();
  const company = signature.companyName.trim();
  const firstName = firstNameFromDisplay(displayName);
  const companyShort = company.replace(/\s+Group$/i, '').trim();

  // Whole-line patterns only (never peel mid-line fragments like ", Helios").
  // Combined title+company lines first so we don't leave "President," behind.
  const linePatterns: string[] = [];
  if (title && company) {
    linePatterns.push(`${escapeRegExp(title)}\\s*,\\s*${escapeRegExp(company)}`);
  }
  if (title && companyShort && companyShort.toLowerCase() !== company.toLowerCase()) {
    linePatterns.push(`${escapeRegExp(title)}\\s*,\\s*${escapeRegExp(companyShort)}`);
  }
  if (displayName) linePatterns.push(escapeRegExp(displayName));
  if (firstName) linePatterns.push(escapeRegExp(firstName));
  if (title) linePatterns.push(`${escapeRegExp(title)},?`);
  if (company) linePatterns.push(escapeRegExp(company));
  if (companyShort && companyShort.toLowerCase() !== company.toLowerCase()) {
    linePatterns.push(escapeRegExp(companyShort));
  }
  // Common sign-offs writers put above a name block.
  linePatterns.push('(?:Best|Best regards|Regards|Thanks|Thank you|Cheers|Warmly)\\s*,?');

  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of linePatterns) {
      const re = new RegExp(`\\n+${pattern}\\s*$`, 'iu');
      if (re.test(text)) {
        text = text.replace(re, '').replace(/\s+$/u, '');
        changed = true;
      }
    }
  }
  return text;
}

/** True when a sender profile has the fields required for the HTML signature. */
export function isSenderProfileSignatureReady(profile: {
  display_name?: string | null;
  title?: string | null;
  work_email?: string | null;
  headshot_storage_path?: string | null;
}): boolean {
  if (!profile.display_name?.trim() || !profile.title?.trim()) return false;
  if (isLucasSenderEmail(profile.work_email)) return true;
  return Boolean(profile.headshot_storage_path?.trim());
}

export function buildSignatureHtml(signature: EmailSignatureFields): string {
  const name = escapeHtml(signature.displayName);
  const title = escapeHtml(signature.title);
  const company = escapeHtml(signature.companyName);
  const img = signature.headshotUrl
    ? `<img src="${escapeHtml(signature.headshotUrl)}" width="72" height="72" alt="" style="display:block;width:72px;height:72px;border-radius:36px;object-fit:cover;border:0;" />`
    : `<div style="width:72px;height:72px;border-radius:36px;background:#e8e8e8;"></div>`;

  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;border-collapse:collapse;">
  <tr>
    <td style="padding:0 14px 0 0;vertical-align:top;">${img}</td>
    <td style="padding:0;vertical-align:middle;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.35;color:#111111;">
      <div style="font-weight:700;">${name}</div>
      ${title ? `<div style="font-weight:400;">${title}</div>` : ''}
      ${company ? `<div style="font-weight:400;">${company}</div>` : ''}
    </td>
  </tr>
</table>`.trim();
}

export function buildOutreachEmailHtml(
  bodyText: string,
  signature: EmailSignatureFields,
  options: { bodyToHtml?: (text: string) => string } = {},
): string {
  const cleaned = stripTrailingTextSignature(bodyText, signature);
  const toHtml = options.bodyToHtml ?? plainTextBodyToHtml;
  const bodyHtml = toHtml(cleaned);
  const signatureHtml = buildSignatureHtml(signature);
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#ffffff;">
  <div style="max-width:640px;margin:0;padding:0;">
    ${bodyHtml}
    ${signatureHtml}
  </div>
</body>
</html>`;
}

export function appendPlainTextSignature(
  bodyText: string,
  signature: EmailSignatureFields,
): string {
  const cleaned = stripTrailingTextSignature(bodyText, signature);
  const lines = [signature.displayName, signature.title, signature.companyName]
    .map((line) => line.trim())
    .filter(Boolean);
  return `${cleaned}\n\n${lines.join('\n')}`;
}
