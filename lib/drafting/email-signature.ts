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

export function publicAppOrigin(): string {
  const explicit = process.env.HELIOS_PUBLIC_URL?.trim()
    || process.env.AUTH_URL?.trim()
    || process.env.NEXTAUTH_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  return 'http://localhost:3000';
}

export function absolutePublicUrl(pathname: string): string {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${publicAppOrigin()}${path}`;
}

export function isLucasSenderEmail(email: string | null | undefined): boolean {
  return (email ?? '').trim().toLowerCase() === LUCAS_EMAIL;
}

/**
 * Resolve signature fields for a send. Lucas is hardcoded (headshot + company + name fallbacks);
 * other senders use profile fields + optional uploaded headshot served via public API.
 */
export function resolveEmailSignature(input: {
  workEmail: string;
  displayName?: string | null;
  title?: string | null;
  companyName?: string | null;
  /** Profile id used for /api/public/sender-headshots/[id] when a headshot is stored. */
  profileId?: string | null;
  headshotStoragePath?: string | null;
}): EmailSignatureFields {
  const workEmail = input.workEmail.trim().toLowerCase();

  if (isLucasSenderEmail(workEmail)) {
    // Hardcoded visual identity for Lucas; profile title may override position only.
    return {
      displayName: LUCAS_SIGNATURE_DEFAULTS.displayName,
      title: (input.title?.trim() || LUCAS_SIGNATURE_DEFAULTS.title),
      companyName: LUCAS_SIGNATURE_DEFAULTS.companyName,
      headshotUrl: absolutePublicUrl(LUCAS_SIGNATURE_DEFAULTS.headshotPublicPath),
    };
  }

  const headshotUrl = input.profileId && input.headshotStoragePath
    ? absolutePublicUrl(`/api/public/sender-headshots/${input.profileId}`)
    : null;

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

/** Remove a trailing plain-text signature that mirrors name/title/company so HTML can own it. */
export function stripTrailingTextSignature(
  bodyText: string,
  signature: Pick<EmailSignatureFields, 'displayName' | 'title' | 'companyName'>,
): string {
  let text = bodyText.replace(/\r\n/g, '\n').replace(/\s+$/u, '');
  const candidates = [signature.companyName, signature.title, signature.displayName]
    .map((part) => part.trim())
    .filter(Boolean);

  for (const part of candidates) {
    const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:\\n+|\\s+)${escaped}\\s*$`, 'iu');
    if (re.test(text)) text = text.replace(re, '').replace(/\s+$/u, '');
  }
  return text;
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

export function buildOutreachEmailHtml(bodyText: string, signature: EmailSignatureFields): string {
  const cleaned = stripTrailingTextSignature(bodyText, signature);
  const bodyHtml = plainTextBodyToHtml(cleaned);
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
