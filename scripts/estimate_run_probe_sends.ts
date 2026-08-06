import fs from 'node:fs';
import { dbQuery } from '@/lib/db';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

async function main() {
  const runId = '54145237-99c7-40c1-9fa1-37a99d67b2f6';
  const leads = await dbQuery<{
    full_name: string;
    email_primary: string | null;
    email_alt_1: string | null;
    email_alt_2: string | null;
    email_status: string;
    email_verification: string | null;
  }>(
    `SELECT l.full_name, l.email_primary, l.email_alt_1, l.email_alt_2,
            l.email_status, l.email_verification
     FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     WHERE cl.run_id = $1
       AND l.email_primary IS NOT NULL
       AND l.email_status IN ('direct', 'inferred', 'format_guess')
     ORDER BY l.email_verification, l.full_name`,
    [runId],
  );

  let minSends = 0;
  let maxSends = 0;
  const breakdown: Record<string, { min: number; max: number; count: number }> = {};

  for (const lead of leads.rows) {
    const candidates = [lead.email_primary, lead.email_alt_1, lead.email_alt_2]
      .map((e) => e?.trim() ?? '')
      .filter(Boolean);
    const n = candidates.length;
    const v = lead.email_verification ?? 'null';
    breakdown[v] ??= { min: 0, max: 0, count: 0 };
    breakdown[v].count++;

    if (v === 'valid') {
      // At least one probe before valid; at most n
      minSends += 1;
      maxSends += n;
      breakdown[v].min += 1;
      breakdown[v].max += n;
    } else if (v === 'invalid') {
      // All candidates tried
      minSends += n;
      maxSends += n;
      breakdown[v].min += n;
      breakdown[v].max += n;
    } else {
      // unknown/null/pending: at least 1 failed attempt if provider error
      minSends += 1;
      maxSends += n;
      breakdown[v].min += 1;
      breakdown[v].max += n;
    }
  }

  console.log(JSON.stringify({
    run_id: runId,
    eligible_leads: leads.rows.length,
    estimated_probe_sends: { min: minSends, max: maxSends },
    by_verification: breakdown,
  }, null, 2));
}

main().catch(console.error);
