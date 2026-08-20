import {
  AGENTMAIL_VERIFY_INBOX,
  INBOUND_FORWARD_LABEL,
  extractEmailAddress,
  isOutreachInbox,
  isVerifyInbox,
  normalizeEmailAddress,
} from '@/lib/agentmail-inboxes';
import { dbQuery } from '@/lib/db';
import type { ReceivedEmailContent } from '@/lib/drafting/reply-inbound';

export type AgentMailWebhookPayload = {
  event_type?: string;
  event_id?: string;
  type?: string;
  inbox_id?: string;
  message?: Record<string, unknown>;
  thread?: Record<string, unknown>;
  send?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
  bounce?: Record<string, unknown>;
  complaint?: Record<string, unknown>;
  data?: Record<string, unknown>;
  event?: Record<string, unknown>;
  [key: string]: unknown;
};

type EmailSendRow = {
  id: string;
  drafting_item_id: string;
  provider_message_id: string | null;
  provider_thread_id: string | null;
  processed_webhook_ids: unknown;
};

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

function webhookIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function alreadyProcessed(send: EmailSendRow, eventId: string | null): boolean {
  if (!eventId) return false;
  return webhookIds(send.processed_webhook_ids).includes(eventId);
}

function nextProcessed(raw: unknown, eventId: string | null): string {
  const ids = webhookIds(raw);
  if (eventId && !ids.includes(eventId)) ids.push(eventId);
  return JSON.stringify(ids.slice(-50));
}

export function unwrapAgentMailWebhookPayload(
  payload: AgentMailWebhookPayload,
): AgentMailWebhookPayload {
  if (payload.message && (asString(payload.event_type) || asString(payload.type))) {
    return payload;
  }
  const nested = payload.data ?? payload.event;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return unwrapAgentMailWebhookPayload(nested as AgentMailWebhookPayload);
  }
  return payload;
}

function inboxFromPayload(payload: AgentMailWebhookPayload): string | null {
  const raw = asString(payload.inbox_id)
    ?? asString(payload.message?.inbox_id)
    ?? asString(payload.thread?.inbox_id)
    ?? asString(payload.send?.inbox_id)
    ?? asString(payload.delivery?.inbox_id)
    ?? asString(payload.bounce?.inbox_id);
  return raw ? normalizeEmailAddress(raw) : null;
}

function messageIdFromPayload(payload: AgentMailWebhookPayload): string | null {
  return asString(payload.message?.message_id)
    ?? asString(payload.send?.message_id)
    ?? asString(payload.delivery?.message_id)
    ?? asString(payload.bounce?.message_id)
    ?? asString(payload.complaint?.message_id);
}

function threadIdFromPayload(payload: AgentMailWebhookPayload): string | null {
  return asString(payload.message?.thread_id)
    ?? asString(payload.thread?.thread_id)
    ?? asString(payload.send?.thread_id)
    ?? asString(payload.delivery?.thread_id)
    ?? asString(payload.bounce?.thread_id);
}

function headerMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim()) out[key.toLowerCase()] = value.trim();
  }
  return out;
}

export function agentMailReceivedContent(
  payload: AgentMailWebhookPayload,
): ReceivedEmailContent | null {
  const message = payload.message;
  if (!message) return null;
  const messageId = messageIdFromPayload(payload);
  if (!messageId) return null;
  const fromEmail = extractEmailAddress(asString(message.from)) ?? 'unknown@unknown';
  const headers = headerMap(message.headers);
  const subject = asString(message.subject);
  if (subject && !headers.subject) headers.subject = subject;
  return {
    providerEmailId: messageId,
    fromEmail,
    toEmails: asStringArray(message.to).map((entry) => extractEmailAddress(entry) ?? entry),
    subject,
    textBody: asString(message.text)
      ?? asString(message.extracted_text)
      ?? asString(message.preview),
    htmlBody: asString(message.html),
    headers,
    receivedAt: asString(message.timestamp)
      ?? asString(message.created_at)
      ?? new Date().toISOString(),
  };
}

function labelsFromMessage(message: Record<string, unknown> | undefined): string[] {
  return asStringArray(message?.labels).map((entry) => entry.toLowerCase());
}

export function shouldIgnoreAgentMailInbound(input: {
  inboxId: string | null;
  fromEmail: string | null;
  labels?: string[];
}): string | null {
  if (input.inboxId && (isVerifyInbox(input.inboxId) || input.inboxId === AGENTMAIL_VERIFY_INBOX)) {
    return 'verify_inbox_ignored';
  }
  if (input.inboxId && !isOutreachInbox(input.inboxId)) {
    return 'unknown_inbox';
  }
  const from = extractEmailAddress(input.fromEmail) ?? normalizeEmailAddress(input.fromEmail);
  if (from && isOutreachInbox(from)) return 'own_outbound';
  if (from && isVerifyInbox(from)) return 'verify_inbox_ignored';
  const labels = (input.labels ?? []).map((entry) => entry.toLowerCase());
  if (labels.includes(INBOUND_FORWARD_LABEL) || labels.includes('helios-outreach-forward')) {
    return 'inbound_forward';
  }
  return null;
}

async function loadSendByProviderIds(input: {
  messageId?: string | null;
  threadId?: string | null;
  inReplyTo?: string | null;
  references?: string[];
}): Promise<EmailSendRow | null> {
  const ids = [
    input.messageId,
    input.inReplyTo,
    ...(input.references ?? []),
  ].filter((value): value is string => Boolean(value));
  for (const id of ids) {
    const { rows } = await dbQuery<EmailSendRow>(
      `SELECT id, drafting_item_id, provider_message_id, provider_thread_id, processed_webhook_ids
         FROM outreach.email_sends
        WHERE provider_message_id = $1
        ORDER BY updated_at DESC
        LIMIT 1`,
      [id],
    );
    if (rows[0]) return rows[0];
  }
  if (input.threadId) {
    const { rows } = await dbQuery<EmailSendRow>(
      `SELECT id, drafting_item_id, provider_message_id, provider_thread_id, processed_webhook_ids
         FROM outreach.email_sends
        WHERE provider_thread_id = $1
        ORDER BY updated_at DESC
        LIMIT 1`,
      [input.threadId],
    );
    if (rows[0]) return rows[0];
  }
  return null;
}

async function loadSendByInboxAndPeer(input: {
  inboxId: string | null;
  fromEmail: string | null;
}): Promise<EmailSendRow | null> {
  const inbox = input.inboxId ? normalizeEmailAddress(input.inboxId) : '';
  const peer = extractEmailAddress(input.fromEmail);
  if (!inbox || !peer || !isOutreachInbox(inbox)) return null;
  const { rows } = await dbQuery<EmailSendRow>(
    `SELECT id, drafting_item_id, provider_message_id, provider_thread_id, processed_webhook_ids
       FROM outreach.email_sends
      WHERE lower(from_email) = $1
        AND lower(to_email) = $2
        AND status = 'sent'
      ORDER BY coalesce(sent_at, created_at) DESC
      LIMIT 1`,
    [inbox, peer],
  );
  return rows[0] ?? null;
}

export async function matchAgentMailInboundSend(input: {
  messageId?: string | null;
  threadId?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  inboxId?: string | null;
  fromEmail?: string | null;
}): Promise<EmailSendRow | null> {
  const byIds = await loadSendByProviderIds(input);
  if (byIds) return byIds;
  return loadSendByInboxAndPeer({
    inboxId: input.inboxId ?? null,
    fromEmail: input.fromEmail ?? null,
  });
}

async function ingestMatchedInbound(input: {
  send: EmailSendRow;
  eventId: string | null;
  eventAt: string;
  messageId: string | null;
  content: ReceivedEmailContent;
}): Promise<{ handled: boolean; sendId: string; reason: string }> {
  if (alreadyProcessed(input.send, input.eventId)) {
    return { handled: true, sendId: input.send.id, reason: 'duplicate' };
  }
  const { processInboundLeadReply } = await import('@/lib/drafting/reply-inbound');
  let inboundResult: Awaited<ReturnType<typeof processInboundLeadReply>>;
  try {
    inboundResult = await processInboundLeadReply({
      emailSendId: input.send.id,
      providerEmailId: input.content.providerEmailId,
      eventAt: input.eventAt,
      content: input.content,
    });
  } catch (error) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      component: 'agentmail-engagement',
      message: 'inbound_reply_pipeline_failed',
      sendId: input.send.id,
      error: error instanceof Error ? error.message : String(error),
    }));
    throw error;
  }
  const processed = nextProcessed(input.send.processed_webhook_ids, input.eventId);
  await dbQuery(
    `UPDATE outreach.email_sends
        SET replied_at = coalesce(replied_at, $2::timestamptz),
            reply_provider_email_id = coalesce(reply_provider_email_id, $3),
            last_event_at = greatest(coalesce(last_event_at, '-infinity'::timestamptz), $2::timestamptz),
            processed_webhook_ids = $4::jsonb,
            updated_at = now()
      WHERE id = $1`,
    [input.send.id, input.eventAt, input.messageId, processed],
  );
  return {
    handled: true,
    sendId: input.send.id,
    reason: inboundResult.skipped
      ?? (inboundResult.replySendId ? 'reply_queued' : 'inbound_stored'),
  };
}

export async function applyAgentMailWebhookEvent(
  payload: AgentMailWebhookPayload,
): Promise<{ handled: boolean; sendId?: string; reason?: string }> {
  const event = unwrapAgentMailWebhookPayload(payload);
  const eventType = asString(event.event_type) ?? asString(event.type) ?? '';
  const inboxId = inboxFromPayload(event);
  const messageId = messageIdFromPayload(event);
  const threadId = threadIdFromPayload(event);
  const eventId = asString(event.event_id) ?? asString(event.message?.message_id);
  const eventAt = asString(event.message?.timestamp)
    ?? asString(event.message?.created_at)
    ?? new Date().toISOString();

  const isReceived = eventType === 'message.received'
    || eventType.startsWith('message.received.');
  if (isReceived) {
    if (eventType.endsWith('.blocked')) {
      return { handled: false, reason: eventType };
    }
    const content = agentMailReceivedContent(event);
    const fromEmail = content?.fromEmail ?? extractEmailAddress(asString(event.message?.from));
    const ignored = shouldIgnoreAgentMailInbound({
      inboxId,
      fromEmail,
      labels: labelsFromMessage(event.message),
    });
    if (ignored) return { handled: false, reason: ignored };

    const send = await matchAgentMailInboundSend({
      messageId,
      threadId,
      inReplyTo: asString(event.message?.in_reply_to),
      references: asStringArray(event.message?.references),
      inboxId,
      fromEmail,
    });
    if (!send) return { handled: false, reason: 'reply_unmatched' };
    if (!content) return { handled: false, sendId: send.id, reason: 'missing_message' };
    return ingestMatchedInbound({
      send,
      eventId,
      eventAt: content.receivedAt,
      messageId,
      content,
    });
  }

  if (inboxId && (isVerifyInbox(inboxId) || inboxId === AGENTMAIL_VERIFY_INBOX)) {
    return { handled: false, reason: 'verify_inbox_ignored' };
  }
  if (inboxId && !isOutreachInbox(inboxId)) {
    return { handled: false, reason: 'unknown_inbox' };
  }

  const send = await loadSendByProviderIds({ messageId, threadId });
  if (!send) return { handled: false, reason: 'send_unmatched' };
  if (alreadyProcessed(send, eventId)) {
    return { handled: true, sendId: send.id, reason: 'duplicate' };
  }
  const processed = nextProcessed(send.processed_webhook_ids, eventId);

  if (eventType === 'message.delivered' || eventType === 'message.sent') {
    await dbQuery(
      `UPDATE outreach.email_sends
          SET delivered_at = CASE WHEN $3 = 'message.delivered' THEN coalesce(delivered_at, $2::timestamptz) ELSE delivered_at END,
              provider_thread_id = coalesce(provider_thread_id, $4),
              last_event_at = greatest(coalesce(last_event_at, '-infinity'::timestamptz), $2::timestamptz),
              processed_webhook_ids = $5::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [send.id, eventAt, eventType, threadId, processed],
    );
    return { handled: true, sendId: send.id };
  }

  if (eventType === 'message.bounced' || eventType === 'message.rejected') {
    await dbQuery(
      `UPDATE outreach.email_sends
          SET bounced_at = coalesce(bounced_at, $2::timestamptz),
              bounce_type = coalesce(bounce_type, $3),
              last_event_at = greatest(coalesce(last_event_at, '-infinity'::timestamptz), $2::timestamptz),
              processed_webhook_ids = $4::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [send.id, eventAt, eventType, processed],
    );
    return { handled: true, sendId: send.id };
  }

  if (eventType === 'message.complained') {
    await dbQuery(
      `UPDATE outreach.email_sends
          SET complained_at = coalesce(complained_at, $2::timestamptz),
              last_event_at = greatest(coalesce(last_event_at, '-infinity'::timestamptz), $2::timestamptz),
              processed_webhook_ids = $3::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [send.id, eventAt, processed],
    );
    return { handled: true, sendId: send.id };
  }

  return { handled: false, reason: 'ignored_type' };
}

export function agentMailMessageToReceivedPayload(
  inboxId: string,
  message: {
    message_id: string;
    thread_id?: string;
    inbox_id?: string;
    from?: string;
    to?: string[];
    subject?: string;
    preview?: string;
    text?: string;
    html?: string;
    extracted_text?: string;
    in_reply_to?: string;
    references?: string[];
    labels?: string[];
    headers?: Record<string, string>;
    timestamp?: string;
    created_at?: string;
  },
): AgentMailWebhookPayload {
  return {
    event_type: 'message.received',
    event_id: `poll:${message.message_id}`,
    inbox_id: inboxId,
    message: {
      ...message,
      inbox_id: message.inbox_id ?? inboxId,
    },
  };
}

/** Poll outreach inboxes for replies the webhook missed. */
export async function reconcileAgentMailInbound(limitPerInbox = 40): Promise<number> {
  if (!process.env.AGENT_MAIL_API?.trim()) return 0;
  const { agentMailGetInboxMessage, agentMailGetInboxThread, agentMailListInboxMessages, agentMailListInboxThreads } = await import('@/lib/agentmail');
  const { OUTREACH_INBOX_SEEDS } = await import('@/lib/agentmail-inboxes');
  let ingested = 0;
  for (const seed of OUTREACH_INBOX_SEEDS) {
    let messages: Array<{
      message_id: string;
      from?: string;
      text?: string;
      html?: string;
      preview?: string;
      labels?: string[];
      thread_id?: string;
      in_reply_to?: string;
      references?: string[];
      to?: string[];
      subject?: string;
      headers?: Record<string, string>;
      timestamp?: string;
      created_at?: string;
      inbox_id?: string;
      extracted_text?: string;
    }> = [];
    try {
      messages = await agentMailListInboxMessages(seed.email, {
        limit: limitPerInbox,
        includeUnauthenticated: true,
        includeSpam: true,
      });
    } catch (error) {
      console.warn(
        `[agentmail-inbound] list failed ${seed.email}:`,
        error instanceof Error ? error.message : error,
      );
    }
    try {
      const threads = await agentMailListInboxThreads(seed.email, {
        limit: limitPerInbox,
        includeUnauthenticated: true,
        includeSpam: true,
      });
      const seen = new Set(messages.map((message) => message.message_id));
      for (const thread of threads) {
        const needsExpand = (thread.message_count ?? 0) > 1 || Boolean(thread.received_timestamp);
        if (!needsExpand) continue;
        const full = await agentMailGetInboxThread(seed.email, thread.thread_id).catch(() => ({ messages: [] }));
        for (const message of full.messages) {
          if (seen.has(message.message_id)) continue;
          seen.add(message.message_id);
          messages.push(message);
        }
        if (full.messages.length === 0 && thread.last_message_id && !seen.has(thread.last_message_id)) {
          const last = await agentMailGetInboxMessage(seed.email, thread.last_message_id).catch(() => null);
          if (last) {
            seen.add(last.message_id);
            messages.push(last);
          }
        }
      }
    } catch (error) {
      console.warn(
        `[agentmail-inbound] threads failed ${seed.email}:`,
        error instanceof Error ? error.message : error,
      );
    }
    for (const listed of messages) {
      const ignored = shouldIgnoreAgentMailInbound({
        inboxId: seed.email,
        fromEmail: listed.from ?? null,
        labels: listed.labels,
      });
      if (ignored) continue;

      const { rows: existing } = await dbQuery<{ present: boolean }>(
        `SELECT true AS present
           FROM outreach.inbound_emails
          WHERE provider_email_id = $1
          LIMIT 1`,
        [listed.message_id],
      );
      if (existing[0]) continue;

      let message = listed;
      if (!listed.text && !listed.html && listed.message_id) {
        try {
          message = await agentMailGetInboxMessage(seed.email, listed.message_id);
        } catch {
          // Keep list payload (preview is enough to store the thread).
        }
      }
      try {
        const result = await applyAgentMailWebhookEvent(
          agentMailMessageToReceivedPayload(seed.email, message),
        );
        if (result.handled && result.reason !== 'duplicate') ingested += 1;
      } catch (error) {
        console.warn(
          `[agentmail-inbound] ingest failed ${seed.email} ${listed.message_id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
  return ingested;
}
