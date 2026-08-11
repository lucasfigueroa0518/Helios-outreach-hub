import type { PoolClient } from 'pg';

import { dbQuery, dbTransaction } from '@/lib/db';
import { KIND_CONFIG, laneLimit, workerLeaseSeconds } from '@/lib/orchestration/config';
import type {
  DispatchWork,
  OrchestrationJob,
  WorkKind,
  WorkLane,
} from '@/lib/orchestration/types';

function assertPostgresOrchestrator(): void {
  const configured = process.env.ORCHESTRATOR?.trim().toLowerCase() || 'postgres';
  if (configured !== 'postgres') {
    throw new Error(`Unsupported ORCHESTRATOR=${configured}; this build requires postgres`);
  }
}

async function enqueueWithClient(client: PoolClient, work: DispatchWork): Promise<string> {
  const config = KIND_CONFIG[work.kind];
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO outreach.orchestration_jobs (
       kind, lane, payload, dedupe_key, scope_key, priority, max_attempts, available_at
     ) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, coalesce($8::timestamptz, now()))
     ON CONFLICT (kind, dedupe_key) DO UPDATE SET
       payload = CASE
         WHEN $9::boolean AND outreach.orchestration_jobs.status IN ('done', 'failed', 'cancelled')
         THEN EXCLUDED.payload
         ELSE outreach.orchestration_jobs.payload
       END,
       scope_key = CASE
         WHEN $9::boolean AND outreach.orchestration_jobs.status IN ('done', 'failed', 'cancelled')
         THEN EXCLUDED.scope_key
         ELSE outreach.orchestration_jobs.scope_key
       END,
       status = CASE
         WHEN $9::boolean AND outreach.orchestration_jobs.status IN ('done', 'failed', 'cancelled')
         THEN 'pending'
         ELSE outreach.orchestration_jobs.status
       END,
       attempt_count = CASE
         WHEN $9::boolean AND outreach.orchestration_jobs.status IN ('done', 'failed', 'cancelled')
         THEN 0
         ELSE outreach.orchestration_jobs.attempt_count
       END,
       available_at = CASE
         WHEN $9::boolean AND outreach.orchestration_jobs.status IN ('done', 'failed', 'cancelled')
         THEN EXCLUDED.available_at
         ELSE outreach.orchestration_jobs.available_at
       END,
       finished_at = CASE
         WHEN $9::boolean AND outreach.orchestration_jobs.status IN ('done', 'failed', 'cancelled')
         THEN NULL
         ELSE outreach.orchestration_jobs.finished_at
       END,
       lease_owner = CASE
         WHEN $9::boolean AND outreach.orchestration_jobs.status IN ('done', 'failed', 'cancelled')
         THEN NULL
         ELSE outreach.orchestration_jobs.lease_owner
       END,
       lease_expires_at = CASE
         WHEN $9::boolean AND outreach.orchestration_jobs.status IN ('done', 'failed', 'cancelled')
         THEN NULL
         ELSE outreach.orchestration_jobs.lease_expires_at
       END,
       heartbeat_at = CASE
         WHEN $9::boolean AND outreach.orchestration_jobs.status IN ('done', 'failed', 'cancelled')
         THEN NULL
         ELSE outreach.orchestration_jobs.heartbeat_at
       END,
       last_error_code = CASE
         WHEN $9::boolean AND outreach.orchestration_jobs.status IN ('done', 'failed', 'cancelled')
         THEN NULL
         ELSE outreach.orchestration_jobs.last_error_code
       END,
       last_error_message = CASE
         WHEN $9::boolean AND outreach.orchestration_jobs.status IN ('done', 'failed', 'cancelled')
         THEN NULL
         ELSE outreach.orchestration_jobs.last_error_message
       END,
       updated_at = now()
     RETURNING id`,
    [
      work.kind,
      config.lane,
      JSON.stringify(work.payload),
      work.dedupeKey,
      work.scopeKey,
      work.priority ?? config.priority,
      work.maxAttempts ?? config.defaultMaxAttempts,
      work.availableAt?.toISOString() ?? null,
      work.reviveTerminal ?? false,
    ],
  );
  return rows[0].id;
}

export async function enqueueWork(work: DispatchWork): Promise<string> {
  assertPostgresOrchestrator();
  return dbTransaction((client) => enqueueWithClient(client, work));
}

/** Enqueue inside a caller-owned transaction (status flip + job must be atomic). */
export async function enqueueWorkInTransaction(
  client: PoolClient,
  work: DispatchWork,
): Promise<string> {
  assertPostgresOrchestrator();
  return enqueueWithClient(client, work);
}

export async function enqueueWorkBatch(works: DispatchWork[]): Promise<string[]> {
  assertPostgresOrchestrator();
  if (!works.length) return [];
  return dbTransaction(async (client) => {
    const ids: string[] = [];
    for (const work of works) ids.push(await enqueueWithClient(client, work));
    return ids;
  });
}

export async function claimWork(
  lane: WorkLane,
  workerId: string,
): Promise<OrchestrationJob | null> {
  assertPostgresOrchestrator();
  const { rows } = await dbQuery<OrchestrationJob>(
    `SELECT *
       FROM public.claim_orchestration_job($1, $2, $3, $4)`,
    [lane, workerId, laneLimit(lane), workerLeaseSeconds()],
  );
  return rows[0] ?? null;
}

export async function heartbeatWork(jobId: string, workerId: string): Promise<boolean> {
  const { rows } = await dbQuery<{ heartbeat_orchestration_job: boolean }>(
    `SELECT public.heartbeat_orchestration_job($1, $2, $3)`,
    [jobId, workerId, workerLeaseSeconds()],
  );
  return Boolean(rows[0]?.heartbeat_orchestration_job);
}

/** Mark parent done and enqueue children in one transaction (transactional outbox). */
export async function completeWork(input: {
  jobId: string;
  workerId: string;
  result?: Record<string, unknown>;
  children?: DispatchWork[];
}): Promise<boolean> {
  return dbTransaction(async (client) => {
    const locked = await client.query<{ id: string }>(
      `SELECT id
         FROM outreach.orchestration_jobs
        WHERE id = $1 AND status = 'in_flight' AND lease_owner = $2
        FOR UPDATE`,
      [input.jobId, input.workerId],
    );
    if (!locked.rows[0]) return false;

    for (const child of input.children ?? []) await enqueueWithClient(client, child);
    await client.query(
      `UPDATE outreach.orchestration_jobs
          SET status = 'done',
              result = $3::jsonb,
              lease_owner = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              finished_at = now(),
              last_error_code = NULL,
              last_error_message = NULL,
              updated_at = now()
        WHERE id = $1 AND lease_owner = $2`,
      [input.jobId, input.workerId, JSON.stringify(input.result ?? {})],
    );
    return true;
  });
}

export async function retryWork(input: {
  jobId: string;
  workerId: string;
  delayMs: number;
  code: string;
  message: string;
}): Promise<boolean> {
  const delaySeconds = Math.max(1, Math.ceil(input.delayMs / 1000));
  const { rowCount } = await dbQuery(
    `UPDATE outreach.orchestration_jobs
        SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'pending' END,
            available_at = now() + make_interval(secs => $3),
            lease_owner = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            finished_at = CASE WHEN attempt_count >= max_attempts THEN now() ELSE NULL END,
            last_error_code = $4,
            last_error_message = $5,
            updated_at = now()
      WHERE id = $1 AND status = 'in_flight' AND lease_owner = $2`,
    [input.jobId, input.workerId, delaySeconds, input.code, input.message.slice(0, 4_000)],
  );
  return (rowCount ?? 0) > 0;
}

export async function failWork(input: {
  jobId: string;
  workerId: string;
  code: string;
  message: string;
}): Promise<boolean> {
  const { rowCount } = await dbQuery(
    `UPDATE outreach.orchestration_jobs
        SET status = 'failed',
            lease_owner = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            finished_at = now(),
            last_error_code = $3,
            last_error_message = $4,
            updated_at = now()
      WHERE id = $1 AND status = 'in_flight' AND lease_owner = $2`,
    [input.jobId, input.workerId, input.code, input.message.slice(0, 4_000)],
  );
  return (rowCount ?? 0) > 0;
}

export async function cancelScope(scopeKey: string): Promise<number> {
  const { rowCount } = await dbQuery(
    `UPDATE outreach.orchestration_jobs
        SET status = 'cancelled',
            lease_owner = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            finished_at = now(),
            updated_at = now()
      WHERE scope_key = $1 AND status = 'pending'`,
    [scopeKey],
  );
  return rowCount ?? 0;
}

export async function cancelWorkByIds(jobIds: string[]): Promise<number> {
  if (jobIds.length === 0) return 0;
  const { rowCount } = await dbQuery(
    `UPDATE outreach.orchestration_jobs
        SET status = 'cancelled',
            lease_owner = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            finished_at = now(),
            updated_at = now()
      WHERE id = ANY($1::uuid[]) AND status = 'pending'`,
    [jobIds],
  );
  return rowCount ?? 0;
}

/**
 * Fixed worker IDs (e.g. gcp-e2-micro-1) keep leases across process restarts.
 * On boot we cannot still be executing those jobs — release them immediately
 * so drafting/research does not stall until lease expiry (~10 minutes).
 */
export async function releaseOwnedInFlightOnStartup(workerId: string): Promise<number> {
  const { rowCount } = await dbQuery(
    `UPDATE outreach.orchestration_jobs
        SET status = 'pending',
            lease_owner = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            started_at = NULL,
            available_at = now(),
            last_error_code = coalesce(last_error_code, 'worker_restart_reclaim'),
            last_error_message = coalesce(
              last_error_message,
              'Reclaimed in-flight lease after worker process restart'
            ),
            updated_at = now()
      WHERE status = 'in_flight'
        AND lease_owner = $1`,
    [workerId],
  );
  return rowCount ?? 0;
}

export async function reschedulePendingWork(
  jobId: string,
  availableAt: Date,
): Promise<boolean> {
  const { rowCount } = await dbQuery(
    `UPDATE outreach.orchestration_jobs
        SET available_at = $2::timestamptz,
            updated_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [jobId, availableAt.toISOString()],
  );
  return (rowCount ?? 0) > 0;
}

export async function registerWorker(
  workerId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await dbQuery(
    `INSERT INTO outreach.orchestration_workers (worker_id, version, metadata)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (worker_id) DO UPDATE SET
       heartbeat_at = now(),
       version = EXCLUDED.version,
       metadata = EXCLUDED.metadata`,
    [workerId, process.env.npm_package_version ?? null, JSON.stringify(metadata)],
  );
}

export async function heartbeatWorker(workerId: string): Promise<void> {
  await dbQuery(
    `UPDATE outreach.orchestration_workers SET heartbeat_at = now() WHERE worker_id = $1`,
    [workerId],
  );
}

export async function unregisterWorker(workerId: string): Promise<void> {
  await dbQuery(`DELETE FROM outreach.orchestration_workers WHERE worker_id = $1`, [workerId]);
}

export const STALE_WORKER_GC_SQL = `DELETE FROM outreach.orchestration_workers
  WHERE heartbeat_at < now() - make_interval(mins => $1)`;

/** Registry cleanup only; worker health continues to use the 45-second window. */
export async function garbageCollectStaleWorkers(maxAgeMinutes = 10): Promise<number> {
  const { rowCount } = await dbQuery(STALE_WORKER_GC_SQL, [maxAgeMinutes]);
  return rowCount ?? 0;
}

export async function hasHealthyWorker(maxAgeSeconds = 45): Promise<boolean> {
  const { rows } = await dbQuery<{ healthy: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM outreach.orchestration_workers
        WHERE heartbeat_at > now() - make_interval(secs => $1)
     ) AS healthy`,
    [maxAgeSeconds],
  );
  return Boolean(rows[0]?.healthy);
}

export async function orchestrationQueueStats(): Promise<Array<{
  lane: WorkLane;
  status: string;
  count: number;
  oldest_at: string | null;
}>> {
  const { rows } = await dbQuery<{
    lane: WorkLane;
    status: string;
    count: number;
    oldest_at: string | null;
  }>(
    `SELECT lane, status, count(*)::int AS count, min(created_at)::text AS oldest_at
       FROM outreach.orchestration_jobs
      GROUP BY lane, status
      ORDER BY lane, status`,
  );
  return rows;
}

export async function draftingOperationalSnapshot(): Promise<{
  workers: { live: number; stale: number };
  performance: {
    completedDraftsLastHour: number;
    costUsdLastHour: number;
    costPerCompletedDraftLastHour: number | null;
  };
  emptyBrief: { retryPending: number; terminal: number; manualRetriesLastHour: number };
  companySingleflight: { researching: number; ready: number; failed: number; parked: number };
  retries: Array<{ surface: string; count: number }>;
  reliability: { providerRateLimitsLastHour: number; poolErrorsLastHour: number; leaseReclaimsLastHour: number };
}> {
  const [workers, performance, emptyBrief, companySingleflight, retries, reliability] = await Promise.all([
    dbQuery<{ live: number; stale: number }>(
      `SELECT
         count(*) FILTER (WHERE heartbeat_at > now() - interval '45 seconds')::int AS live,
         count(*) FILTER (WHERE heartbeat_at <= now() - interval '45 seconds')::int AS stale
       FROM outreach.orchestration_workers`,
    ),
    dbQuery<{
      completed: number;
      cost_usd: string;
      cost_per_completed: string | null;
    }>(
      `WITH completed AS (
         SELECT count(*)::int AS n
           FROM outreach.email_drafts
          WHERE generated_at >= now() - interval '1 hour'
       ), cost AS (
         SELECT coalesce(sum(actual_cost_usd), 0)::text AS usd
           FROM outreach.drafting_jobs
          WHERE finished_at >= now() - interval '1 hour'
       )
       SELECT completed.n AS completed, cost.usd AS cost_usd,
              CASE WHEN completed.n > 0
                THEN (cost.usd::numeric / completed.n)::text
                ELSE NULL
              END AS cost_per_completed
         FROM completed CROSS JOIN cost`,
    ),
    dbQuery<{ retry_pending: number; terminal: number; manual_retries: number }>(
      `SELECT
         count(*) FILTER (WHERE last_error_code = 'empty_research_brief_retry')::int AS retry_pending,
         count(*) FILTER (WHERE last_error_code = 'empty_research_brief')::int AS terminal,
         coalesce(sum((
           SELECT count(*) FROM jsonb_array_elements(retry_audit) event
            WHERE event->>'at' IS NOT NULL
              AND (event->>'at')::timestamptz >= now() - interval '1 hour'
         )), 0)::int AS manual_retries
       FROM outreach.drafting_items`,
    ),
    dbQuery<{ researching: number; ready: number; failed: number; parked: number }>(
      `SELECT
         (SELECT count(*)::int FROM outreach.drafting_company_research_leases
           WHERE status = 'researching') AS researching,
         (SELECT count(*)::int FROM outreach.drafting_company_research_leases
           WHERE status = 'ready') AS ready,
         (SELECT count(*)::int FROM outreach.drafting_company_research_leases
           WHERE status = 'failed') AS failed,
         (SELECT count(*)::int FROM outreach.drafting_items
           WHERE state = 'waiting_company_research') AS parked`,
    ),
    dbQuery<{ surface: string; count: number }>(
      `SELECT coalesce(event->>'surface', 'unknown') AS surface, count(*)::int AS count
         FROM outreach.drafting_items,
              LATERAL jsonb_array_elements(retry_audit) event
        WHERE event->>'at' IS NOT NULL
          AND (event->>'at')::timestamptz >= now() - interval '1 hour'
        GROUP BY coalesce(event->>'surface', 'unknown')
        ORDER BY surface`,
    ),
    dbQuery<{
      provider_rate_limits: number;
      pool_errors: number;
      lease_reclaims: number;
    }>(
      `SELECT
         count(*) FILTER (
           WHERE coalesce(last_error_code, '') ~* 'rate.?limit|429'
              OR coalesce(last_error_message, '') ~* 'rate.?limit|429'
         )::int AS provider_rate_limits,
         count(*) FILTER (
           WHERE coalesce(last_error_message, '') ~* 'EMAXCONNSESSION|max clients|pool'
         )::int AS pool_errors,
         count(*) FILTER (
           WHERE last_error_code IN ('lease_expired', 'reclaimed_stale_in_flight')
         )::int AS lease_reclaims
       FROM outreach.orchestration_jobs
      WHERE coalesce(finished_at, updated_at) >= now() - interval '1 hour'`,
    ),
  ]);
  const performanceRow = performance.rows[0];
  return {
    workers: workers.rows[0] ?? { live: 0, stale: 0 },
    performance: {
      completedDraftsLastHour: performanceRow?.completed ?? 0,
      costUsdLastHour: Number(performanceRow?.cost_usd ?? 0),
      costPerCompletedDraftLastHour: performanceRow?.cost_per_completed == null
        ? null
        : Number(performanceRow.cost_per_completed),
    },
    emptyBrief: {
      retryPending: emptyBrief.rows[0]?.retry_pending ?? 0,
      terminal: emptyBrief.rows[0]?.terminal ?? 0,
      manualRetriesLastHour: emptyBrief.rows[0]?.manual_retries ?? 0,
    },
    companySingleflight: companySingleflight.rows[0]
      ?? { researching: 0, ready: 0, failed: 0, parked: 0 },
    retries: retries.rows,
    reliability: {
      providerRateLimitsLastHour: reliability.rows[0]?.provider_rate_limits ?? 0,
      poolErrorsLastHour: reliability.rows[0]?.pool_errors ?? 0,
      leaseReclaimsLastHour: reliability.rows[0]?.lease_reclaims ?? 0,
    },
  };
}

/** Cap orphan fan-out per reconcile tick so maintenance cannot enqueue thousands. */
export const RECONCILE_ORPHAN_FANOUT_LIMIT = 75;

export async function resetBackingPendingWork(
  limitPerKind = RECONCILE_ORPHAN_FANOUT_LIMIT,
): Promise<DispatchWork[]> {
  const works: DispatchWork[] = [];
  const pageLimit = Math.max(1, Math.min(500, Math.floor(limitPerKind)));

  // Reclaim pending + orphaned in_flight research (worker died after claim;
  // orch job already terminal). Without this, enriching runs hang forever.
  await dbQuery(
    `UPDATE outreach.company_research_jobs AS crj
        SET status = 'pending',
            claimed_at = NULL,
            last_error = coalesce(last_error, 'reclaimed_stale_in_flight'),
            updated_at = now()
      WHERE crj.id IN (
        SELECT crj2.id
          FROM outreach.company_research_jobs AS crj2
         WHERE crj2.status = 'in_flight'
           AND crj2.claimed_at < now() - interval '10 minutes'
           AND crj2.attempt_count < 5
           AND NOT EXISTS (
             SELECT 1
               FROM outreach.orchestration_jobs oj
              WHERE oj.dedupe_key = crj2.id::text
                AND oj.kind IN ('research.company', 'research.profile_rescue', 'research.email_rescue')
                AND oj.status IN ('pending', 'in_flight')
           )
         ORDER BY crj2.claimed_at ASC NULLS FIRST
         LIMIT $1
      )`,
    [pageLimit],
  );

  const research = await dbQuery<{ id: string; job_kind: string; requested_by_runs: string[] }>(
    `SELECT crj.id, crj.job_kind, crj.requested_by_runs
       FROM outreach.company_research_jobs crj
      WHERE crj.status = 'pending'
        AND crj.attempt_count < 5
        AND NOT EXISTS (
          SELECT 1
            FROM outreach.orchestration_jobs oj
           WHERE oj.dedupe_key = crj.id::text
             AND oj.kind IN ('research.company', 'research.profile_rescue', 'research.email_rescue')
             AND oj.status IN ('pending', 'in_flight')
        )
      ORDER BY crj.updated_at ASC NULLS FIRST, crj.created_at ASC
      LIMIT $1`,
    [pageLimit],
  );
  for (const row of research.rows) {
    const kind: WorkKind = row.job_kind === 'profile_rescue'
      ? 'research.profile_rescue'
      : row.job_kind === 'email_rescue'
        ? 'research.email_rescue'
        : 'research.company';
    works.push({
      kind,
      payload: { jobId: row.id },
      dedupeKey: row.id,
      scopeKey: row.requested_by_runs[0] ?? `research:${row.id}`,
      reviveTerminal: true,
    } as DispatchWork);
  }

  const drafting = await dbQuery<{
    id: string;
    kind: string;
    drafting_run_id: string;
  }>(
    `SELECT dj.id, dj.kind, dj.drafting_run_id
       FROM outreach.drafting_jobs dj
      WHERE dj.status = 'pending'
        AND dj.attempt_count < dj.max_attempts
        AND dj.next_attempt_at <= now()
        AND NOT EXISTS (
          SELECT 1
            FROM outreach.orchestration_jobs oj
           WHERE oj.dedupe_key = dj.id::text
             AND oj.kind LIKE 'drafting.job.%'
             AND oj.status IN ('pending', 'in_flight')
        )
      ORDER BY dj.priority DESC, dj.next_attempt_at ASC, dj.created_at ASC
      LIMIT $1`,
    [pageLimit],
  );
  for (const row of drafting.rows) {
    const kind: WorkKind = row.kind === 'verify_mailbox'
      ? 'drafting.job.verify_mailbox'
      : row.kind === 'research'
        ? 'drafting.job.process'
        : 'drafting.job.write';
    works.push({
      kind,
      payload: { jobId: row.id },
      dedupeKey: row.id,
      scopeKey: row.drafting_run_id,
      reviveTerminal: true,
    });
  }

  return works;
}

/** Reset expired/orphaned in-flight orch leases even when the worker is saturated. */
export async function reclaimExpiredOrchestrationLeases(limit = 50): Promise<number> {
  const { rowCount } = await dbQuery(
    `WITH stale AS (
       SELECT candidate.id
         FROM outreach.orchestration_jobs AS candidate
        WHERE candidate.status = 'in_flight'
          AND candidate.attempt_count < candidate.max_attempts
          AND (
            candidate.lease_expires_at <= now()
            OR candidate.lease_owner IS NULL
            OR NOT EXISTS (
              SELECT 1
                FROM outreach.orchestration_workers worker
               WHERE worker.worker_id = candidate.lease_owner
                 AND worker.heartbeat_at > now() - interval '45 seconds'
            )
          )
        ORDER BY candidate.lease_expires_at ASC NULLS FIRST
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE outreach.orchestration_jobs AS job
        SET status = 'pending',
            lease_owner = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            last_error_code = 'lease_expired',
            last_error_message = coalesce(last_error_message, 'reclaimed while worker saturated'),
            updated_at = now()
       FROM stale
      WHERE job.id = stale.id`,
    [Math.max(1, Math.min(200, Math.floor(limit)))],
  );
  return rowCount ?? 0;
}
