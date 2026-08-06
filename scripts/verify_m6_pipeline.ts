import fs from 'node:fs';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1]] = match[2];
}

async function main() {
const { dbQuery } = await import('@/lib/db');
const { executeResearchJob } = await import('@/lib/enrichment');
const { buildDisambiguation, researchJobKey } = await import('@/lib/research-types');
const { ScrapeDirectEmailResult } = await import('@/lib/site-scraper');

const stamp = Date.now();
const email = `m6-pipeline-${stamp}@embarkwithus.com`;
const companyName = `M6 Fixture ${stamp}`;
const domain = `fixture-${stamp}.example`;
let userId: string | null = null;
let campaignId: string | null = null;
let runId: string | null = null;
let jobId: string | null = null;
const leadIds: string[] = [];

try {
  userId = (await dbQuery<{ id: string }>(
    `INSERT INTO outreach.users (email, display_name) VALUES ($1, 'M6 Fixture') RETURNING id`,
    [email],
  )).rows[0].id;
  campaignId = (await dbQuery<{ id: string }>(
    `INSERT INTO outreach.campaigns (owner_id, name) VALUES ($1, 'M6 Fixture') RETURNING id`,
    [userId],
  )).rows[0].id;
  runId = (await dbQuery<{ id: string }>(
    `INSERT INTO outreach.runs (campaign_id, user_id, status)
     VALUES ($1,$2,'enriching') RETURNING id`,
    [campaignId, userId],
  )).rows[0].id;

  for (const [fullName, firstName, lastName] of [
    ['Jane Literal', 'Jane', 'Literal'],
    ['John Inferred', 'John', 'Inferred'],
  ]) {
    const leadId = (await dbQuery<{ id: string }>(
      `INSERT INTO outreach.leads (
         first_name,last_name,full_name,company_name,email_status,source_run_id
       ) VALUES ($1,$2,$3,$4,'not_found',$5) RETURNING id`,
      [firstName, lastName, fullName, companyName, runId],
    )).rows[0].id;
    leadIds.push(leadId);
    await dbQuery(
      `INSERT INTO outreach.campaign_leads (campaign_id,lead_id,run_id) VALUES ($1,$2,$3)`,
      [campaignId, leadId, runId],
    );
  }

  const disambiguation = buildDisambiguation(companyName, [
    { lead_id: leadIds[0], full_name: 'Jane Literal', first_name: 'Jane', last_name: 'Literal', title: 'CFO', location: 'Dallas, TX' },
    {
      lead_id: leadIds[1],
      full_name: 'John Inferred',
      first_name: 'John',
      last_name: 'Inferred',
      title: null,
      location: 'Dallas, TX',
      requested_fields: ['title'],
    },
  ]);
  jobId = (await dbQuery<{ enqueue: string }>(
    `SELECT public.enqueue($1,$2::jsonb,$3)`,
    [researchJobKey(disambiguation), JSON.stringify(disambiguation), runId],
  )).rows[0].enqueue;

  const firstResult = await executeResearchJob(jobId, async () => ({
    domain,
    domain_confidence: 'confirmed',
    domain_evidence: `https://${domain}`,
    alternate_domain: null,
    literal_emails: [{
      person_name: 'Jane Literal',
      email: `jane.literal@${domain}`,
      source_url: `https://${domain}/team`,
      source_quote: `Jane Literal — jane.literal@${domain}`,
    }],
    formats: [],
    profile_findings: [{
      person_name: 'John Inferred',
      field: 'title',
      value: 'Controller',
      confidence: 'medium',
      reasoning: 'The first pass found one person-specific source.',
      evidence: [{
        url: `https://${domain}/team/john-inferred`,
        source_type: 'first_party',
        quote: 'John Inferred is Controller.',
        value: 'Controller',
        person_specific: true,
      }],
    }],
    company_notes: null,
  }), {
    verifyLiteral: async (inputOrUrl) => {
      if (typeof inputOrUrl === 'string') throw new Error('Fixture expects structured verification input');
      return {
      verified: true,
      source_url: inputOrUrl.source_url,
      email: inputOrUrl.email,
      person_name: inputOrUrl.person_name ?? inputOrUrl.full_name ?? '',
      content_hash: 'fixture-content-hash',
      context: `Jane Literal — jane.literal@${domain}`,
      };
    },
    scraper: async () => new ScrapeDirectEmailResult({
      pagesAttempted: 0,
      pagesFetched: 0,
      pathsAttempted: [],
      pathsHit: [],
      errors: [],
      deadlineExceeded: false,
    }),
  });
  if (firstResult.profileRescueJobIds.length !== 1
    || firstResult.emailRescueJobIds.length !== 1
    || firstResult.completedRunIds.length !== 0) {
    throw new Error('Primary job did not enqueue blocking row-scoped profile and email rescues');
  }
  const guessed = await dbQuery<{ email_status: string }>(
    `SELECT email_status FROM outreach.leads WHERE id = $1`,
    [leadIds[1]],
  );
  if (guessed.rows[0]?.email_status !== 'format_guess') {
    throw new Error('No-evidence heuristic was not classified as Format Guess');
  }
  const rescueJobId = firstResult.profileRescueJobIds[0];
  const rescueResult = await executeResearchJob(rescueJobId, async (rescue) => {
    if (rescue.research_pass !== 'profile_rescue'
      || rescue.people.length !== 1
      || rescue.people[0].lead_id !== leadIds[1]
      || rescue.people[0].requested_fields?.join(',') !== 'title') {
      throw new Error('Profile rescue was not sharded to only John’s still-blank title');
    }
    return {
      domain,
      domain_confidence: 'confirmed',
      domain_evidence: `https://${domain}`,
      alternate_domain: null,
      literal_emails: [],
      formats: [],
      profile_findings: [{
        person_name: 'John Inferred',
        field: 'title',
        value: 'Controller',
        confidence: 'high',
        reasoning: 'A new independent source corroborates the first-pass candidate.',
        evidence: [{
          url: `https://conference-${stamp}.example/speakers/john-inferred`,
          source_type: 'conference_bio',
          quote: 'John Inferred, Controller at M6 Fixture, will speak.',
          value: 'Controller',
          person_specific: true,
        }],
      }],
      company_notes: null,
    };
  });
  if (rescueResult.completedRunIds.length !== 0) {
    throw new Error('Profile rescue completed the run before the trailing email rescue');
  }
  const emailRescueResult = await executeResearchJob(
    firstResult.emailRescueJobIds[0],
    async (rescue) => {
      if (rescue.research_pass !== 'email_rescue'
        || rescue.people.length !== 1
        || rescue.people[0].lead_id !== leadIds[1]) {
        throw new Error('Email rescue was not sharded to only John’s unresolved guess');
      }
      return {
        domain,
        domain_confidence: 'confirmed',
        domain_evidence: `https://${domain}`,
        alternate_domain: null,
        literal_emails: [],
        formats: [{
          pattern: 'first.last',
          share_pct: 90,
          confidence: 'high',
          evidence: `Confirmed by https://directory-${stamp}.example/${domain}/email-format`,
        }],
        profile_findings: [],
        company_notes: null,
      };
    },
  );
  if (!emailRescueResult.completedRunIds.includes(runId)) {
    throw new Error('Run did not become completable after both trailing rescues finished');
  }

  const result = await dbQuery<{
    full_name: string;
    email_primary: string | null;
    email_alt_1: string | null;
    email_status: string;
    title: string | null;
    profile_pass: string | null;
  }>(
    `SELECT full_name,email_primary,email_alt_1,email_status,title,
            profile_enrichment->'title'->>'research_pass' AS profile_pass
     FROM outreach.leads WHERE id = ANY($1::uuid[]) ORDER BY full_name`,
    [leadIds],
  );
  const jane = result.rows.find((row) => row.full_name === 'Jane Literal');
  const john = result.rows.find((row) => row.full_name === 'John Inferred');
  if (jane?.email_status !== 'direct' || jane.email_primary !== `jane.literal@${domain}` || jane.email_alt_1) {
    throw new Error('Literal-email-first behavior failed');
  }
  if (john?.email_status !== 'inferred' || john.email_primary !== `john.inferred@${domain}` || john.email_alt_1) {
    throw new Error('Format inference behavior failed');
  }
  if (john.title !== 'Controller' || john.profile_pass !== 'profile_rescue') {
    throw new Error('Profile rescue did not merge evidence and populate provenance');
  }
  console.log('M6 stubbed pipeline with row-scoped profile and email rescues passed.');
} finally {
  if (campaignId) await dbQuery(`DELETE FROM outreach.campaign_leads WHERE campaign_id = $1`, [campaignId]);
  if (leadIds.length) await dbQuery(`DELETE FROM outreach.leads WHERE id = ANY($1::uuid[])`, [leadIds]);
  if (runId) {
    await dbQuery(`DELETE FROM outreach.company_research_jobs WHERE $1 = ANY(requested_by_runs)`, [runId]);
  }
  await dbQuery(`DELETE FROM outreach.company_resolutions WHERE normalized_name = lower($1)`, [companyName]);
  await dbQuery(`DELETE FROM outreach.companies WHERE domain = $1`, [domain]);
  if (runId) await dbQuery(`DELETE FROM outreach.runs WHERE id = $1`, [runId]);
  if (campaignId) await dbQuery(`DELETE FROM outreach.campaigns WHERE id = $1`, [campaignId]);
  if (userId) await dbQuery(`DELETE FROM outreach.users WHERE id = $1`, [userId]);
}
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
