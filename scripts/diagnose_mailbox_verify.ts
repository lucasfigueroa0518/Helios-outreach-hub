import fs from 'node:fs';
import { dbQuery } from '@/lib/db';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

async function main() {
  const run = await dbQuery<{ id: string; stats: Record<string, unknown> }>(
    `SELECT id, stats FROM outreach.runs WHERE status = 'complete' ORDER BY finished_at DESC LIMIT 1`,
  );
  const runId = run.rows[0]?.id;
  if (!runId) throw new Error('no run');

  const leads = await dbQuery(
    `SELECT l.full_name, l.email_primary, l.email_status, l.email_verification,
            l.email_verified_at, l.email_alt_1, l.email_alt_2
     FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     WHERE cl.run_id = $1
     ORDER BY l.email_verification NULLS LAST, l.full_name`,
    [runId],
  );

  const pending = leads.rows.filter((l) => l.email_verification === 'pending');
  const unknown = leads.rows.filter((l) => l.email_verification === 'unknown');

  console.log(JSON.stringify({
    run_id: runId,
    enrichment_stats: run.rows[0]?.stats?.enrichment ?? null,
    verification_counts: {
      pending: pending.length,
      unknown: unknown.length,
      valid: leads.rows.filter((l) => l.email_verification === 'valid').length,
      invalid: leads.rows.filter((l) => l.email_verification === 'invalid').length,
      null: leads.rows.filter((l) => !l.email_verification).length,
    },
    pending_sample: pending.slice(0, 5),
    unknown_sample: unknown.slice(0, 5),
    orchestrator: process.env.ORCHESTRATOR ?? 'postgres',
    agentmail_configured: Boolean(process.env.AGENT_MAIL_API),
  }, null, 2));
}

main().catch(console.error);
