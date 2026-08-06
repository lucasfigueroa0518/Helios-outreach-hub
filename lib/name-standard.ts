const credentialPattern = /\b(CPA|CFA|CA|MBA|PHD|JD|CMA|CIA|EA|MD|ESQ)\.?\b/gi;

export function normalizeName(fullName: string) {
  const cleaned = fullName.normalize('NFC').replace(/\s+/g, ' ').trim();
  const credentials = [...cleaned.matchAll(credentialPattern)].map((match) => match[1].toUpperCase());
  const withoutCredentials = cleaned
    .replace(credentialPattern, '')
    .replace(/[,\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = withoutCredentials.split(' ').filter(Boolean);
  const firstName = parts.shift() ?? '';
  const lastName = parts.join(' ');
  return {
    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(' '),
    credentials: credentials.length ? [...new Set(credentials)].join(', ') : null,
  };
}

export function canonicalCompany(value: string | undefined) {
  return (value ?? '')
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(incorporated|inc|llc|ltd|limited|lp|llp|corp|corporation|co|company)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
