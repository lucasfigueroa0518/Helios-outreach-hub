import fs from 'node:fs';
import { dbQuery } from '@/lib/db';
import { agentMailInboxId, agentMailListMessages } from '@/lib/agentmail';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

async function main() {
  const runs = await dbQuery<{
    id: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    enrichment: Record<string, number> | null;
  }>(
    `SELECT id, started_at, finished_at, status, stats->'enrichment' AS enrichment
     FROM outreach.runs
     ORDER BY started_at DESC
     LIMIT 15`,
  );

  console.log('=== Mailbox stats by run (lead outcomes, not necessarily 1:1 with sends) ===');
  const runRows = runs.rows.map((run) => {
    const e = run.enrichment ?? {};
    const mailbox = {
      valid: e.mailbox_valid ?? 0,
      invalid: e.mailbox_invalid ?? 0,
      unknown: e.mailbox_unknown ?? 0,
      provider_errors: e.mailbox_provider_errors ?? 0,
      rate_limited: e.mailbox_rate_limited ?? 0,
    };
    return { id: run.id, started_at: run.started_at, status: run.status, mailbox };
  });
  console.log(JSON.stringify(runRows, null, 2));

  const totals = runRows.reduce(
    (acc, row) => {
      for (const [key, value] of Object.entries(row.mailbox)) {
        acc[key] = (acc[key] ?? 0) + value;
      }
      return acc;
    },
    {} as Record<string, number>,
  );
  console.log('\n=== Totals across recent runs ===');
  console.log(JSON.stringify(totals, null, 2));

  const leads = await dbQuery<{
    run_id: string;
    email_verification: string | null;
    email_status: string;
    alt_count: number;
  }>(
    `SELECT cl.run_id,
            l.email_verification,
            l.email_status,
            (CASE WHEN nullif(l.email_alt_1, '') IS NOT NULL THEN 1 ELSE 0 END
             + CASE WHEN nullif(l.email_alt_2, '') IS NOT NULL THEN 1 ELSE 0 END)::int AS alt_count
     FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     WHERE l.email_primary IS NOT NULL
       AND l.email_status IN ('direct', 'inferred', 'format_guess')`,
  );

  const byRunVerification: Record<string, Record<string, number>> = {};
  for (const row of leads.rows) {
    const key = row.email_verification ?? 'null';
    byRunVerification[row.run_id] ??= {};
    byRunVerification[row.run_id][key] = (byRunVerification[row.run_id][key] ?? 0) + 1;
  }
  console.log('\n=== Leads eligible for mailbox verify by run ===');
  console.log(JSON.stringify(byRunVerification, null, 2));

  try {
    const inboxId = agentMailInboxId();
    const messages = await agentMailListMessages({ limit: 100 });
    const probeMessages = messages.filter((message) =>
      (message.subject?.trim() ?? '') === 'a'
      && ((message.text?.trim() ?? '') === 'f' || (message.preview?.trim() ?? '') === 'f'),
    );
    const outbound = probeMessages.filter((message) => {
      const from = message.from?.toLowerCase() ?? '';
      return from.includes(inboxId.toLowerCase()) || from.includes('agentmail');
    });
    const today = new Date().toISOString().slice(0, 10);
    const todayProbes = outbound.filter((message) => {
      const ts = message.timestamp ?? message.created_at ?? '';
      return ts.startsWith(today);
    });
    console.log('\n=== AgentMail inbox messages ===');
    console.log(JSON.stringify({
      inbox_id: inboxId,
      listed_total: messages.length,
      probe_subject_a_body_f: probeMessages.length,
      outbound_probe_like: outbound.length,
      outbound_today: todayProbes.length,
      all_subjects_sample: [...new Set(messages.slice(0, 20).map((m) => m.subject ?? null))],
      probe_recipients_sample: probeMessages.slice(0, 5).map((m) => m.to ?? null),
      probe_timestamps: probeMessages.map((m) => m.timestamp ?? m.created_at ?? null),
    }, null, 2));
  } catch (error) {
    console.log('\n=== AgentMail inbox query failed ===');
    console.log(error instanceof Error ? error.message : String(error));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
