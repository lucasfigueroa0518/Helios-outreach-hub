import { agentMailSendProbe, type AgentMailSendResult } from '@/lib/agentmail';
import { dbQuery } from '@/lib/db';
import { isAgentMailRateLimitError } from '@/lib/mailbox-verify';

const UNCERTAIN_SEND = 'Mailbox probe send outcome is uncertain; refusing duplicate send';

export function isUncertainMailboxProbeError(message: string | undefined): boolean {
  return Boolean(message?.includes(UNCERTAIN_SEND));
}

/**
 * Persist the send intent before the external side effect. If a process dies
 * after AgentMail accepts the message but before the acknowledgement is saved,
 * retries stop rather than emailing the same lead twice.
 */
export async function sendMailboxProbeOnce(
  email: string,
  leadId: string,
  scopeKey: string,
  runId?: string,
): Promise<AgentMailSendResult> {
  const normalized = email.trim().toLowerCase();
  const inserted = await dbQuery<{ id: string }>(
    `INSERT INTO outreach.orchestration_mailbox_probes (
       run_id, scope_key, lead_id, email, status
     ) VALUES ($1, $2, $3, $4, 'sending')
     ON CONFLICT (scope_key, lead_id, email) DO NOTHING
     RETURNING id`,
    [runId ?? null, scopeKey, leadId, normalized],
  );

  if (!inserted.rows[0]) {
    const { rows } = await dbQuery<{
      status: string;
      provider_message_id: string | null;
      provider_thread_id: string | null;
      sent_at: string | null;
    }>(
      `SELECT status, provider_message_id, provider_thread_id, sent_at::text
         FROM outreach.orchestration_mailbox_probes
        WHERE scope_key = $1 AND lead_id = $2 AND email = $3`,
      [scopeKey, leadId, normalized],
    );
    const prior = rows[0];
    if (
      prior?.status === 'sent'
      && prior.provider_message_id
      && prior.provider_thread_id
      && prior.sent_at
    ) {
      return {
        message_id: prior.provider_message_id,
        thread_id: prior.provider_thread_id,
        sent_at: prior.sent_at,
      };
    }
    throw new Error(UNCERTAIN_SEND);
  }

  try {
    const sent = await agentMailSendProbe(normalized, leadId);
    await dbQuery(
      `UPDATE outreach.orchestration_mailbox_probes
          SET status = 'sent',
              provider_message_id = $4,
              provider_thread_id = $5,
              sent_at = $6::timestamptz,
              updated_at = now()
        WHERE scope_key = $1 AND lead_id = $2 AND email = $3`,
      [scopeKey, leadId, normalized, sent.message_id, sent.thread_id, sent.sent_at],
    );
    return sent;
  } catch (error) {
    if (isAgentMailRateLimitError(error)) {
      await dbQuery(
        `DELETE FROM outreach.orchestration_mailbox_probes
          WHERE scope_key = $1 AND lead_id = $2 AND email = $3 AND status = 'sending'`,
        [scopeKey, leadId, normalized],
      );
    }
    throw error;
  }
}
