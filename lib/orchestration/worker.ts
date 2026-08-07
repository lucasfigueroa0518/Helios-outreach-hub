import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

import { dbPoolSnapshot } from '@/lib/db';
import { draftingAnthropicSnapshot } from '@/lib/drafting/anthropic-semaphore';
import {
  jitteredBackoffMs,
  workerLeaseSeconds,
  workerMaxConcurrency,
  workerPollMs,
} from '@/lib/orchestration/config';
import {
  enqueueReconciliation,
  handleWork,
  markTerminalWorkFailure,
} from '@/lib/orchestration/handlers';
import {
  claimWork,
  completeWork,
  draftingOperationalSnapshot,
  failWork,
  heartbeatWork,
  heartbeatWorker,
  registerWorker,
  orchestrationQueueStats,
  retryWork,
  unregisterWorker,
} from '@/lib/orchestration/repository';
import {
  RetryableWorkError,
  WORK_LANES,
  type OrchestrationJob,
  type WorkLane,
} from '@/lib/orchestration/types';

type LogFields = Record<string, unknown>;

function log(level: 'info' | 'error' | 'warn', message: string, fields: LogFields = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    component: 'orchestration-worker',
    message,
    ...fields,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function errorCode(error: unknown): string {
  if (error instanceof RetryableWorkError) return error.code;
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code?: unknown }).code ?? 'handler_error');
  }
  return 'handler_error';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function drainActiveJobs(
  active: ReadonlyMap<string, Promise<void>>,
  graceMs: number,
): Promise<string[]> {
  if (active.size === 0) return [];
  let timeout: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      Promise.allSettled([...active.values()]),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, Math.max(0, graceMs));
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  return [...active.keys()];
}

export class OrchestrationWorker {
  readonly workerId: string;
  private active = new Map<string, Promise<void>>();
  private stopping = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private workerHeartbeatTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private telemetryTimer: NodeJS.Timeout | null = null;
  private laneCursor = 0;
  private activeByLane = new Map<WorkLane, number>();
  private stopPromise: Promise<number> | null = null;
  private lastBillingGuardLogAt = 0;

  constructor(workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`) {
    this.workerId = workerId;
  }

  async start(): Promise<void> {
    await registerWorker(this.workerId, {
      pid: process.pid,
      hostname: hostname(),
      lanes: WORK_LANES,
    });
    if (this.stopping) {
      await unregisterWorker(this.workerId).catch(() => undefined);
      return;
    }
    await enqueueReconciliation('worker_start');
    if (this.stopping) {
      await unregisterWorker(this.workerId).catch(() => undefined);
      return;
    }
    const { describeDbTarget } = await import('@/lib/db');
    const dbTarget = describeDbTarget();
    log('info', 'worker_started', {
      workerId: this.workerId,
      processConcurrency: workerMaxConcurrency(),
      leaseSeconds: workerLeaseSeconds(),
      dbMode: dbTarget.mode,
      dbHostPort: dbTarget.hostPort,
      pgPoolMax: Number(process.env.PG_POOL_MAX ?? 2),
    });
    const pgPoolMax = Number(process.env.PG_POOL_MAX ?? 2);
    if (Number.isFinite(pgPoolMax) && workerMaxConcurrency() > Math.max(1, pgPoolMax) * 4) {
      log('warn', 'worker_concurrency_exceeds_pool_budget', {
        processConcurrency: workerMaxConcurrency(),
        pgPoolMax,
      });
    }

    this.workerHeartbeatTimer = setInterval(() => {
      void heartbeatWorker(this.workerId).catch((error) => {
        log('error', 'worker_heartbeat_failed', {
          workerId: this.workerId,
          error: errorMessage(error),
        });
      });
    }, 10_000);
    this.workerHeartbeatTimer.unref();

    this.reconcileTimer = setInterval(() => {
      void enqueueReconciliation('periodic').catch((error) => {
        log('error', 'reconcile_enqueue_failed', { error: errorMessage(error) });
      });
    }, 30_000);
    this.reconcileTimer.unref();

    this.telemetryTimer = setInterval(() => {
      void Promise.all([
        orchestrationQueueStats(),
        draftingOperationalSnapshot(),
      ]).then(([queue, drafting]) => {
        log('info', 'worker_saturation', {
          workerId: this.workerId,
          active: this.active.size,
          activeByLane: Object.fromEntries(this.activeByLane),
          processConcurrency: workerMaxConcurrency(),
          anthropic: draftingAnthropicSnapshot(),
          pool: dbPoolSnapshot(),
          queue,
          drafting,
        });
      }).catch((error) => {
        log('warn', 'worker_telemetry_failed', { error: errorMessage(error) });
      });
    }, 30_000);
    this.telemetryTimer.unref();

    this.schedulePoll(0);
  }

  private schedulePoll(delay = workerPollMs()) {
    if (this.stopping) return;
    this.pollTimer = setTimeout(() => void this.poll(), delay);
  }

  private async poll(): Promise<void> {
    if (this.stopping) return;
    const maximum = workerMaxConcurrency();
    try {
      // Fail-closed: if GCP billing guard tripped (spend > $0), do not claim work.
      const { isBillingGuardTripped } = await import('@/lib/billing-guard');
      if (await isBillingGuardTripped()) {
        const now = Date.now();
        if (now - this.lastBillingGuardLogAt > 60_000) {
          this.lastBillingGuardLogAt = now;
          log('error', 'billing_guard_fail_closed', {
            workerId: this.workerId,
            message: 'Cloud worker billing guard is tripped; refusing to claim jobs',
          });
        }
        return;
      }

      let checked = 0;
      while (!this.stopping && this.active.size < maximum && checked < WORK_LANES.length) {
        const lane = WORK_LANES[this.laneCursor % WORK_LANES.length] as WorkLane;
        this.laneCursor = (this.laneCursor + 1) % WORK_LANES.length;
        checked += 1;
        const job = await claimWork(lane, this.workerId);
        if (!job) continue;
        this.activeByLane.set(job.lane, (this.activeByLane.get(job.lane) ?? 0) + 1);
        const execution = this.execute(job).finally(() => {
          this.active.delete(job.id);
          const remaining = Math.max(0, (this.activeByLane.get(job.lane) ?? 1) - 1);
          if (remaining === 0) this.activeByLane.delete(job.lane);
          else this.activeByLane.set(job.lane, remaining);
        });
        this.active.set(job.id, execution);
      }
    } catch (error) {
      log('error', 'poll_failed', {
        workerId: this.workerId,
        error: errorMessage(error),
      });
    } finally {
      this.schedulePoll();
    }
  }

  private async execute(job: OrchestrationJob): Promise<void> {
    const startedAt = Date.now();
    // Drafting research/write can run 60–120s; heartbeat more often than lease/3
    // so a brief GC pause or pool wait does not drop the orch lease mid-job.
    const heartbeatEveryMs = String(job.kind).startsWith('drafting.')
      ? 30_000
      : Math.max(5_000, Math.floor(workerLeaseSeconds() * 1_000 / 3));
    const heartbeatTimer = setInterval(() => {
      void heartbeatWork(job.id, this.workerId).then((owned) => {
        if (!owned) {
          log('warn', 'job_lease_lost', {
            workerId: this.workerId,
            jobId: job.id,
            kind: job.kind,
            lane: job.lane,
          });
        }
      }).catch((error) => {
        log('error', 'job_heartbeat_failed', {
          workerId: this.workerId,
          jobId: job.id,
          error: errorMessage(error),
        });
      });
    }, heartbeatEveryMs);
    heartbeatTimer.unref();

    log('info', 'job_started', {
      workerId: this.workerId,
      jobId: job.id,
      kind: job.kind,
      lane: job.lane,
      scopeKey: job.scope_key,
      attempt: job.attempt_count,
      claimLatencyMs: Math.max(0, Date.now() - new Date(job.created_at).getTime()),
    });

    try {
      const outcome = await handleWork(job);
      const completed = await completeWork({
        jobId: job.id,
        workerId: this.workerId,
        result: outcome.result,
        children: outcome.children,
      });
      log(completed ? 'info' : 'warn', completed ? 'job_completed' : 'job_completion_lease_lost', {
        workerId: this.workerId,
        jobId: job.id,
        kind: job.kind,
        lane: job.lane,
        attempt: job.attempt_count,
        durationMs: Date.now() - startedAt,
        children: outcome.children?.length ?? 0,
      });
    } catch (error) {
      const code = errorCode(error);
      const message = errorMessage(error);
      const retryable = job.attempt_count < job.max_attempts;
      if (retryable) {
        const delayMs = error instanceof RetryableWorkError
          ? error.delayMs
          : jitteredBackoffMs(job.attempt_count);
        await retryWork({
          jobId: job.id,
          workerId: this.workerId,
          delayMs,
          code,
          message,
        });
        log('warn', 'job_retry_scheduled', {
          workerId: this.workerId,
          jobId: job.id,
          kind: job.kind,
          lane: job.lane,
          attempt: job.attempt_count,
          delayMs,
          durationMs: Date.now() - startedAt,
          errorCode: code,
          error: message,
        });
      } else {
        await failWork({
          jobId: job.id,
          workerId: this.workerId,
          code,
          message,
        });
        await markTerminalWorkFailure(job, message).catch((markError) => {
          log('error', 'backing_failure_mark_failed', {
            jobId: job.id,
            kind: job.kind,
            error: errorMessage(markError),
          });
        });
        log('error', 'job_failed', {
          workerId: this.workerId,
          jobId: job.id,
          kind: job.kind,
          lane: job.lane,
          attempt: job.attempt_count,
          durationMs: Date.now() - startedAt,
          errorCode: code,
          error: message,
        });
      }
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  async stop(graceMs = 30_000): Promise<number> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOnce(graceMs);
    return this.stopPromise;
  }

  private async stopOnce(graceMs: number): Promise<number> {
    // Stop timers/claims before draining. New work cannot enter active after
    // this point because poll checks `stopping` before every claim cycle.
    this.stopping = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.telemetryTimer) {
      clearInterval(this.telemetryTimer);
      this.telemetryTimer = null;
    }

    try {
      const remainingJobIds = await drainActiveJobs(this.active, graceMs);
      if (remainingJobIds.length > 0) {
        log('warn', 'worker_shutdown_drain_expired', {
          workerId: this.workerId,
          activeRemaining: remainingJobIds.length,
          remainingJobIds,
        });
      }
      return remainingJobIds.length;
    } finally {
      // Keep the registry heartbeat alive for the full drain. Per-job heartbeat
      // timers are owned by execute() and remain live until each body settles.
      if (this.workerHeartbeatTimer) {
        clearInterval(this.workerHeartbeatTimer);
        this.workerHeartbeatTimer = null;
      }
      await unregisterWorker(this.workerId).catch((error) => {
        log('warn', 'worker_unregister_failed', {
          workerId: this.workerId,
          error: errorMessage(error),
        });
      });
      log('info', 'worker_stopped', {
        workerId: this.workerId,
        activeRemaining: this.active.size,
      });
    }
  }
}
