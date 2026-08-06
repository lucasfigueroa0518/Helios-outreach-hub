import fs from 'node:fs';

if (fs.existsSync('.env.local')) {
  for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

async function main() {
  const { dbPoolSnapshot, dbQuery } = await import('@/lib/db');
  const { draftingAnthropicSnapshot } = await import('@/lib/drafting/anthropic-semaphore');
  const { laneLimit, workerMaxConcurrency } = await import('@/lib/orchestration/config');
  const {
    draftingOperationalSnapshot,
    orchestrationQueueStats,
  } = await import('@/lib/orchestration/repository');
  const workers = await dbQuery<{
    worker_id: string;
    heartbeat_at: string;
    heartbeat_age_seconds: number;
    metadata: Record<string, unknown>;
  }>(
    `SELECT worker_id,
            heartbeat_at::text,
            extract(epoch FROM now() - heartbeat_at)::int AS heartbeat_age_seconds,
            metadata
       FROM outreach.orchestration_workers
      ORDER BY heartbeat_at DESC`,
  );
  const failures = await dbQuery<{
    id: string;
    kind: string;
    lane: string;
    scope_key: string;
    attempt_count: number;
    last_error_code: string | null;
    last_error_message: string | null;
    finished_at: string | null;
  }>(
    `SELECT id, kind, lane, scope_key, attempt_count,
            last_error_code, last_error_message, finished_at::text
       FROM outreach.orchestration_jobs
      WHERE status = 'failed'
      ORDER BY finished_at DESC NULLS LAST
      LIMIT 20`,
  );
  const oldestPending = await dbQuery<{
    id: string;
    kind: string;
    lane: string;
    scope_key: string;
    age_seconds: number;
    available_at: string;
  }>(
    `SELECT id, kind, lane, scope_key,
            extract(epoch FROM now() - created_at)::int AS age_seconds,
            available_at::text
       FROM outreach.orchestration_jobs
      WHERE status = 'pending'
      ORDER BY created_at
      LIMIT 20`,
  );

  console.log(JSON.stringify({
    config: {
      draftingResearch: laneLimit('drafting'),
      draftingWrite: laneLimit('drafting_write'),
      workerMax: workerMaxConcurrency(),
      mailboxVerify: laneLimit('mailbox_verify'),
      enrichmentResearch: laneLimit('research'),
    },
    anthropic: draftingAnthropicSnapshot(),
    pool: dbPoolSnapshot(),
    workers: {
      live: workers.rows.filter((worker) => worker.heartbeat_age_seconds <= 45),
      stale: workers.rows.filter((worker) => worker.heartbeat_age_seconds > 45),
    },
    queue: await orchestrationQueueStats(),
    drafting: await draftingOperationalSnapshot(),
    oldest_pending: oldestPending.rows,
    recent_failures: failures.rows,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
