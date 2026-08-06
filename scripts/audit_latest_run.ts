import fs from 'node:fs';
import { dbQuery } from '@/lib/db';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

async function main() {
  const campaigns = await dbQuery<{ id: string; name: string; created_at: string }>(
    `SELECT id, name, created_at FROM outreach.campaigns ORDER BY created_at`,
  );
  console.log('=== Campaigns ===');
  console.log(campaigns.rows);

  const latestRun = await dbQuery<{
    id: string;
    campaign_id: string;
    campaign_name: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    stats: Record<string, unknown>;
  }>(
    `SELECT r.id, r.campaign_id, c.name AS campaign_name, r.status,
            r.started_at, r.finished_at, r.stats
     FROM outreach.runs r
     JOIN outreach.campaigns c ON c.id = r.campaign_id
     ORDER BY r.started_at DESC
     LIMIT 5`,
  );
  console.log('\n=== Latest runs ===');
  for (const run of latestRun.rows) {
    console.log(JSON.stringify({
      id: run.id,
      campaign: run.campaign_name,
      status: run.status,
      started_at: run.started_at,
      finished_at: run.finished_at,
      enrichment: run.stats?.enrichment ?? null,
    }, null, 2));
  }

  const run = latestRun.rows.find((row) => row.status === 'complete') ?? latestRun.rows[0];
  if (!run) return;

  const emailBreakdown = await dbQuery<{
    email_status: string;
    email_verification: string | null;
    email_mx_status: string | null;
    count: number;
  }>(
    `SELECT l.email_status, l.email_verification, l.email_mx_status, count(*)::int AS count
     FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     WHERE cl.run_id = $1
     GROUP BY 1,2,3
     ORDER BY count DESC`,
    [run.id],
  );
  console.log('\n=== Email status breakdown (latest run) ===');
  console.log(emailBreakdown.rows);

  const researchJobs = await dbQuery<{ research_pass: string; job_kind: string; status: string; count: number }>(
    `SELECT coalesce(disambiguation->>'research_pass','primary') AS research_pass,
            job_kind, status, count(*)::int AS count
     FROM outreach.company_research_jobs
     WHERE $1 = ANY(requested_by_runs)
     GROUP BY 1,2,3 ORDER BY count DESC`,
    [run.id],
  );
  console.log('\n=== Research jobs (latest run) ===');
  console.log(researchJobs.rows);

  const samples = await dbQuery<{
    full_name: string;
    email_primary: string | null;
    email_status: string;
    email_verification: string | null;
    email_mx_status: string | null;
    email_source_note: string | null;
  }>(
    `SELECT l.full_name, l.email_primary, l.email_status, l.email_verification,
            l.email_mx_status, l.email_source_note
     FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     WHERE cl.run_id = $1
     ORDER BY l.email_status, l.last_name NULLS LAST
     LIMIT 20`,
    [run.id],
  );
  console.log('\n=== Sample leads (latest run) ===');
  console.log(samples.rows);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
