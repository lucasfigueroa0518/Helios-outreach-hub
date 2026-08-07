/**
 * Login allowlist + display-name helpers (no Auth.js import — safe for auth.ts).
 *
 * Controlled by `ALLOWED_EMAIL_DOMAINS`:
 * - unset or `*` → any syntactically valid email (blocked in production by auth.ts)
 * - comma-separated domains (e.g. `heliosgroup.ai,heliosmarketing.org`) → only those
 */

/** Strip accidental quotes/whitespace from Vercel env values. */
export function parseAllowedEmailDomains(
  allowlist: string | undefined = process.env.ALLOWED_EMAIL_DOMAINS,
): string[] | '*' | null {
  const raw = allowlist?.trim();
  if (!raw) return null;
  const unquoted = raw.replace(/^['"]+|['"]+$/g, '').trim();
  if (!unquoted || unquoted === '*') return '*';
  return unquoted
    .split(',')
    .map((d) => d.trim().replace(/^['"]+|['"]+$/g, '').toLowerCase())
    .filter(Boolean);
}

export function isAllowedLoginEmail(email: string): boolean {
  const trimmed = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return false;

  const allowed = parseAllowedEmailDomains();
  if (allowed === null || allowed === '*') return true;

  const domain = trimmed.split('@')[1]?.toLowerCase();
  return Boolean(domain && allowed.includes(domain));
}

/** True when production must not run with an open allowlist. */
export function isOpenAllowlistForbidden(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  allowlist: string | undefined = process.env.ALLOWED_EMAIL_DOMAINS,
): boolean {
  if (nodeEnv !== 'production') return false;
  const allowed = parseAllowedEmailDomains(allowlist);
  return allowed === null || allowed === '*';
}

/** @deprecated Use isAllowedLoginEmail */
export function isEmbarkEmail(email: string): boolean {
  return isAllowedLoginEmail(email);
}

/** User-facing denial copy — never names allowed domains (keeps allowlist private). */
export function loginEmailPolicyMessage(): string {
  if (isOpenAllowlistForbidden()) {
    return 'Sign-in is temporarily unavailable. Please try again later.';
  }
  return "This account isn't authorized to sign in.";
}

export function displayNameFromEmail(email: string): string {
  const local = email.trim().split('@')[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}
