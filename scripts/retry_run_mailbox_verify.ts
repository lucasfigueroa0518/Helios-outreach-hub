import fs from 'node:fs';
import { dbQuery } from '@/lib/db';
import { runMailboxVerificationForLead } from '@/lib/mailbox-verify';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

async function main() {
  const runId = process.argv[2];
  if (!runId) throw new Error('Usage: npx tsx scripts/retry_run_mailbox_verify.ts <run-id>');

  await dbQuery(
    `UPDATE outreach.leads l
     SET email_verification = 'pending', updated_at = now()
     FROM outreach.campaign_leads cl
     WHERE cl.lead_id = l.id
       AND cl.run_id = $1
       AND l.email_primary IS NOT NULL
       AND l.email_status IN ('direct', 'inferred', 'format_guess')
       AND coalesce(l.email_verification, 'unknown') IN ('unknown', 'pending')`,
    [runId],
  );

  const { rows } = await dbQuery<{
    lead_id: string;
    email_primary: string;
  }>(
    `SELECT l.id AS lead_id, l.email_primary
     FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     WHERE cl.run_id = $1
       AND l.email_primary IS NOT NULL
       AND l.email_status IN ('direct', 'inferred', 'format_guess')
       AND l.email_verification = 'pending'`,
    [runId],
  );

  console.log(`Verifying ${rows.length} leads...`);
  const concurrency = Math.max(1, Number(process.env.ORG_MAILBOX_VERIFY_CONCURRENCY ?? 3));
  let index = 0;
  const results: Array<{ lead_id: string; status: string }> = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (index < rows.length) {
      const row = rows[index++];
      const result = await runMailboxVerificationForLead(row.lead_id, row.email_primary, runId);
      results.push({ lead_id: row.lead_id, status: result.status });
      console.log(`${row.email_primary}: ${result.status}`);
    }
  }));

  const summary = results.reduce<Record<string, number>>((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log('Done:', summary);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
