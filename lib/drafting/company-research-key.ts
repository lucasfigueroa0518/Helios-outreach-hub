const GENERIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'icloud.com',
  'live.com',
  'outlook.com',
  'proton.me',
  'protonmail.com',
  'yahoo.com',
]);

export function resolveCompanyResearchKey(email: string | null): string | null {
  const normalized = email?.trim().toLocaleLowerCase('en-US') ?? '';
  const at = normalized.lastIndexOf('@');
  if (at <= 0 || at === normalized.length - 1) return null;
  const domain = normalized.slice(at + 1).replace(/\.$/, '');
  if (
    !domain.includes('.')
    || /\s/.test(domain)
    || GENERIC_EMAIL_DOMAINS.has(domain)
  ) return null;
  return domain;
}
