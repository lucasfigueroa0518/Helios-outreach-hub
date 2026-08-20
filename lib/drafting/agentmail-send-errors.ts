/**
 * Agent Mail send-error classifiers that must not treat an account-wide
 * provider outage as a per-recipient failure.
 */

/** Wait this long after an account-pause 403, then try the same queued send again. */
export const AGENTMAIL_ACCOUNT_PAUSE_RETRY_MS = 4 * 60 * 60 * 1000;

/**
 * AWS SES pause on Agent Mail's tenant (`403` + `message_rejected` +
 * "Sending paused for this account"). Not a bad recipient or blocked From.
 */
export function isAgentMailAccountSendingPausedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /sending paused for this account/i.test(message)
    || /AccountSendingPaused/i.test(message);
}

export function nextAgentMailPauseRetryAt(from = new Date()): Date {
  return new Date(from.getTime() + AGENTMAIL_ACCOUNT_PAUSE_RETRY_MS);
}
