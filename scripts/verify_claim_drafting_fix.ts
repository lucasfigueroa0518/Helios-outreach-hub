import fs from 'node:fs';
import { dbQuery } from '@/lib/db';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

async function main() {
  const run = await dbQuery<{ id: string }>(
    `SELECT id FROM outreach.drafting_runs WHERE status = 'active' ORDER BY started_at DESC LIMIT 1`,
  );
  const runId = run.rows[0]?.id;
  if (!runId) throw new Error('no active run');

  // Insert a one-off pending research job for an existing queued_research item
  const item = await dbQuery<{ item_id: string; input_fingerprint: string | null }>(
    `SELECT i.id AS item_id, i.input_fingerprint
     FROM outreach.drafting_items i
     JOIN outreach.drafting_run_items ri ON ri.drafting_item_id = i.id
     WHERE ri.drafting_run_id = $1 AND i.state = 'queued_research'
     LIMIT 1`,
    [runId],
  );
  if (!item.rows[0]) throw new Error('no queued_research item');

  const key = `claim-verify:${item.rows[0].item_id}:${Date.now()}`;
  const inserted = await dbQuery<{ id: string }>(
    `INSERT INTO outreach.drafting_jobs (
       drafting_run_id, drafting_item_id, kind, idempotency_key,
       expected_input_fingerprint, status
     ) VALUES ($1, $2, 'research', $3, $4, 'pending')
     RETURNING id`,
    [runId, item.rows[0].item_id, key, item.rows[0].input_fingerprint],
  );
  const jobId = inserted.rows[0].id;

  const claimed = await dbQuery<{ id: string; status: string; attempt_count: number }>(
    `SELECT id, status, attempt_count FROM public.claim_drafting_job($1)`,
    [jobId],
  );

  // Clean up: cancel the verification job so it does not burn a live research slot
  await dbQuery(
    `UPDATE outreach.drafting_jobs
     SET status = 'cancelled', finished_at = now(), claimed_at = NULL, heartbeat_at = NULL
     WHERE id = $1`,
    [jobId],
  );

  const ok = claimed.rows[0]?.status === 'in_flight';
  console.log(JSON.stringify({
    ok,
    claimed: claimed.rows[0] ?? null,
    note: ok
      ? 'claim_drafting_job now promotes research jobs with null expected revisions'
      : 'claim still failing — check function definition in DB',
  }, null, 2));
  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
