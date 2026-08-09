import {
  effectiveDraftingResearchLaneLimit,
  effectiveDraftingWriteLaneLimit,
  effectiveWorkerMaxConcurrency,
} from '@/lib/drafting/provider-admission';
import type { WorkKind, WorkLane } from '@/lib/orchestration/types';

type KindConfig = {
  lane: WorkLane;
  defaultMaxAttempts: number;
  priority: number;
};

export const KIND_CONFIG: Record<WorkKind, KindConfig> = {
  'run.process': { lane: 'extraction', defaultMaxAttempts: 3, priority: 20 },
  'upload.extract': { lane: 'extraction', defaultMaxAttempts: 3, priority: 30 },
  'run.prepare': { lane: 'extraction', defaultMaxAttempts: 1_000, priority: 10 },
  'run.enrich': { lane: 'extraction', defaultMaxAttempts: 3, priority: 15 },
  'research.company': { lane: 'research', defaultMaxAttempts: 3, priority: 20 },
  'research.profile_rescue': { lane: 'profile_rescue', defaultMaxAttempts: 3, priority: 10 },
  'research.email_rescue': { lane: 'email_rescue', defaultMaxAttempts: 3, priority: 10 },
  'run.finalize': { lane: 'finalize', defaultMaxAttempts: 5, priority: 30 },
  'domain.verify': { lane: 'domain_verify', defaultMaxAttempts: 3, priority: 0 },
  'mailbox.lead': { lane: 'mailbox_verify', defaultMaxAttempts: 3, priority: 10 },
  'mailbox.run': { lane: 'mailbox_sweep', defaultMaxAttempts: 3, priority: 0 },
  'pre_enriched.ingest': { lane: 'extraction', defaultMaxAttempts: 3, priority: 25 },
  'pre_enriched.extract_file': { lane: 'extraction', defaultMaxAttempts: 3, priority: 30 },
  'pre_enriched.assemble': { lane: 'extraction', defaultMaxAttempts: 1_000, priority: 10 },
  'drafting.run.start': { lane: 'drafting', defaultMaxAttempts: 3, priority: 30 },
  'drafting.job.verify_mailbox': { lane: 'mailbox_verify', defaultMaxAttempts: 3, priority: 20 },
  // Research occupies the drafting lane (default 8 shards). Writes use a
  // separate lane so long Sonnet research cannot head-of-line-block the queue.
  'drafting.job.process': { lane: 'drafting', defaultMaxAttempts: 3, priority: 20 },
  'drafting.job.write': { lane: 'drafting_write', defaultMaxAttempts: 3, priority: 40 },
  'email.send': { lane: 'email_send', defaultMaxAttempts: 3, priority: 25 },
  'reply.respond': { lane: 'email_send', defaultMaxAttempts: 3, priority: 35 },
  'reply.followup': { lane: 'email_send', defaultMaxAttempts: 3, priority: 30 },
  'system.reconcile': { lane: 'maintenance', defaultMaxAttempts: 3, priority: -10 },
};

function positiveInt(name: string, fallback: number, maximum = 100): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(parsed)));
}

export function laneLimit(lane: WorkLane): number {
  switch (lane) {
    case 'extraction':
      // Safe defaults sized for Supabase transaction pooler + small PG_POOL_MAX.
      // Throughput for hundreds of leads comes from queue depth, not 20+ parallel DB clients.
      return positiveInt('ORG_EXTRACTION_CONCURRENCY', 3);
    case 'research':
      return positiveInt('ORG_RESEARCH_CONCURRENCY', 2);
    case 'profile_rescue':
      return positiveInt('ORG_PROFILE_RESCUE_CONCURRENCY', 2);
    case 'email_rescue':
      return positiveInt('ORG_EMAIL_RESCUE_CONCURRENCY', 2);
    case 'finalize':
      return positiveInt('ORG_FINALIZE_CONCURRENCY', 2);
    case 'domain_verify':
      return positiveInt('ORG_VERIFY_CONCURRENCY', 2);
    case 'mailbox_verify':
      return positiveInt('ORG_MAILBOX_VERIFY_CONCURRENCY', 3, 20);
    case 'mailbox_sweep':
      return 1;
    case 'drafting':
      return effectiveDraftingResearchLaneLimit();
    case 'drafting_write':
      return effectiveDraftingWriteLaneLimit();
    case 'email_send':
      return positiveInt('ORG_EMAIL_SEND_CONCURRENCY', 2, 10);
    case 'maintenance':
      return 1;
  }
}

export function workerLeaseSeconds(): number {
  return positiveInt('ORCHESTRATION_LEASE_SECONDS', 600, 3600);
}

export function workerPollMs(): number {
  return positiveInt('ORCHESTRATION_POLL_MS', 400, 10_000);
}

export function workerMaxConcurrency(): number {
  return effectiveWorkerMaxConcurrency();
}

export function jitteredBackoffMs(attempt: number): number {
  const base = Math.min(5 * 60_000, 1_000 * (2 ** Math.max(0, attempt - 1)));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}
