import { createHash } from 'node:crypto';
import { dbQuery, dbTransaction } from '@/lib/db';
import { deriveFormatForDomain } from '@/lib/derive-format';
import { resolveMxOverHttps } from '@/lib/dns-over-https';
import {
  appendCollisionToSourceNote,
  appendMxWarningToSourceNote,
  buildDirectWebLiteralNote,
  buildInferredSourceNote,
  buildProvisionalDirectNote,
  confidenceTierFromCandidateCount,
  type InferenceMethod,
} from '@/lib/email-source-note';
import {
  applyPattern,
  inferEmails,
  maxCandidatesForFormats,
  rankFormatsForInference,
  type EmailPattern,
  type FormatMeta,
} from '@/lib/email-patterns';
import { resolveInferenceDomain } from '@/lib/inference-domain';
import {
  ScrapeDirectEmailResult,
  scrapeDirectEmails,
  verifyDirectEmailSource,
  type DirectEmailMatch,
} from '@/lib/site-scraper';
import { snapshotRelationshipsForRun } from '@/lib/relationships';
import { resolveCompanyAccountId } from '@/lib/identity';
import {
  buildResearchQueryPlan,
  researchCompanyLive,
  researchCompanyWithSearxng,
  researchEmailRescueLive,
  researchProfileRescueLive,
} from '@/lib/research-provider';
import {
  buildDisambiguation,
  gradeReport,
  normalizeCompanyName,
  normalizePersonName,
  researchJobKey,
  sanitizeDomain,
  isHighConfidenceProfileFinding,
  evidenceBackedFormats,
  mergeProfileRescueFindings,
  rescueFrontierAdvanced,
  type ProfileField,
  type ResearchDisambiguation,
  type ResearchFormat,
  type ResearchPerson,
  type ResearchReport,
} from '@/lib/research-types';
import {
  searchBudgetForJob,
  shardPeopleForEmailResearch,
} from '@/lib/research-budget';
import {
  buildRequestedProfileFields,
  hardRequestedFields,
  peopleNeedHardProfileResearch,
  peopleStillNeedEmailResearch,
  softRequestedFields,
} from '@/lib/enrichment-fields';
import {
  buildEnrichmentJobInsight,
  emptyEnrichmentInsightCounters,
  logPipelineInsight,
  type EnrichmentJobInsight,
  type EnrichmentPathKind,
} from '@/lib/pipeline-telemetry';

function elapsedMsSafe(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

type LeadForEnrichment = ResearchPerson & {
  company_name: string | null;
  company_id: string | null;
  account_website: string | null;
  email: string | null;
  email_status: string | null;
};

type ResearchJob = {
  id: string;
  company_key: string;
  job_kind?: string;
  disambiguation: ResearchDisambiguation;
  attempt_count: number;
  requested_by_runs: string[];
  status?: string;
  research_result?: ResearchReport | null;
  search_budget: number;
  searches_used: number;
};

type CompanyFormat = {
  pattern: EmailPattern;
  confidence?: string;
  share_pct?: number | null;
  evidence?: string;
  source_url?: string | null;
};

const supportedEmailPatterns: EmailPattern[] = [
  'first.last', 'flast', 'first', 'firstlast', 'first_last',
  'firstl', 'f.last', 'last.first', 'lastf',
];

function patternFromNamedEmail(personName: string, email: string) {
  const tokens = normalizePersonName(personName).split(' ').filter(Boolean);
  const first = tokens[0] ?? '';
  const last = tokens.at(-1) ?? '';
  const local = email.toLowerCase().split('@')[0] ?? '';
  if (!first || !last || !local) return null;
  return supportedEmailPatterns.find((pattern) =>
    applyPattern(pattern, first, last) === local) ?? null;
}

function inferFormatMeta(
  formats: Array<{
    pattern: EmailPattern | 'other';
    confidence?: string;
    share_pct?: number | null;
    evidence?: string;
  }>,
): FormatMeta[] {
  return formats.flatMap((format) => {
    if (format.pattern === 'other') return [];
    const evidence = format.evidence?.trim();
    return [{
      pattern: format.pattern,
      confidence: format.confidence as FormatMeta['confidence'],
      share_pct: format.share_pct ?? null,
      ...(evidence ? { evidence } : {}),
      ...(evidence?.includes('verified named employee sample') ? { verified_sample: true } : {}),
    }];
  });
}

function evidenceBackedCompanyFormats(formats: CompanyFormat[]): ResearchFormat[] {
  // Formats only ever reach outreach.companies.email_formats after already
  // passing evidenceBackedFormats' cited/real-pattern check (see
  // lib/research-types.ts), so a cached 'low' entry here already earned its
  // keep — this is a shape check on read, not a second confidence gate.
  return formats.flatMap((format) => {
    if (!['high', 'medium', 'low'].includes(format.confidence ?? '')) return [];
    return [{
      pattern: format.pattern,
      confidence: format.confidence as ResearchFormat['confidence'],
      share_pct: format.share_pct ?? null,
      evidence: format.evidence ?? '',
      source_url: format.source_url ?? null,
    }];
  });
}

export class ResearchRetryError extends Error {
  constructor(message: string, readonly waitMs: number, options?: { cause?: unknown }) {
    super(message, options);
  }
}

async function runIsCancelled(runId: string) {
  const { rows } = await dbQuery<{ status: string }>(
    `SELECT status FROM outreach.runs WHERE id = $1`,
    [runId],
  );
  return !rows[0] || rows[0].status === 'cancelled';
}

async function appendEnrichmentStats(runId: string, values: Record<string, number>) {
  await dbQuery(
    `UPDATE outreach.runs
     SET stats = jsonb_set(
       stats,
       '{enrichment}',
       $2::jsonb || coalesce(stats->'enrichment', '{}'::jsonb),
       true
     )
     WHERE id = $1`,
    [runId, JSON.stringify(values)],
  );
}

async function incrementEnrichmentStat(runId: string, key: string, amount = 1) {
  await dbQuery(
    `UPDATE outreach.runs
     SET stats = stats || jsonb_build_object(
       'enrichment',
       coalesce(stats->'enrichment', '{}'::jsonb)
         || jsonb_build_object($2::text, coalesce((stats->'enrichment'->>$2)::int, 0) + $3::int)
     )
     WHERE id = $1`,
    [runId, key, amount],
  );
}

/** Nested counters under runs.stats.enrichment.insight for Campaign inefficiency analysis. */
async function incrementEnrichmentInsight(runId: string, key: string, amount = 1) {
  if (!amount) return;
  await dbQuery(
    `UPDATE outreach.runs
     SET stats = jsonb_set(
       jsonb_set(
         stats,
         '{enrichment,insight}',
         coalesce(stats->'enrichment'->'insight', '{}'::jsonb),
         true
       ),
       ARRAY['enrichment', 'insight', $2::text],
       to_jsonb(coalesce((stats->'enrichment'->'insight'->>$2)::int, 0) + $3::int),
       true
     )
     WHERE id = $1`,
    [runId, key, amount],
  );
}

async function persistResearchJobInsight(jobId: string, insight: EnrichmentJobInsight) {
  await dbQuery(
    `UPDATE outreach.company_research_jobs
     SET usage = coalesce(usage, '{}'::jsonb) || jsonb_build_object('insight', $2::jsonb),
         updated_at = now()
     WHERE id = $1`,
    [jobId, JSON.stringify(insight)],
  );
  logPipelineInsight('enrich', `job=${jobId} path=${insight.path ?? 'unknown'}`, {
    companyKey: insight.companyKey,
    budget: insight.budget,
    decisions: insight.decisions,
    hardGaps: insight.hardGaps,
    softGaps: insight.softGaps,
  });
}

function profileGapsForPeople(people: ResearchPerson[]) {
  const hardGaps = new Set<string>();
  const softGaps = new Set<string>();
  for (const person of people) {
    for (const field of hardRequestedFields(person.requested_fields)) hardGaps.add(field);
    for (const field of softRequestedFields(person.opportunistic_fields ?? person.requested_fields)) {
      softGaps.add(field);
    }
  }
  return { hardGaps: [...hardGaps], softGaps: [...softGaps] };
}

async function decrementRemaining(runId: string) {
  await dbQuery(
    `UPDATE outreach.runs
     SET stats = stats || jsonb_build_object(
       'enrichment',
       coalesce(stats->'enrichment', '{}'::jsonb)
         || jsonb_build_object(
           'companies_remaining',
           greatest(coalesce((stats->'enrichment'->>'companies_remaining')::int, 0) - 1, 0)
         )
     )
     WHERE id = $1`,
    [runId],
  );
}

async function companyFormats(domain: string) {
  const { rows } = await dbQuery<{
    email_formats: CompanyFormat[];
    source: string | null;
    researched_at: string | null;
    scrape_paths: string[];
  }>(
    `SELECT email_formats, source, researched_at, scrape_paths
     FROM outreach.companies WHERE domain = lower($1)`,
    [domain],
  );
  return rows[0] ?? null;
}

async function knownDomainForCompany(companyName: string) {
  const { rows } = await dbQuery<{ domain: string; samples: number }>(
    `SELECT lower(split_part(email_primary, '@', 2)) AS domain, count(*)::int AS samples
     FROM outreach.leads
     WHERE email_primary IS NOT NULL
       AND company_name IS NOT NULL
       AND email_status IN ('direct', 'from_embark_db')
       AND similarity(lower(company_name), lower($1)) >= 0.6
     GROUP BY lower(split_part(email_primary, '@', 2))
     HAVING count(*) >= 3
     ORDER BY count(*) DESC
     LIMIT 1`,
    [companyName],
  );
  return sanitizeDomain(rows[0]?.domain);
}

async function assignInferredEmails(
  people: ResearchPerson[],
  domain: string,
  patterns: EmailPattern[],
  options: {
    method: InferenceMethod;
    formatMeta?: FormatMeta[];
    companyId?: string | null;
    runIds: string[];
  },
) {
  const rawFormatMeta: FormatMeta[] = options.formatMeta
    ?? patterns.map((pattern): FormatMeta => ({ pattern }));
  const rankedMeta = options.method === 'guessed'
    ? rawFormatMeta
    : rankFormatsForInference(rawFormatMeta, domain);
  const rankedPatterns = rankedMeta.map((format) => format.pattern as EmailPattern);
  const maxCandidates = maxCandidatesForFormats(rankedMeta, rankedPatterns.length > 0);
  const confidenceTier = confidenceTierFromCandidateCount(maxCandidates);
  const sourceNote = buildInferredSourceNote({ method: options.method, domain, confidenceTier });
  const emailStatus = options.method === 'guessed' ? 'format_guess' : 'inferred';
  let companyId = options.companyId ?? null;
  if (!companyId) {
    const company = await dbQuery<{ id: string }>(
      `INSERT INTO outreach.companies (domain, email_formats, source)
       VALUES (lower($1), '[]'::jsonb, $2)
       ON CONFLICT (domain) DO UPDATE SET domain = EXCLUDED.domain
       RETURNING id`,
      [domain, options.method === 'local' ? 'lead_samples' : 'web_research'],
    );
    companyId = company.rows[0].id;
  }
  const candidatesByLead = new Map<string, string[]>();
  const ownersByCandidate = new Map<string, string[]>();
  for (const person of people) {
    const candidates = options.method === 'guessed'
      ? inferEmails(domain, person.first_name, person.last_name, undefined, 3)
      : inferEmails(domain, person.first_name, person.last_name, rankedPatterns, maxCandidates);
    candidatesByLead.set(person.lead_id, candidates);
    for (const candidate of candidates) {
      ownersByCandidate.set(candidate, [...(ownersByCandidate.get(candidate) ?? []), person.full_name]);
    }
  }
  let assigned = 0;
  for (const person of people) {
    const candidates = candidatesByLead.get(person.lead_id) ?? [];
    if (!candidates.length) continue;
    const collision = candidates.find((candidate) => (ownersByCandidate.get(candidate)?.length ?? 0) > 1);
    const note = collision
      ? appendCollisionToSourceNote(
        sourceNote,
        (ownersByCandidate.get(collision) ?? []).filter((name) => name !== person.full_name),
      )
      : sourceNote;
    const result = await dbQuery(
      `UPDATE outreach.leads
       SET email_primary = $2,
           email_alt_1 = $3,
           email_alt_2 = $4,
           email_status = $5,
           email_source_note = $6,
           outreach_company_id = $7,
           email_verification = CASE WHEN $5 IN ('inferred', 'format_guess') THEN 'pending' ELSE NULL END,
           updated_at = now()
       WHERE id = $1
         AND (
           email_primary IS NULL
           OR (
             email_status = 'format_guess'
             AND ($5 <> 'format_guess' OR email_primary IS DISTINCT FROM $2)
           )
         )
         AND EXISTS (
           SELECT 1 FROM outreach.campaign_leads cl
           JOIN outreach.runs r ON r.id = cl.run_id
           WHERE cl.lead_id = outreach.leads.id
             AND cl.run_id = ANY($8::uuid[])
             AND r.status <> 'cancelled'
         )`,
      [
        person.lead_id,
        candidates[0],
        candidates[1] ?? null,
        candidates[2] ?? null,
        emailStatus,
        note,
        companyId,
        options.runIds,
      ],
    );
    assigned += result.rowCount ?? 0;
    if (result.rowCount) {
      person.email = candidates[0];
      person.email_status = emailStatus;
      if (['inferred', 'format_guess'].includes(emailStatus) && options.runIds[0]) {
        const { scheduleLeadMailboxVerification } = await import('@/lib/mailbox-verify-schedule');
        void scheduleLeadMailboxVerification({
          leadId: person.lead_id,
          runId: options.runIds[0],
          emailStatus,
        }).catch((error) => console.error('Failed to schedule mailbox verification:', error));
      }
    }
  }
  return assigned;
}

function directSearchTargets(people: LeadForEnrichment[]) {
  return people.filter((person) =>
    !person.email || ['inferred', 'format_guess'].includes(person.email_status ?? ''));
}

/** Prior DB rows tagged `format_guess` must go through web research — never cache-infer over them. */
export function priorFormatGuessNeedsWebResearch(
  people: Array<{ email_status?: string | null }>,
) {
  return people.some((person) => person.email_status === 'format_guess');
}

function leadsEligibleForCachedInference(people: LeadForEnrichment[]) {
  return people.filter((person) => !person.email && person.email_status !== 'format_guess');
}

async function ensureCompanyCache(domain: string) {
  const { rows } = await dbQuery<{ id: string; scrape_paths: string[] }>(
    `INSERT INTO outreach.companies (domain)
     VALUES (lower($1))
     ON CONFLICT (domain) DO UPDATE SET domain = EXCLUDED.domain
     RETURNING id, scrape_paths`,
    [domain],
  );
  return rows[0];
}

async function applyDirectEmailMatches(
  people: LeadForEnrichment[],
  matches: ReadonlyMap<string, DirectEmailMatch>,
  companyId: string,
  extractionMethod = 'deterministic_site_scrape',
  runIds: string[] = [],
) {
  let assigned = 0;
  let upgradedInferred = 0;
  let upgradedFormatGuess = 0;
  const matchedLeadIds = new Set<string>();
  for (const person of people) {
    const match = matches.get(person.full_name);
    if (!match) continue;
    const evidence = JSON.stringify({
      source_url: match.source_url,
      source_quote: match.context,
      content_hash: match.content_hash,
      extraction_method: extractionMethod,
      verified_at: new Date().toISOString(),
      provisional: Boolean(match.provisional),
      refetch_outcome: match.refetch_outcome ?? null,
      refetch_attempted_at: match.refetch_attempted_at ?? null,
    });
    const result = await dbQuery<{ previous_status: string }>(
      `WITH previous AS (
         SELECT email_status AS previous_status
         FROM outreach.leads
         WHERE id = $1
           AND (email_primary IS NULL OR email_status IN ('inferred', 'format_guess'))
       ), updated AS (
         UPDATE outreach.leads
         SET email_primary = lower($2), email_alt_1 = NULL, email_alt_2 = NULL,
             email_status = 'direct', email_source_note = $3,
             direct_email_evidence = $4::jsonb,
             outreach_company_id = $5, email_verification = 'pending',
             updated_at = now()
         WHERE id = $1
           AND (email_primary IS NULL OR email_status IN ('inferred', 'format_guess'))
           AND EXISTS (
             SELECT 1 FROM outreach.campaign_leads cl
             JOIN outreach.runs r ON r.id = cl.run_id
             WHERE cl.lead_id = outreach.leads.id
               AND cl.run_id = ANY($6::uuid[])
               AND r.status <> 'cancelled'
           )
         RETURNING id
       )
       SELECT previous.previous_status
       FROM previous JOIN updated ON true`,
      [
        person.lead_id,
        match.email,
        match.provisional
          ? buildProvisionalDirectNote(match.email, match.source_url)
          : buildDirectWebLiteralNote(match.email, match.source_url),
        evidence,
        companyId,
        runIds,
      ],
    );
    if (!result.rowCount) continue;
    assigned++;
    if (result.rows[0]?.previous_status === 'inferred') upgradedInferred++;
    if (result.rows[0]?.previous_status === 'format_guess') upgradedFormatGuess++;
    matchedLeadIds.add(person.lead_id);
    person.email = match.email;
    person.email_status = 'direct';
    if (runIds[0]) {
      const { scheduleLeadMailboxVerification } = await import('@/lib/mailbox-verify-schedule');
      void scheduleLeadMailboxVerification({
        leadId: person.lead_id,
        runId: runIds[0],
        emailStatus: 'direct',
      }).catch((error) => console.error('Failed to schedule mailbox verification:', error));
    }
  }
  return {
    assigned,
    upgraded: upgradedInferred + upgradedFormatGuess,
    upgradedInferred,
    upgradedFormatGuess,
    matchedLeadIds,
  };
}

async function scrapeAndApplyDirectEmails(
  domain: string,
  people: LeadForEnrichment[],
  runIds: string[],
  statKey: 'd4_scrape_preflight' | 'd4_scrape_post',
  additionalEvidenceUrls: string[] = [],
  scraper: typeof scrapeDirectEmails = scrapeDirectEmails,
) {
  const targets = directSearchTargets(people);
  if (!targets.length) {
    return { assigned: 0, upgraded: 0, matchedLeadIds: new Set<string>(), diagnostics: null };
  }
  const company = await ensureCompanyCache(domain);
  let scraped: Awaited<ReturnType<typeof scrapeDirectEmails>>;
  try {
    scraped = await scraper(domain, targets, {
      preferredCachedPaths: company.scrape_paths ?? [],
      additionalEvidenceUrls,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unexpected scraper failure';
    scraped = new ScrapeDirectEmailResult({
      pagesAttempted: 0,
      pagesFetched: 0,
      pathsAttempted: [],
      pathsHit: [],
      errors: [{
        url: `https://${domain}/`,
        path: '/',
        error: message,
        outcome: 'error_unknown',
      }],
      deadlineExceeded: false,
      outcomes: { error_unknown: 1 },
      pageOutcomes: [],
      retries: 0,
      renderedPages: 0,
      ocrImages: 0,
      nicknameMatches: 0,
      localPartMatches: 0,
      throttled: 0,
    });
  }
  const applied = await applyDirectEmailMatches(
    targets,
    scraped.matches,
    company.id,
    'deterministic_site_scrape',
    runIds,
  );
  const winningPaths = [...new Set(
    [
      ...[...scraped.matches.values()].map((match) => {
        try {
          const url = new URL(match.source_url);
          return `${url.pathname}${url.search}`;
        } catch {
          return match.source_url;
        }
      }),
      ...scraped.diagnostics.pathsHit.filter((path) =>
        !['/', '/robots.txt', '/sitemap.xml'].includes(path)),
    ],
  )];
  await dbQuery(
    `UPDATE outreach.companies
     SET scrape_paths = (
           SELECT coalesce(jsonb_agg(path), '[]'::jsonb)
           FROM (
             SELECT DISTINCT path
             FROM jsonb_array_elements_text(
               coalesce(scrape_paths, '[]'::jsonb) || $2::jsonb
             ) AS path
             LIMIT 24
           ) paths
         ),
         scrape_checked_at = now()
     WHERE id = $1`,
    [company.id, JSON.stringify(winningPaths)],
  );
  for (const runId of runIds) {
    await incrementEnrichmentStat(runId, statKey, applied.assigned);
    await incrementEnrichmentStat(runId, 'd4', applied.assigned);
    await incrementEnrichmentStat(runId, 'direct', applied.assigned);
    if (applied.upgradedInferred) {
      await incrementEnrichmentStat(runId, 'inferred', -applied.upgradedInferred);
    }
    if (applied.upgradedFormatGuess) {
      await incrementEnrichmentStat(runId, 'format_guess', -applied.upgradedFormatGuess);
    }
    await incrementEnrichmentStat(runId, 'scrape_pages_attempted', scraped.diagnostics.pagesAttempted);
    await incrementEnrichmentStat(runId, 'scrape_pages_fetched', scraped.diagnostics.pagesFetched);
    await incrementEnrichmentStat(runId, 'scrape_errors', scraped.diagnostics.errors.length);
    await incrementEnrichmentStat(runId, 'scrape_retries', scraped.diagnostics.retries);
    await incrementEnrichmentStat(runId, 'scrape_rendered_pages', scraped.diagnostics.renderedPages);
    await incrementEnrichmentStat(runId, 'scrape_ocr_images', scraped.diagnostics.ocrImages);
    await incrementEnrichmentStat(runId, 'scrape_nickname_matches', scraped.diagnostics.nicknameMatches);
    await incrementEnrichmentStat(runId, 'scrape_local_part_matches', scraped.diagnostics.localPartMatches);
    for (const [outcome, count] of Object.entries(scraped.diagnostics.outcomes)) {
      if (count) await incrementEnrichmentStat(runId, `scrape_${outcome}`, count);
    }
  }
  return { ...applied, diagnostics: scraped.diagnostics };
}

function configuredResearchSearches(name: string, fallback: number, ceiling: number) {
  const parsed = Number(process.env[name] ?? fallback);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(ceiling, Math.floor(parsed)))
    : fallback;
}

async function setPendingResearchBudget(
  jobId: string,
  disambiguation: ResearchDisambiguation,
  pass: 'primary' | 'profile_rescue' | 'email_rescue' = 'primary',
) {
  const budget = searchBudgetForJob(disambiguation.people, pass);
  await dbQuery(
    `UPDATE outreach.company_research_jobs
     SET search_budget = $2, updated_at = now()
     WHERE id = $1 AND status = 'pending' AND searches_used = 0`,
    [jobId, budget],
  );
}

async function knownDomainOutcome(runId: string, people: LeadForEnrichment[], domain: string) {
  const direct = await scrapeAndApplyDirectEmails(
    domain,
    people,
    [runId],
    'd4_scrape_preflight',
  );
  const cached = await companyFormats(domain);
  const cachedFormats = cached?.source === 'lead_samples'
    ? (cached.email_formats ?? [])
    : evidenceBackedCompanyFormats(cached?.email_formats ?? []);
  let patterns: EmailPattern[] = cachedFormats.flatMap((format) =>
    format.pattern === 'other' ? [] : [format.pattern]);
  let formatMeta: FormatMeta[] = inferFormatMeta(cachedFormats);
  let method: InferenceMethod = cached?.source === 'lead_samples' ? 'local' : patterns.length ? 'web' : 'guessed';
  if (!patterns.length) {
    const derived = await deriveFormatForDomain(domain);
    if (derived) {
      patterns = derived.patterns;
      formatMeta = derived.patterns.map((pattern) => ({
        pattern,
        confidence: derived.confidence as FormatMeta['confidence'],
      }));
      method = 'local';
    }
  }
  const unresolved = leadsEligibleForCachedInference(people);
  if (!patterns.length) {
    return {
      direct: direct.assigned,
      inferred: 0,
      domain,
      needsResearch: unresolved.length > 0 || priorFormatGuessNeedsWebResearch(people),
      preflight: direct,
    };
  }
  const inferred = await assignInferredEmails(
    unresolved,
    domain,
    patterns,
    { method, formatMeta, runIds: [runId] },
  );
  await incrementEnrichmentStat(runId, patterns.length ? (method === 'local' ? 'i1' : 'i2') : 'i3', inferred);
  await incrementEnrichmentStat(runId, 'inferred', inferred);
  // Re-check AFTER assignment — a prior bug skipped Anthropic whenever formats
  // existed even if inference left most leads without an email (sheet = Not Found).
  const stillMissingEmail = peopleStillNeedEmailResearch(people);
  return {
    direct: direct.assigned,
    inferred,
    domain,
    needsResearch: stillMissingEmail || priorFormatGuessNeedsWebResearch(people),
    preflight: direct,
  };
}

async function cachedResolution(disambiguation: ResearchDisambiguation) {
  const { rows } = await dbQuery<{
    resolved_domain: string | null;
    confidence: string;
    created_at: string;
  }>(
    `SELECT resolved_domain, confidence, created_at
     FROM outreach.company_resolutions
     WHERE normalized_name = $1
       AND confidence IN ('confirmed', 'likely', 'none')
       AND (
         disambiguation_hash = $2
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements(coalesce(disambiguation->'people', '[]'::jsonb)) AS person
           WHERE lower(trim(person->>'full_name')) = ANY($3::text[])
         )
         OR similarity(
           lower(coalesce(disambiguation->>'context_text', '')),
           lower($4)
         ) >= 0.6
       )
       AND created_at >= now() - CASE
         WHEN resolved_domain IS NULL THEN interval '30 days'
         ELSE interval '90 days'
       END
     ORDER BY (disambiguation_hash = $2) DESC, created_at DESC
     LIMIT 1`,
    [
      disambiguation.normalized_name,
      disambiguation.context_hash,
      disambiguation.people.map((person) => person.full_name.trim().toLowerCase()),
      disambiguation.context_text,
    ],
  );
  return rows[0] ?? null;
}

export async function prepareRunEnrichment(runId: string) {
  if (await runIsCancelled(runId)) return { jobIds: [], verifyDomains: [], finalize: false };
  const directStats = await dbQuery<{
    d1: number;
    d2: number;
    d3: number;
    reused_inferred: number;
    reused_format_guess: number;
  }>(
    `SELECT
       count(*) FILTER (WHERE l.email_primary IS NOT NULL AND l.email_source_note = 'present in upload')::int AS d1,
       count(*) FILTER (WHERE l.email_primary IS NOT NULL AND l.email_status = 'from_embark_db')::int AS d2,
       count(*) FILTER (
         WHERE l.email_primary IS NOT NULL
           AND l.email_status = 'direct'
           AND l.email_source_note <> 'present in upload'
       )::int AS d3,
       count(*) FILTER (
         WHERE l.email_primary IS NOT NULL AND l.email_status = 'inferred'
       )::int AS reused_inferred,
       count(*) FILTER (
         WHERE l.email_primary IS NOT NULL AND l.email_status = 'format_guess'
       )::int AS reused_format_guess
     FROM outreach.campaign_leads cl
     JOIN outreach.runs r ON r.id = cl.run_id AND r.status <> 'cancelled'
     JOIN outreach.leads l ON l.id = cl.lead_id
     WHERE cl.run_id = $1`,
    [runId],
  );
  const { rows: leads } = await dbQuery<LeadForEnrichment>(
    `SELECT l.id AS lead_id, l.full_name,
            coalesce(l.first_name, '') AS first_name,
            coalesce(l.last_name, '') AS last_name,
            l.title, l.location, l.linkedin_url, l.company_name, l.company_id,
            l.email_primary AS email, l.email_status,
            NULL::text AS account_website
     FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     WHERE cl.run_id = $1
       AND (
         l.email_primary IS NULL
         OR l.email_status IN ('inferred', 'format_guess')
         OR nullif(trim(l.title), '') IS NULL
         OR nullif(trim(l.location), '') IS NULL
         OR nullif(trim(l.company_name), '') IS NULL
       )`,
    [runId],
  );
  const grouped = new Map<string, LeadForEnrichment[]>();
  for (const lead of leads) {
    const key = lead.company_name?.trim()
      ? `company:${normalizeCompanyName(lead.company_name)}`
      : `person:${lead.lead_id}`;
    grouped.set(key, [...(grouped.get(key) ?? []), lead]);
  }

  await appendEnrichmentStats(runId, {
    d1: directStats.rows[0]?.d1 ?? 0,
    d2: directStats.rows[0]?.d2 ?? 0,
    d3: directStats.rows[0]?.d3 ?? 0,
    reused_inferred: directStats.rows[0]?.reused_inferred ?? 0,
    reused_format_guess: directStats.rows[0]?.reused_format_guess ?? 0,
    d4: 0,
    d4_model: 0,
    d4_scrape_preflight: 0,
    d4_scrape_post: 0,
    i1: 0, i2: 0, i3: 0, i4: 0,
    companies_researched: 0,
    companies_cache_hit: 0,
    companies_failed: 0,
    companies_total: 0,
    companies_remaining: 0,
    direct: (directStats.rows[0]?.d1 ?? 0) + (directStats.rows[0]?.d2 ?? 0) + (directStats.rows[0]?.d3 ?? 0),
    inferred: directStats.rows[0]?.reused_inferred ?? 0,
    format_guess: directStats.rows[0]?.reused_format_guess ?? 0,
    not_found: 0,
    verified_ok: 0,
    verified_no_mx: 0,
    profile_fields_requested: leads.reduce((count, lead) => {
      const fields = buildRequestedProfileFields(lead);
      return count + fields.requested_fields.length;
    }, 0),
    profile_fields_enriched: 0,
    profile_fields_rejected: 0,
    profile_rescue_jobs: 0,
    profile_rescue_jobs_completed: 0,
    profile_rescue_jobs_failed: 0,
    profile_rescue_fields_requested: 0,
    profile_rescue_fields_enriched: 0,
    profile_rescue_fields_unresolved: 0,
    email_rescue_jobs: 0,
    email_rescue_jobs_completed: 0,
    email_rescue_jobs_failed: 0,
    email_rescue_people: 0,
    email_rescue_direct: 0,
    email_rescue_inferred: 0,
    exact_search_queries: 0,
    exact_search_confirmed: 0,
    provider_calls: 0,
    provider_finder_found: 0,
    provider_finder_no_result: 0,
    provider_verifier_invalid: 0,
    provider_errors: 0,
    mailbox_valid: 0,
    mailbox_invalid: 0,
    mailbox_accept_all: 0,
    mailbox_risky: 0,
    mailbox_unknown: 0,
    mailbox_provider_errors: 0,
    mailbox_rate_limited: 0,
    scrape_pages_attempted: 0,
    scrape_pages_fetched: 0,
    scrape_errors: 0,
    scrape_retries: 0,
    scrape_rendered_pages: 0,
    scrape_ocr_images: 0,
    scrape_nickname_matches: 0,
    scrape_local_part_matches: 0,
    research_budget_assigned: 0,
    research_budget_used: 0,
    research_budget_exhausted: 0,
    provisional_direct: 0,
    provisional_direct_rejected: 0,
  });
  await dbQuery(
    `UPDATE outreach.runs
     SET stats = jsonb_set(
       stats,
       '{enrichment,insight}',
       $2::jsonb,
       true
     )
     WHERE id = $1`,
    [runId, JSON.stringify(emptyEnrichmentInsightCounters())],
  );
  logPipelineInsight('enrich', `run=${runId} enrich_started`, {
    leadCount: leads.length,
    companyGroups: grouped.size,
  });

  const jobIds: string[] = [];
  const verifyDomains = new Set<string>();
  let cacheHits = 0;
  const companyGroups = [...grouped.values()].flatMap((companyLeads) =>
    shardPeopleForEmailResearch(companyLeads));
  const preflightConcurrency = Math.max(1, Number(process.env.ORG_SCRAPE_CONCURRENCY ?? 2));
  for (let index = 0; index < companyGroups.length; index += preflightConcurrency) {
    const batch = companyGroups.slice(index, index + preflightConcurrency);
    await Promise.all(batch.map(async (companyLeads) => {
    const companyName = companyLeads[0].company_name?.trim() || null;
    const people = companyLeads.map((lead) => {
      const fields = buildRequestedProfileFields(lead);
      return {
        lead_id: lead.lead_id,
        full_name: lead.full_name,
        first_name: lead.first_name,
        last_name: lead.last_name,
        title: lead.title,
        location: lead.location,
        linkedin_url: lead.linkedin_url,
        email: lead.email,
        email_status: lead.email_status,
        requested_fields: fields.requested_fields,
        opportunistic_fields: fields.opportunistic_fields,
      };
    });
    let disambiguation = buildDisambiguation(companyName, people);
    let completedPreflight: Awaited<ReturnType<typeof scrapeAndApplyDirectEmails>> | null = null;
    const needsProfileResearch = peopleNeedHardProfileResearch(people);
    const gaps = profileGapsForPeople(people);
    if (gaps.hardGaps.length) await incrementEnrichmentInsight(runId, 'hard_gap_batches');
    else if (gaps.softGaps.length) await incrementEnrichmentInsight(runId, 'soft_only_gap_batches');
    const resolution = companyName ? await cachedResolution(disambiguation) : null;
    const resolvedDomain = sanitizeDomain(resolution?.resolved_domain);
    if (resolvedDomain && !needsProfileResearch) {
      const outcome = await knownDomainOutcome(runId, companyLeads, resolvedDomain);
      verifyDomains.add(resolvedDomain);
      if (!outcome.needsResearch) {
        cacheHits++;
        await incrementEnrichmentInsight(runId, 'path_known_domain_skip');
        logPipelineInsight('enrich', `run=${runId} known_domain_skip`, {
          company: companyName,
          domain: resolvedDomain,
          leadCount: people.length,
          hardGaps: gaps.hardGaps,
          softGaps: gaps.softGaps,
        });
        return;
      }
      completedPreflight = outcome.preflight;
    }
    if (resolution?.confidence === 'none' && !needsProfileResearch) {
      // Cached "domain not found" must not freeze a new run when emails are still
      // missing — retry research instead of finalizing a Not Found sheet.
      if (!peopleStillNeedEmailResearch(people)) {
        await incrementEnrichmentStat(runId, 'i4', people.length);
        await incrementEnrichmentStat(runId, 'not_found', people.length);
        cacheHits++;
        await incrementEnrichmentInsight(runId, 'path_i4_not_found');
        return;
      }
      await incrementEnrichmentInsight(runId, 'path_i4_retry_missing_email');
    }

    const candidateDomain = resolvedDomain
      ?? sanitizeDomain(companyLeads.find((lead) => lead.account_website)?.account_website)
      ?? sanitizeDomain(companyLeads.find((lead) => lead.email)?.email?.split('@')[1])
      ?? (companyName ? await knownDomainForCompany(companyName) : null);
    if (candidateDomain) {
      const cached = await companyFormats(candidateDomain);
      let localPatterns = cached?.source === 'lead_samples'
        ? cached.email_formats.map((format) => format.pattern)
        : [];
      if (!localPatterns.length) {
        const derived = await deriveFormatForDomain(candidateDomain);
        localPatterns = derived?.patterns ?? [];
      }
      disambiguation = { ...disambiguation, candidate_domain: candidateDomain, local_patterns: localPatterns };
      if (companyName) {
        const preflight = completedPreflight ?? await scrapeAndApplyDirectEmails(
            candidateDomain,
            companyLeads,
            [runId],
            'd4_scrape_preflight',
          );
        disambiguation = {
          ...disambiguation,
          people: people.map((person) => {
            const lead = companyLeads.find((candidate) => candidate.lead_id === person.lead_id);
            return {
              ...person,
              email: lead?.email ?? person.email,
              email_status: lead?.email_status ?? person.email_status,
            };
          }),
          direct_search: {
            pages_attempted: preflight.diagnostics?.pagesAttempted ?? 0,
            pages_fetched: preflight.diagnostics?.pagesFetched ?? 0,
            checked_paths: preflight.diagnostics?.pathsHit ?? [],
            unresolved_people: companyLeads
              .filter((lead) =>
                !lead.email || ['inferred', 'format_guess'].includes(lead.email_status ?? ''))
              .map((lead) => lead.full_name),
            page_outcomes: preflight.diagnostics?.pageOutcomes.map((outcome) => ({
              url: outcome.url,
              path: outcome.path,
              outcome: outcome.outcome,
              ...(outcome.error ? { error: outcome.error } : {}),
            })) ?? [],
            failed_high_value_paths: preflight.diagnostics?.pageOutcomes
              .filter((outcome) =>
                outcome.outcome.startsWith('error_')
                && /(?:team|people|leadership|staff|directory|management|professional|partner|advisor|executive|board|contact)/i
                  .test(outcome.path))
              .map((outcome) => outcome.url) ?? [],
          },
        };
        const needsEmailResearch = directSearchTargets(companyLeads).length > 0;
        if (!needsEmailResearch && !needsProfileResearch) {
          cacheHits++;
          await incrementEnrichmentInsight(runId, 'path_scrape_preflight_resolved');
          logPipelineInsight('enrich', `run=${runId} scrape_preflight_resolved`, {
            company: companyName,
            domain: candidateDomain,
            leadCount: people.length,
          });
          return;
        }
      }
    }

    const { rows } = await dbQuery<{ enqueue: string }>(
      `SELECT public.enqueue($1, $2::jsonb, $3, 'primary')`,
      [researchJobKey(disambiguation), JSON.stringify(disambiguation), runId],
    );
    if (rows[0]?.enqueue) {
      const assignedBudget = searchBudgetForJob(
        disambiguation.people,
        disambiguation.research_pass ?? 'primary',
      );
      const emailTargets = disambiguation.people.filter((person) =>
        !person.email || ['inferred', 'format_guess'].includes(person.email_status ?? '')).length;
      const emailOnlyBudget = emailTargets <= 0 ? 0 : emailTargets <= 2 ? 5 : 10;
      const floorApplied = needsProfileResearch && emailOnlyBudget < 5;
      await dbQuery(
        `UPDATE outreach.company_research_jobs
         SET status = 'pending', attempt_count = 0, claimed_at = NULL,
             last_error = NULL,
             search_budget = CASE WHEN searches_used = 0 THEN $2 ELSE search_budget END,
             searches_used = CASE
               WHEN status IN ('failed', 'done') THEN 0
               ELSE searches_used
             END,
             updated_at = now()
         WHERE id = $1
           AND (
             status = 'failed'
             OR (
               status = 'done'
               AND (
                 research_result IS NULL
                 OR research_result->>'domain_confidence' NOT IN ('confirmed', 'likely', 'none')
                 OR updated_at < now() - CASE
                   WHEN resolved_domain IS NULL THEN interval '30 days'
                   ELSE interval '90 days'
                 END
               )
             )
           )`,
        [rows[0].enqueue, assignedBudget],
      );
      await dbQuery(
        `UPDATE outreach.company_research_jobs
         SET search_budget = $2, updated_at = now()
         WHERE id = $1 AND status = 'pending' AND searches_used = 0`,
        [rows[0].enqueue, assignedBudget],
      );
      const enqueueInsight = buildEnrichmentJobInsight({
        jobKind: 'primary',
        companyKey: researchJobKey(disambiguation),
        path: 'research_enqueued',
        hardGaps: gaps.hardGaps,
        softGaps: gaps.softGaps,
        requestedFields: [...new Set(people.flatMap((p) => p.requested_fields ?? []))],
        opportunisticFields: [...new Set(people.flatMap((p) => p.opportunistic_fields ?? []))],
        leadCount: people.length,
        budget: {
          assigned: assignedBudget,
          used: null,
          remainingBefore: null,
          floorApplied,
          hardUnresolvedBeforeBudget: gaps.hardGaps.length,
        },
        decisions: {
          needsHardProfileResearch: needsProfileResearch,
          scrapePreflightCompleted: Boolean(completedPreflight),
          knownDomainSkipResearch: false,
          profileRescueEnqueued: 0,
          profileRescueSkipped: 0,
          profileRescueSkipReasons: [],
          emailRescueEnqueued: 0,
          followupsEnqueued: 0,
        },
        provider: {
          modelId: null,
          promptVersion: null,
          searchesUsed: null,
          costUsd: null,
        },
        timingsMs: { researchMs: null, totalMs: null },
      });
      await persistResearchJobInsight(rows[0].enqueue, enqueueInsight);
      await incrementEnrichmentInsight(runId, 'path_research_enqueued');
      if (floorApplied) await incrementEnrichmentInsight(runId, 'budget_floor_applied');
      jobIds.push(rows[0].enqueue);
    }
    }));
  }

  if (cacheHits) {
    await incrementEnrichmentStat(runId, 'companies_cache_hit', cacheHits);
    await incrementEnrichmentInsight(runId, 'path_cache_hit', cacheHits);
  }
  await incrementEnrichmentStat(runId, 'companies_total', jobIds.length + cacheHits);
  await incrementEnrichmentStat(runId, 'companies_remaining', jobIds.length);
  if (jobIds.length) {
    await dbQuery(
      `UPDATE outreach.runs SET status = 'enriching' WHERE id = $1 AND status <> 'cancelled'`,
      [runId],
    );
  }
  return { jobIds: [...new Set(jobIds)], verifyDomains: [...verifyDomains], finalize: jobIds.length === 0 };
}

async function leadsForJob(job: ResearchJob) {
  const { rows } = await dbQuery<LeadForEnrichment>(
    `SELECT l.id AS lead_id, l.full_name,
            coalesce(l.first_name, '') AS first_name,
            coalesce(l.last_name, '') AS last_name,
            l.title, l.location, l.linkedin_url, l.company_name, l.company_id,
            l.email_primary AS email, l.email_status,
            NULL::text AS account_website
     FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     WHERE cl.run_id = ANY($1::uuid[])
       AND l.id = ANY($2::uuid[])`,
    [job.requested_by_runs, job.disambiguation.people.map((person) => person.lead_id)],
  );
  return rows;
}

async function applyProfileFindings(
  job: ResearchJob,
  report: ResearchReport,
  leads: LeadForEnrichment[],
  countGenericStats = true,
) {
  let enriched = 0;
  const acceptedCompanies: Array<{ lead: LeadForEnrichment; companyName: string }> = [];
  for (const finding of report.profile_findings ?? []) {
    const person = job.disambiguation.people.find((candidate) =>
      normalizePersonName(candidate.full_name) === normalizePersonName(finding.person_name),
    );
    if (!person || !isHighConfidenceProfileFinding(finding, person)) continue;
    const lead = leads.find((candidate) => candidate.lead_id === person.lead_id);
    if (!lead) continue;
    const provenance = JSON.stringify({
      value: finding.value,
      confidence: finding.confidence,
      reasoning: finding.reasoning,
      evidence: finding.evidence,
      run_ids: job.requested_by_runs,
      research_pass: job.disambiguation.research_pass ?? 'primary',
      enriched_at: new Date().toISOString(),
    });

    let result: Awaited<ReturnType<typeof dbQuery>>;
    if (finding.field === 'company_name') {
      const accountId = await resolveCompanyAccountId(finding.value);
      result = await dbQuery(
        `UPDATE outreach.leads
         SET company_name = $2,
             company_id = coalesce(company_id, $3),
             profile_enrichment = jsonb_set(
               coalesce(profile_enrichment, '{}'::jsonb), '{company_name}', $4::jsonb, true
             ),
             updated_at = now()
         WHERE id = $1 AND nullif(trim(company_name), '') IS NULL
           AND EXISTS (
             SELECT 1 FROM outreach.campaign_leads cl
             JOIN outreach.runs r ON r.id = cl.run_id
             WHERE cl.lead_id = outreach.leads.id AND r.status <> 'cancelled'
           )`,
        [lead.lead_id, finding.value, accountId, provenance],
      );
    } else if (finding.field === 'title') {
      result = await dbQuery(
        `UPDATE outreach.leads
         SET title = $2,
             profile_enrichment = jsonb_set(
               coalesce(profile_enrichment, '{}'::jsonb), '{title}', $3::jsonb, true
             ),
             updated_at = now()
         WHERE id = $1 AND nullif(trim(title), '') IS NULL
           AND EXISTS (
             SELECT 1 FROM outreach.campaign_leads cl
             JOIN outreach.runs r ON r.id = cl.run_id
             WHERE cl.lead_id = outreach.leads.id AND r.status <> 'cancelled'
           )`,
        [lead.lead_id, finding.value, provenance],
      );
    } else {
      result = await dbQuery(
        `UPDATE outreach.leads
         SET location = $2,
             profile_enrichment = jsonb_set(
               coalesce(profile_enrichment, '{}'::jsonb), '{location}', $3::jsonb, true
             ),
             updated_at = now()
         WHERE id = $1 AND nullif(trim(location), '') IS NULL
           AND EXISTS (
             SELECT 1 FROM outreach.campaign_leads cl
             JOIN outreach.runs r ON r.id = cl.run_id
             WHERE cl.lead_id = outreach.leads.id AND r.status <> 'cancelled'
           )`,
        [lead.lead_id, finding.value, provenance],
      );
    }
    const changed = result.rowCount ?? 0;
    enriched += changed;
    if (changed > 0 && finding.field === 'company_name') {
      acceptedCompanies.push({ lead, companyName: finding.value });
    }
  }

  const requested = job.disambiguation.people.reduce(
    (count, person) => count + (person.requested_fields?.length ?? 0),
    0,
  );
  const rejected = Math.max(0, requested - enriched);
  if (countGenericStats) {
    for (const runId of job.requested_by_runs) {
      if (enriched) await incrementEnrichmentStat(runId, 'profile_fields_enriched', enriched);
      if (rejected) await incrementEnrichmentStat(runId, 'profile_fields_rejected', rejected);
    }
  }
  return { enriched, rejected, acceptedCompanies };
}

async function enqueueCompanyFollowups(
  job: ResearchJob,
  report: ResearchReport,
  acceptedCompanies: Array<{ lead: LeadForEnrichment; companyName: string }>,
) {
  const followupJobIds = new Set<string>();
  for (const { lead, companyName } of acceptedCompanies) {
    const fields = buildRequestedProfileFields(lead);
    if (lead.email && fields.requested_fields.length === 0 && fields.opportunistic_fields.length === 0) {
      continue;
    }
    // Soft-only (location) with a known email still benefits from a cheap follow-up
    // only when hard fields are missing; otherwise skip a dedicated job.
    if (lead.email && fields.requested_fields.length === 0) continue;

    let disambiguation = buildDisambiguation(companyName, [{
      lead_id: lead.lead_id,
      full_name: lead.full_name,
      first_name: lead.first_name,
      last_name: lead.last_name,
      title: lead.title,
      location: lead.location,
      linkedin_url: lead.linkedin_url,
      email: lead.email,
      email_status: lead.email_status,
      requested_fields: fields.requested_fields,
      opportunistic_fields: fields.opportunistic_fields,
    }]);
    const candidateDomain = sanitizeDomain(report.domain)
      ?? sanitizeDomain(lead.email?.split('@')[1]);
    if (candidateDomain) {
      const derived = await deriveFormatForDomain(candidateDomain);
      disambiguation = {
        ...disambiguation,
        candidate_domain: candidateDomain,
        local_patterns: derived?.patterns ?? [],
      };
    }

    for (const runId of job.requested_by_runs) {
      const { rows } = await dbQuery<{ enqueue: string }>(
        `SELECT public.enqueue($1, $2::jsonb, $3, 'company_followup')`,
        [researchJobKey(disambiguation), JSON.stringify(disambiguation), runId],
      );
      if (!rows[0]?.enqueue) continue;
      await setPendingResearchBudget(rows[0].enqueue, disambiguation);
      followupJobIds.add(rows[0].enqueue);
      await incrementEnrichmentStat(runId, 'companies_total');
      await incrementEnrichmentStat(runId, 'companies_remaining');
      if (fields.requested_fields.length) {
        await incrementEnrichmentStat(runId, 'profile_fields_requested', fields.requested_fields.length);
      }
    }
  }
  return [...followupJobIds];
}

export function unresolvedProfileFields(
  requestedFields: ProfileField[],
  values: Pick<LeadForEnrichment, 'company_name' | 'title' | 'location'>,
) {
  return requestedFields.filter((field) => {
    if (field === 'company_name') return !values.company_name?.trim();
    return !values[field]?.trim();
  });
}

async function enqueueProfileRescues(job: ResearchJob, report: ResearchReport) {
  if (job.disambiguation.research_pass && job.disambiguation.research_pass !== 'primary') return [];
  const refreshedLeads = await leadsForJob(job);
  const rescueJobIds = new Set<string>();
  let skipped = 0;
  const skipReasons: string[] = [];
  for (const originalPerson of job.disambiguation.people) {
    const lead = refreshedLeads.find((candidate) => candidate.lead_id === originalPerson.lead_id);
    if (!lead) continue;
    const unresolvedAll = unresolvedProfileFields(
      [...(originalPerson.requested_fields ?? []), ...(originalPerson.opportunistic_fields ?? [])],
      lead,
    );
    const softLeft = softRequestedFields(unresolvedAll);
    // Rescue only hard fields — location is opportunistic and never gets a second job.
    const requestedFields = hardRequestedFields(unresolvedAll);
    if (!requestedFields.length) {
      skipped += 1;
      const reason = softLeft.length
        ? `soft_only:${softLeft.join(',')}`
        : unresolvedAll.length
          ? `non_hard_unresolved:${unresolvedAll.join(',')}`
          : 'hard_fields_resolved';
      skipReasons.push(`${lead.full_name}:${reason}`);
      for (const runId of job.requested_by_runs) {
        await incrementEnrichmentInsight(runId, 'profile_rescue_skipped');
      }
      continue;
    }

    let rescue = buildDisambiguation(lead.company_name, [{
      lead_id: lead.lead_id,
      full_name: lead.full_name,
      first_name: lead.first_name,
      last_name: lead.last_name,
      title: lead.title,
      location: lead.location,
      linkedin_url: lead.linkedin_url,
      email: lead.email,
      email_status: lead.email_status,
      requested_fields: requestedFields,
      opportunistic_fields: [],
    }]);
    rescue = {
      ...rescue,
      research_pass: 'profile_rescue',
      candidate_domain: sanitizeDomain(report.domain)
        ?? sanitizeDomain(job.disambiguation.candidate_domain),
      profile_rescue_context: {
        parent_job_id: job.id,
        domain: sanitizeDomain(report.domain),
        domain_evidence: report.domain_evidence,
        alternate_domain: sanitizeDomain(report.alternate_domain),
        company_notes: report.company_notes,
        prior_findings: report.profile_findings.filter((finding) =>
          normalizePersonName(finding.person_name) === normalizePersonName(originalPerson.full_name)
          && requestedFields.includes(finding.field),
        ),
      },
    };

    for (const runId of job.requested_by_runs) {
      const { rows } = await dbQuery<{ enqueue: string }>(
        `SELECT public.enqueue($1, $2::jsonb, $3, 'profile_rescue')`,
        [researchJobKey(rescue), JSON.stringify(rescue), runId],
      );
      if (!rows[0]?.enqueue) continue;
      await setPendingResearchBudget(rows[0].enqueue, rescue, 'profile_rescue');
      rescueJobIds.add(rows[0].enqueue);
      await incrementEnrichmentStat(runId, 'companies_total');
      await incrementEnrichmentStat(runId, 'companies_remaining');
      await incrementEnrichmentStat(runId, 'profile_rescue_jobs');
      await incrementEnrichmentStat(runId, 'profile_rescue_fields_requested', requestedFields.length);
      await incrementEnrichmentInsight(runId, 'profile_rescue_enqueued');
      await persistResearchJobInsight(rows[0].enqueue, buildEnrichmentJobInsight({
        jobKind: 'profile_rescue',
        companyKey: researchJobKey(rescue),
        path: 'profile_rescue',
        hardGaps: requestedFields,
        softGaps: softLeft,
        requestedFields,
        opportunisticFields: [],
        leadCount: 1,
        budget: {
          assigned: 1,
          used: null,
          remainingBefore: null,
          floorApplied: false,
          hardUnresolvedBeforeBudget: requestedFields.length,
        },
        decisions: {
          needsHardProfileResearch: true,
          scrapePreflightCompleted: false,
          knownDomainSkipResearch: false,
          profileRescueEnqueued: 1,
          profileRescueSkipped: 0,
          profileRescueSkipReasons: [],
          emailRescueEnqueued: 0,
          followupsEnqueued: 0,
        },
        provider: { modelId: null, promptVersion: null, searchesUsed: null, costUsd: null },
        timingsMs: { researchMs: null, totalMs: null },
      }));
    }
  }
  if (skipped || rescueJobIds.size) {
    logPipelineInsight('enrich', `job=${job.id} profile_rescue_decision`, {
      enqueued: rescueJobIds.size,
      skipped,
      skipReasons: skipReasons.slice(0, 20),
    });
  }
  return [...rescueJobIds];
}

async function enqueueEmailRescues(job: ResearchJob, report: ResearchReport) {
  if (job.disambiguation.research_pass === 'profile_rescue'
    || job.disambiguation.research_scope === 'person') return [];
  const priorContext = job.disambiguation.email_rescue_context;
  const priorTranche = priorContext?.tranche ?? 0;
  if (job.disambiguation.research_pass === 'email_rescue') {
    if (priorTranche >= 2) return [];
    if (!rescueFrontierAdvanced(priorContext, report)) return [];
  }
  const refreshedLeads = await leadsForJob(job);
  const unresolved = refreshedLeads.filter((lead) =>
    lead.company_name?.trim()
    && (lead.email_status === 'format_guess'
      || (lead.email_status === 'not_found' && !lead.email)));
  if (!unresolved.length) return [];
  const companyName = unresolved[0].company_name?.trim();
  if (!companyName) return [];

  let rescue = buildDisambiguation(companyName, unresolved.map((lead) => ({
      lead_id: lead.lead_id,
      full_name: lead.full_name,
      first_name: lead.first_name,
      last_name: lead.last_name,
      title: lead.title,
      location: lead.location,
      linkedin_url: lead.linkedin_url,
      email: lead.email,
      email_status: lead.email_status,
      requested_fields: [],
  })));
  const domain = sanitizeDomain(report.domain)
    ?? sanitizeDomain(job.disambiguation.candidate_domain)
    ?? sanitizeDomain(unresolved.find((lead) => lead.email)?.email?.split('@')[1]);
  const uncitedFormatQueries = report.formats.flatMap((format) => {
    if (format.source_url || /https?:\/\//i.test(format.evidence)) return [];
    const evidence = format.evidence.toLowerCase();
    const family = evidence.includes('rocketreach')
      ? 'format_rocketreach' as const
      : evidence.includes('zoominfo')
        ? 'format_zoominfo' as const
        : 'generic_format' as const;
    const source = family === 'format_rocketreach'
      ? 'site:rocketreach.co'
      : family === 'format_zoominfo'
        ? 'site:zoominfo.com'
        : '';
    return [{
      person_name: null,
      family,
      query: `${source} "${companyName}" email format percentage`.trim(),
    }];
  });
  const deferredQueries = [
    ...(report.deferred_queries ?? []),
    ...uncitedFormatQueries,
    ...(report.research_budget_exhausted && !(report.deferred_queries?.length)
      ? buildResearchQueryPlan(job.disambiguation).filter((item) =>
        !(report.attempted_query_families ?? []).includes(item.family))
      : []),
  ].filter((item, index, all) =>
    all.findIndex((candidate) => candidate.query === item.query) === index);
  rescue = {
    ...rescue,
    research_pass: 'email_rescue',
    candidate_domain: domain,
    direct_search: job.disambiguation.direct_search,
    email_rescue_context: {
      parent_job_id: job.id,
      domain,
      domain_evidence: report.domain_evidence,
      company_notes: report.company_notes,
      prior_literal_emails: report.literal_emails.filter((literal) =>
        unresolved.some((lead) =>
          normalizePersonName(literal.person_name) === normalizePersonName(lead.full_name))),
      prior_formats: report.formats,
      checked_paths: job.disambiguation.direct_search?.checked_paths ?? [],
      search_budget: Number(job.search_budget ?? 0),
      searches_used: Number(job.searches_used ?? 0) + Number(report.research_searches_used ?? 0),
      attempted_query_families: report.attempted_query_families ?? [],
      deferred_queries: deferredQueries,
      rejected_direct_literals: report.rejected_direct_literals ?? [],
      failed_high_value_paths: [
        ...(job.disambiguation.direct_search?.failed_high_value_paths ?? []),
        ...(report.promising_paths ?? []),
      ],
      scraper_outcomes: job.disambiguation.direct_search?.page_outcomes ?? [],
      tranche: priorTranche + 1,
    },
  };

  const rescueJobIds = new Set<string>();
  for (const runId of job.requested_by_runs) {
    const { rows } = await dbQuery<{ enqueue: string }>(
      `SELECT public.enqueue($1, $2::jsonb, $3, 'email_rescue')`,
      [researchJobKey(rescue), JSON.stringify(rescue), runId],
    );
    if (!rows[0]?.enqueue) continue;
    await setPendingResearchBudget(rows[0].enqueue, rescue, 'email_rescue');
    rescueJobIds.add(rows[0].enqueue);
    await incrementEnrichmentStat(runId, 'companies_total');
    await incrementEnrichmentStat(runId, 'companies_remaining');
    await incrementEnrichmentStat(runId, 'email_rescue_jobs');
    await incrementEnrichmentStat(runId, 'email_rescue_people', unresolved.length);
  }
  return [...rescueJobIds];
}

async function applyProfileRescueReport(
  job: ResearchJob,
  report: ResearchReport,
) {
  const mergedReport: ResearchReport = {
    ...report,
    profile_findings: mergeProfileRescueFindings(
      report.profile_findings,
      job.disambiguation.profile_rescue_context?.prior_findings ?? [],
    ),
  };
  const leads = await leadsForJob(job);
  const profile = await applyProfileFindings(job, mergedReport, leads, false);
  const followupJobIds = await enqueueCompanyFollowups(
    job,
    mergedReport,
    profile.acceptedCompanies,
  );
  const domain = sanitizeDomain(mergedReport.domain)
    ?? sanitizeDomain(job.disambiguation.candidate_domain);
  await dbQuery(
    `UPDATE outreach.company_research_jobs
     SET research_result = $2::jsonb, grade = 'P', resolved_domain = $3
     WHERE id = $1`,
    [job.id, JSON.stringify(mergedReport), domain],
  );
  for (const runId of job.requested_by_runs) {
    await incrementEnrichmentStat(runId, 'profile_rescue_jobs_completed');
    if (profile.enriched) {
      await incrementEnrichmentStat(runId, 'profile_rescue_fields_enriched', profile.enriched);
    }
    if (profile.rejected) {
      await incrementEnrichmentStat(runId, 'profile_rescue_fields_unresolved', profile.rejected);
    }
  }
  return {
    domain,
    inferenceDomain: null,
    direct: 0,
    inferred: 0,
    profile,
    followupJobIds,
    profileRescueJobIds: [] as string[],
    emailRescueJobIds: [] as string[],
    verifyDomains: [] as string[],
  };
}

async function applyResearchReport(
  job: ResearchJob,
  report: ResearchReport,
  countAsResearch = true,
  verifyLiteral: typeof verifyDirectEmailSource = verifyDirectEmailSource,
  scraper: typeof scrapeDirectEmails = scrapeDirectEmails,
) {
  const targetNames = new Set(job.disambiguation.people.map((person) =>
    normalizePersonName(person.full_name)));
  const targetLiterals = report.literal_emails.filter((literal) =>
    targetNames.has(normalizePersonName(literal.person_name)));
  const verifiedTargetLiterals: Array<{
    literal: ResearchReport['literal_emails'][number];
    verification: Awaited<ReturnType<typeof verifyDirectEmailSource>>;
  }> = [];
  const rejectedTargetLiterals: NonNullable<ResearchReport['rejected_direct_literals']> = [];
  for (const literal of targetLiterals) {
    const literalDomain = sanitizeDomain(literal.email.split('@')[1]);
    if (!literalDomain) continue;
    const verification = await verifyLiteral({
      source_url: literal.source_url,
      email: literal.email,
      person_name: literal.person_name,
      domain: literalDomain,
      source_quote: literal.source_quote,
    });
    if ((verification.verified && verification.content_hash && verification.context)
      || verification.provisional) {
      verifiedTargetLiterals.push({ literal, verification });
    } else {
      rejectedTargetLiterals.push({
        ...literal,
        reason: verification.error ?? verification.failure_class ?? 'source re-verification failed',
      });
    }
  }
  const coworkerCandidates = [
    ...(report.company_email_samples ?? []),
    ...report.literal_emails.filter((literal) =>
      !targetNames.has(normalizePersonName(literal.person_name))),
  ];
  const literalDomain = verifiedTargetLiterals[0]?.literal.email.split('@')[1];
  const reportedEmailDomain = (report.email_domains ?? [])
    .filter((candidate) => candidate.confidence !== 'low')
    .map((candidate) => sanitizeDomain(candidate.domain))
    .find(Boolean);
  const domain = sanitizeDomain(report.domain)
    ?? sanitizeDomain(literalDomain)
    ?? reportedEmailDomain
    ?? sanitizeDomain(job.disambiguation.candidate_domain);
  const alternate = sanitizeDomain(report.alternate_domain);
  const allowedSampleDomains = new Set(
    [
      domain,
      alternate,
      sanitizeDomain(job.disambiguation.candidate_domain),
      ...(report.email_domains ?? []).map((candidate) => sanitizeDomain(candidate.domain)),
    ].filter(Boolean) as string[],
  );
  const verifiedSamples: Array<{
    person_name: string;
    email: string;
    source_url: string;
    source_quote?: string;
    pattern: EmailPattern;
  }> = [];
  for (const sample of coworkerCandidates) {
    const sampleDomain = sanitizeDomain(sample.email.split('@')[1]);
    if (!sampleDomain || !allowedSampleDomains.has(sampleDomain)) continue;
    const verified = await verifyLiteral({
      source_url: sample.source_url,
      email: sample.email,
      person_name: sample.person_name,
      domain: sampleDomain,
      source_quote: sample.source_quote,
    });
    if (!verified.verified) continue;
    const pattern = patternFromNamedEmail(sample.person_name, sample.email);
    if (!pattern) continue;
    verifiedSamples.push({ ...sample, pattern });
  }
  const sampleFormats: ResearchFormat[] = verifiedSamples.map((sample) => ({
    pattern: sample.pattern,
    share_pct: null,
    confidence: 'high',
    evidence: `${sample.source_url} — verified named employee sample`,
  }));
  report = {
    ...report,
    literal_emails: verifiedTargetLiterals.map(({ literal }) => literal),
    company_email_samples: coworkerCandidates,
    formats: [...sampleFormats, ...report.formats],
    rejected_direct_literals: [
      ...(report.rejected_direct_literals ?? []),
      ...rejectedTargetLiterals,
    ],
  };
  const grade = gradeReport({
    ...report,
    domain,
    formats: evidenceBackedFormats(report.formats),
  });
  const leads = await leadsForJob(job);
  const profile = await applyProfileFindings(job, report, leads);
  const companyFollowupJobIds = await enqueueCompanyFollowups(job, report, profile.acceptedCompanies);
  const rescueJobIds = await enqueueProfileRescues(job, report);
  if (job.disambiguation.research_scope === 'person' && profile.acceptedCompanies.length === 0) {
    const blockedLeadIds = leads
      .filter((lead) => !lead.company_name?.trim())
      .map((lead) => lead.lead_id);
    if (blockedLeadIds.length) {
      const blocked = await dbQuery(
        `UPDATE outreach.leads
         SET email_primary = NULL, email_alt_1 = NULL, email_alt_2 = NULL,
             email_status = 'not_found',
             email_source_note = 'company must be confirmed first',
             email_verification = NULL,
             updated_at = now()
         WHERE id = ANY($1::uuid[])
           AND nullif(trim(company_name), '') IS NULL
           AND (email_primary IS NULL OR email_status IN ('inferred', 'format_guess'))
           AND (
             email_primary IS NOT NULL
             OR email_status <> 'not_found'
             OR email_source_note IS DISTINCT FROM 'company must be confirmed first'
           )`,
        [blockedLeadIds],
      );
      for (const runId of job.requested_by_runs) {
        await incrementEnrichmentStat(runId, 'i4', blocked.rowCount ?? 0);
        await incrementEnrichmentStat(runId, 'not_found', blocked.rowCount ?? 0);
      }
    }
  }
  const emailLeads = job.disambiguation.research_scope === 'person' ? [] : leads;
  let webFormats = evidenceBackedFormats(report.formats);
  let webPatterns = webFormats.flatMap((format) =>
    format.pattern === 'other' ? [] : [format.pattern],
  );
  const cached = domain ? await companyFormats(domain) : null;
  const localPatterns = job.disambiguation.local_patterns ?? [];
  const cachedWebFormats = cached?.source === 'web_research'
    ? evidenceBackedCompanyFormats(cached.email_formats ?? [])
    : [];
  let patterns: EmailPattern[] = localPatterns.length
    ? localPatterns
    : cached?.source === 'lead_samples'
      ? cached.email_formats.map((format) => format.pattern)
      : cachedWebFormats.length
        ? cachedWebFormats.flatMap((format) =>
          format.pattern === 'other' ? [] : [format.pattern])
        : webPatterns;
  let formatMeta: FormatMeta[] = localPatterns.length
    ? localPatterns.map((pattern) => ({ pattern }))
    : cached?.source === 'lead_samples'
      ? inferFormatMeta(cached.email_formats ?? [])
      : cachedWebFormats.length
        ? inferFormatMeta(cachedWebFormats)
        : inferFormatMeta(webFormats);
  let inferenceMethod: InferenceMethod = localPatterns.length || cached?.source === 'lead_samples'
    ? 'local'
    : patterns.length
      ? 'web'
      : 'guessed';
  const evidenceTexts = [
    ...webFormats.map((format) => format.evidence),
    ...report.literal_emails.map((literal) => literal.email),
    ...(report.company_email_samples ?? []).map((sample) => sample.email),
    ...(report.email_domains ?? []).map((candidate) =>
      `${candidate.domain} ${candidate.evidence}`),
  ];
  const inferenceDomain = resolveInferenceDomain(domain, evidenceTexts) ?? domain;
  let companyId: string | null = null;

  if (domain) {
    const { rows } = await dbQuery<{ id: string }>(
      `INSERT INTO outreach.companies (domain, email_formats, researched_at, source)
       VALUES (lower($1), $2::jsonb, now(), 'web_research')
       ON CONFLICT (domain) DO UPDATE SET
         email_formats = CASE
           WHEN outreach.companies.source = 'lead_samples' THEN outreach.companies.email_formats
           WHEN jsonb_array_length(EXCLUDED.email_formats) = 0 THEN outreach.companies.email_formats
           ELSE EXCLUDED.email_formats
         END,
         researched_at = now(),
         source = CASE
           WHEN outreach.companies.source = 'lead_samples' THEN outreach.companies.source
           ELSE 'web_research'
         END
       RETURNING id`,
      [domain, JSON.stringify(webFormats)],
    );
    companyId = rows[0].id;
  }
  if (alternate && report.domain_confidence === 'ambiguous') {
    await dbQuery(
      `INSERT INTO outreach.companies (domain, email_formats, researched_at, source)
       VALUES (lower($1), '[]'::jsonb, now(), 'web_research')
       ON CONFLICT (domain) DO UPDATE SET researched_at = now()`,
      [alternate],
    );
  }

  let inferenceCompanyId = companyId;
  if (inferenceDomain && inferenceDomain !== domain) {
    const { rows } = await dbQuery<{ id: string }>(
      `INSERT INTO outreach.companies (domain, email_formats, researched_at, source)
       VALUES (lower($1), $2::jsonb, now(), 'web_research')
       ON CONFLICT (domain) DO UPDATE SET
         email_formats = CASE
           WHEN outreach.companies.source = 'lead_samples' THEN outreach.companies.email_formats
           WHEN jsonb_array_length(EXCLUDED.email_formats) = 0 THEN outreach.companies.email_formats
           ELSE EXCLUDED.email_formats
         END,
         researched_at = now(),
         source = CASE
           WHEN outreach.companies.source = 'lead_samples' THEN outreach.companies.source
           ELSE 'web_research'
         END
       RETURNING id`,
      [inferenceDomain, JSON.stringify(webFormats)],
    );
    inferenceCompanyId = rows[0].id;
  }

  if (job.disambiguation.research_scope !== 'person') {
    await dbQuery(
      `INSERT INTO outreach.company_resolutions (
         normalized_name, disambiguation_hash, resolved_domain, confidence,
         evidence, disambiguation, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,now())
       ON CONFLICT (normalized_name, disambiguation_hash) DO UPDATE SET
         resolved_domain = CASE
           WHEN CASE EXCLUDED.confidence
             WHEN 'confirmed' THEN 3 WHEN 'likely' THEN 2
             WHEN 'ambiguous' THEN 1 ELSE 0 END
             >= CASE outreach.company_resolutions.confidence
             WHEN 'confirmed' THEN 3 WHEN 'likely' THEN 2
             WHEN 'ambiguous' THEN 1 ELSE 0 END
           THEN coalesce(EXCLUDED.resolved_domain, outreach.company_resolutions.resolved_domain)
           ELSE outreach.company_resolutions.resolved_domain
         END,
         confidence = CASE
           WHEN CASE EXCLUDED.confidence
             WHEN 'confirmed' THEN 3 WHEN 'likely' THEN 2
             WHEN 'ambiguous' THEN 1 ELSE 0 END
             >= CASE outreach.company_resolutions.confidence
             WHEN 'confirmed' THEN 3 WHEN 'likely' THEN 2
             WHEN 'ambiguous' THEN 1 ELSE 0 END
           THEN EXCLUDED.confidence
           ELSE outreach.company_resolutions.confidence
         END,
         evidence = CASE
           WHEN CASE EXCLUDED.confidence
             WHEN 'confirmed' THEN 3 WHEN 'likely' THEN 2
             WHEN 'ambiguous' THEN 1 ELSE 0 END
             >= CASE outreach.company_resolutions.confidence
             WHEN 'confirmed' THEN 3 WHEN 'likely' THEN 2
             WHEN 'ambiguous' THEN 1 ELSE 0 END
           THEN EXCLUDED.evidence
           ELSE outreach.company_resolutions.evidence
         END,
         disambiguation = CASE
           WHEN CASE EXCLUDED.confidence
             WHEN 'confirmed' THEN 3 WHEN 'likely' THEN 2
             WHEN 'ambiguous' THEN 1 ELSE 0 END
             >= CASE outreach.company_resolutions.confidence
             WHEN 'confirmed' THEN 3 WHEN 'likely' THEN 2
             WHEN 'ambiguous' THEN 1 ELSE 0 END
           THEN EXCLUDED.disambiguation
           ELSE outreach.company_resolutions.disambiguation
         END,
         created_at = CASE
           WHEN CASE EXCLUDED.confidence
             WHEN 'confirmed' THEN 3 WHEN 'likely' THEN 2
             WHEN 'ambiguous' THEN 1 ELSE 0 END
             >= CASE outreach.company_resolutions.confidence
             WHEN 'confirmed' THEN 3 WHEN 'likely' THEN 2
             WHEN 'ambiguous' THEN 1 ELSE 0 END
           THEN now()
           ELSE outreach.company_resolutions.created_at
         END`,
      [
        job.disambiguation.normalized_name,
        job.disambiguation.context_hash,
        domain,
        report.domain_confidence === 'ambiguous' ? 'ambiguous' : report.domain_confidence,
        [report.domain_evidence, alternate ? `alternate domain: ${alternate}` : null, report.company_notes].filter(Boolean).join('; '),
        JSON.stringify(job.disambiguation),
      ],
    );
  }

  let direct = 0;
  const directlyResolved = new Set<string>();
  const allowedLiteralDomains = new Set(
    [domain, inferenceDomain, sanitizeDomain(job.disambiguation.candidate_domain), alternate]
      .filter(Boolean) as string[],
  );
  for (const literal of report.literal_emails) {
    const lead = emailLeads.find((candidate) =>
      (!candidate.email || ['inferred', 'format_guess'].includes(candidate.email_status ?? ''))
      && normalizePersonName(candidate.full_name) === normalizePersonName(literal.person_name),
    );
    if (!lead) continue;
    const literalDomain = sanitizeDomain(literal.email.split('@')[1]);
    if (!literalDomain || !allowedLiteralDomains.has(literalDomain) || !companyId) continue;
    const verified = verifiedTargetLiterals.find(({ literal: candidate }) =>
      candidate.email.toLowerCase() === literal.email.toLowerCase()
      && normalizePersonName(candidate.person_name) === normalizePersonName(literal.person_name))
      ?.verification;
    if (!verified || (!verified.verified && !verified.provisional)) continue;
    if (verified.verified && (!verified.content_hash || !verified.context)) continue;
    const modelMatch = new Map<string, DirectEmailMatch>([[
      lead.full_name,
      {
        email: literal.email,
        source_url: verified.source_url,
        content_hash: verified.content_hash
          ?? createHash('sha256').update(literal.source_quote ?? literal.email).digest('hex'),
        context: verified.context ?? literal.source_quote ?? `${literal.person_name} ${literal.email}`,
        provisional: verified.provisional,
        refetch_outcome: verified.failure_class,
        refetch_attempted_at: new Date().toISOString(),
      },
    ]]);
    const applied = await applyDirectEmailMatches(
      [lead],
      modelMatch,
      companyId,
      verified.provisional ? 'model_report_provisional' : 'model_report_reverified',
      job.requested_by_runs,
    );
    if (!applied.assigned) continue;
    direct += applied.assigned;
    directlyResolved.add(lead.lead_id);
    for (const runId of job.requested_by_runs) {
      await incrementEnrichmentStat(runId, 'd4_model', applied.assigned);
      await incrementEnrichmentStat(runId, 'd4', applied.assigned);
      await incrementEnrichmentStat(runId, 'direct', applied.assigned);
      if (verified.provisional) {
        await incrementEnrichmentStat(runId, 'provisional_direct', applied.assigned);
      }
      if (applied.upgradedInferred) {
        await incrementEnrichmentStat(runId, 'inferred', -applied.upgradedInferred);
      }
      if (applied.upgradedFormatGuess) {
        await incrementEnrichmentStat(runId, 'format_guess', -applied.upgradedFormatGuess);
      }
    }
  }

  const stillUnresolvedForScrape = emailLeads.filter((lead) =>
    (!lead.email || ['inferred', 'format_guess'].includes(lead.email_status ?? ''))
      && !directlyResolved.has(lead.lead_id),
  );
  if (stillUnresolvedForScrape.length) {
    const scrapeDomains = [...new Set([domain, inferenceDomain].filter(Boolean) as string[])];
    const evidenceUrls = [
      ...report.literal_emails.map((literal) => literal.source_url),
      ...report.formats.flatMap((format) => format.evidence.match(/https?:\/\/[^\s)"']+/g) ?? []),
    ];
    for (const scrapeDomain of scrapeDomains) {
      const remaining = stillUnresolvedForScrape.filter((lead) => !directlyResolved.has(lead.lead_id));
      if (!remaining.length) break;
      const scraped = await scrapeAndApplyDirectEmails(
        scrapeDomain,
        remaining,
        job.requested_by_runs,
        'd4_scrape_post',
        evidenceUrls,
        scraper,
      );
      direct += scraped.assigned;
      for (const leadId of scraped.matchedLeadIds) directlyResolved.add(leadId);
    }
  }

  const unresolved = emailLeads.filter((lead) =>
    (!lead.email || lead.email_status === 'format_guess')
      && !directlyResolved.has(lead.lead_id));
  const priorFormatGuesses = unresolved.filter((lead) => lead.email_status === 'format_guess').length;
  const inferred = inferenceDomain
    ? await assignInferredEmails(
      unresolved,
      inferenceDomain,
      patterns,
      {
        method: inferenceMethod,
        formatMeta,
        companyId: inferenceCompanyId,
        runIds: job.requested_by_runs,
      },
    )
    : 0;
  if (!domain) {
    for (const lead of unresolved) {
      await dbQuery(
        `UPDATE outreach.leads
         SET email_status = 'not_found',
             email_source_note = 'no domain found',
             updated_at = now()
         WHERE id = $1 AND email_primary IS NULL
           AND EXISTS (
             SELECT 1 FROM outreach.campaign_leads cl
             JOIN outreach.runs r ON r.id = cl.run_id
             WHERE cl.lead_id = outreach.leads.id AND r.status <> 'cancelled'
           )`,
        [lead.lead_id],
      );
    }
  }

  await dbQuery(
    `UPDATE outreach.company_research_jobs
     SET research_result = $2::jsonb, grade = $3, resolved_domain = $4
     WHERE id = $1`,
    [job.id, JSON.stringify(report), grade, domain],
  );
  for (const runId of job.requested_by_runs) {
    await incrementEnrichmentStat(runId, countAsResearch ? 'companies_researched' : 'companies_cache_hit');
    await incrementEnrichmentStat(
      runId,
      inferenceMethod === 'local' ? 'i1' : patterns.length ? 'i2' : 'i3',
      inferred,
    );
    await incrementEnrichmentStat(
      runId,
      inferenceMethod === 'guessed' ? 'format_guess' : 'inferred',
      inferred,
    );
    if (inferenceMethod !== 'guessed' && priorFormatGuesses) {
      await incrementEnrichmentStat(
        runId,
        'format_guess',
        -Math.min(inferred, priorFormatGuesses),
      );
    }
    if (!domain) {
      await incrementEnrichmentStat(runId, 'i4', unresolved.length);
      await incrementEnrichmentStat(runId, 'not_found', unresolved.length);
    }
    if (job.disambiguation.research_pass === 'email_rescue') {
      await incrementEnrichmentStat(runId, 'email_rescue_jobs_completed');
      if (direct) await incrementEnrichmentStat(runId, 'email_rescue_direct', direct);
      if (inferred && inferenceMethod !== 'guessed') {
        await incrementEnrichmentStat(runId, 'email_rescue_inferred', inferred);
      }
    }
  }
  const emailRescueJobIds = await enqueueEmailRescues(job, report);
  const verifyDomains = [...new Set([domain, inferenceDomain].filter(Boolean) as string[])];
  return {
    domain,
    inferenceDomain,
    direct,
    inferred,
    profile,
    followupJobIds: companyFollowupJobIds,
    profileRescueJobIds: rescueJobIds,
    emailRescueJobIds,
    verifyDomains,
  };
}

async function applyCompletedResearchReport(
  job: ResearchJob,
  report: ResearchReport,
  countAsResearch: boolean,
  dependencies: {
    verifyLiteral?: typeof verifyDirectEmailSource;
    scraper?: typeof scrapeDirectEmails;
  },
) {
  if (job.disambiguation.research_pass === 'profile_rescue') {
    return applyProfileRescueReport(job, report);
  }
  return applyResearchReport(
    job,
    report,
    countAsResearch,
    dependencies.verifyLiteral,
    dependencies.scraper,
  );
}

async function finishResearchJobAndLedger(
  job: ResearchJob,
  status: 'done' | 'failed',
  domain: string | null,
  errorMessage: string | null,
  billedUsage?: import('@/lib/anthropic-pricing').AnthropicUsageContract | null,
): Promise<string[]> {
  const finished = await dbQuery<{ finish_research_job: string[] }>(
    `SELECT public.finish_research_job($1, $2, $3, $4)`,
    [job.id, status, domain, errorMessage],
  );
  try {
    const { recordEnrichmentJobCost } = await import('@/lib/cost-ledger');
    const { rows } = await dbQuery<{ searches_used: number }>(
      `SELECT searches_used FROM outreach.company_research_jobs WHERE id = $1`,
      [job.id],
    );
    await recordEnrichmentJobCost({
      jobId: job.id,
      companyKey: job.company_key,
      runIds: job.requested_by_runs,
      searchesUsed: Number(rows[0]?.searches_used ?? job.searches_used ?? 0),
      billedUsage,
    });
  } catch (error) {
    console.error('lead cost ledger (enrichment) failed:', error);
  }
  return finished.rows[0]?.finish_research_job ?? [];
}

export async function executeResearchJob(
  jobId: string,
  provider?: (disambiguation: ResearchDisambiguation) => Promise<ResearchReport>,
  dependencies: {
    verifyLiteral?: typeof verifyDirectEmailSource;
    scraper?: typeof scrapeDirectEmails;
  } = {},
) {
  const breaker = await dbQuery<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM outreach.company_research_jobs
     WHERE last_error LIKE 'rate_limited:%'
       AND updated_at >= now() - interval '60 seconds'`,
  );
  if ((breaker.rows[0]?.count ?? 0) >= 3) {
    throw new ResearchRetryError('Research circuit breaker is open after repeated rate limits', 300_000);
  }
  const { rows } = await dbQuery<ResearchJob>(
    `SELECT * FROM public.claim_research_job($1)`,
    [jobId],
  );
  const job = rows[0];
  if (!job) {
    // Empty claim used to return success → orch marked done while the backing
    // row stayed in_flight (attempt ceiling / race), permanently blocking finalize.
    const existing = await dbQuery<ResearchJob>(
      `SELECT * FROM outreach.company_research_jobs WHERE id = $1`,
      [jobId],
    );
    const stuck = existing.rows[0];
    if (stuck?.status === 'in_flight') {
      const completedRunIds = await finishResearchJobAndLedger(
        stuck,
        'failed',
        null,
        'claim failed while in_flight (attempt ceiling or stale lease)',
      );
      for (const runId of stuck.requested_by_runs) {
        await incrementEnrichmentInsight(runId, 'research_jobs_failed');
        await decrementRemaining(runId);
      }
      return {
        completedRunIds,
        followupJobIds: [],
        profileRescueJobIds: [],
        emailRescueJobIds: [],
        verifyDomains: [],
      };
    }
    if (stuck?.status === 'done' || stuck?.status === 'failed') {
      const completedRunIds: string[] = [];
      for (const runId of stuck.requested_by_runs) {
        const open = await dbQuery<{ n: number }>(
          `SELECT count(*)::int AS n
             FROM outreach.company_research_jobs
            WHERE $1 = ANY(requested_by_runs)
              AND status IN ('pending', 'in_flight')`,
          [runId],
        );
        if ((open.rows[0]?.n ?? 0) === 0) completedRunIds.push(runId);
      }
      return {
        completedRunIds,
        followupJobIds: [],
        profileRescueJobIds: [],
        emailRescueJobIds: [],
        verifyDomains: [],
      };
    }
    return {
      completedRunIds: [],
      followupJobIds: [],
      profileRescueJobIds: [],
      emailRescueJobIds: [],
      verifyDomains: [],
    };
  }
  const activeRuns: string[] = [];
  for (const runId of job.requested_by_runs) {
    if (!(await runIsCancelled(runId))) activeRuns.push(runId);
  }
  if (!activeRuns.length) {
    const completedRunIds = await finishResearchJobAndLedger(
      job,
      'failed',
      null,
      'all requesting runs cancelled',
    );
    return {
      completedRunIds,
      followupJobIds: [],
      profileRescueJobIds: [],
      emailRescueJobIds: [],
      verifyDomains: [],
    };
  }

  let reservedSearches = 0;
  let billedUsage: import('@/lib/anthropic-pricing').AnthropicUsageContract | null = null;
  const researchStartedAt = Date.now();
  for (const runId of activeRuns) {
    await incrementEnrichmentInsight(runId, 'research_jobs_started');
  }
  try {
    let report: ResearchReport;
    if (provider) {
      report = await provider(job.disambiguation);
    } else {
      const pass = job.disambiguation.research_pass;
      const calculatedBudget = searchBudgetForJob(
        job.disambiguation.people,
        pass ?? 'primary',
      );
      const assignedBudget = Math.max(0, Number(job.search_budget ?? calculatedBudget));
      const remainingBudget = Math.max(0, assignedBudget - Number(job.searches_used ?? 0));
      const configuredCeiling = pass === 'profile_rescue'
        ? configuredResearchSearches('ORG_PROFILE_RESCUE_SEARCH_USES', 1, 1)
        : Math.min(10, calculatedBudget);
      const maxSearchUses = Math.min(remainingBudget, configuredCeiling);
      if (maxSearchUses <= 0) {
        throw new Error('research search budget exhausted');
      }
      reservedSearches = maxSearchUses;
      await dbQuery(
        `UPDATE outreach.company_research_jobs
         SET searches_used = least(search_budget, searches_used + $2), updated_at = now()
         WHERE id = $1`,
        [job.id, reservedSearches],
      );
      for (const runId of activeRuns) {
        await incrementEnrichmentStat(runId, 'research_search_queries', maxSearchUses);
        await incrementEnrichmentStat(runId, 'research_budget_assigned', assignedBudget);
      }
      logPipelineInsight('enrich', `job=${job.id} research_live_start`, {
        pass: pass ?? 'primary',
        companyKey: job.company_key,
        assignedBudget,
        remainingBudget,
        maxSearchUses,
        leadCount: job.disambiguation.people.length,
        hardGaps: profileGapsForPeople(job.disambiguation.people).hardGaps,
      });
      const liveProvider = pass === 'profile_rescue'
        ? researchProfileRescueLive
        : pass === 'email_rescue'
          ? researchEmailRescueLive
          : researchCompanyLive;
      report = await liveProvider(job.disambiguation, { maxSearchUses });
      const actualSearches = Math.max(
        0,
        Math.min(maxSearchUses, Number(report.research_searches_used ?? maxSearchUses)),
      );
      const unusedSearches = maxSearchUses - actualSearches;
      if (unusedSearches) {
        await dbQuery(
          `UPDATE outreach.company_research_jobs
           SET searches_used = greatest(0, searches_used - $2), updated_at = now()
           WHERE id = $1`,
          [job.id, unusedSearches],
        );
        reservedSearches -= unusedSearches;
      }
      for (const runId of activeRuns) {
        if (unusedSearches) await incrementEnrichmentStat(runId, 'research_search_queries', -unusedSearches);
        await incrementEnrichmentStat(runId, 'research_budget_used', actualSearches);
        if (actualSearches >= remainingBudget) {
          await incrementEnrichmentStat(runId, 'research_budget_exhausted');
        }
      }
      report = {
        ...report,
        research_searches_used: actualSearches,
        research_budget_assigned: assignedBudget,
        research_budget_exhausted: actualSearches >= remainingBudget,
      };
    }
    billedUsage = report.research_billed_usage ?? null;
    const stillActive: string[] = [];
    for (const runId of activeRuns) {
      if (!(await runIsCancelled(runId))) stillActive.push(runId);
    }
    if (!stillActive.length) {
      const completedRunIds = await finishResearchJobAndLedger(
        job,
        'failed',
        null,
        'cancelled during research',
        billedUsage,
      );
      return {
        completedRunIds,
        followupJobIds: [],
        profileRescueJobIds: [],
        emailRescueJobIds: [],
        verifyDomains: [],
      };
    }
    const result = await applyCompletedResearchReport(
      { ...job, requested_by_runs: stillActive },
      report,
      true,
      dependencies,
    );
    const gaps = profileGapsForPeople(job.disambiguation.people);
    const pass = job.disambiguation.research_pass ?? 'primary';
    const path: EnrichmentPathKind = pass === 'profile_rescue'
      ? 'profile_rescue'
      : pass === 'email_rescue'
        ? 'email_rescue'
        : 'research_enqueued';
    await persistResearchJobInsight(job.id, buildEnrichmentJobInsight({
      jobKind: pass,
      companyKey: job.company_key,
      path,
      hardGaps: gaps.hardGaps,
      softGaps: gaps.softGaps,
      requestedFields: [...new Set(job.disambiguation.people.flatMap((p) => p.requested_fields ?? []))],
      opportunisticFields: [...new Set(job.disambiguation.people.flatMap((p) => p.opportunistic_fields ?? []))],
      leadCount: job.disambiguation.people.length,
      budget: {
        assigned: Number(report.research_budget_assigned ?? job.search_budget ?? 0),
        used: Number(report.research_searches_used ?? job.searches_used ?? 0),
        remainingBefore: null,
        floorApplied: false,
        hardUnresolvedBeforeBudget: gaps.hardGaps.length,
      },
      decisions: {
        needsHardProfileResearch: peopleNeedHardProfileResearch(job.disambiguation.people),
        scrapePreflightCompleted: false,
        knownDomainSkipResearch: false,
        profileRescueEnqueued: result.profileRescueJobIds.length,
        profileRescueSkipped: 0,
        profileRescueSkipReasons: [],
        emailRescueEnqueued: result.emailRescueJobIds.length,
        followupsEnqueued: result.followupJobIds.length,
      },
      provider: {
        modelId: null,
        promptVersion: null,
        searchesUsed: Number(report.research_searches_used ?? 0),
        costUsd: null,
      },
      timingsMs: {
        researchMs: elapsedMsSafe(researchStartedAt),
        totalMs: elapsedMsSafe(researchStartedAt),
      },
    }));
    for (const runId of stillActive) {
      await incrementEnrichmentInsight(runId, 'research_jobs_done');
      if (result.emailRescueJobIds.length) {
        await incrementEnrichmentInsight(runId, 'email_rescue_enqueued', result.emailRescueJobIds.length);
      }
      if (result.followupJobIds.length) {
        await incrementEnrichmentInsight(runId, 'followups_enqueued', result.followupJobIds.length);
      }
    }
    const completedRunIds = await finishResearchJobAndLedger(
      job,
      'done',
      result.domain,
      null,
      billedUsage,
    );
    for (const runId of stillActive) await decrementRemaining(runId);
    return {
      completedRunIds,
      followupJobIds: result.followupJobIds,
      profileRescueJobIds: result.profileRescueJobIds,
      emailRescueJobIds: result.emailRescueJobIds,
      verifyDomains: result.verifyDomains,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'research failed';
    const status = (error as { status?: number }).status;
    const budgetExhausted = Number(job.searches_used ?? 0) + reservedSearches
      >= Number(job.search_budget ?? 0);
    if (job.attempt_count < 2 && !budgetExhausted) {
      await dbQuery(
        `UPDATE outreach.company_research_jobs
         SET status = 'pending', claimed_at = NULL, last_error = $2, updated_at = now()
         WHERE id = $1`,
        [job.id, status === 429 ? `rate_limited: ${message}` : message],
      );
      const waitMs = status === 429 ? 30_000 : 5_000;
      for (const runId of activeRuns) {
        if (status === 429) {
          await dbQuery(
            `UPDATE outreach.runs
             SET stats = jsonb_set(
               stats, '{enrichment,rate_limit_events}',
               coalesce(stats->'enrichment'->'rate_limit_events', '[]'::jsonb)
                 || jsonb_build_array(jsonb_build_object('ts', now(), 'scope', 'research', 'wait_ms', $2::int)),
               true
             )
             WHERE id = $1`,
            [runId, waitMs],
          );
        }
      }
      throw new ResearchRetryError(message, waitMs, { cause: error });
    }

    if (job.disambiguation.research_pass === 'profile_rescue') {
      const completedRunIds = await finishResearchJobAndLedger(
        job,
        'failed',
        null,
        message,
        billedUsage,
      );
      for (const runId of activeRuns) {
        await incrementEnrichmentStat(
          runId,
          'profile_rescue_jobs_failed',
        );
        await incrementEnrichmentInsight(runId, 'research_jobs_failed');
        await decrementRemaining(runId);
      }
      return {
        completedRunIds,
        followupJobIds: [],
        profileRescueJobIds: [],
        emailRescueJobIds: [],
        verifyDomains: [],
      };
    }

    try {
      if (budgetExhausted) throw new Error('research search budget exhausted');
      const fallbackRemaining = Math.max(
        0,
        Number(job.search_budget ?? 0) - Number(job.searches_used ?? 0) - reservedSearches,
      );
      const fallbackMaxSearchUses = Math.min(
        fallbackRemaining,
        searchBudgetForJob(
          job.disambiguation.people,
          job.disambiguation.research_pass ?? 'primary',
        ),
      );
      if (fallbackMaxSearchUses <= 0) throw new Error('research search budget exhausted');
      await dbQuery(
        `UPDATE outreach.company_research_jobs
         SET searches_used = least(search_budget, searches_used + $2), updated_at = now()
         WHERE id = $1`,
        [job.id, fallbackMaxSearchUses],
      );
      reservedSearches += fallbackMaxSearchUses;
      for (const runId of activeRuns) {
        await incrementEnrichmentStat(runId, 'research_search_queries', fallbackMaxSearchUses);
      }
      const fallback = await researchCompanyWithSearxng(
        job.disambiguation,
        { maxSearchUses: fallbackMaxSearchUses },
      );
      const fallbackActual = Math.max(
        0,
        Math.min(fallbackMaxSearchUses, Number(fallback.research_searches_used ?? fallbackMaxSearchUses)),
      );
      const fallbackUnused = fallbackMaxSearchUses - fallbackActual;
      if (fallbackUnused) {
        await dbQuery(
          `UPDATE outreach.company_research_jobs
           SET searches_used = greatest(0, searches_used - $2), updated_at = now()
           WHERE id = $1`,
          [job.id, fallbackUnused],
        );
        reservedSearches -= fallbackUnused;
      }
      for (const runId of activeRuns) {
        if (fallbackUnused) {
          await incrementEnrichmentStat(runId, 'research_search_queries', -fallbackUnused);
        }
      }
      const fallbackActiveRuns: string[] = [];
      for (const runId of activeRuns) {
        if (!(await runIsCancelled(runId))) fallbackActiveRuns.push(runId);
      }
      if (!fallbackActiveRuns.length) {
        const completedRunIds = await finishResearchJobAndLedger(
          job,
          'failed',
          null,
          'cancelled during fallback research',
          billedUsage,
        );
        return {
          completedRunIds,
          followupJobIds: [],
          profileRescueJobIds: [],
          emailRescueJobIds: [],
          verifyDomains: [],
        };
      }
      const result = await applyCompletedResearchReport(
        { ...job, requested_by_runs: fallbackActiveRuns },
        fallback,
        true,
        dependencies,
      );
      billedUsage = fallback.research_billed_usage ?? billedUsage;
      const completedRunIds = await finishResearchJobAndLedger(
        job,
        'done',
        result.domain,
        null,
        billedUsage,
      );
      for (const runId of fallbackActiveRuns) {
        await decrementRemaining(runId);
      }
      return {
        completedRunIds,
        followupJobIds: result.followupJobIds,
        profileRescueJobIds: result.profileRescueJobIds,
        emailRescueJobIds: result.emailRescueJobIds,
        verifyDomains: result.verifyDomains,
      };
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : 'fallback failed';
      const fallbackStillActive: string[] = [];
      for (const runId of activeRuns) {
        if (!(await runIsCancelled(runId))) fallbackStillActive.push(runId);
      }
      const fallbackDomain = sanitizeDomain(job.disambiguation.candidate_domain);
      let fallbackEmailRescueJobIds: string[] = [];
      if (fallbackDomain && fallbackStillActive.length
        && job.disambiguation.research_scope !== 'person') {
        const fallbackLeads = await leadsForJob({ ...job, requested_by_runs: fallbackStillActive });
        await scrapeAndApplyDirectEmails(
          fallbackDomain,
          fallbackLeads,
          fallbackStillActive,
          'd4_scrape_post',
          [],
          dependencies.scraper,
        );
        const fallbackPatterns = job.disambiguation.local_patterns ?? [];
        const fallbackFormatMeta = fallbackPatterns.map((pattern) => ({ pattern }));
        const fallbackInferred = await assignInferredEmails(
          fallbackLeads.filter((lead) =>
            !lead.email || lead.email_status === 'format_guess'),
          fallbackDomain,
          fallbackPatterns,
          {
            method: fallbackPatterns.length ? 'local' : 'guessed',
            formatMeta: fallbackFormatMeta,
            runIds: fallbackStillActive,
          },
        );
        for (const runId of fallbackStillActive) {
          await incrementEnrichmentStat(runId, fallbackPatterns.length ? 'i1' : 'i3', fallbackInferred);
          await incrementEnrichmentStat(
            runId,
            fallbackPatterns.length ? 'inferred' : 'format_guess',
            fallbackInferred,
          );
        }
        if (!fallbackPatterns.length) {
          fallbackEmailRescueJobIds = await enqueueEmailRescues(
            { ...job, requested_by_runs: fallbackStillActive },
            {
              domain: fallbackDomain,
              domain_confidence: 'likely',
              domain_evidence: '',
              alternate_domain: null,
              literal_emails: [],
              formats: [],
              profile_findings: [],
              company_notes: null,
            },
          );
        }
      }
      const completedRunIds = await finishResearchJobAndLedger(
        job,
        'failed',
        null,
        `${message}; fallback: ${fallbackMessage}`,
        billedUsage,
      );
      for (const runId of fallbackStillActive) {
        await incrementEnrichmentStat(runId, 'companies_failed');
        await incrementEnrichmentInsight(runId, 'research_jobs_failed');
        if (job.disambiguation.research_pass === 'email_rescue') {
          await incrementEnrichmentStat(runId, 'email_rescue_jobs_failed');
        }
      }
      for (const runId of fallbackStillActive) await decrementRemaining(runId);
      return {
        completedRunIds,
        followupJobIds: [],
        profileRescueJobIds: [],
        emailRescueJobIds: fallbackEmailRescueJobIds,
        verifyDomains: fallbackDomain ? [fallbackDomain] : [],
      };
    }
  }
}

export async function verifyRunEmailsWithProvider(runId: string) {
  const { sweepPendingMailboxVerifications } = await import('@/lib/mailbox-verify');
  await sweepPendingMailboxVerifications(runId);
}

export async function finalizeRunEnrichment(runId: string) {
  if (await runIsCancelled(runId)) return [] as string[];
  const {
    canFinalizeEnrichingRun,
    countOpenEnrichmentWork,
  } = await import('@/lib/orchestration/enrichment-finalize-guard');
  const openWork = await countOpenEnrichmentWork(runId);
  if (!canFinalizeEnrichingRun(openWork)) {
    throw new Error(
      `Refusing finalizeRunEnrichment for ${runId}: open research=${openWork.researchJobs} orch=${openWork.orchJobs}`,
    );
  }
  const { rows: domains } = await dbQuery<{ domain: string }>(
    `SELECT DISTINCT lower(split_part(l.email_primary, '@', 2)) AS domain
     FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     WHERE cl.run_id = $1
       AND l.email_status <> 'format_guess'
       AND nullif(split_part(l.email_primary, '@', 2), '') IS NOT NULL`,
    [runId],
  );
  await snapshotRelationshipsForRun(runId);
  const { rows } = await dbQuery<{
    direct: number;
    inferred: number;
    format_guess: number;
    not_found: number;
  }>(
    `SELECT
       count(*) FILTER (WHERE l.email_status IN ('direct', 'from_embark_db'))::int AS direct,
       count(*) FILTER (WHERE l.email_status = 'inferred')::int AS inferred,
       count(*) FILTER (WHERE l.email_status = 'format_guess')::int AS format_guess,
       count(*) FILTER (WHERE l.email_status = 'not_found')::int AS not_found
     FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     WHERE cl.run_id = $1`,
    [runId],
  );
  await dbQuery(
    `UPDATE outreach.runs
     SET status = 'complete',
         stats = jsonb_set(
           stats, '{enrichment}',
           coalesce(stats->'enrichment', '{}'::jsonb) || $2::jsonb,
           true
         ),
         finished_at = now()
     WHERE id = $1 AND status <> 'cancelled'`,
    [runId, JSON.stringify(rows[0] ?? {
      direct: 0,
      inferred: 0,
      format_guess: 0,
      not_found: 0,
    })],
  );
  return domains.map(({ domain }) => domain);
}

export async function verifyDomainMx(domain: string, runId?: string) {
  const normalized = sanitizeDomain(domain);
  if (!normalized) return 'unknown' as const;
  const existing = await dbQuery<{ mx_status: string | null }>(
    `SELECT mx_status FROM outreach.companies
     WHERE domain = $1 AND verified_at >= now() - interval '30 days'`,
    [normalized],
  );
  let status: 'ok' | 'no_mx' | 'unknown' =
    existing.rows[0]?.mx_status === 'ok' || existing.rows[0]?.mx_status === 'no_mx'
      ? existing.rows[0].mx_status
      : 'unknown';
  if (status === 'unknown') {
    try {
      const records = await resolveMxOverHttps(normalized);
      status = records.some((record) => record.exchange && record.exchange !== '.')
        ? 'ok'
        : 'no_mx';
    } catch {
      status = 'unknown';
    }
  }
  const changedLeads = await dbTransaction(async (client) => {
    await client.query(
      `UPDATE outreach.companies SET mx_status = $2, verified_at = now() WHERE domain = $1`,
      [normalized, status],
    );
    if (!runId) return 0;
    const { rows: leads } = await client.query<{ id: string; email_source_note: string | null }>(
      `SELECT l.id, l.email_source_note
       FROM outreach.campaign_leads cl
       JOIN outreach.leads l ON l.id = cl.lead_id
       WHERE cl.run_id = $2
         AND l.email_status <> 'format_guess'
         AND l.email_mx_status IS DISTINCT FROM $3
           AND (
             lower(split_part(l.email_primary, '@', 2)) = $1
             OR lower(split_part(l.email_alt_1, '@', 2)) = $1
             OR lower(split_part(l.email_alt_2, '@', 2)) = $1
           )`,
      [normalized, runId, status],
    );
    if (status === 'no_mx') {
      for (const lead of leads) {
        await client.query(
          `UPDATE outreach.leads
           SET email_mx_status = $2,
               email_source_note = $3,
               updated_at = now()
           WHERE id = $1`,
          [lead.id, status, appendMxWarningToSourceNote(lead.email_source_note)],
        );
      }
    } else if (leads.length) {
      await client.query(
        `UPDATE outreach.leads
         SET email_mx_status = $2,
             updated_at = now()
         WHERE id = ANY($1::uuid[])`,
        [leads.map((lead) => lead.id), status],
      );
    }
    return leads.length;
  });
  if (runId && changedLeads > 0 && (status === 'ok' || status === 'no_mx')) {
    await incrementEnrichmentStat(runId, status === 'ok' ? 'verified_ok' : 'verified_no_mx');
  }
  return status;
}
