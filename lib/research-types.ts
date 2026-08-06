import { createHash } from 'node:crypto';
import type { EmailPattern } from '@/lib/email-patterns';

export type ResearchPerson = {
  lead_id: string;
  full_name: string;
  first_name: string;
  last_name: string;
  title: string | null;
  location: string | null;
  linkedin_url?: string | null;
  email?: string | null;
  email_status?: string | null;
  /** Hard profile fields that drive budget, cache gating, and rescue. */
  requested_fields?: ProfileField[];
  /** Soft fields (location) to fill if easy — never chase with dedicated budget/rescue. */
  opportunistic_fields?: ProfileField[];
};

export type ProfileField = 'company_name' | 'title' | 'location';

export type ResearchDisambiguation = {
  normalized_name: string;
  company_name: string;
  research_scope: 'company' | 'person';
  research_pass?: 'primary' | 'profile_rescue' | 'email_rescue';
  context_hash: string;
  context_text: string;
  candidate_domain?: string | null;
  local_patterns?: EmailPattern[];
  direct_search?: {
    pages_attempted: number;
    pages_fetched: number;
    checked_paths: string[];
    unresolved_people: string[];
    page_outcomes?: Array<{
      url: string;
      path: string;
      outcome: string;
      error?: string;
    }>;
    failed_high_value_paths?: string[];
  };
  profile_rescue_context?: {
    parent_job_id: string;
    domain: string | null;
    domain_evidence: string;
    alternate_domain: string | null;
    company_notes: string | null;
    prior_findings: ProfileFinding[];
  };
  email_rescue_context?: {
    parent_job_id: string;
    domain: string | null;
    domain_evidence: string;
    company_notes: string | null;
    prior_literal_emails: ResearchReport['literal_emails'];
    prior_formats: ResearchFormat[];
    checked_paths: string[];
    search_budget: number;
    searches_used: number;
    attempted_query_families: string[];
    deferred_queries: ResearchSearchPlanItem[];
    rejected_direct_literals: Array<ResearchReport['literal_emails'][number] & {
      reason: string;
    }>;
    failed_high_value_paths: string[];
    scraper_outcomes: Array<{
      url: string;
      path: string;
      outcome: string;
      error?: string;
    }>;
    tranche?: number;
  };
  people: ResearchPerson[];
};

export type ResearchQueryFamily =
  | 'target_literal'
  | 'first_party_document'
  | 'company_people_page'
  | 'format_rocketreach'
  | 'format_zoominfo'
  | 'generic_format';

export type ResearchSearchPlanItem = {
  person_name: string | null;
  family: ResearchQueryFamily;
  query: string;
};

export type ResearchFormat = {
  pattern: EmailPattern | 'other';
  share_pct: number | null;
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
  source_url?: string | null;
};

export type CompanyEmailSample = {
  person_name: string;
  email: string;
  source_url: string;
  source_quote?: string;
};

export type EmailDomainEvidence = {
  domain: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
};

export type ProfileEvidenceSource =
  | 'first_party'
  | 'professional_profile'
  | 'press_release'
  | 'conference_bio'
  | 'regulatory_filing'
  | 'reputable_news'
  | 'other';

export type ProfileEvidence = {
  url: string;
  source_type: ProfileEvidenceSource;
  quote: string;
  value: string;
  person_specific: boolean;
  location_scope?: 'person_work_location' | 'company_location' | 'unknown';
};

export type ProfileFinding = {
  person_name: string;
  field: ProfileField;
  value: string;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  location_scope?: 'person_work_location' | 'company_location' | 'unknown';
  evidence: ProfileEvidence[];
};

export type ResearchReport = {
  domain: string | null;
  domain_confidence: 'confirmed' | 'likely' | 'ambiguous' | 'none';
  domain_evidence: string;
  alternate_domain: string | null;
  literal_emails: Array<{
    person_name: string;
    email: string;
    source_url: string;
    source_quote?: string;
  }>;
  company_email_samples?: CompanyEmailSample[];
  email_domains?: EmailDomainEvidence[];
  formats: ResearchFormat[];
  profile_findings: ProfileFinding[];
  company_notes: string | null;
  research_searches_used?: number;
  research_budget_assigned?: number;
  research_budget_exhausted?: boolean;
  attempted_query_families?: string[];
  deferred_queries?: ResearchSearchPlanItem[];
  rejected_direct_literals?: Array<{
    person_name: string;
    email: string;
    source_url: string;
    source_quote?: string;
    reason: string;
  }>;
  promising_paths?: string[];
};

const freeDomains = new Set([
  'gmail.com', 'outlook.com', 'yahoo.com', 'hotmail.com', 'icloud.com',
  'aol.com', 'proton.me', 'live.com', 'msn.com', 'comcast.net',
]);

const blockedHosts = new Set([
  'linkedin.com', 'x.com', 'twitter.com', 'facebook.com', 'instagram.com',
  'crunchbase.com', 'angel.co', 'zoominfo.com', 'rocketreach.co',
]);

export function normalizeCompanyName(value: string) {
  return value.normalize('NFKC').toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|co|company|plc|lp|llp)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizePersonName(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function buildDisambiguation(companyName: string | null, people: ResearchPerson[]): ResearchDisambiguation {
  const stablePeople = [...people].sort((a, b) => a.full_name.localeCompare(b.full_name))
    .map((person) => {
      const hard = [...new Set((person.requested_fields ?? []).filter((f) => f === 'company_name' || f === 'title'))].sort();
      const softFromRequested = (person.requested_fields ?? []).filter((f) => f === 'location');
      const softFromOpportunistic = person.opportunistic_fields ?? [];
      const opportunistic = [...new Set([...softFromRequested, ...softFromOpportunistic])].sort();
      return {
        ...person,
        full_name: person.full_name.trim(),
        title: person.title?.trim() || null,
        location: person.location?.trim() || null,
        email: person.email?.trim().toLowerCase() || null,
        linkedin_url: person.linkedin_url?.trim() || null,
        requested_fields: hard,
        opportunistic_fields: opportunistic,
      };
    });
  const context = stablePeople.map((person) =>
    [
      normalizePersonName(person.full_name),
      person.title?.toLowerCase() ?? '',
      person.location?.toLowerCase() ?? '',
      person.email ?? '',
      person.linkedin_url ?? '',
      person.requested_fields.join(','),
      (person.opportunistic_fields ?? []).join(','),
    ].join('|'),
  ).join('\n');
  const contextHash = createHash('sha256').update(context).digest('hex');
  const normalizedName = companyName
    ? normalizeCompanyName(companyName)
    : `person:${normalizePersonName(stablePeople[0]?.full_name ?? '')}:${stablePeople[0]?.lead_id ?? contextHash.slice(0, 8)}`;
  return {
    normalized_name: normalizedName,
    company_name: companyName?.trim() ?? '',
    research_scope: companyName ? 'company' : 'person',
    context_hash: contextHash,
    context_text: context,
    people: stablePeople,
  };
}

function normalizeFindingValue(field: ProfileField, value: string) {
  if (field === 'company_name') return normalizeCompanyName(value);
  let normalized = value.normalize('NFKC').toLowerCase();
  if (field === 'title') {
    normalized = normalized
      .replace(/\bfp\s*(?:&|and)\s*a\b|\bfpa\b/g, 'financial planning analysis')
      .replace(/\b(of|and|at|the)\b/g, ' ');
  } else {
    normalized = normalized
      .replace(/\b(united states of america|united states|usa|us|florida|fl)\b/g, ' ')
      .replace(/\barea\b/g, ' ');
  }
  return normalized.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function valuesAgree(field: ProfileField, left: string, right: string) {
  if (field === 'company_name') {
    const leftBase = normalizeCompanyName(left.replace(/\([^)]*\)/g, ' '));
    const rightBase = normalizeCompanyName(right.replace(/\([^)]*\)/g, ' '));
    if (leftBase && leftBase === rightBase) return true;
  }
  const leftTokens = new Set(normalizeFindingValue(field, left).split(' ').filter(Boolean));
  const rightTokens = new Set(normalizeFindingValue(field, right).split(' ').filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return false;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  if (intersection === leftTokens.size && intersection === rightTokens.size) return true;
  const smaller = Math.min(leftTokens.size, rightTokens.size);
  const larger = Math.max(leftTokens.size, rightTokens.size);
  return intersection === smaller && smaller / larger >= 0.6;
}

function quoteSupportsValue(field: ProfileField, value: string, quote: string) {
  const valueTokens = new Set(normalizeFindingValue(field, value).split(' ').filter(Boolean));
  const quoteTokens = new Set(normalizeFindingValue(field, quote).split(' ').filter(Boolean));
  if (!valueTokens.size) return false;
  const covered = [...valueTokens].filter((token) => quoteTokens.has(token)).length;
  return covered / valueTokens.size >= 0.6;
}

function sourceFamily(hostname: string) {
  const parts = hostname.toLowerCase().replace(/^www\./, '').split('.');
  const compoundSuffix = parts.length >= 3
    && ['co.uk', 'com.au', 'co.nz', 'co.jp'].includes(parts.slice(-2).join('.'));
  return parts.slice(compoundSuffix ? -3 : -2).join('.');
}

/**
 * Final write gate for person profile data. Model confidence alone is not enough:
 * Independent person-specific sources are preferred. One authoritative source
 * may pass when at least two supplied identity attributes corroborate the same
 * person. Location evidence must explicitly describe where this person works —
 * company/HQ/billing locations are rejected.
 */
export function isHighConfidenceProfileFinding(
  finding: ProfileFinding,
  person: ResearchPerson,
) {
  const allowedFields = new Set<ProfileField>([
    ...(person.requested_fields ?? []),
    ...(person.opportunistic_fields ?? []),
  ]);
  if (!allowedFields.has(finding.field)) return false;
  if (normalizePersonName(finding.person_name) !== normalizePersonName(person.full_name)) return false;
  if (!['high', 'medium'].includes(finding.confidence)
    || !finding.value.trim()
    || finding.value.trim().length > 200) return false;
  if (!finding.evidence.length) return false;
  if (finding.field === 'location' && finding.location_scope !== 'person_work_location') return false;

  const expectedValue = normalizeFindingValue(finding.field, finding.value);
  if (!expectedValue) return false;
  const personTokens = normalizePersonName(person.full_name).split(' ').filter(Boolean);
  const personFirstToken = personTokens[0] ?? '';
  const personLastToken = personTokens.at(-1) ?? '';
  const hosts = new Set<string>();
  let hasAuthoritativeSource = false;
  for (const evidence of finding.evidence) {
    if (!evidence.person_specific) continue;
    if (!valuesAgree(finding.field, finding.value, evidence.value)) continue;
    if (finding.field === 'location' && evidence.location_scope !== 'person_work_location') continue;
    if (!evidence.quote.trim() || !quoteSupportsValue(finding.field, evidence.value, evidence.quote)) continue;
    const normalizedQuote = normalizePersonName(evidence.quote);
    let url: URL;
    try {
      url = new URL(evidence.url);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
    } catch {
      continue;
    }
    const normalizedPath = normalizePersonName(url.pathname);
    const identifiesPerson = normalizedQuote.includes(personLastToken)
      || (normalizedPath.includes(personFirstToken) && normalizedPath.includes(personLastToken));
    if (!identifiesPerson) continue;
    hosts.add(sourceFamily(url.hostname));
    if (['first_party', 'professional_profile'].includes(evidence.source_type)) {
      hasAuthoritativeSource = true;
    }
  }
  if (!hasAuthoritativeSource) return false;
  if (hosts.size >= 2) return true;
  const suppliedContextSignals = [person.title, person.location, person.email]
    .filter((value) => typeof value === 'string' && value.trim()).length;
  return hosts.size === 1 && suppliedContextSignals >= 2;
}

/**
 * A rescue pass may corroborate a first-pass candidate, but it cannot rewrite
 * that candidate or manufacture agreement. Only evidence supporting the same
 * person, field, and normalized value is carried forward into the write gate.
 */
export function mergeProfileRescueFindings(
  findings: ProfileFinding[],
  priorFindings: ProfileFinding[],
) {
  return findings.map((finding) => {
    const matchingPrior = priorFindings.filter((prior) =>
      normalizePersonName(prior.person_name) === normalizePersonName(finding.person_name)
      && prior.field === finding.field
      && valuesAgree(finding.field, prior.value, finding.value),
    );
    const evidence = [...finding.evidence, ...matchingPrior.flatMap((prior) => prior.evidence)];
    const seen = new Set<string>();
    return {
      ...finding,
      evidence: evidence.filter((item) => {
        const key = `${item.url.trim().toLowerCase()}|${item.quote.trim()}|${item.value.trim().toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    };
  });
}

/**
 * Any cited, real-pattern web format finding can produce an Inferred email —
 * a single weak citation is still strictly better evidence than the
 * zero-evidence blind default guess (`format_guess`). The model is
 * instructed to never fabricate a format without a URL it can cite (see
 * research-provider.ts SYSTEM_PROMPT), so "one low-confidence citation" and
 * "nothing at all" are not the same thing and shouldn't produce the same
 * output. `pattern === 'other'` and uncited claims are still excluded —
 * those genuinely carry no usable signal.
 *
 * Independent corroboration (2+ distinct sources) or a strong majority share
 * remains meaningful — it's exactly how you'd separate a well-established
 * format from a barely-supported one — but it now only affects *how many*
 * candidate addresses get generated downstream (email-patterns.ts), not
 * whether the evidence counts at all.
 */
export function evidenceBackedFormats(formats: ResearchFormat[]) {
  return formats.filter((format) =>
    format.pattern !== 'other'
    && ['high', 'medium', 'low'].includes(format.confidence)
    && (
      Boolean(format.source_url && /^https?:\/\//i.test(format.source_url))
      || /https?:\/\/[^\s)"']+/i.test(format.evidence)
    ));
}

export function researchJobKey(disambiguation: ResearchDisambiguation) {
  if (disambiguation.research_pass === 'profile_rescue') {
    const parentJobId = disambiguation.profile_rescue_context?.parent_job_id ?? 'unknown';
    return `profile-rescue:${disambiguation.normalized_name}:${disambiguation.context_hash.slice(0, 16)}:${parentJobId}`;
  }
  if (disambiguation.research_pass === 'email_rescue') {
    const parentJobId = disambiguation.email_rescue_context?.parent_job_id ?? 'unknown';
    return `email-rescue:${disambiguation.normalized_name}:${disambiguation.context_hash.slice(0, 16)}:${parentJobId}`;
  }
  return `${disambiguation.normalized_name}:${disambiguation.context_hash.slice(0, 16)}`;
}

export function rescueFrontierAdvanced(
  context: ResearchDisambiguation['email_rescue_context'],
  report: ResearchReport,
) {
  if (!context) return true;
  const previousSignals = new Set([
    ...context.deferred_queries.map((item) => `query:${item.query}`),
    ...context.failed_high_value_paths.map((item) => `path:${item}`),
    ...context.prior_formats.map((item) =>
      `format:${item.pattern}:${item.source_url ?? item.evidence}`),
    ...context.prior_literal_emails.map((item) => `literal:${item.email}`),
  ]);
  const currentSignals = [
    ...(report.deferred_queries ?? []).map((item) => `query:${item.query}`),
    ...(report.promising_paths ?? []).map((item) => `path:${item}`),
    ...report.formats.map((item) => `format:${item.pattern}:${item.source_url ?? item.evidence}`),
    ...report.literal_emails.map((item) => `literal:${item.email}`),
  ];
  return currentSignals.some((signal) => !previousSignals.has(signal));
}

export function sanitizeDomain(value: string | null | undefined) {
  if (!value) return null;
  const domain = value.trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').replace(/\.$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
  if (freeDomains.has(domain) || blockedHosts.has(domain)) return null;
  return domain;
}

export function gradeReport(report: ResearchReport): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (report.literal_emails.length > 0) return 'A';
  const counts = new Map<string, number>();
  for (const format of report.formats) {
    counts.set(format.pattern, (counts.get(format.pattern) ?? 0) + 1);
  }
  if (report.formats.some((format) => (format.share_pct ?? 0) >= 70)
    || [...counts.values()].some((count) => count >= 2)) return 'B';
  if (report.formats.length > 0) return 'C';
  if (sanitizeDomain(report.domain)) return 'D';
  return 'F';
}
