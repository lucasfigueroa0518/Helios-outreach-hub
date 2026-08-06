import { sanitizeDomain } from '@/lib/research-types';

const emailDomainPattern = /@([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi;

export function extractEmailDomainsFromText(text: string) {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(emailDomainPattern)) {
    const domain = sanitizeDomain(match[1]);
    if (!domain) continue;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return counts;
}

export function resolveInferenceDomain(
  websiteDomain: string | null,
  evidenceTexts: string[],
) {
  const counts = new Map<string, number>();
  for (const text of evidenceTexts) {
    for (const [domain, weight] of extractEmailDomainsFromText(text)) {
      counts.set(domain, (counts.get(domain) ?? 0) + weight);
    }
  }
  if (!counts.size) return websiteDomain;

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const evidenceDomain = ranked[0][0];
  if (!websiteDomain) return evidenceDomain;
  if (evidenceDomain !== websiteDomain) return evidenceDomain;
  return websiteDomain;
}
