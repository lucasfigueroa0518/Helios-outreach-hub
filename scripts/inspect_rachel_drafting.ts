import fs from 'node:fs';
import { dbQuery } from '@/lib/db';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

async function main() {
  const { rows } = await dbQuery<{
    full_name: string;
    state: string;
    research_revision: number;
    human_attention_code: string | null;
    last_error_code: string | null;
    last_error_message: string | null;
    packet_status: string | null;
    identity: string | null;
    resolution: string | null;
    job_id: string | null;
    job_status: string | null;
    job_error: string | null;
    job_finished: string | null;
  }>(
    `SELECT l.full_name, i.state, i.research_revision, i.human_attention_code,
            i.last_error_code, i.last_error_message,
            p.status AS packet_status,
            p.identity_classification AS identity,
            p.resolution_level AS resolution,
            j.id AS job_id, j.status AS job_status, j.last_error_message AS job_error,
            j.finished_at::text AS job_finished
     FROM outreach.drafting_items i
     JOIN outreach.leads l ON l.id = i.lead_id
     LEFT JOIN outreach.draft_research_packets p ON p.drafting_item_id = i.id
     LEFT JOIN LATERAL (
       SELECT * FROM outreach.drafting_jobs j
       WHERE j.drafting_item_id = i.id
       ORDER BY coalesce(j.finished_at, j.created_at) DESC LIMIT 1
     ) j ON true
     WHERE lower(l.full_name) LIKE '%rachel barron%'`,
  );
  console.log(JSON.stringify(rows, null, 2));

  const pending = await dbQuery<{ count: number }>(
    `SELECT count(*)::int AS count FROM outreach.drafting_jobs
     WHERE status = 'pending' AND kind = 'research'`,
  );
  console.log('still_pending_research', pending.rows[0]?.count);
}

main().catch(console.error);
