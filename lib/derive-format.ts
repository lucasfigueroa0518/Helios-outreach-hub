import { dbQuery } from '@/lib/db';
import { applyPattern, type EmailPattern } from '@/lib/email-patterns';

const freeDomains = new Set(['gmail.com', 'outlook.com', 'yahoo.com', 'hotmail.com', 'icloud.com', 'aol.com', 'proton.me', 'live.com', 'msn.com', 'comcast.net']);
const patterns: EmailPattern[] = ['first.last', 'flast', 'first', 'firstlast', 'first_last', 'firstl', 'f.last', 'last.first', 'lastf'];

export function deriveFormatFromSamples(
  rows: Array<{ first_name: string; last_name: string; email: string }>,
) {
  if (rows.length < 2) return null;
  const counts = new Map<EmailPattern, number>();
  for (const row of rows) {
    const local = row.email.split('@')[0].toLowerCase();
    const match = patterns.find((pattern) => applyPattern(pattern, row.first_name, row.last_name) === local);
    if (match) counts.set(match, (counts.get(match) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const matchedSamples = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (!ranked.length || matchedSamples < 2) return null;
  const share = ranked[0][1] / matchedSamples;
  const confidence = matchedSamples === 2
    ? (share === 1 ? 'medium' : 'low')
    : share >= 0.8 ? 'high' : share >= 0.55 ? 'medium' : 'low';
  return {
    patterns: ranked.slice(0, confidence === 'low' ? 2 : 1).map(([pattern]) => pattern),
    confidence,
    sample_count: matchedSamples,
  };
}

/** Derive email format from Helios leads only (no Salesforce contacts dump). */
export async function deriveFormatForDomain(domain: string) {
  if (freeDomains.has(domain.toLowerCase())) return null;
  const { rows } = await dbQuery<{ first_name: string; last_name: string; email: string }>(
    `SELECT first_name, last_name, email_primary AS email FROM outreach.leads
     WHERE lower(split_part(email_primary, '@', 2)) = lower($1)
       AND email_primary IS NOT NULL
       AND email_status IN ('direct', 'from_embark_db')`,
    [domain],
  );
  const result = deriveFormatFromSamples(rows);
  if (!result) return null;
  await dbQuery(
    `INSERT INTO outreach.companies (domain, email_formats, source)
     VALUES (lower($1), $2::jsonb, 'lead_samples')
     ON CONFLICT (domain) DO UPDATE SET
       email_formats = CASE
         WHEN outreach.companies.source = 'lead_samples' THEN outreach.companies.email_formats
         ELSE EXCLUDED.email_formats
       END,
       source = 'lead_samples'`,
    [domain, JSON.stringify(result.patterns.map((pattern) => ({
      pattern,
      confidence: result.confidence,
    })))],
  );
  return result;
}
