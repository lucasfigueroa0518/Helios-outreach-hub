import fs from 'node:fs';
import { dbQuery } from '@/lib/db';
import { durationBetween, formatDuration } from '@/scripts/lib/stopwatch';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

async function main() {
  const runs = await dbQuery<{
    run_id: string;
    campaign_id: string;
    campaign_name: string;
    workspace_status: string;
    run_status: string;
    trigger: string;
    target_count: number;
    started_at: string;
    finished_at: string | null;
    actual_cost_usd: string;
    usage: Record<string, unknown>;
  }>(
    `SELECT r.id AS run_id,
            c.id AS campaign_id,
            c.name AS campaign_name,
            w.status AS workspace_status,
            r.status AS run_status,
            r.trigger,
            r.target_count,
            r.started_at,
            r.finished_at,
            r.actual_cost_usd::text,
            r.usage
     FROM outreach.drafting_runs r
     JOIN outreach.drafting_workspaces w ON w.id = r.workspace_id
     JOIN outreach.campaigns c ON c.id = w.campaign_id
     ORDER BY r.started_at DESC
     LIMIT 5`,
  );

  const activeRun = runs.rows.find((row) => row.run_status === 'active') ?? runs.rows[0];
  if (!activeRun) {
    console.log(JSON.stringify({ error: 'No drafting runs found' }, null, 2));
    return;
  }

  const jobCounts = await dbQuery<{ status: string; kind: string; count: number }>(
    `SELECT status, kind, count(*)::int AS count
     FROM outreach.drafting_jobs
     WHERE drafting_run_id = $1
     GROUP BY status, kind
     ORDER BY kind, status`,
    [activeRun.run_id],
  );

  const staleJobs = await dbQuery<{
    id: string;
    kind: string;
    status: string;
    attempt_count: number;
    heartbeat_at: string | null;
    claimed_at: string | null;
    last_error_message: string | null;
    lead_name: string | null;
    age_seconds: number;
  }>(
    `SELECT j.id, j.kind, j.status, j.attempt_count,
            j.heartbeat_at, j.claimed_at, j.last_error_message,
            l.full_name AS lead_name,
            extract(epoch from (now() - coalesce(j.heartbeat_at, j.claimed_at, j.created_at)))::int AS age_seconds
     FROM outreach.drafting_jobs j
     LEFT JOIN outreach.drafting_items i ON i.id = j.drafting_item_id
     LEFT JOIN outreach.leads l ON l.id = i.lead_id
     WHERE j.drafting_run_id = $1
       AND j.status IN ('pending', 'claimed', 'in_flight')
     ORDER BY age_seconds DESC
     LIMIT 20`,
    [activeRun.run_id],
  );

  const itemCounts = await dbQuery<{ state: string; count: number }>(
    `SELECT state, count(*)::int AS count
     FROM outreach.drafting_items
     WHERE workspace_id = (
       SELECT workspace_id FROM outreach.drafting_runs WHERE id = $1
     )
     GROUP BY state
     ORDER BY state`,
    [activeRun.run_id],
  );

  const recentActivity = await dbQuery<{
    id: string;
    kind: string;
    status: string;
    finished_at: string | null;
    lead_name: string | null;
    last_error_message: string | null;
    last_error_code: string | null;
  }>(
    `SELECT j.id, j.kind, j.status, j.finished_at,
            l.full_name AS lead_name,
            j.last_error_message,
            j.last_error_code
     FROM outreach.drafting_jobs j
     LEFT JOIN outreach.drafting_items i ON i.id = j.drafting_item_id
     LEFT JOIN outreach.leads l ON l.id = i.lead_id
     WHERE j.drafting_run_id = $1
     ORDER BY coalesce(j.finished_at, j.claimed_at, j.created_at) DESC
     LIMIT 10`,
    [activeRun.run_id],
  );

  const queuedItems = await dbQuery<{
    full_name: string;
    state: string;
    input_fingerprint: string | null;
    delivery_snapshot: Record<string, unknown>;
    job_status: string | null;
    expected_input_fingerprint: string | null;
    last_error_code: string | null;
    fingerprint_match: boolean | null;
  }>(
    `SELECT l.full_name, i.state, i.input_fingerprint, i.delivery_snapshot,
            j.status AS job_status, j.expected_input_fingerprint,
            j.last_error_code,
            (i.input_fingerprint IS NOT DISTINCT FROM j.expected_input_fingerprint) AS fingerprint_match
     FROM outreach.drafting_items i
     JOIN outreach.leads l ON l.id = i.lead_id
     LEFT JOIN outreach.drafting_jobs j
       ON j.drafting_item_id = i.id AND j.drafting_run_id = $1
     WHERE i.state = 'queued_research'
     ORDER BY l.full_name
     LIMIT 8`,
    [activeRun.run_id],
  );

  const supersededReasons = await dbQuery<{ last_error_code: string | null; count: number }>(
    `SELECT last_error_code, count(*)::int AS count
     FROM outreach.drafting_jobs
     WHERE drafting_run_id = $1 AND status = 'superseded'
     GROUP BY last_error_code`,
    [activeRun.run_id],
  );

  // claimed_at is cleared when jobs finish — use created_at as stage start.
  const leadTimings = await dbQuery<{
    full_name: string | null;
    item_state: string;
    research_started_at: string | null;
    research_finished_at: string | null;
    write_started_at: string | null;
    write_finished_at: string | null;
    draft_generated_at: string | null;
    subject: string | null;
    prompt_version: string | null;
  }>(
    `SELECT l.full_name, i.state AS item_state,
            rj.created_at::text AS research_started_at,
            rj.finished_at::text AS research_finished_at,
            wj.created_at::text AS write_started_at,
            coalesce(wj.finished_at, d.generated_at)::text AS write_finished_at,
            d.generated_at::text AS draft_generated_at,
            d.subject,
            d.prompt_version
     FROM outreach.drafting_items i
     JOIN outreach.leads l ON l.id = i.lead_id
     LEFT JOIN LATERAL (
       SELECT created_at, finished_at
       FROM outreach.drafting_jobs
       WHERE drafting_item_id = i.id AND kind = 'research'
       ORDER BY created_at DESC
       LIMIT 1
     ) rj ON true
     LEFT JOIN LATERAL (
       SELECT created_at, finished_at
       FROM outreach.drafting_jobs
       WHERE drafting_item_id = i.id AND kind = 'write'
       ORDER BY created_at DESC
       LIMIT 1
     ) wj ON true
     LEFT JOIN outreach.email_drafts d ON d.drafting_item_id = i.id
     WHERE i.workspace_id = (
       SELECT workspace_id FROM outreach.drafting_runs WHERE id = $1
     )
       AND i.state IN ('ready_for_review', 'approved', 'writing', 'researching', 'queued_write', 'failed_research', 'failed_write')
     ORDER BY coalesce(d.generated_at, wj.finished_at, rj.finished_at, i.updated_at) DESC NULLS LAST
     LIMIT 20`,
    [activeRun.run_id],
  );

  const lead_timings = leadTimings.rows.map((row) => {
    const end = row.draft_generated_at ?? row.write_finished_at;
    const start = row.research_started_at;
    let total_ms: number | null = null;
    if (start && end) {
      const a = Date.parse(start);
      const b = Date.parse(end);
      if (Number.isFinite(a) && Number.isFinite(b) && b >= a) total_ms = b - a;
    }
    return {
      lead: row.full_name,
      item_state: row.item_state,
      subject: row.subject,
      prompt_version: row.prompt_version,
      research: durationBetween(row.research_started_at, row.research_finished_at),
      write: durationBetween(row.write_started_at, row.write_finished_at ?? row.draft_generated_at),
      total: total_ms != null ? formatDuration(total_ms) : null,
      total_ms,
    };
  });

  const runAgeSeconds = Math.round(
    (Date.now() - new Date(activeRun.started_at).getTime()) / 1000,
  );
  const openJobs = staleJobs.rows;
  const likelyStuck = openJobs.filter((job) => job.age_seconds > 180);

  console.log(JSON.stringify({
    campaign: {
      id: activeRun.campaign_id,
      name: activeRun.campaign_name,
      workspace_status: activeRun.workspace_status,
    },
    run: {
      id: activeRun.run_id,
      status: activeRun.run_status,
      trigger: activeRun.trigger,
      target_count: activeRun.target_count,
      started_at: activeRun.started_at,
      finished_at: activeRun.finished_at,
      age_seconds: runAgeSeconds,
      actual_cost_usd: activeRun.actual_cost_usd,
      usage: activeRun.usage,
    },
    jobs_by_status_kind: jobCounts.rows,
    item_states: itemCounts.rows,
    open_jobs: openJobs,
    likely_stuck_jobs: likelyStuck,
    recent_activity: recentActivity.rows,
    queued_research_sample: queuedItems.rows,
    superseded_reasons: supersededReasons.rows,
    lead_timings,
    orchestrator: process.env.ORCHESTRATOR ?? 'postgres',
    assessment: assess(activeRun, jobCounts.rows, openJobs, likelyStuck),
  }, null, 2));
}

function assess(
  run: { run_status: string; started_at: string; finished_at: string | null },
  jobCounts: Array<{ status: string; kind: string; count: number }>,
  openJobs: Array<{ status: string; age_seconds: number }>,
  likelyStuck: Array<{ status: string; age_seconds: number }>,
) {
  if (run.run_status !== 'active') {
    return run.run_status === 'complete' ? 'complete' : run.run_status;
  }
  const pending = jobCounts
    .filter((row) => row.status === 'pending')
    .reduce((sum, row) => sum + row.count, 0);
  const inFlight = jobCounts
    .filter((row) => ['claimed', 'in_flight'].includes(row.status))
    .reduce((sum, row) => sum + row.count, 0);
  if (likelyStuck.length > 0) return 'likely_stuck';
  if (inFlight > 0) return 'running';
  if (pending > 0 && openJobs.every((job) => job.age_seconds < 60)) return 'starting';
  if (pending > 0) return 'queued';
  const supersededOnly = jobCounts.every((row) => row.status === 'superseded' || row.status === 'done');
  const hasSuperseded = jobCounts.some((row) => row.status === 'superseded');
  if (run.run_status === 'active' && hasSuperseded && pending === 0 && inFlight === 0) {
    return 'stuck_superseded_no_requeue';
  }
  return 'active_no_open_jobs';
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
