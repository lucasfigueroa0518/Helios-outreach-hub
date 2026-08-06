/**
 * Poll drafting orchestration for a campaign and append timing snapshots.
 * Usage: node scripts/observe-drafting-run.mjs <campaignId> [intervalMs]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) process.env[match[1]] = match[2];
  }
}

const campaignId = process.argv[2] || '2e600d5a-3998-4174-9814-00039a7de9d7';
const intervalMs = Number(process.argv[3] || 5000);
const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error('No DATABASE_URL');

const outDir = path.join(root, 'tmp');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `drafting-observe-${campaignId.slice(0, 8)}.jsonl`);

const pool = new pg.Pool({
  connectionString: process.platform === 'win32'
    ? `${url}${url.includes('?') ? '&' : '?'}sslmode=disable`
    : url,
  max: 1,
});

async function snapshot() {
  const workspace = await pool.query(
    `SELECT id::text, status, last_started_at, generation_completed_at, updated_at
       FROM outreach.drafting_workspaces
      WHERE campaign_id = $1`,
    [campaignId],
  );
  const ws = workspace.rows[0];
  if (!ws) {
    return { ts: new Date().toISOString(), campaignId, workspace: null };
  }

  const runs = await pool.query(
    `SELECT id::text, trigger, status, target_count, started_at, finished_at,
            reserved_cost_usd::text, spent_cost_usd::text
       FROM outreach.drafting_runs
      WHERE workspace_id = $1
      ORDER BY started_at DESC
      LIMIT 3`,
    [ws.id],
  );

  const itemStates = await pool.query(
    `SELECT state, count(*)::int AS n
       FROM outreach.drafting_items
      WHERE workspace_id = $1 AND removed_at IS NULL
      GROUP BY 1
      ORDER BY 1`,
    [ws.id],
  );

  const delivery = await pool.query(
    `SELECT coalesce(delivery_snapshot->>'emailVerification', 'null') AS v, count(*)::int AS n
       FROM outreach.drafting_items
      WHERE workspace_id = $1 AND removed_at IS NULL
      GROUP BY 1
      ORDER BY 1`,
    [ws.id],
  );

  const jobs = await pool.query(
    `SELECT j.kind, j.status, count(*)::int AS n,
            round(avg(EXTRACT(EPOCH FROM (coalesce(j.finished_at, now()) - j.claimed_at)))::numeric, 1) AS avg_claim_s
       FROM outreach.drafting_jobs j
       JOIN outreach.drafting_runs r ON r.id = j.drafting_run_id
      WHERE r.workspace_id = $1
        AND j.created_at > now() - interval '6 hours'
      GROUP BY 1, 2
      ORDER BY 1, 2`,
    [ws.id],
  );

  const orch = await pool.query(
    `SELECT kind, status, count(*)::int AS n,
            round(avg(EXTRACT(EPOCH FROM (coalesce(finished_at, now()) - coalesce(started_at, created_at))))::numeric, 1) AS avg_s
       FROM outreach.orchestration_jobs
      WHERE scope_key = ANY($1::text[])
         OR (kind LIKE 'drafting%' AND created_at > now() - interval '6 hours'
             AND payload->>'jobId' IN (
               SELECT j.id::text FROM outreach.drafting_jobs j
               JOIN outreach.drafting_runs r ON r.id = j.drafting_run_id
               WHERE r.workspace_id = $2
             ))
      GROUP BY 1, 2
      ORDER BY 1, 2`,
    [runs.rows.map((r) => r.id), ws.id],
  ).catch(async () => {
    // Fallback without started_at if column missing
    return pool.query(
      `SELECT kind, status, count(*)::int AS n
         FROM outreach.orchestration_jobs
        WHERE scope_key = ANY($1::text[])
        GROUP BY 1, 2
        ORDER BY 1, 2`,
      [runs.rows.map((r) => r.id)],
    );
  });

  const inFlight = await pool.query(
    `SELECT j.id::text, j.kind, j.status, j.attempt_count,
            j.claimed_at, j.last_error_code,
            EXTRACT(EPOCH FROM (now() - j.claimed_at))::int AS claimed_for_s
       FROM outreach.drafting_jobs j
       JOIN outreach.drafting_runs r ON r.id = j.drafting_run_id
      WHERE r.workspace_id = $1
        AND j.status = 'in_flight'
      ORDER BY j.claimed_at NULLS LAST
      LIMIT 20`,
    [ws.id],
  );

  return {
    ts: new Date().toISOString(),
    campaignId,
    workspace: ws,
    runs: runs.rows,
    itemStates: itemStates.rows,
    delivery: delivery.rows,
    jobs: jobs.rows,
    orch: orch.rows,
    inFlight: inFlight.rows,
  };
}

console.log(`Observing campaign ${campaignId} every ${intervalMs}ms → ${outFile}`);
console.log('Ctrl+C to stop');

let ticks = 0;
async function tick() {
  try {
    const snap = await snapshot();
    fs.appendFileSync(outFile, `${JSON.stringify(snap)}\n`);
    ticks += 1;
    const states = (snap.itemStates || []).map((r) => `${r.state}:${r.n}`).join(' ');
    const jobSummary = (snap.jobs || []).map((r) => `${r.kind}/${r.status}:${r.n}`).join(' ');
    console.log(
      `[${snap.ts}] tick=${ticks} items{${states || 'none'}} jobs{${jobSummary || 'none'}} inFlight=${snap.inFlight?.length ?? 0}`,
    );
  } catch (error) {
    console.error('snapshot failed', error);
  }
}

await tick();
const timer = setInterval(tick, intervalMs);
process.on('SIGINT', async () => {
  clearInterval(timer);
  await pool.end();
  process.exit(0);
});
