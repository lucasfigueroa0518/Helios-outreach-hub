const supported = ['first.last', 'flast', 'first', 'firstlast', 'first_last', 'firstl', 'f.last', 'last.first', 'lastf'] as const;
export type EmailPattern = typeof supported[number];

export type FormatMeta = {
  pattern: EmailPattern | 'other';
  confidence?: 'high' | 'medium' | 'low';
  share_pct?: number | null;
  evidence?: string;
  verified_sample?: boolean;
};

const defaultPatterns: EmailPattern[] = ['first.last', 'flast', 'first'];

function confidenceScore(confidence?: FormatMeta['confidence']) {
  if (confidence === 'high') return 3;
  if (confidence === 'medium') return 2;
  if (confidence === 'low') return 1;
  return 0;
}

function sourceFamily(hostname: string) {
  const parts = hostname.toLowerCase().replace(/^www\./, '').split('.');
  const compoundSuffix = parts.length >= 3
    && ['co.uk', 'com.au', 'co.nz', 'co.jp'].includes(parts.slice(-2).join('.'));
  return parts.slice(compoundSuffix ? -3 : -2).join('.');
}

function sourceFamiliesFromEvidence(evidence?: string) {
  const families = new Set<string>();
  for (const match of evidence?.match(/https?:\/\/[^\s)"']+/gi) ?? []) {
    try {
      families.add(sourceFamily(new URL(match).hostname));
    } catch {
      continue;
    }
  }
  return families;
}

function isFirstPartyEvidence(evidence: string | undefined, domain: string | undefined) {
  if (!evidence || !domain) return false;
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '');
  for (const match of evidence.match(/https?:\/\/[^\s)"']+/gi) ?? []) {
    try {
      const hostname = new URL(match).hostname.toLowerCase().replace(/^www\./, '');
      if (hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function formatRankScore(format: FormatMeta, domain?: string) {
  let score = 0;
  if (format.verified_sample) score += 1_000_000;
  if (isFirstPartyEvidence(format.evidence, domain)) score += 10_000;
  score += (format.share_pct ?? 0) * 100;
  score += confidenceScore(format.confidence) * 500;
  score += sourceFamiliesFromEvidence(format.evidence).size * 100;
  return score;
}

/** Rank patterns so column 1 = most likely, column 2 = next, column 3 = least. */
export function rankFormatsForInference(formats: FormatMeta[], domain?: string): FormatMeta[] {
  const indexed = formats
    .map((format, index) => ({ format, index }))
    .filter(({ format }) => format.pattern !== 'other');
  const byPattern = new Map<EmailPattern, { format: FormatMeta; index: number }>();
  for (const entry of indexed) {
    const pattern = entry.format.pattern as EmailPattern;
    const existing = byPattern.get(pattern);
    if (!existing || formatRankScore(entry.format, domain) > formatRankScore(existing.format, domain)) {
      byPattern.set(pattern, entry);
    }
  }
  return [...byPattern.values()]
    .sort((left, right) => {
      const delta = formatRankScore(right.format, domain) - formatRankScore(left.format, domain);
      if (delta !== 0) return delta;
      return left.index - right.index;
    })
    .map(({ format }) => format);
}

export function maxCandidatesForFormats(formats: FormatMeta[], hasKnownPatterns: boolean) {
  if (!hasKnownPatterns) return 3;
  const known = formats.filter((format) => format.pattern !== 'other');
  if (!known.length) return 3;

  const highConfidence = known.filter((format) => format.confidence === 'high');
  const top = known[0];
  const topShare = top.share_pct ?? 0;

  if (highConfidence.length === 1 && known.length === 1) return 1;
  if (highConfidence.length === 1 && topShare >= 70) return 1;
  if (known.length === 1 && top.confidence === 'medium' && topShare >= 70) return 1;

  if (known.length >= 2 || highConfidence.length >= 2) return 2;
  if (known.some((format) => format.confidence === 'low')) return 3;
  if (known.some((format) => format.confidence === 'medium')) return 2;
  return 2;
}

function part(value: string | null | undefined) {
  return (value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/['.\s-]/g, '').replace(/\b(jr|sr|ii|iii|iv)\b/g, '');
}

export function applyPattern(pattern: EmailPattern, firstName: string, lastName: string) {
  const first = part(firstName);
  const last = part(lastName);
  if (!first) return null;
  const local = {
    'first.last': last ? `${first}.${last}` : null,
    flast: last ? `${first[0]}${last}` : null,
    first,
    firstlast: `${first}${last}`,
    first_last: last ? `${first}_${last}` : null,
    firstl: last ? `${first}${last[0]}` : null,
    'f.last': last ? `${first[0]}.${last}` : null,
    'last.first': last ? `${last}.${first}` : null,
    lastf: last ? `${last}${first[0]}` : null,
  }[pattern];
  return local || null;
}

export function inferEmails(
  domain: string,
  firstName: string,
  lastName: string,
  patterns: EmailPattern[] = defaultPatterns,
  maxCandidates = 3,
) {
  const normalizedDomain = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(normalizedDomain)) return [];
  const limit = Math.max(1, Math.min(3, maxCandidates));
  const ordered = (patterns.length ? patterns : defaultPatterns) as readonly EmailPattern[];
  const candidates = ordered.map((pattern) => applyPattern(pattern, firstName, lastName))
    .filter((local): local is string => Boolean(local))
    .map((local) => `${local}@${normalizedDomain}`)
    .filter((email) => /^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email));
  return [...new Set(candidates)].slice(0, limit);
}
