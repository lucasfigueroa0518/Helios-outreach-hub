import { enqueueWork } from '@/lib/orchestration/repository';

export type MailboxVerifySchedulePayload = {
  leadId: string;
  runId: string;
  emailStatus: string;
  /** Deprecated — cascade reads candidates from the lead row. */
  email?: string;
};

export async function scheduleLeadMailboxVerification(payload: MailboxVerifySchedulePayload) {
  // Dynamic import avoids a circular load with mailbox-verify (sweep imports us).
  const {
    markMailboxVerificationRateLimited,
    runHasMailboxRateLimit,
    shouldScheduleMailboxVerification,
  } = await import('@/lib/mailbox-verify');

  if (!shouldScheduleMailboxVerification(payload.emailStatus)) return;
  if (!process.env.AGENT_MAIL_API?.trim()) return;

  // Already rate-limited on this run → never send more probes; fail-open.
  if (await runHasMailboxRateLimit(payload.runId)) {
    await markMailboxVerificationRateLimited(payload.leadId, payload.runId);
    return;
  }

  await enqueueWork({
    kind: 'mailbox.lead',
    payload,
    dedupeKey: `${payload.runId}:${payload.leadId}`,
    scopeKey: payload.runId,
    reviveTerminal: true,
  });
}
