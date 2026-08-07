/**
 * Login allowlist + display-name helpers (no Auth.js import — safe for auth.ts).
 *
 * Controlled by `ALLOWED_EMAIL_DOMAINS`:
 * - unset or `*` → any syntactically valid email (blocked in production by auth.ts)
 * - comma-separated domains (e.g. `heliosgroup.ai`) → only those
 */

export function isAllowedLoginEmail(email: string): boolean {
  const trimmed = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return false;

  const raw = process.env.ALLOWED_EMAIL_DOMAINS?.trim();
  if (!raw || raw === '*') return true;

  const allowed = raw
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const domain = trimmed.split('@')[1]?.toLowerCase();
  return Boolean(domain && allowed.includes(domain));
}

/** True when production must not run with an open allowlist. */
export function isOpenAllowlistForbidden(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  allowlist: string | undefined = process.env.ALLOWED_EMAIL_DOMAINS,
): boolean {
  if (nodeEnv !== 'production') return false;
  const raw = allowlist?.trim();
  return !raw || raw === '*';
}

/** @deprecated Use isAllowedLoginEmail */
export function isEmbarkEmail(email: string): boolean {
  return isAllowedLoginEmail(email);
}

export function loginEmailPolicyMessage(): string {
  if (isOpenAllowlistForbidden()) {
    return 'Login is misconfigured: ALLOWED_EMAIL_DOMAINS must be set in production.';
  }
  const raw = process.env.ALLOWED_EMAIL_DOMAINS?.trim();
  if (!raw || raw === '*') return 'Enter a valid email address to continue.';
  const domains = raw
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  if (domains.length === 1) return `Only @${domains[0]} email addresses are allowed.`;
  return `Only these email domains are allowed: ${domains.map((d) => `@${d}`).join(', ')}.`;
}

export function displayNameFromEmail(email: string): string {
  const local = email.trim().split('@')[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}
