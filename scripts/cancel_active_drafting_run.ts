/**
 * Cancel the active drafting run: stop pending/in-flight jobs, mark run cancelled,
 * and reset zombie in-progress items. Preserves ready_for_review drafts.
 *
 * Usage: npx tsx scripts/cancel_active_drafting_run.ts
 */
import fs from 'node:fs';
import { dbQuery, dbTransaction } from '@/lib/db';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

async function main() {
  const active = await dbQuery<{ id: string; target_count: number; actual_cost_usd: string }>(
    `SELECT id, target_count, actual_cost_usd::text
     FROM outreach.drafting_runs
     WHERE status = 'active'
     ORDER BY started_at DESC
     LIMIT 1`,
  );
  const run = active.rows[0];
  if (!run) {
    console.log(JSON.stringify({ cancelled: false, reason: 'no_active_run' }, null, 2));
    return;
  }

  const before = await dbQuery<{
    job_status: string;
    kind: string;
    count: number;
  }>(
    `SELECT status AS job_status, kind, count(*)::int AS count
     FROM outreach.drafting_jobs
     WHERE drafting_run_id = $1
       AND status IN ('pending', 'claimed', 'in_flight')
     GROUP BY status, kind
     ORDER BY kind, status`,
    [run.id],
  );

  const kept = await dbQuery<{ full_name: string; state: string; subject: string | null }>(
    `SELECT l.full_name, i.state, d.subject
     FROM outreach.drafting_items i
     JOIN outreach.leads l ON l.id = i.lead_id
     LEFT JOIN outreach.email_drafts d ON d.drafting_item_id = i.id
     WHERE i.workspace_id = (SELECT workspace_id FROM outreach.drafting_runs WHERE id = $1)
       AND i.state = 'ready_for_review'`,
    [run.id],
  );

  const result = await dbTransaction(async (client) => {
    const cancelledJobs = await client.query<{ id: string }>(
      `UPDATE outreach.drafting_jobs
       SET status = 'cancelled',
           finished_at = now(),
           last_error_code = coalesce(last_error_code, 'run_cancelled'),
           last_error_message = coalesce(last_error_message, 'Drafting run cancelled by operator')
       WHERE drafting_run_id = $1
         AND status IN ('pending', 'claimed', 'in_flight')
       RETURNING id`,
      [run.id],
    );

    const resetItems = await client.query<{ id: string; state: string }>(
      `UPDATE outreach.drafting_items i
       SET state = CASE
             WHEN i.state = 'researching' THEN 'queued_research'
             WHEN i.state IN ('queued_write', 'writing', 'repairing', 'rewriting') THEN 'queued_research'
             ELSE i.state
           END,
           last_error_code = CASE
             WHEN i.state IN ('researching', 'queued_write', 'writing', 'repairing', 'rewriting')
               THEN 'run_cancelled'
             ELSE i.last_error_code
           END,
           last_error_message = CASE
             WHEN i.state IN ('researching', 'queued_write', 'writing', 'repairing', 'rewriting')
               THEN 'Drafting run cancelled while job was in progress'
             ELSE i.last_error_message
           END,
           updated_at = now()
       FROM outreach.drafting_run_items ri
       WHERE ri.drafting_run_id = $1
         AND ri.drafting_item_id = i.id
         AND i.state IN ('researching', 'queued_write', 'writing', 'repairing', 'rewriting')
       RETURNING i.id, i.state`,
      [run.id],
    );

    await client.query(
      `UPDATE outreach.drafting_runs
       SET status = 'cancelled',
           finished_at = now()
       WHERE id = $1`,
      [run.id],
    );

    return {
      cancelled_job_count: cancelledJobs.rowCount ?? 0,
      reset_item_count: resetItems.rowCount ?? 0,
    };
  });

  const after = await dbQuery<{ state: string; count: number }>(
    `SELECT i.state, count(*)::int AS count
     FROM outreach.drafting_items i
     WHERE i.workspace_id = (SELECT workspace_id FROM outreach.drafting_runs WHERE id = $1)
     GROUP BY i.state
     ORDER BY i.state`,
    [run.id],
  );

  console.log(JSON.stringify({
    run_id: run.id,
    run_cost_usd: run.actual_cost_usd,
    open_jobs_before: before.rows,
    kept_ready_for_review: kept.rows,
    ...result,
    item_states_after: after.rows,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
