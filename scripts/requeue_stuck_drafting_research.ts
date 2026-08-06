/**
 * Re-queue research jobs that were incorrectly superseded by claim_drafting_job
 * when expected_*_revision was NULL (research inserts omit those columns).
 *
 * Usage: npx tsx scripts/requeue_stuck_drafting_research.ts [run-id] [--dispatch]
 * Default: latest active drafting run. Pass --dispatch to start local processors.
 */
import fs from 'node:fs';
import { dbQuery } from '@/lib/db';
import { dispatchDraftingJobs } from '@/lib/drafting/transport';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const dispatch = process.argv.includes('--dispatch');
  let runId = args[0];

  if (!runId) {
    const active = await dbQuery<{ id: string }>(
      `SELECT id FROM outreach.drafting_runs
       WHERE status = 'active'
       ORDER BY started_at DESC
       LIMIT 1`,
    );
    runId = active.rows[0]?.id;
  }
  if (!runId) throw new Error('No active drafting run found');

  const stuck = await dbQuery<{
    item_id: string;
    full_name: string;
    input_fingerprint: string | null;
  }>(
    `SELECT i.id AS item_id, l.full_name, i.input_fingerprint
     FROM outreach.drafting_items i
     JOIN outreach.leads l ON l.id = i.lead_id
     JOIN outreach.drafting_run_items ri
       ON ri.drafting_item_id = i.id AND ri.drafting_run_id = $1
     WHERE i.state = 'queued_research'
       AND NOT EXISTS (
         SELECT 1 FROM outreach.drafting_jobs j
         WHERE j.drafting_item_id = i.id
           AND j.drafting_run_id = $1
           AND j.status IN ('pending', 'in_flight', 'claimed')
       )
     ORDER BY i.ordinal`,
    [runId],
  );

  if (!stuck.rows.length) {
    console.log(JSON.stringify({ run_id: runId, requeued: 0, note: 'nothing stuck' }, null, 2));
    return;
  }

  const jobs: Array<{ id: string; kind: 'research'; attempt_count: number }> = [];
  for (const row of stuck.rows) {
    const key = `research:${row.item_id}:${runId}:requeue-${Date.now()}`;
    const inserted = await dbQuery<{ id: string; attempt_count: number }>(
      `INSERT INTO outreach.drafting_jobs (
         drafting_run_id, drafting_item_id, kind, idempotency_key,
         expected_input_fingerprint, status
       ) VALUES ($1, $2, 'research', $3, $4, 'pending')
       RETURNING id, attempt_count`,
      [runId, row.item_id, key, row.input_fingerprint],
    );
    if (inserted.rows[0]) {
      jobs.push({
        id: inserted.rows[0].id,
        kind: 'research',
        attempt_count: inserted.rows[0].attempt_count,
      });
    }
  }

  console.log(JSON.stringify({
    run_id: runId,
    requeued: jobs.length,
    leads: stuck.rows.map((row) => row.full_name),
    dispatch,
  }, null, 2));

  if (dispatch && jobs.length) {
    await dispatchDraftingJobs(jobs);
    console.log(`Dispatched ${jobs.length} research jobs (local/dev processor).`);
  } else if (jobs.length) {
    console.log('Jobs are pending. Re-run with --dispatch to start them.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
