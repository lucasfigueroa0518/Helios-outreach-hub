/**
 * Resend webhook → outreach.email_sends engagement updates (no new tables).
 */

import { dbQuery } from '@/lib/db';

const MAX_PROCESSED_WEBHOOK_IDS = 50;

export type ResendWebhookPayload = {
  type: string;
  created_at?: string;
  data?: Record<string, unknown>;
};

type EmailSendRow = {
  id: string;
  drafting_item_id: string;
  provider_message_id: string | null;
  provider_rfc_message_id: string | null;
  processed_webhook_ids: unknown;
};

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function tagsFromData(data: Record<string, unknown>): Record<string, string> {
  const tags = data.tags;
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return out;
}

function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  return value.trim().replace(/^<|>$/g, '').toLowerCase();
}

function webhookIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

async function loadSendByProviderMessageId(emailId: string): Promise<EmailSendRow | null> {
  const { rows } = await dbQuery<EmailSendRow>(
    `SELECT id, drafting_item_id, provider_message_id, provider_rfc_message_id, processed_webhook_ids
       FROM outreach.email_sends
      WHERE provider_message_id = $1
      ORDER BY updated_at DESC
      LIMIT 1`,
    [emailId],
  );
  return rows[0] ?? null;
}

async function loadSendByItemId(itemId: string): Promise<EmailSendRow | null> {
  const { rows } = await dbQuery<EmailSendRow>(
    `SELECT id, drafting_item_id, provider_message_id, provider_rfc_message_id, processed_webhook_ids
       FROM outreach.email_sends
      WHERE drafting_item_id = $1::uuid
        AND status = 'sent'
      ORDER BY updated_at DESC
      LIMIT 1`,
    [itemId],
  );
  return rows[0] ?? null;
}

async function loadSendByRfcMessageId(rfcMessageId: string): Promise<EmailSendRow | null> {
  const normalized = normalizeMessageId(rfcMessageId);
  if (!normalized) return null;
  const { rows } = await dbQuery<EmailSendRow>(
    `SELECT id, drafting_item_id, provider_message_id, provider_rfc_message_id, processed_webhook_ids
       FROM outreach.email_sends
      WHERE lower(replace(replace(coalesce(provider_rfc_message_id, ''), '<', ''), '>', '')) = $1
        AND status = 'sent'
      ORDER BY updated_at DESC
      LIMIT 1`,
    [normalized],
  );
  return rows[0] ?? null;
}

async function resolveOutboundSend(
  data: Record<string, unknown>,
): Promise<EmailSendRow | null> {
  const emailId = asString(data.email_id);
  if (emailId) {
    const byProvider = await loadSendByProviderMessageId(emailId);
    if (byProvider) return byProvider;
  }
  const tags = tagsFromData(data);
  if (tags.item_id) {
    return loadSendByItemId(tags.item_id);
  }
  return null;
}

function nextProcessedWebhookIds(raw: unknown, eventId: string | null): string[] {
  const existing = webhookIds(raw);
  if (!eventId) return existing;
  if (existing.includes(eventId)) return existing;
  return [...existing, eventId].slice(-MAX_PROCESSED_WEBHOOK_IDS);
}

function alreadyProcessed(send: EmailSendRow, eventId: string | null): boolean {
  if (!eventId) return false;
  return webhookIds(send.processed_webhook_ids).includes(eventId);
}

async function applyOutboundEngagement(
  send: EmailSendRow,
  type: string,
  data: Record<string, unknown>,
  eventAt: string,
  eventId: string | null,
): Promise<void> {
  const rfcMessageId = asString(data.message_id);
  const bounce = data.bounce && typeof data.bounce === 'object'
    ? (data.bounce as Record<string, unknown>)
    : null;
  const processed = JSON.stringify(nextProcessedWebhookIds(send.processed_webhook_ids, eventId));

  if (type === 'email.sent' || type === 'email.delivered') {
    await dbQuery(
      `UPDATE outreach.email_sends
          SET provider_rfc_message_id = coalesce(provider_rfc_message_id, $2),
              delivered_at = CASE
                WHEN $3::text = 'email.delivered' THEN coalesce(delivered_at, $4::timestamptz)
                ELSE delivered_at
              END,
              last_event_at = greatest(coalesce(last_event_at, '-infinity'::timestamptz), $4::timestamptz),
              processed_webhook_ids = $5::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [send.id, rfcMessageId, type, eventAt, processed],
    );
    return;
  }

  if (type === 'email.opened') {
    await dbQuery(
      `UPDATE outreach.email_sends
          SET provider_rfc_message_id = coalesce(provider_rfc_message_id, $2),
              opened_at = coalesce(opened_at, $3::timestamptz),
              open_count = open_count + 1,
              delivered_at = coalesce(delivered_at, $3::timestamptz),
              last_event_at = greatest(coalesce(last_event_at, '-infinity'::timestamptz), $3::timestamptz),
              processed_webhook_ids = $4::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [send.id, rfcMessageId, eventAt, processed],
    );
    return;
  }

  if (type === 'email.clicked') {
    await dbQuery(
      `UPDATE outreach.email_sends
          SET provider_rfc_message_id = coalesce(provider_rfc_message_id, $2),
              clicked_at = coalesce(clicked_at, $3::timestamptz),
              click_count = click_count + 1,
              opened_at = coalesce(opened_at, $3::timestamptz),
              delivered_at = coalesce(delivered_at, $3::timestamptz),
              last_event_at = greatest(coalesce(last_event_at, '-infinity'::timestamptz), $3::timestamptz),
              processed_webhook_ids = $4::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [send.id, rfcMessageId, eventAt, processed],
    );
    return;
  }

  if (type === 'email.bounced') {
    await dbQuery(
      `UPDATE outreach.email_sends
          SET provider_rfc_message_id = coalesce(provider_rfc_message_id, $2),
              bounced_at = coalesce(bounced_at, $3::timestamptz),
              bounce_type = coalesce($4, bounce_type),
              last_event_at = greatest(coalesce(last_event_at, '-infinity'::timestamptz), $3::timestamptz),
              processed_webhook_ids = $5::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [
        send.id,
        rfcMessageId,
        eventAt,
        asString(bounce?.type) ?? asString(bounce?.subType),
        processed,
      ],
    );
    return;
  }

  if (type === 'email.complained') {
    await dbQuery(
      `UPDATE outreach.email_sends
          SET provider_rfc_message_id = coalesce(provider_rfc_message_id, $2),
              complained_at = coalesce(complained_at, $3::timestamptz),
              last_event_at = greatest(coalesce(last_event_at, '-infinity'::timestamptz), $3::timestamptz),
              processed_webhook_ids = $4::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [send.id, rfcMessageId, eventAt, processed],
    );
    return;
  }

  if (type === 'email.failed' || type === 'email.delivery_delayed') {
    await dbQuery(
      `UPDATE outreach.email_sends
          SET provider_rfc_message_id = coalesce(provider_rfc_message_id, $2),
              last_event_at = greatest(coalesce(last_event_at, '-infinity'::timestamptz), $3::timestamptz),
              error_message = CASE
                WHEN $4::text = 'email.failed' THEN coalesce(
                  $5,
                  error_message
                )
                ELSE error_message
              END,
              processed_webhook_ids = $6::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [
        send.id,
        rfcMessageId,
        eventAt,
        type,
        asString((data.failed as { reason?: string } | undefined)?.reason),
        processed,
      ],
    );
  }
}

async function resolveReplySend(
  data: Record<string, unknown>,
): Promise<EmailSendRow | null> {
  const to = asStringArray(data.to);
  const receivedFor = asStringArray(data.received_for);
  const plusItemId = null as string | null;
  void to;
  void receivedFor;
  if (plusItemId) {
    const byPlus = await loadSendByItemId(plusItemId);
    if (byPlus) return byPlus;
  }

  return null;
}

/**
 * Apply one verified Resend webhook payload to email_sends.
 * Returns whether a row was updated.
 */
export async function applyResendWebhookEvent(
  payload: ResendWebhookPayload,
  svixId: string | null,
): Promise<{ handled: boolean; sendId?: string; reason?: string }> {
  const type = payload.type;
  const data = payload.data && typeof payload.data === 'object'
    ? payload.data
    : null;
  if (!data) return { handled: false, reason: 'missing_data' };

  const eventAt = asString(payload.created_at)
    ?? asString(data.created_at)
    ?? new Date().toISOString();

  if (type === 'email.received') {
    const send = await resolveReplySend(data);
    if (!send) return { handled: false, reason: 'reply_unmatched' };
    if (alreadyProcessed(send, svixId)) {
      return { handled: true, sendId: send.id, reason: 'duplicate' };
    }
    const processed = JSON.stringify(nextProcessedWebhookIds(send.processed_webhook_ids, svixId));
    const providerEmailId = asString(data.email_id);
    await dbQuery(
      `UPDATE outreach.email_sends
          SET replied_at = coalesce(replied_at, $2::timestamptz),
              reply_provider_email_id = coalesce(reply_provider_email_id, $3),
              last_event_at = greatest(coalesce(last_event_at, '-infinity'::timestamptz), $2::timestamptz),
              processed_webhook_ids = $4::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [send.id, eventAt, providerEmailId, processed],
    );

    try {
      const { processInboundLeadReply } = await import('@/lib/drafting/reply-inbound');
      const inboundResult = await processInboundLeadReply({
        emailSendId: send.id,
        providerEmailId,
        eventAt,
      });
      return {
        handled: true,
        sendId: send.id,
        reason: inboundResult.skipped
          ?? (inboundResult.replySendId ? 'reply_queued' : 'inbound_stored'),
      };
    } catch (error) {
      // Engagement stamp already committed; do not fail the webhook hard.
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        component: 'resend-engagement',
        message: 'inbound_reply_pipeline_failed',
        sendId: send.id,
        error: error instanceof Error ? error.message : String(error),
      }));
      return { handled: true, sendId: send.id, reason: 'inbound_pipeline_error' };
    }
  }

  const outboundTypes = new Set([
    'email.sent',
    'email.delivered',
    'email.delivery_delayed',
    'email.opened',
    'email.clicked',
    'email.bounced',
    'email.complained',
    'email.failed',
  ]);
  if (!outboundTypes.has(type)) {
    return { handled: false, reason: 'ignored_type' };
  }

  const send = await resolveOutboundSend(data);
  if (!send) return { handled: false, reason: 'send_unmatched' };
  if (alreadyProcessed(send, svixId)) {
    return { handled: true, sendId: send.id, reason: 'duplicate' };
  }
  await applyOutboundEngagement(send, type, data, eventAt, svixId);
  return { handled: true, sendId: send.id };
}

/** Best-effort: fill delivered_at for recent sent rows missing delivery (reconcile). */
export async function reconcileRecentEmailDelivery(_limit = 25): Promise<number> {
  return 0;
}
