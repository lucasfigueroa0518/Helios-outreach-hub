import fs from 'node:fs';
import { Client } from 'pg';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
}

const RUN_ID = '428f7e76-2ea5-4881-a3f5-2889f4bf1ca2';

async function main() {
  const client = new Client({ connectionString: process.env.DIRECT_DATABASE_URL, ssl: false });
  await client.connect();

  const rows = await client.query(
    `SELECT l.full_name,
            l.company_name,
            i.state AS item_state,
            p.status AS packet_status,
            p.temporal_status,
            p.packet->'resolution'->>'level' AS resolution_level,
            jsonb_array_length(coalesce(p.packet->'resolution'->'selectedFactIds', '[]'::jsonb)) AS selected_count,
            jsonb_array_length(coalesce(p.packet->'personFacts', '[]'::jsonb)) AS person_fact_count,
            jsonb_array_length(coalesce(p.packet->'companyFacts', '[]'::jsonb)) AS company_fact_count,
            jsonb_array_length(coalesce(p.packet->'roleSegmentFacts', '[]'::jsonb)) AS role_fact_count,
            p.packet->'leadIdentity'->>'classification' AS identity_class,
            p.packet->'leadIdentity'->>'conflictSummary' AS identity_conflict,
            p.packet->'companyContextProvenance'->>'origin' AS company_reuse,
            p.usage->'reconcileActions' AS reconcile_actions,
            p.usage->'adversarial' AS adversarial,
            p.usage->'stages' AS stages,
            p.usage->'research' AS research_usage,
            j.status AS research_job_status,
            j.last_error_code,
            j.last_error_message,
            left(p.packet->'resolution'->>'whyNow', 120) AS why_now
     FROM outreach.drafting_items i
     JOIN outreach.drafting_runs r ON r.workspace_id = i.workspace_id
     JOIN outreach.leads l ON l.id = i.lead_id
     LEFT JOIN outreach.draft_research_packets p ON p.drafting_item_id = i.id
     LEFT JOIN LATERAL (
       SELECT status, last_error_code, last_error_message
       FROM outreach.drafting_jobs
       WHERE drafting_item_id = i.id AND kind = 'research' AND drafting_run_id = r.id
       ORDER BY created_at DESC
       LIMIT 1
     ) j ON true
     WHERE r.id = $1
     ORDER BY selected_count ASC, l.full_name`,
    [RUN_ID],
  );

  const failed = rows.rows.filter((r) => r.item_state === 'failed_write');
  const ok = rows.rows.filter((r) => r.item_state === 'ready_for_review');

  console.log(JSON.stringify({
    env: {
      DRAFTING_MODE: process.env.DRAFTING_MODE,
      DRAFT_RESEARCH_MAX_SEARCHES: process.env.DRAFT_RESEARCH_MAX_SEARCHES,
      DRAFT_RESEARCH_MAX_CALLS: process.env.DRAFT_RESEARCH_MAX_CALLS,
    },
    summary: {
      total: rows.rows.length,
      failed_write: failed.length,
      ready_for_review: ok.length,
      zero_selected: rows.rows.filter((r) => Number(r.selected_count) === 0).length,
      company_reused: rows.rows.filter((r) => r.company_reuse === 'reused_within_workspace').length,
    },
    failed_write: failed,
    ready_for_review: ok,
  }, null, 2));

  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
