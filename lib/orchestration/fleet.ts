import { dbQuery } from '@/lib/db';

/**
 * Dual-worker fence: when ORCHESTRATION_PRIMARY_WORKER_ID is set and that
 * worker is healthy, every other worker ID yields claim loops so laptop + GCP
 * do not race the same queue.
 *
 * Failover: if the primary heartbeat is stale, secondaries claim again.
 */
export function primaryFleetWorkerId(): string | null {
  const value = process.env.ORCHESTRATION_PRIMARY_WORKER_ID?.trim();
  return value || null;
}

export async function shouldYieldToPrimaryFleet(workerId: string): Promise<boolean> {
  const primary = primaryFleetWorkerId();
  if (!primary || primary === workerId) return false;

  const { rows } = await dbQuery<{ healthy: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM outreach.orchestration_workers
        WHERE worker_id = $1
          AND heartbeat_at > now() - interval '45 seconds'
     ) AS healthy`,
    [primary],
  );
  return Boolean(rows[0]?.healthy);
}
