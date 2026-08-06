import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPattern, inferEmails, maxCandidatesForFormats, rankFormatsForInference, type EmailPattern } from '@/lib/email-patterns';
import {
  appendCollisionToSourceNote,
  appendMxWarningToSourceNote,
  buildDirectWebLiteralNote,
  buildInferredSourceNote,
  confidenceTierFromCandidateCount,
  truncateSourceNote,
} from '@/lib/email-source-note';
import { resolveInferenceDomain } from '@/lib/inference-domain';
import { corroboratingSignals, isPriorHubEnrichmentReuse, isPriorLeadReuse, priorLeadGuessUntrusted } from '@/lib/identity';
import { priorFormatGuessNeedsWebResearch, unresolvedProfileFields } from '@/lib/enrichment';
import {
  buildDisambiguation,
  evidenceBackedFormats,
  gradeReport,
  isHighConfidenceProfileFinding,
  mergeProfileRescueFindings,
  researchJobKey,
  sanitizeDomain,
  type ProfileFinding,
  type ResearchReport,
  type ResearchPerson,
} from '@/lib/research-types';
import { validateResearchReport } from '@/lib/research-provider';
import { scrapeDirectEmails, verifyDirectEmailSource } from '@/lib/site-scraper';

test('past-lead provenance excludes same-run duplicates', () => {
  assert.equal(isPriorLeadReuse({ source: 'lead', source_run_id: 'older-run' }, 'current-run'), true);
  assert.equal(isPriorLeadReuse({ source: 'lead', source_run_id: 'current-run' }, 'current-run'), false);
});

test('prior hub enrichment gate excludes sparse prior leads', () => {
  const enrichedPrior = {
    source: 'lead' as const,
    source_run_id: 'older-run',
    email: 'a@example.com',
    title: 'CFO',
    company: 'Acme',
    location: null,
    email_status: 'direct',
  };
  assert.equal(isPriorHubEnrichmentReuse(enrichedPrior, 'current-run'), true);
  assert.equal(isPriorHubEnrichmentReuse({ ...enrichedPrior, source_run_id: 'current-run' }, 'current-run'), false);
  assert.equal(isPriorHubEnrichmentReuse({ source: 'lead', source_run_id: 'older-run', email: null, title: null, company: null, location: null, email_status: 'not_found' }, 'current-run'), false);
});

test('sparse uploads confirm prior leads when name and company both match', () => {
  const person = {
    full_name: 'Mike Crawford',
    company: 'TBC Corporation',
    title: undefined,
    location: undefined,
    email: undefined,
    linkedin_url: undefined,
  };
  const priorLead = {
    name: 'Mike Crawford',
    company: 'TBC Corporation',
    title: 'Director, FP&A, Corporate Services & Workforce Planning',
    location: null,
    email: 'mike.crawford@tbccorp.com',
  };
  assert.equal(corroboratingSignals(person, priorLead), 2);
});

test('prior format-guess emails are untrusted and still require web research', () => {
  assert.equal(priorLeadGuessUntrusted('format_guess'), true);
  assert.equal(priorLeadGuessUntrusted('inferred'), false);
  assert.equal(priorLeadGuessUntrusted('direct'), false);
  assert.equal(
    priorFormatGuessNeedsWebResearch([
      { email_status: 'inferred' },
      { email_status: 'format_guess' },
    ]),
    true,
  );
  assert.equal(
    priorFormatGuessNeedsWebResearch([{ email_status: 'inferred' }]),
    false,
  );
});

test('email patterns normalize accents, punctuation, and multi-word names', () => {
  assert.equal(applyPattern('first.last', 'José', "van der Berg"), 'jose.vanderberg');
  assert.equal(applyPattern('flast', 'Anne-Marie', "O'Brien"), 'aobrien');
  assert.equal(applyPattern('lastf', 'Jane', 'Smith'), 'smithj');
  assert.deepEqual(
    inferEmails('Example.COM', 'Jane', 'Smith', ['first.last']),
    ['jane.smith@example.com'],
  );
});

test('high-confidence single format emits one candidate', () => {
  assert.equal(
    maxCandidatesForFormats([{ pattern: 'firstl', confidence: 'high', share_pct: 94.8 }], true),
    1,
  );
  assert.deepEqual(
    inferEmails('surfpci.com', 'Andrea', 'Carter', ['firstl'], 1),
    ['andreac@surfpci.com'],
  );
});

test('conflicting or medium formats emit two candidates', () => {
  assert.equal(
    maxCandidatesForFormats([
      { pattern: 'first.last', confidence: 'high' },
      { pattern: 'flast', confidence: 'high' },
    ], true),
    2,
  );
  assert.equal(
    maxCandidatesForFormats([{ pattern: 'first.last', confidence: 'medium', share_pct: 55 }], true),
    2,
  );
});

test('evidence-backed formats are never padded with blind defaults', () => {
  assert.deepEqual(
    inferEmails('example.com', 'Jane', 'Smith', ['flast'], 3),
    ['jsmith@example.com'],
  );
});

test('rankFormatsForInference puts the strongest evidence first for multi-column inference', () => {
  const ranked = rankFormatsForInference([
    {
      pattern: 'first.last',
      confidence: 'low',
      share_pct: null,
      evidence: 'LeadIQ notes secondary First.Last at https://leadiq.com/acme',
    },
    {
      pattern: 'flast',
      confidence: 'medium',
      share_pct: 86.4,
      evidence: 'RocketReach reports flast at https://rocketreach.co/acme and ContactOut at https://contactout.com/acme',
    },
  ], 'acme.com');
  assert.deepEqual(ranked.map((format) => format.pattern), ['flast', 'first.last']);
  assert.deepEqual(
    inferEmails('acme.com', 'Jane', 'Doe', ranked.map((format) => format.pattern as EmailPattern), 2),
    ['jdoe@acme.com', 'jane.doe@acme.com'],
  );
});

test('verified coworker samples outrank aggregator-only formats', () => {
  const ranked = rankFormatsForInference([
    {
      pattern: 'first.last',
      confidence: 'medium',
      share_pct: 66,
      evidence: 'LeadIQ reports First.Last at https://leadiq.com/trilantic',
    },
    {
      pattern: 'flast',
      confidence: 'high',
      verified_sample: true,
      evidence: 'https://trilantic.com/contact — verified named employee sample',
    },
  ], 'trilantic.com');
  assert.deepEqual(ranked.map((format) => format.pattern), ['flast', 'first.last']);
});

test('dominant share_pct ranks first even when multiple columns are emitted', () => {
  const ranked = rankFormatsForInference([
    { pattern: 'first.last', confidence: 'low', share_pct: 10, evidence: 'https://example.org/a' },
    { pattern: 'flast', confidence: 'medium', share_pct: 86, evidence: 'https://example.org/b' },
  ], 'acme.com');
  assert.equal(maxCandidatesForFormats(ranked, true), 2);
  assert.deepEqual(
    inferEmails('acme.com', 'Jane', 'Doe', ranked.map((format) => format.pattern as EmailPattern), 2),
    ['jdoe@acme.com', 'jane.doe@acme.com'],
  );
});

test('format evidence domain overrides website domain for inference', () => {
  assert.equal(
    resolveInferenceDomain('pcibrands.com', ['andreac@surfpci.com (94.8% use firstl)']),
    'surfpci.com',
  );
  assert.equal(
    resolveInferenceDomain('seaboardmarine.com', ['joel.martin@seaboardmarine.com on contact page']),
    'seaboardmarine.com',
  );
});

test('email source notes are plain English and stay within fifteen words', () => {
  assert.equal(confidenceTierFromCandidateCount(1), 'high');
  assert.equal(confidenceTierFromCandidateCount(2), 'medium');
  assert.equal(confidenceTierFromCandidateCount(3), 'low');

  const note = buildInferredSourceNote({ method: 'web', domain: 'surfpci.com', confidenceTier: 'high' });
  assert.ok(note.split(/\s+/).length <= 15);
  assert.doesNotMatch(note, /firstl|flast|first\.last|%/);
  assert.match(note, /Best guess for surfpci\.com/);
  assert.match(note, /public research/);

  const mediumLocal = buildInferredSourceNote({ method: 'local', domain: 'acme.com', confidenceTier: 'medium' });
  assert.ok(mediumLocal.split(/\s+/).length <= 15);
  assert.match(mediumLocal, /prior Helios leads/);

  const guessed = buildInferredSourceNote({ method: 'guessed', domain: 'acme.com', confidenceTier: 'low' });
  assert.ok(guessed.split(/\s+/).length <= 15);
  assert.match(guessed, /no email format evidence/);

  const direct = buildDirectWebLiteralNote('jane@acme.com');
  assert.ok(direct.split(/\s+/).length <= 15);
  assert.match(direct, /Confirmed real email/);
  assert.match(direct, /acme\.com/);
  const directWithPath = buildDirectWebLiteralNote(
    'jane@acme.com',
    'https://acme.com/company/contact-directory',
  );
  assert.ok(directWithPath.split(/\s+/).length <= 15);
  assert.match(directWithPath, /contact-directory/);

  const withCollision = appendCollisionToSourceNote(note, ['John Doe']);
  assert.ok(withCollision.split(/\s+/).length <= 15);
  assert.match(withCollision, /also guessed for John Doe/);

  const withMx = appendMxWarningToSourceNote(note);
  assert.ok(withMx.split(/\s+/).length <= 15);
  assert.match(withMx, /can.t receive email$/);

  const truncated = truncateSourceNote('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen');
  assert.equal(truncated.split(/\s+/).length, 15);
});

test('single-token names emit only valid candidates', () => {
  assert.equal(applyPattern('first.last', 'Prince', ''), null);
  assert.deepEqual(inferEmails('example.com', 'Prince', '', ['first.last']), []);
  assert.deepEqual(inferEmails('example.com', 'Prince', '', []), ['prince@example.com']);
});

test('domain filtering rejects free-mail and directory hosts', () => {
  assert.equal(sanitizeDomain('https://www.Acme.com/about'), 'acme.com');
  assert.equal(sanitizeDomain('gmail.com'), null);
  assert.equal(sanitizeDomain('linkedin.com'), null);
});

test('disambiguation keys separate same-name companies with different people', () => {
  const first = buildDisambiguation('Apex Partners LLC', [{
    lead_id: '1', full_name: 'Jane Smith', first_name: 'Jane', last_name: 'Smith',
    title: 'CFO', location: 'Dallas, TX',
  }]);
  const second = buildDisambiguation('Apex Partners', [{
    lead_id: '2', full_name: 'John Doe', first_name: 'John', last_name: 'Doe',
    title: 'Controller', location: 'Boston, MA',
  }]);
  assert.notEqual(first.context_hash, second.context_hash);
  assert.notEqual(researchJobKey(first), researchJobKey(second));
});

test('literal emails grade A and domain-only results grade D', () => {
  const base: ResearchReport = {
    domain: 'acme.com',
    domain_confidence: 'confirmed',
    domain_evidence: 'https://acme.com',
    alternate_domain: null,
    literal_emails: [],
    formats: [],
    profile_findings: [],
    company_notes: null,
  };
  assert.equal(gradeReport(base), 'D');
  assert.equal(gradeReport({
    ...base,
    literal_emails: [{ person_name: 'Jane Smith', email: 'jane@acme.com', source_url: 'https://acme.com/team' }],
  }), 'A');
  assert.equal(gradeReport({ ...base, domain: null, domain_confidence: 'none' }), 'F');
});

test('any cited, real-pattern format evidence beats a blind guess, even a single low-confidence citation', () => {
  const formats = evidenceBackedFormats([
    {
      pattern: 'first.last',
      share_pct: 90,
      confidence: 'high',
      evidence: 'Published at https://example.com/email-format',
    },
    {
      pattern: 'flast',
      share_pct: null,
      confidence: 'low',
      evidence: 'Weak claim at https://example.org/guess',
    },
    {
      pattern: 'first',
      share_pct: 80,
      confidence: 'medium',
      evidence: 'No cited URL',
    },
    {
      pattern: 'first_last',
      share_pct: null,
      confidence: 'medium',
      evidence: 'Single weak source https://example.net/pattern',
    },
    {
      pattern: 'lastf',
      share_pct: null,
      confidence: 'low',
      evidence: 'RocketReach reports lastf at https://rocketreach.co/acme and LeadIQ independently reports the same at https://leadiq.com/acme',
    },
    {
      pattern: 'other',
      share_pct: null,
      confidence: 'low',
      evidence: 'Some unclassifiable pattern at https://example.com/weird',
    },
  ]);
  // Every cited, real-pattern claim counts now, regardless of confidence tier
  // or corroboration — even a single weak citation is strictly better
  // evidence than the zero-evidence blind guess. Only two things still get
  // dropped: 'first' (no cited URL at all — a bare assertion, not evidence)
  // and 'other' (not a real, usable pattern).
  assert.deepEqual(
    formats.map((format) => format.pattern),
    ['first.last', 'flast', 'first_last', 'lastf'],
  );
});

test('masked emails are never accepted as direct findings', () => {
  const report = validateResearchReport({
    domain: 'acme.com',
    domain_confidence: 'confirmed',
    domain_evidence: 'https://acme.com',
    alternate_domain: null,
    literal_emails: [
      { person_name: 'Jane Smith', email: 'j***@acme.com', source_url: 'https://example.com/result' },
      { person_name: 'Jane Smith', email: 'jane.smith@acme.com', source_url: 'https://acme.com/team' },
    ],
    formats: [],
    profile_findings: [],
    company_notes: null,
  });
  assert.deepEqual(report.literal_emails, [
    { person_name: 'Jane Smith', email: 'jane.smith@acme.com', source_url: 'https://acme.com/team' },
  ]);
});

test('generic and personal-mail literals never become person-direct findings', () => {
  const report = validateResearchReport({
    domain: 'acme.com',
    domain_confidence: 'confirmed',
    domain_evidence: 'https://acme.com',
    alternate_domain: null,
    literal_emails: [
      {
        person_name: 'Jane Smith',
        email: 'support@acme.com',
        source_url: 'https://acme.com/contact',
        source_quote: 'Support: support@acme.com',
      },
      {
        person_name: 'Jane Smith',
        email: 'jane.smith@gmail.com',
        source_url: 'https://example.com/bio',
        source_quote: 'Jane Smith: jane.smith@gmail.com',
      },
    ],
    formats: [],
    profile_findings: [],
    company_notes: null,
  });
  assert.deepEqual(report.literal_emails, []);
});

test('direct scraper discovers nonstandard contact links and binds literal emails', async () => {
  const pages = new Map([
    ['https://acme.com/', '<a href="/company/contact-directory">People directory</a>'],
    [
      'https://acme.com/company/contact-directory',
      '<section><h2>Jane Smith</h2><a href="mailto:jane.smith@acme.com">Email Jane</a></section>',
    ],
  ]);
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    const body = pages.get(url);
    return new Response(body ?? 'not found', {
      status: body ? 200 : 404,
      headers: { 'content-type': 'text/html' },
    });
  };
  const result = await scrapeDirectEmails(
    'acme.com',
    [{ full_name: 'Jane Smith', first_name: 'Jane', last_name: 'Smith' }],
    { fetchImpl, deadlineMs: 2_000, maxPages: 16 },
  );
  assert.equal(result.get('Jane Smith')?.email, 'jane.smith@acme.com');
  assert.equal(
    result.get('Jane Smith')?.source_url,
    'https://acme.com/company/contact-directory',
  );
  assert.ok(result.diagnostics.pagesFetched >= 2);
});

test('direct scraper decodes obfuscation and rejects generic inboxes', async () => {
  const html = `
    <div>Jane Smith — jane [at] acme [dot] com</div>
    <div>Support Team — support@acme.com</div>
  `;
  const fetchImpl = async (input: string | URL | Request) =>
    new Response(String(input).endsWith('/') ? html : 'not found', {
      status: String(input).endsWith('/') ? 200 : 404,
      headers: { 'content-type': 'text/html' },
    });
  const result = await scrapeDirectEmails(
    'acme.com',
    [{ full_name: 'Jane Smith', first_name: 'Jane', last_name: 'Smith' }],
    { fetchImpl, deadlineMs: 1_000, maxPages: 1 },
  );
  assert.equal(result.get('Jane Smith')?.email, 'jane@acme.com');
  assert.notEqual(result.get('Jane Smith')?.email, 'support@acme.com');
});

test('direct source verification requires the exact email and named person', async () => {
  const fetchImpl = async () => new Response(
    '<article>Jane Smith can be reached at jane.smith@acme.com.</article>',
    { status: 200, headers: { 'content-type': 'text/html' } },
  );
  const verified = await verifyDirectEmailSource({
    source_url: 'https://news.example.com/jane-smith',
    email: 'jane.smith@acme.com',
    person_name: 'Jane Smith',
    domain: 'acme.com',
  }, { fetchImpl });
  assert.equal(verified.verified, true);

  const wrongPerson = await verifyDirectEmailSource({
    source_url: 'https://news.example.com/jane-smith',
    email: 'jane.smith@acme.com',
    person_name: 'John Smith',
    domain: 'acme.com',
  }, { fetchImpl });
  assert.equal(wrongPerson.verified, false);
});

const missingLocationPerson: ResearchPerson = {
  lead_id: 'lead-1',
  full_name: 'Jane Smith',
  first_name: 'Jane',
  last_name: 'Smith',
  title: 'Chief Financial Officer',
  location: null,
  email: 'jane@acme.com',
  requested_fields: ['location'],
};

test('profile enrichment accepts only triangulated person-specific work location', () => {
  const finding = {
    person_name: 'Jane Smith',
    field: 'location' as const,
    value: 'Dallas, TX',
    confidence: 'high' as const,
    reasoning: 'Two independent sources explicitly place Jane in Dallas.',
    location_scope: 'person_work_location' as const,
    evidence: [
      {
        url: 'https://acme.com/team/jane-smith',
        source_type: 'first_party' as const,
        quote: 'Jane Smith is based in Dallas, TX.',
        value: 'Dallas, TX',
        person_specific: true,
        location_scope: 'person_work_location' as const,
      },
      {
        url: 'https://conference.org/speakers/jane-smith',
        source_type: 'conference_bio' as const,
        quote: 'Jane Smith works from Dallas, TX.',
        value: 'Dallas, TX',
        person_specific: true,
        location_scope: 'person_work_location' as const,
      },
    ],
  };
  assert.equal(isHighConfidenceProfileFinding(finding, missingLocationPerson), true);
  assert.equal(isHighConfidenceProfileFinding({
    ...finding,
    location_scope: 'company_location',
  }, missingLocationPerson), false);
  assert.equal(isHighConfidenceProfileFinding({
    ...finding,
    evidence: finding.evidence.map((item) => ({
      ...item,
      url: item.url.replace('conference.org', 'news.acme.com'),
    })),
  }, missingLocationPerson), true);
});

test('profile enrichment rejects one-source findings without corroborating identity context', () => {
  const finding = {
    person_name: 'Jane Smith',
    field: 'title' as const,
    value: 'Chief Financial Officer',
    confidence: 'high' as const,
    reasoning: 'Direct source.',
    evidence: [{
      url: 'https://acme.com/team/jane-smith',
      source_type: 'first_party' as const,
      quote: 'Jane Smith is Chief Financial Officer.',
      value: 'Chief Financial Officer',
      person_specific: true,
    }],
  };
  const sparsePerson: ResearchPerson = {
    lead_id: 'lead-sparse',
    full_name: 'Jane Smith',
    first_name: 'Jane',
    last_name: 'Smith',
    title: null,
    location: null,
    email: null,
    requested_fields: ['title'],
  };
  assert.equal(isHighConfidenceProfileFinding(finding, sparsePerson), false);
});

test('profile rescue carries forward only agreeing first-pass evidence', () => {
  const firstPass: ProfileFinding = {
    person_name: 'Jane Smith',
    field: 'title',
    value: 'Chief Financial Officer',
    confidence: 'medium',
    reasoning: 'One direct source found.',
    evidence: [{
      url: 'https://acme.com/team/jane-smith',
      source_type: 'first_party',
      quote: 'Jane Smith is Chief Financial Officer.',
      value: 'Chief Financial Officer',
      person_specific: true,
    }],
  };
  const rescue: ProfileFinding = {
    ...firstPass,
    confidence: 'high',
    reasoning: 'A second independent source corroborates the candidate.',
    evidence: [{
      url: 'https://conference.org/speakers/jane-smith',
      source_type: 'conference_bio',
      quote: 'Jane Smith, Chief Financial Officer at Acme, will speak.',
      value: 'Chief Financial Officer',
      person_specific: true,
    }],
  };
  const conflicting = { ...firstPass, value: 'Chief Operating Officer' };
  const [merged] = mergeProfileRescueFindings([rescue], [firstPass, conflicting]);
  assert.equal(merged.evidence.length, 2);
  assert.equal(isHighConfidenceProfileFinding(merged, {
    lead_id: 'lead-rescue',
    full_name: 'Jane Smith',
    first_name: 'Jane',
    last_name: 'Smith',
    title: null,
    location: null,
    requested_fields: ['title'],
  }), true);
});

test('profile rescue targets only fields still blank after the first pass', () => {
  assert.deepEqual(
    unresolvedProfileFields(
      ['company_name', 'title', 'location'],
      { company_name: 'Acme', title: '', location: 'Dallas, TX' },
    ),
    ['title'],
  );
  const primary = buildDisambiguation('Acme', [missingLocationPerson]);
  const rescue = {
    ...primary,
    research_pass: 'profile_rescue' as const,
    profile_rescue_context: {
      parent_job_id: 'job-1',
      domain: 'acme.com',
      domain_evidence: '',
      alternate_domain: null,
      company_notes: null,
      prior_findings: [],
    },
  };
  assert.notEqual(researchJobKey(rescue), researchJobKey(primary));
});

test('profile enrichment accepts harmless title and location wording differences', () => {
  const person: ResearchPerson = {
    lead_id: 'lead-2',
    full_name: 'Gary Smith',
    first_name: 'Gary',
    last_name: 'Smith',
    title: null,
    location: null,
    requested_fields: ['location'],
  };
  assert.equal(isHighConfidenceProfileFinding({
    person_name: 'Gary Smith',
    field: 'location',
    value: 'Miami, Florida',
    confidence: 'high',
    reasoning: 'Independent person-specific sources agree on Miami.',
    location_scope: 'person_work_location',
    evidence: [
      {
        url: 'https://www.linkedin.com/in/garysmithcpa/',
        source_type: 'professional_profile',
        quote: 'Experience: Brightline Trains · Location: Miami',
        value: 'Miami',
        person_specific: true,
        location_scope: 'person_work_location',
      },
      {
        url: 'https://profiles.example.org/gary-smith',
        source_type: 'other',
        quote: 'Gary Smith works in Miami, Florida.',
        value: 'Miami, Florida',
        person_specific: true,
        location_scope: 'person_work_location',
      },
    ],
  }, person), true);
});

test('confidence gate accepts corroborated authoritative findings but rejects news-only company claims', () => {
  const bruno: ResearchPerson = {
    lead_id: 'bruno',
    full_name: 'Bruno Barros',
    first_name: 'Bruno',
    last_name: 'Barros',
    title: 'Corporate Controller',
    location: 'Greater Philadelphia',
    email: null,
    requested_fields: ['company_name'],
  };
  assert.equal(isHighConfidenceProfileFinding({
    person_name: 'Bruno Barros',
    field: 'company_name',
    value: 'AEG FUELS (Associated Energy Group)',
    confidence: 'high',
    reasoning: 'Professional profile matches the supplied title and location.',
    evidence: [{
      url: 'https://www.signalhire.com/profiles/bruno-barros',
      source_type: 'professional_profile',
      quote: 'Bruno Barros works as Corporate Controller for AEG FUELS.',
      value: 'AEG FUELS',
      person_specific: true,
    }],
  }, bruno), true);

  const nada: ResearchPerson = {
    lead_id: 'nada',
    full_name: 'Nada Yared',
    first_name: 'Nada',
    last_name: 'Yared',
    title: 'Chief Financial Officer',
    location: null,
    email: 'nada.yared@nauticalventures.com',
    requested_fields: ['location'],
  };
  assert.equal(isHighConfidenceProfileFinding({
    person_name: 'Nada Yared',
    field: 'location',
    value: 'Miami-Fort Lauderdale Area',
    confidence: 'medium',
    reasoning: 'Her professional profile supplies the work location.',
    location_scope: 'person_work_location',
    evidence: [{
      url: 'https://www.linkedin.com/in/nada-yared/',
      source_type: 'professional_profile',
      quote: 'Experience: Nautical Ventures · Location: Miami-Fort Lauderdale Area',
      value: 'Miami-Fort Lauderdale Area',
      person_specific: true,
      location_scope: 'person_work_location',
    }],
  }, nada), true);

  const iraq: ResearchPerson = {
    lead_id: 'iraq',
    full_name: 'Iraq Pacheco',
    first_name: 'Iraq',
    last_name: 'Pacheco',
    title: 'Chief Financial Officer',
    location: 'Miami, Florida',
    email: null,
    requested_fields: ['company_name'],
  };
  assert.equal(isHighConfidenceProfileFinding({
    person_name: 'Iraq Pacheco',
    field: 'company_name',
    value: '7Air',
    confidence: 'high',
    reasoning: 'News reports make the claim, but no authoritative profile confirms it.',
    evidence: [
      {
        url: 'https://aircargonews.net/people/iraq-pacheco',
        source_type: 'reputable_news',
        quote: 'Iraq Pacheco joined 7Air.',
        value: '7Air',
        person_specific: true,
      },
      {
        url: 'https://cargonewswire.com/iraq-pacheco',
        source_type: 'press_release',
        quote: 'Iraq Pacheco serves at 7Air.',
        value: '7Air',
        person_specific: true,
      },
    ],
  }, iraq), false);
});
