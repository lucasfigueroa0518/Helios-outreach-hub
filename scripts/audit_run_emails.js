const fs = require('fs');
const { Client } = require('pg');

const campaignName = process.argv[2] ?? '5 tests, just email enrichment';

const url = fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)
  .map((line) => line.match(/^DIRECT_DATABASE_URL=(.*)$/)?.[1])
  .find(Boolean);

(async () => {
  const client = new Client({ connectionString: url, ssl: false });
  await client.connect();

  const campaign = await client.query(
    `SELECT id, name FROM outreach.campaigns WHERE name = $1 ORDER BY updated_at DESC LIMIT 1`,
    [campaignName],
  );
  if (!campaign.rows[0]) {
    console.log(JSON.stringify({ error: `Campaign not found: ${campaignName}` }));
    await client.end();
    return;
  }

  const runs = await client.query(
    `SELECT id, status, started_at, finished_at, stats
     FROM outreach.runs
     WHERE campaign_id = $1
     ORDER BY started_at DESC
     LIMIT 3`,
    [campaign.rows[0].id],
  );

  const leads = await client.query(
    `SELECT l.full_name, l.company_name, l.email_primary, l.email_alt_1, l.email_alt_2,
            l.email_status, l.email_source_note, l.email_verification,
            cl.run_id, r.status AS run_status, r.stats->'enrichment' AS enrichment_stats
     FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     JOIN outreach.runs r ON r.id = cl.run_id
     WHERE cl.campaign_id = $1
     ORDER BY l.full_name`,
    [campaign.rows[0].id],
  );

  const jobs = await client.query(
    `SELECT id, company_key, status, grade, resolved_domain, research_result, last_error
     FROM outreach.company_research_jobs
     WHERE $1 = ANY(requested_by_runs)
     ORDER BY updated_at DESC`,
    [runs.rows[0]?.id ?? null],
  );

  const summary = {
    campaign: campaign.rows[0].name,
    latest_run: runs.rows[0] ?? null,
    enrichment_stats: runs.rows[0]?.stats?.enrichment ?? null,
    research_jobs: jobs.rows.map((job) => ({
      company_key: job.company_key,
      status: job.status,
      grade: job.grade,
      domain: job.resolved_domain,
      literal_emails: job.research_result?.literal_emails ?? [],
      formats: job.research_result?.formats ?? [],
      last_error: job.last_error,
    })),
    leads: leads.rows.map((row) => ({
      full_name: row.full_name,
      company_name: row.company_name,
      email_primary: row.email_primary,
      email_alt_1: row.email_alt_1,
      email_alt_2: row.email_alt_2,
      email_count: [row.email_primary, row.email_alt_1, row.email_alt_2].filter(Boolean).length,
      email_status: row.email_status,
      email_source_note: row.email_source_note,
      email_verification: row.email_verification,
      source_word_count: (row.email_source_note ?? '').split(/\s+/).filter(Boolean).length,
    })),
    by_status: {},
    triple_inferred: 0,
    direct_web_literal: 0,
    inferred: 0,
    direct_upload: 0,
    from_embark_db: 0,
    not_found: 0,
  };

  for (const row of leads.rows) {
    summary.by_status[row.email_status] = (summary.by_status[row.email_status] ?? 0) + 1;
    if (row.email_status === 'inferred') summary.inferred++;
    if (row.email_status === 'direct' && (row.email_source_note ?? '').includes('web literal')) summary.direct_web_literal++;
    if (row.email_status === 'direct' && (row.email_source_note ?? '').includes('present in upload')) summary.direct_upload++;
    if (row.email_status === 'from_embark_db') summary.from_embark_db++;
    if (row.email_status === 'not_found') summary.not_found++;
    const count = [row.email_primary, row.email_alt_1, row.email_alt_2].filter(Boolean).length;
    if (row.email_status === 'inferred' && count === 3) summary.triple_inferred++;
  }

  console.log(JSON.stringify(summary, null, 2));
  await client.end();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
