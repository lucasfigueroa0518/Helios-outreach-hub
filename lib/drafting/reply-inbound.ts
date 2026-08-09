/**
 * Inbound reply ingest: store body, forward to sender, enqueue delayed auto-response.
 */

import { dbQuery } from '@/lib/db';
import { enqueueWork } from '@/lib/orchestration/repository';
import {
  REPLY_AUTO_DELAY_MS,
  REPLY_MAX_IMMEDIATE_TURNS,
} from '@/lib/drafting/reply-constants';
import { createResendClient } from '@/lib/drafting/send';
import {
  cancelScheduledFollowups,
  countImmediateSentReplies,
  isThreadSuppressed,
} from '@/lib/drafting/reply-thread';

export type OutboundSendContext = {
  id: string;
  drafting_item_id: string;
  from_email: string;
  to_email: string;
  subject: string;
  provider_rfc_message_id: string | null;
  owner_id: string;
  campaign_id: string;
};

export type ReceivedEmailContent = {
  providerEmailId: string;
  fromEmail: string;
  toEmails: string[];
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  headers: Record<string, string>;
  receivedAt: string;
};

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function headerMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim()) out[key.toLowerCase()] = value.trim();
  }
  return out;
}

function extractEmailAddress(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const match = raw.trim().match(/<([^>]+)>/);
  const addr = (match?.[1] ?? raw).trim().toLowerCase();
  return addr.includes('@') ? addr : null;
}

/** True when the inbound message looks like an autoresponder / OOO / bulk. */
export function isAutomaticReply(headers: Record<string, string>, fromEmail: string): string | null {
  const autoSubmitted = headers['auto-submitted']?.toLowerCase() ?? '';
  if (autoSubmitted && autoSubmitted !== 'no') {
    return `auto_submitted:${autoSubmitted}`;
  }
  const precedence = headers.precedence?.toLowerCase() ?? '';
  if (['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)) {
    return `precedence:${precedence}`;
  }
  if (headers['x-autoreply'] || headers['x-autorespond'] || headers['x-auto-response-suppress']) {
    return 'x_auto_reply_header';
  }
  if (/^(mailer-daemon|postmaster)@/i.test(fromEmail)) {
    return 'mailer_daemon';
  }
  return null;
}

export async function loadOutboundSendContext(emailSendId: string): Promise<OutboundSendContext | null> {
  const { rows } = await dbQuery<OutboundSendContext>(
    `SELECT s.id,
            s.drafting_item_id,
            s.from_email,
            s.to_email,
            s.subject,
            s.provider_rfc_message_id,
            c.owner_id::text AS owner_id,
            w.campaign_id::text AS campaign_id
       FROM outreach.email_sends s
       JOIN outreach.drafting_items i ON i.id = s.drafting_item_id
       JOIN outreach.drafting_workspaces w ON w.id = i.workspace_id
       JOIN outreach.campaigns c ON c.id = w.campaign_id
      WHERE s.id = $1
      LIMIT 1`,
    [emailSendId],
  );
  return rows[0] ?? null;
}

export async function fetchReceivedEmailContent(
  providerEmailId: string,
  fallbackReceivedAt: string,
): Promise<ReceivedEmailContent | null> {
  if (!process.env.RESEND_API_KEY?.trim()) return null;
  try {
    const client = createResendClient();
    const received = await client.emails.receiving.get(providerEmailId);
    const data = received.data;
    if (!data) return null;
    const headers = headerMap(data.headers);
    const fromEmail = extractEmailAddress(asString(data.from) ?? headers.from)
      ?? 'unknown@unknown';
    const toRaw = data.to;
    const toEmails = Array.isArray(toRaw)
      ? toRaw.map((entry) => extractEmailAddress(String(entry))).filter((e): e is string => Boolean(e))
      : [];
    return {
      providerEmailId,
      fromEmail,
      toEmails,
      subject: asString(data.subject),
      textBody: asString(data.text) ?? asString((data as { text_body?: string }).text_body),
      htmlBody: asString(data.html) ?? asString((data as { html_body?: string }).html_body),
      headers,
      receivedAt: asString(data.created_at) ?? fallbackReceivedAt,
    };
  } catch {
    return null;
  }
}

async function forwardInboundToSender(
  outbound: OutboundSendContext,
  inbound: ReceivedEmailContent,
): Promise<boolean> {
  const sender = outbound.from_email.trim().toLowerCase();
  if (!sender.includes('@') || !process.env.RESEND_API_KEY?.trim()) return false;
  try {
    const client = createResendClient();
    const subject = `Fwd: ${inbound.subject?.trim() || outbound.subject || 'Lead reply'}`;
    const body = [
      'Forwarded lead reply from Outreach Hub.',
      '',
      `From: ${inbound.fromEmail}`,
      `Received: ${inbound.receivedAt}`,
      `Original outbound: ${outbound.subject}`,
      '',
      '-----',
      '',
      inbound.textBody?.trim()
        || '(no plain-text body; see HTML in Resend if needed)',
    ].join('\n');
    const response = await client.emails.send({
      from: process.env.RESEND_FROM_EMAIL?.trim() || outbound.from_email,
      to: [sender],
      subject,
      text: body,
    });
    return !response.error;
  } catch {
    return false;
  }
}

/**
 * Persist inbound, forward to sender, and enqueue reply.respond (+60s) when allowed.
 */
export async function processInboundLeadReply(input: {
  emailSendId: string;
  providerEmailId: string | null;
  eventAt: string;
}): Promise<{
  inboundId?: string;
  replySendId?: string;
  skipped?: string;
  forwarded?: boolean;
}> {
  const outbound = await loadOutboundSendContext(input.emailSendId);
  if (!outbound) return { skipped: 'outbound_context_missing' };

  const providerEmailId = input.providerEmailId?.trim();
  if (!providerEmailId) return { skipped: 'missing_provider_email_id' };

  let inbound = await fetchReceivedEmailContent(providerEmailId, input.eventAt);
  if (!inbound) {
    inbound = {
      providerEmailId,
      fromEmail: outbound.to_email,
      toEmails: [],
      subject: null,
      textBody: null,
      htmlBody: null,
      headers: {},
      receivedAt: input.eventAt,
    };
  }

  // Never auto-respond to our own addresses.
  if (inbound.fromEmail.toLowerCase() === outbound.from_email.toLowerCase()) {
    const { rows } = await dbQuery<{ id: string }>(
      `INSERT INTO outreach.inbound_emails (
         owner_id, campaign_id, email_send_id, drafting_item_id, provider_email_id,
         from_email, to_emails, subject, text_body, html_body, headers, received_at, auto_reply_skipped
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::timestamptz,$13)
       ON CONFLICT (provider_email_id) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [
        outbound.owner_id,
        outbound.campaign_id,
        outbound.id,
        outbound.drafting_item_id,
        inbound.providerEmailId,
        inbound.fromEmail,
        inbound.toEmails,
        inbound.subject,
        inbound.textBody,
        inbound.htmlBody,
        JSON.stringify(inbound.headers),
        inbound.receivedAt,
        'from_self',
      ],
    );
    return { inboundId: rows[0]?.id, skipped: 'from_self' };
  }

  const autoSkip = isAutomaticReply(inbound.headers, inbound.fromEmail);
  const { rows: inboundRows } = await dbQuery<{ id: string; forwarded_to_sender_at: string | null }>(
    `INSERT INTO outreach.inbound_emails (
       owner_id, campaign_id, email_send_id, drafting_item_id, provider_email_id,
       from_email, to_emails, subject, text_body, html_body, headers, received_at, auto_reply_skipped
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::timestamptz,$13)
     ON CONFLICT (provider_email_id) DO UPDATE SET
       text_body = coalesce(EXCLUDED.text_body, outreach.inbound_emails.text_body),
       html_body = coalesce(EXCLUDED.html_body, outreach.inbound_emails.html_body),
       headers = CASE
         WHEN EXCLUDED.headers = '{}'::jsonb THEN outreach.inbound_emails.headers
         ELSE EXCLUDED.headers
       END,
       auto_reply_skipped = coalesce(outreach.inbound_emails.auto_reply_skipped, EXCLUDED.auto_reply_skipped),
       updated_at = now()
     RETURNING id, forwarded_to_sender_at::text`,
    [
      outbound.owner_id,
      outbound.campaign_id,
      outbound.id,
      outbound.drafting_item_id,
      inbound.providerEmailId,
      inbound.fromEmail,
      inbound.toEmails,
      inbound.subject,
      inbound.textBody,
      inbound.htmlBody,
      JSON.stringify(inbound.headers),
      inbound.receivedAt,
      autoSkip,
    ],
  );
  const inboundId = inboundRows[0]?.id;
  if (!inboundId) return { skipped: 'inbound_insert_failed' };

  let forwarded = Boolean(inboundRows[0]?.forwarded_to_sender_at);
  if (!forwarded) {
    forwarded = await forwardInboundToSender(outbound, inbound);
    if (forwarded) {
      await dbQuery(
        `UPDATE outreach.inbound_emails
            SET forwarded_to_sender_at = coalesce(forwarded_to_sender_at, now()),
                updated_at = now()
          WHERE id = $1`,
        [inboundId],
      );
    }
  }

  if (autoSkip) {
    return { inboundId, skipped: autoSkip, forwarded };
  }

  // New human inbound supersedes any queued deferred follow-up.
  await cancelScheduledFollowups(outbound.id, 'newer_inbound');

  if (await isThreadSuppressed(outbound.id)) {
    return { inboundId, skipped: 'thread_suppressed', forwarded };
  }

  const sentTurns = await countImmediateSentReplies(outbound.id);
  if (sentTurns >= REPLY_MAX_IMMEDIATE_TURNS) {
    return { inboundId, skipped: 'max_turns', forwarded };
  }

  // Also count in-flight immediate replies toward the cap.
  const { rows: inflight } = await dbQuery<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM outreach.reply_sends
      WHERE email_send_id = $1::uuid
        AND kind = 'immediate'
        AND status IN ('queued', 'drafting')`,
    [outbound.id],
  );
  if (sentTurns + (inflight[0]?.n ?? 0) >= REPLY_MAX_IMMEDIATE_TURNS) {
    return { inboundId, skipped: 'max_turns_inflight', forwarded };
  }

  const { rows: existingReply } = await dbQuery<{ id: string }>(
    `SELECT id::text FROM outreach.reply_sends
      WHERE inbound_email_id = $1::uuid AND kind = 'immediate'
      LIMIT 1`,
    [inboundId],
  );
  if (existingReply[0]) {
    return { inboundId, skipped: 'reply_already_queued', forwarded };
  }

  const scheduledFor = new Date(Date.now() + REPLY_AUTO_DELAY_MS);
  let replySend: { id: string; status: string } | undefined;
  try {
    const { rows: replyRows } = await dbQuery<{ id: string; status: string }>(
      `INSERT INTO outreach.reply_sends (
         owner_id, campaign_id, inbound_email_id, drafting_item_id, email_send_id,
         status, kind, scheduled_for
       ) VALUES ($1,$2,$3,$4,$5,'queued','immediate',$6::timestamptz)
       RETURNING id, status`,
      [
        outbound.owner_id,
        outbound.campaign_id,
        inboundId,
        outbound.drafting_item_id,
        outbound.id,
        scheduledFor.toISOString(),
      ],
    );
    replySend = replyRows[0];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unique|duplicate/i.test(message)) {
      return { inboundId, skipped: 'reply_already_queued', forwarded };
    }
    throw error;
  }

  if (!replySend) {
    return { inboundId, skipped: 'reply_insert_failed', forwarded };
  }

  const jobId = await enqueueWork({
    kind: 'reply.respond',
    payload: { replySendId: replySend.id },
    dedupeKey: replySend.id,
    scopeKey: outbound.campaign_id,
    availableAt: scheduledFor,
    priority: 35,
  });

  await dbQuery(
    `UPDATE outreach.reply_sends
        SET orchestration_job_id = $2::uuid,
            updated_at = now()
      WHERE id = $1`,
    [replySend.id, jobId],
  );

  return { inboundId, replySendId: replySend.id, forwarded };
}
