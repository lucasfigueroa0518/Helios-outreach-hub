/**
 * Delete Rachel Barron's completed drafting artifacts, then run three leads
 * research → write → ready_for_review synchronously (dev local transport).
 *
 * Usage: npx tsx scripts/run_three_drafting_e2e.ts
 */
import fs from 'node:fs';
import { dbQuery, dbTransaction } from '@/lib/db';
import { processDraftingJob } from '@/lib/drafting/jobs';
import { DRAFTING_WRITER_PROMPT_VERSION } from '@/lib/drafting/writer-prompt';
import { getDraftingMode } from '@/lib/models';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

const TARGET_LEADS = [
  'Eric Edwards',
  'Harvey Grunwald',
  'Pat Sorensen',
] as const;

async function deleteRachelDrafting(runId: string) {
  const { rows } = await dbQuery<{ item_id: string; full_name: string; state: string }>(
    `SELECT i.id AS item_id, l.full_name, i.state
     FROM outreach.drafting_items i
     JOIN outreach.leads l ON l.id = i.lead_id
     WHERE lower(l.full_name) LIKE '%rachel barron%'
     LIMIT 1`,
  );
  const row = rows[0];
  if (!row) {
    console.log(JSON.stringify({ rachel: 'not_found' }));
    return null;
  }

  await dbTransaction(async (client) => {
    await client.query(
      `UPDATE outreach.drafting_jobs
       SET status = 'cancelled', finished_at = now()
       WHERE drafting_item_id = $1
         AND status IN ('pending', 'claimed', 'in_flight')`,
      [row.item_id],
    );
    await client.query(
      `DELETE FROM outreach.email_drafts WHERE drafting_item_id = $1`,
      [row.item_id],
    );
    await client.query(
      `DELETE FROM outreach.draft_research_packets WHERE drafting_item_id = $1`,
      [row.item_id],
    );
    await client.query(
      `UPDATE outreach.drafting_items
       SET state = 'queued_research',
           research_revision = 0,
           draft_revision = 0,
           human_attention_code = NULL,
           last_error_code = NULL,
           last_error_message = NULL,
           updated_at = now()
       WHERE id = $1`,
      [row.item_id],
    );
  });

  console.log(JSON.stringify({
    rachel_deleted: {
      item_id: row.item_id,
      previous_state: row.state,
      reset_to: 'queued_research',
    },
  }, null, 2));
  return row.item_id;
}

async function ensurePendingPipelineJob(runId: string, leadName: string) {
  const { rows } = await dbQuery<{
    item_id: string;
    state: string;
    input_fingerprint: string | null;
    research_revision: number;
    draft_revision: number;
    job_id: string | null;
    job_kind: string | null;
  }>(
    `SELECT i.id AS item_id, i.state, i.input_fingerprint,
            i.research_revision, i.draft_revision,
            j.id AS job_id, j.kind AS job_kind
     FROM outreach.drafting_items i
     JOIN outreach.leads l ON l.id = i.lead_id
     JOIN outreach.drafting_run_items ri ON ri.drafting_item_id = i.id AND ri.drafting_run_id = $1
     LEFT JOIN LATERAL (
       SELECT id, kind
       FROM outreach.drafting_jobs
       WHERE drafting_item_id = i.id
         AND drafting_run_id = $1
         AND status = 'pending'
         AND kind IN ('research', 'write', 'repair')
       ORDER BY CASE kind WHEN 'research' THEN 1 WHEN 'write' THEN 2 ELSE 3 END, created_at DESC
       LIMIT 1
     ) j ON true
     WHERE lower(l.full_name) = lower($2)
     LIMIT 1`,
    [runId, leadName],
  );
  const item = rows[0];
  if (!item) throw new Error(`Drafting item not found for ${leadName}`);

  if (item.job_id) {
    return {
      job_id: item.job_id,
      item_id: item.item_id,
      full_name: leadName,
      item_state: item.state,
    };
  }

  await dbTransaction(async (client) => {
    if (item.state === 'repairing') {
      await client.query(
        `INSERT INTO outreach.drafting_jobs (
           drafting_run_id, drafting_item_id, kind, idempotency_key,
           expected_input_fingerprint, expected_research_revision, expected_draft_revision,
           status, max_attempts
         ) VALUES ($1, $2, 'repair', $3, $4, $5, $6, 'pending', 1)`,
        [
          runId,
          item.item_id,
          `repair:${item.item_id}:${runId}:e2e-${Date.now()}`,
          item.input_fingerprint,
          item.research_revision,
          item.draft_revision,
        ],
      );
      return;
    }

    await client.query(`DELETE FROM outreach.email_drafts WHERE drafting_item_id = $1`, [item.item_id]);
    await client.query(`DELETE FROM outreach.draft_research_packets WHERE drafting_item_id = $1`, [item.item_id]);
    await client.query(
      `UPDATE outreach.drafting_items
       SET state = 'queued_research',
           human_attention_code = NULL,
           last_error_code = NULL,
           last_error_message = NULL,
           updated_at = now()
       WHERE id = $1`,
      [item.item_id],
    );
    await client.query(
      `INSERT INTO outreach.drafting_jobs (
         drafting_run_id, drafting_item_id, kind, idempotency_key,
         expected_input_fingerprint, status
       ) VALUES ($1, $2, 'research', $3, $4, 'pending')`,
      [
        runId,
        item.item_id,
        `research:${item.item_id}:${runId}:e2e-${Date.now()}-${leadName.replace(/\s+/g, '-').toLowerCase()}`,
        item.input_fingerprint,
      ],
    );
  });

  const pending = await findPendingPipelineJob(runId, leadName);
  if (!pending) throw new Error(`Failed to queue pipeline job for ${leadName}`);
  return pending;
}

async function findPendingPipelineJob(runId: string, leadName: string) {
  const { rows } = await dbQuery<{
    job_id: string;
    item_id: string;
    full_name: string;
    item_state: string;
    job_kind: string;
  }>(
    `SELECT j.id AS job_id, i.id AS item_id, l.full_name, i.state AS item_state, j.kind AS job_kind
     FROM outreach.drafting_jobs j
     JOIN outreach.drafting_items i ON i.id = j.drafting_item_id
     JOIN outreach.leads l ON l.id = i.lead_id
     WHERE j.drafting_run_id = $1
       AND j.status = 'pending'
       AND j.kind IN ('research', 'write', 'repair')
       AND lower(l.full_name) = lower($2)
     ORDER BY j.created_at DESC
     LIMIT 1`,
    [runId, leadName],
  );
  return rows[0] ?? null;
}

async function findPendingResearchJob(runId: string, leadName: string) {
  return findPendingPipelineJob(runId, leadName);
}

async function ensurePendingResearchJob(runId: string, leadName: string) {
  return ensurePendingPipelineJob(runId, leadName);
}

async function processJobChain(startJobId: string): Promise<void> {
  let jobId: string | null = startJobId;
  while (jobId) {
    console.log(`  processing job ${jobId}…`);
    const result = await processDraftingJob(jobId);
    console.log(JSON.stringify({ job_id: jobId, result: {
      status: result.status,
      nextJobIds: result.nextJobIds,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    } }, null, 2));

    if (result.status === 'failed') {
      throw new Error(result.errorMessage ?? result.errorCode ?? 'job failed');
    }
    if (result.status === 'superseded' || result.status === 'cancelled') {
      throw new Error(`job ${result.status}`);
    }

    jobId = result.nextJobIds[0] ?? null;
  }
}

async function assertLeadReady(runId: string, leadName: string) {
  const summary = await summarizeLead(runId, leadName);
  if (!summary) throw new Error(`No summary for ${leadName}`);
  if (summary.state !== 'ready_for_review') {
    throw new Error(`${leadName} ended in state ${summary.state} (expected ready_for_review)`);
  }
  if (summary.prompt_version !== DRAFTING_WRITER_PROMPT_VERSION) {
    throw new Error(`${leadName} writer prompt ${summary.prompt_version} (expected ${DRAFTING_WRITER_PROMPT_VERSION})`);
  }
  return summary;
}

async function summarizeLead(runId: string, leadName: string) {
  const { rows } = await dbQuery<{
    full_name: string;
    state: string;
    subject: string | null;
    prompt_version: string | null;
    packet_status: string | null;
    research_cost: string | null;
    write_cost: string | null;
  }>(
    `SELECT l.full_name, i.state,
            d.subject, d.prompt_version,
            p.status AS packet_status,
            (SELECT actual_cost_usd::text FROM outreach.drafting_jobs j
             WHERE j.drafting_item_id = i.id AND j.kind = 'research' AND j.status = 'done'
             ORDER BY j.finished_at DESC NULLS LAST LIMIT 1) AS research_cost,
            (SELECT actual_cost_usd::text FROM outreach.drafting_jobs j
             WHERE j.drafting_item_id = i.id AND j.kind = 'write' AND j.status = 'done'
             ORDER BY j.finished_at DESC NULLS LAST LIMIT 1) AS write_cost
     FROM outreach.drafting_items i
     JOIN outreach.leads l ON l.id = i.lead_id
     LEFT JOIN outreach.email_drafts d ON d.drafting_item_id = i.id
     LEFT JOIN outreach.draft_research_packets p ON p.drafting_item_id = i.id
     WHERE lower(l.full_name) = lower($1)
       AND i.workspace_id = (SELECT workspace_id FROM outreach.drafting_runs WHERE id = $2)`,
    [leadName, runId],
  );
  return rows[0] ?? null;
}

async function main() {
  if (getDraftingMode() !== 'live') {
    throw new Error('DRAFTING_MODE must be live');
  }

  const active = await dbQuery<{ id: string }>(
    `SELECT id FROM outreach.drafting_runs WHERE status = 'active' ORDER BY started_at DESC LIMIT 1`,
  );
  const runId = active.rows[0]?.id;
  if (!runId) throw new Error('No active drafting run');

  await deleteRachelDrafting(runId);

  const results: Array<Record<string, unknown>> = [];

  for (const leadName of TARGET_LEADS) {
    console.log(`\n=== ${leadName} ===`);
    const existing = await summarizeLead(runId, leadName);
    if (
      existing?.state === 'ready_for_review'
      && existing.prompt_version === DRAFTING_WRITER_PROMPT_VERSION
    ) {
      console.log(JSON.stringify({ lead: leadName, skipped: 'already ready_for_review' }, null, 2));
      results.push({ lead: leadName, skipped: true, ...existing });
      continue;
    }

    const job = await ensurePendingPipelineJob(runId, leadName);
    console.log(JSON.stringify({ lead: leadName, job_id: job.job_id, item_state: job.item_state }, null, 2));

    const started = Date.now();
    await processJobChain(job.job_id);
    const summary = await assertLeadReady(runId, leadName);
    results.push({
      lead: leadName,
      elapsed_seconds: Math.round((Date.now() - started) / 1000),
      expected_writer_prompt: DRAFTING_WRITER_PROMPT_VERSION,
      ...summary,
    });
  }

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({ run_id: runId, results }, null, 2));

  const allReady = results.every((row) => row.state === 'ready_for_review');
  const allV4 = results.every((row) => row.prompt_version === DRAFTING_WRITER_PROMPT_VERSION);
  if (!allReady || !allV4) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
