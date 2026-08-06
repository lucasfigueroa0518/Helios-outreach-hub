export const EMAIL_SOURCE_NOTE_MAX_WORDS = 15;

export type ConfidenceTier = 'high' | 'medium' | 'low';
export type InferenceMethod = 'local' | 'web' | 'guessed';

function words(value: string) {
  return value.trim().split(/\s+/).filter(Boolean);
}

export function truncateSourceNote(value: string, maxWords = EMAIL_SOURCE_NOTE_MAX_WORDS) {
  return words(value).slice(0, maxWords).join(' ');
}

/**
 * Appends a clause to a note without exceeding the word budget. The clause
 * (newer, more important information — e.g. a collision or MX warning) is
 * always shown in full; the base note is trimmed to make room for it rather
 * than being cut off mid-sentence.
 */
export function appendClauseWithBudget(base: string, clause: string, maxWords = EMAIL_SOURCE_NOTE_MAX_WORDS) {
  const clauseWords = words(clause);
  if (clauseWords.length >= maxWords) return truncateSourceNote(clause, maxWords);
  const room = maxWords - clauseWords.length;
  const baseWords = words(base).slice(0, room);
  return [...baseWords, ...clauseWords].join(' ');
}

export function confidenceTierFromCandidateCount(maxCandidates: number): ConfidenceTier {
  if (maxCandidates <= 1) return 'high';
  if (maxCandidates === 2) return 'medium';
  return 'low';
}

const verbByTier: Record<ConfidenceTier, string> = {
  high: 'Best guess',
  medium: 'Guess',
  low: 'Rough guess',
};

function inferredPhrase(method: InferenceMethod, tier: ConfidenceTier) {
  if (method === 'guessed') return 'no email format evidence was found';
  const source = method === 'local' ? 'prior Helios leads' : 'public research';
  if (tier === 'high') return `matches the company's usual format, per ${source}`;
  if (tier === 'medium') return `the company uses more than one format, per ${source}`;
  return `format evidence was weak, per ${source}`;
}

/**
 * Plain-English, ≤15-word note for a guessed (pattern-based) email. Written
 * for a first-time, non-technical reader: no pattern codes (`first.last`),
 * no raw percentages — just what happened and how sure we are.
 */
export function buildInferredSourceNote(opts: {
  method: InferenceMethod;
  domain: string;
  confidenceTier: ConfidenceTier;
}) {
  const { method, domain, confidenceTier } = opts;
  const verb = verbByTier[confidenceTier];
  const phrase = inferredPhrase(method, confidenceTier);
  return truncateSourceNote(`${verb} for ${domain}, ${phrase}`);
}

/**
 * Plain-English note for an email found verbatim (not guessed) on a
 * company's own website or a public page.
 */
export function buildDirectWebLiteralNote(email: string, sourceUrl?: string) {
  const domain = email.split('@')[1]?.toLowerCase() || 'the company site';
  if (!sourceUrl) return truncateSourceNote(`Confirmed real email, found directly on ${domain}`);
  try {
    const url = new URL(sourceUrl);
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    return truncateSourceNote(`Confirmed real email, published on ${domain}${path}`);
  } catch {
    return truncateSourceNote(`Confirmed real email, found directly on ${domain}`);
  }
}

export function buildProvisionalDirectNote(email: string, sourceUrl?: string) {
  const domain = email.split('@')[1]?.toLowerCase() || 'the company site';
  if (!sourceUrl) return truncateSourceNote(`Found in cited research; source re-check blocked; mailbox verification pending`);
  try {
    const host = new URL(sourceUrl).hostname.replace(/^www\./, '');
    return truncateSourceNote(`Found in cited research on ${host}; re-check blocked; mailbox verification pending`);
  } catch {
    return truncateSourceNote(`Found in cited research for ${domain}; re-check blocked; verification pending`);
  }
}

export function appendCollisionToSourceNote(note: string, otherNames: string[]) {
  if (!otherNames.length) return note;
  const clause = `also guessed for ${otherNames.join(' and ')}`;
  return appendClauseWithBudget(note, clause);
}

export function appendMxWarningToSourceNote(note: string | null) {
  const base = (note ?? '').trim();
  const clause = "this domain can't receive email";
  if (!base) return truncateSourceNote(clause);
  if (/can.t receive email/i.test(base)) return truncateSourceNote(base);
  return appendClauseWithBudget(base, clause);
}
