import { dbQuery } from '@/lib/db';

/**
 * Dual-worker fence: the laptop/dev worker claims whenever it is alive.
 * The designated cloud fallback (usually gcp-e2-micro-1) yields while any
 * other worker heartbeat is healthy, then takes over ~45s after the machine
 * goes away.
 *
 * ORCHESTRATION_FALLBACK_WORKER_ID is the preferred knob.
 * ORCHESTRATION_PRIMARY_WORKER_ID is accepted as an alias for the fallback id
 * so existing GCP env files keep working after the invert.
 */
export function fallbackFleetWorkerId(): string | null {
  const fallback = process.env.ORCHESTRATION_FALLBACK_WORKER_ID?.trim();
  if (fallback) return fallback;
  const legacy = process.env.ORCHESTRATION_PRIMARY_WORKER_ID?.trim();
  return legacy || null;
}

/** @deprecated Use fallbackFleetWorkerId — name kept for existing tests/callers. */
export function primaryFleetWorkerId(): string | null {
  return fallbackFleetWorkerId();
}

export function shouldFallbackWorkerYield(
  workerId: string,
  otherWorkerHealthy: boolean,
): boolean {
  const fallback = fallbackFleetWorkerId();
  if (!fallback || workerId !== fallback) return false;
  return otherWorkerHealthy;
}

export async function shouldYieldToPrimaryFleet(workerId: string): Promise<boolean> {
  const fallback = fallbackFleetWorkerId();
  if (!fallback || workerId !== fallback) return false;

  const { rows } = await dbQuery<{ healthy: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM outreach.orchestration_workers
        WHERE worker_id <> $1
          AND heartbeat_at > now() - interval '45 seconds'
     ) AS healthy`,
    [fallback],
  );
  return shouldFallbackWorkerYield(workerId, Boolean(rows[0]?.healthy));
}
