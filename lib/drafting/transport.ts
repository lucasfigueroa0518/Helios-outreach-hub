import type { DraftingJobKind } from '@/lib/drafting/types';
import { enqueueWork, enqueueWorkBatch } from '@/lib/orchestration/repository';
import type { WorkKind } from '@/lib/orchestration/types';

export type DispatchableDraftingEvent = {
  name: string;
  data: Record<string, string>;
  id?: string;
};

const VERIFY_EVENT = 'drafting.job.verify_mailbox';
const PROCESS_EVENT = 'drafting.job.process';
const WRITE_EVENT = 'drafting.job.write';
const RUN_STARTED_EVENT = 'drafting.run.started';

/** Map drafting_jobs.kind → orchestration work kind (research vs write lanes). */
export function orchKindForDraftingJobKind(kind: DraftingJobKind): WorkKind {
  if (kind === 'verify_mailbox') return 'drafting.job.verify_mailbox';
  if (kind === 'research') return 'drafting.job.process';
  return 'drafting.job.write';
}

export function eventNameForJobKind(kind: DraftingJobKind): string {
  if (kind === 'verify_mailbox') return VERIFY_EVENT;
  if (kind === 'research') return PROCESS_EVENT;
  return WRITE_EVENT;
}

export function deterministicJobEventId(jobId: string, attemptCount: number): string {
  return `draft-job:${jobId}:${attemptCount}`;
}

export async function sendDraftingEvents(events: DispatchableDraftingEvent[]): Promise<void> {
  if (events.length === 0) return;
  const works = [];
  for (const event of events) {
    if (event.name === RUN_STARTED_EVENT) {
      const draftingRunId = event.data.draftingRunId;
      works.push({
        kind: 'drafting.run.start' as const,
        payload: { draftingRunId },
        dedupeKey: draftingRunId,
        scopeKey: draftingRunId,
        reviveTerminal: true,
      });
      continue;
    }
    if (
      event.name === VERIFY_EVENT
      || event.name === PROCESS_EVENT
      || event.name === WRITE_EVENT
    ) {
      const jobId = event.data.jobId;
      const draftingJobs = await loadJobsForDispatch([jobId]);
      const draftingJob = draftingJobs[0];
      if (!draftingJob) continue;
      works.push({
        kind: orchKindForDraftingJobKind(draftingJob.kind),
        payload: { jobId },
        dedupeKey: jobId,
        scopeKey: draftingJob.drafting_run_id,
        availableAt: new Date(draftingJob.next_attempt_at),
        reviveTerminal: true,
      });
    }
  }
  await enqueueWorkBatch(works);
}

async function loadJobsForDispatch(jobIds: string[]): Promise<Array<{
  id: string;
  drafting_run_id: string;
  kind: DraftingJobKind;
  attempt_count: number;
  next_attempt_at: string;
}>> {
  if (!jobIds.length) return [];
  const { dbQuery } = await import('@/lib/db');
  const { rows } = await dbQuery<{
    id: string;
    drafting_run_id: string;
    kind: DraftingJobKind;
    attempt_count: number;
    next_attempt_at: string;
  }>(
    `SELECT id, drafting_run_id, kind, attempt_count, next_attempt_at
     FROM outreach.drafting_jobs
     WHERE id = ANY($1::uuid[])
       AND status = 'pending'
     ORDER BY priority DESC, created_at`,
    [jobIds],
  );
  return rows;
}

export async function loadPendingDraftingJobsByIds(jobIds: string[]): Promise<Array<{
  id: string;
  drafting_run_id: string;
  kind: DraftingJobKind;
  attempt_count: number;
}>> {
  return loadJobsForDispatch(jobIds);
}

export async function dispatchDraftingJob(job: {
  id: string;
  kind: DraftingJobKind;
  attempt_count: number;
}): Promise<void> {
  const loaded = (await loadJobsForDispatch([job.id]))[0];
  if (!loaded) return;
  await enqueueWork({
    kind: orchKindForDraftingJobKind(loaded.kind),
    payload: { jobId: loaded.id },
    dedupeKey: loaded.id,
    scopeKey: loaded.drafting_run_id,
    availableAt: new Date(loaded.next_attempt_at),
    reviveTerminal: true,
  });
}

export async function dispatchDraftingJobs(
  jobs: Array<{ id: string; kind: DraftingJobKind; attempt_count: number }>,
): Promise<void> {
  const loaded = await loadJobsForDispatch(jobs.map((job) => job.id));
  await enqueueWorkBatch(loaded.map((job) => ({
    kind: orchKindForDraftingJobKind(job.kind),
    payload: { jobId: job.id },
    dedupeKey: job.id,
    scopeKey: job.drafting_run_id,
    availableAt: new Date(job.next_attempt_at),
    reviveTerminal: true,
  })));
}

export async function dispatchDraftingRunStarted(draftingRunId: string): Promise<void> {
  await enqueueWork({
    kind: 'drafting.run.start',
    payload: { draftingRunId },
    dedupeKey: draftingRunId,
    scopeKey: draftingRunId,
    reviveTerminal: true,
  });
}

export async function listPendingJobsForRun(draftingRunId: string): Promise<Array<{
  id: string;
  kind: DraftingJobKind;
  attempt_count: number;
}>> {
  const { dbQuery } = await import('@/lib/db');
  const { rows } = await dbQuery<{
    id: string;
    kind: DraftingJobKind;
    attempt_count: number;
  }>(
    `SELECT id, kind, attempt_count
     FROM outreach.drafting_jobs
     WHERE drafting_run_id = $1 AND status = 'pending'
     ORDER BY priority DESC, created_at`,
    [draftingRunId],
  );
  return rows;
}
