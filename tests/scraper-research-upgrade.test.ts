import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveFormatFromSamples } from '@/lib/derive-format';
import { buildNameSearchVariants } from '@/lib/person-name-aliases';
import {
  emailResearchBudget,
  shardPeopleForEmailResearch,
} from '@/lib/research-budget';
import { buildResearchQueryPlan } from '@/lib/research-provider';
import {
  buildDisambiguation,
  rescueFrontierAdvanced,
  type ResearchPerson,
  type ResearchReport,
} from '@/lib/research-types';
import {
  scrapeDirectEmails,
  verifyDirectEmailSource,
  type SiteScraperFetch,
} from '@/lib/site-scraper';

const people = (count: number): ResearchPerson[] => Array.from({ length: count }, (_, index) => ({
  lead_id: String(index + 1),
  full_name: `Person ${index + 1}`,
  first_name: 'Person',
  last_name: String(index + 1),
  title: null,
  location: null,
  email: null,
  email_status: null,
}));

test('adaptive budget follows the 2.5-person rule and shards at five', () => {
  assert.equal(emailResearchBudget(1), 5);
  assert.equal(emailResearchBudget(2), 5);
  assert.equal(emailResearchBudget(3), 10);
  assert.equal(emailResearchBudget(5), 10);
  assert.deepEqual(shardPeopleForEmailResearch(people(6)).map((shard) => shard.length), [5, 1]);
});

test('target query plans include name variants and purposeful format sources', () => {
  const disambiguation = buildDisambiguation('Acme Partners', [{
    ...people(1)[0],
    full_name: 'William Smith',
    first_name: 'William',
    last_name: 'Smith',
  }]);
  const plan = buildResearchQueryPlan({ ...disambiguation, candidate_domain: 'acme.com' });
  assert.ok(plan.some((item) => item.query.includes('"bill smith"')));
  assert.ok(plan.some((item) => item.family === 'format_rocketreach'));
  assert.ok(plan.some((item) => item.family === 'format_zoominfo'));
  assert.ok(buildNameSearchVariants({ full_name: 'William (Bill) Smith' })
    .some((variant) => variant.display === 'bill smith'));
});

test('temporary page failures retry and retain classified outcomes', async () => {
  let calls = 0;
  const fetchImpl: SiteScraperFetch = async () => {
    calls++;
    if (calls === 1) return new Response('temporary', { status: 503 });
    return new Response('Jane Smith jane.smith@acme.com', {
      headers: { 'content-type': 'text/html' },
    });
  };
  const result = await scrapeDirectEmails(
    'acme.com',
    [{ full_name: 'Jane Smith' }],
    { fetchImpl, maxPages: 1, maxRetries: 2, deadlineMs: 2_000 },
  );
  assert.equal(
    result.get('Jane Smith')?.email,
    'jane.smith@acme.com',
    JSON.stringify(result.diagnostics),
  );
  assert.equal(result.diagnostics.retries, 1);
  assert.equal(result.diagnostics.outcomes.error_http, 1);
  assert.equal(result.diagnostics.outcomes.fetched_html, 1);
});

test('global backpressure holds under four-times parallel scraper load', async () => {
  const previousGlobal = process.env.ORG_SCRAPE_GLOBAL_CONCURRENCY;
  const previousHost = process.env.ORG_SCRAPE_PER_HOST_CONCURRENCY;
  process.env.ORG_SCRAPE_GLOBAL_CONCURRENCY = '2';
  process.env.ORG_SCRAPE_PER_HOST_CONCURRENCY = '2';
  let active = 0;
  let maximum = 0;
  const fetchImpl: SiteScraperFetch = async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active--;
    return new Response('<html><body>No email</body></html>', {
      headers: { 'content-type': 'text/html' },
    });
  };
  try {
    await Promise.all(Array.from({ length: 4 }, (_, index) =>
      scrapeDirectEmails(
        `acme${index}.com`,
        [{ full_name: 'Jane Smith' }],
        { fetchImpl, maxPages: 2, concurrency: 4, maxRetries: 0, deadlineMs: 3_000 },
      )));
    assert.ok(maximum <= 2, `expected at most two concurrent fetches, saw ${maximum}`);
  } finally {
    if (previousGlobal === undefined) delete process.env.ORG_SCRAPE_GLOBAL_CONCURRENCY;
    else process.env.ORG_SCRAPE_GLOBAL_CONCURRENCY = previousGlobal;
    if (previousHost === undefined) delete process.env.ORG_SCRAPE_PER_HOST_CONCURRENCY;
    else process.env.ORG_SCRAPE_PER_HOST_CONCURRENCY = previousHost;
  }
});

test('nonstandard locale route is discovered from application state', async () => {
  const fetchImpl: SiteScraperFetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/') {
      return new Response('<script>window.routes=["/us/en/investment-professionals"]</script>', {
        headers: { 'content-type': 'text/html' },
      });
    }
    if (url.pathname === '/us/en/investment-professionals') {
      return new Response('Jane Smith jane.smith@acme.com', {
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response('missing', { status: 404 });
  };
  const result = await scrapeDirectEmails(
    'acme.com',
    [{ full_name: 'Jane Smith' }],
    { fetchImpl, maxPages: 8, concurrency: 1, maxRetries: 0, deadlineMs: 3_000 },
  );
  assert.equal(
    result.get('Jane Smith')?.email,
    'jane.smith@acme.com',
    JSON.stringify(result.diagnostics),
  );
});

test('JS shell uses injected renderer and nickname binding', async () => {
  const fetchImpl: SiteScraperFetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/our-people') {
      return new Response('<div id="__next">Loading</div><script src="/chunk.js"></script>', {
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response('missing', { status: 404 });
  };
  const result = await scrapeDirectEmails(
    'acme.com',
    [{ full_name: 'William Smith', first_name: 'William', last_name: 'Smith' }],
    {
      fetchImpl,
      preferredPaths: ['/our-people'],
      renderFetch: async (url) => ({
        finalUrl: url.toString(),
        html: '<main>Bill Smith bill.smith@acme.com</main>',
      }),
      maxPages: 8,
      concurrency: 1,
      maxRetries: 0,
      deadlineMs: 3_000,
    },
  );
  assert.equal(result.get('William Smith')?.email, 'bill.smith@acme.com');
  assert.equal(result.diagnostics.renderedPages, 1);
  assert.equal(result.diagnostics.nicknameMatches, 1);
});

test('image email extraction uses injected local OCR and fails safely', async () => {
  const fetchImpl: SiteScraperFetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/team') {
      return new Response('<main>Jane Smith<img src="/images/jane-contact.png"></main>', {
        headers: { 'content-type': 'text/html' },
      });
    }
    if (url.pathname.endsWith('.png')) {
      return new Response(Buffer.alloc(3_000, 1), {
        headers: { 'content-type': 'image/png', 'content-length': '3000' },
      });
    }
    return new Response('missing', { status: 404 });
  };
  const result = await scrapeDirectEmails(
    'acme.com',
    [{ full_name: 'Jane Smith' }],
    {
      fetchImpl,
      preferredPaths: ['/team'],
      ocrImpl: async () => 'Jane Smith jane.smith@acme.com',
      maxPages: 8,
      maxRetries: 0,
      deadlineMs: 3_000,
    },
  );
  assert.equal(result.get('Jane Smith')?.email, 'jane.smith@acme.com');
  assert.equal(result.get('Jane Smith')?.extraction_method, 'image_ocr');
  assert.equal(result.diagnostics.ocrImages, 1);
});

test('an OCR exception is classified without failing the company scrape', async () => {
  const fetchImpl: SiteScraperFetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/contact') {
      return new Response('<main>Jane Smith<img src="/contact-card.png"></main>', {
        headers: { 'content-type': 'text/html' },
      });
    }
    if (url.pathname.endsWith('.png')) {
      return new Response(Buffer.alloc(3_000, 1), {
        headers: { 'content-type': 'image/png', 'content-length': '3000' },
      });
    }
    return new Response('missing', { status: 404 });
  };
  const result = await scrapeDirectEmails('acme.com', [{ full_name: 'Jane Smith' }], {
    fetchImpl,
    preferredPaths: ['/contact'],
    ocrImpl: async () => {
      throw new Error('unreadable image');
    },
    maxPages: 8,
    concurrency: 1,
    maxRetries: 0,
    deadlineMs: 3_000,
  });
  assert.equal(result.size, 0);
  assert.equal(result.diagnostics.outcomes.error_ocr_failed, 1);
});

test('blocked re-fetch becomes provisional only with an exact cited quote', async () => {
  const blocked = async () => new Response('blocked', { status: 403 });
  const accepted = await verifyDirectEmailSource({
    source_url: 'https://acme.com/team/jane',
    email: 'jane.smith@acme.com',
    person_name: 'Jane Smith',
    domain: 'acme.com',
    source_quote: 'Jane Smith — jane.smith@acme.com',
  }, { fetchImpl: blocked });
  assert.equal(accepted.refetch_attempted, true);
  assert.equal(accepted.provisional, true);
  assert.equal(accepted.failure_class, 'blocked');

  const rejected = await verifyDirectEmailSource({
    source_url: 'https://acme.com/team/jane',
    email: 'jane.smith@acme.com',
    person_name: 'Jane Smith',
    domain: 'acme.com',
    source_quote: 'Contact our team',
  }, { fetchImpl: blocked });
  assert.equal(rejected.provisional, false);
});

test('two local samples cap confidence at medium and conflicts retain alternatives', () => {
  const agreeing = deriveFormatFromSamples([
    { first_name: 'Jane', last_name: 'Smith', email: 'jane.smith@acme.com' },
    { first_name: 'John', last_name: 'Doe', email: 'john.doe@acme.com' },
  ]);
  assert.equal(agreeing?.confidence, 'medium');
  assert.deepEqual(agreeing?.patterns, ['first.last']);

  const conflicting = deriveFormatFromSamples([
    { first_name: 'Jane', last_name: 'Smith', email: 'jane.smith@acme.com' },
    { first_name: 'John', last_name: 'Doe', email: 'jdoe@acme.com' },
  ]);
  assert.equal(conflicting?.confidence, 'low');
  assert.equal(conflicting?.patterns.length, 2);

  const three = deriveFormatFromSamples([
    { first_name: 'Jane', last_name: 'Smith', email: 'jane.smith@acme.com' },
    { first_name: 'John', last_name: 'Doe', email: 'john.doe@acme.com' },
    { first_name: 'Ada', last_name: 'Lovelace', email: 'ada.lovelace@acme.com' },
  ]);
  assert.equal(three?.confidence, 'high');
});

test('rescue continues only when its persisted frontier advances', () => {
  const context = {
    parent_job_id: 'job-1',
    domain: 'acme.com',
    domain_evidence: '',
    company_notes: null,
    prior_literal_emails: [],
    prior_formats: [],
    checked_paths: ['/team'],
    search_budget: 5,
    searches_used: 5,
    attempted_query_families: ['target_literal'],
    deferred_queries: [{
      person_name: 'Jane Smith',
      family: 'first_party_document' as const,
      query: '"Jane Smith" email filetype:pdf',
    }],
    rejected_direct_literals: [],
    failed_high_value_paths: ['https://acme.com/people'],
    scraper_outcomes: [],
    tranche: 1,
  };
  const base: ResearchReport = {
    domain: 'acme.com',
    domain_confidence: 'confirmed',
    domain_evidence: '',
    alternate_domain: null,
    literal_emails: [],
    formats: [],
    profile_findings: [],
    company_notes: null,
    deferred_queries: context.deferred_queries,
    promising_paths: ['https://acme.com/people'],
  };
  assert.equal(rescueFrontierAdvanced(context, base), false);
  assert.equal(rescueFrontierAdvanced(context, {
    ...base,
    promising_paths: [...(base.promising_paths ?? []), 'https://acme.com/advisors'],
  }), true);
});
