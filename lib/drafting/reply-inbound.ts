/**
 * Inbound reply ingest: store body, forward to sender, enqueue delayed auto-response.
 */

import { agentMailSendOutreach } from '@/lib/agentmail';
import {
  extractEmailAddress,
  INBOUND_FORWARD_LABEL,
  isOutreachInbox,
  personalForwardEmailForInbox,
} from '@/lib/agentmail-inboxes';
import { dbQuery } from '@/lib/db';
import { enqueueWork } from '@/lib/orchestration/repository';
import {
  REPLY_AUTO_DELAY_MS,
  REPLY_MAX_IMMEDIATE_TURNS,
} from '@/lib/drafting/reply-constants';
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

function stripHtml(html: string | null | undefined): string | null {
  if (!html?.trim()) return null;
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text || null;
}

/** OOO / bulk headers — stored for display, but we still auto-respond. */
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

/** Only bounce/daemon mail skips the Calendly auto-response. OOO still gets one. */
export function autoReplySkipReason(
  headers: Record<string, string>,
  fromEmail: string,
): string | null {
  if (/^(mailer-daemon|postmaster)@/i.test(fromEmail)) return 'mailer_daemon';
  const subject = headers.subject?.toLowerCase() ?? '';
  if (/\b(undeliverable|delivery status notification|mail delivery failed)\b/i.test(subject)) {
    return 'bounce_subject';
  }
  return null;
}

export function buildInboundForwardPayload(
  outbound: Pick<OutboundSendContext, 'from_email' | 'to_email' | 'subject'>,
  inbound: ReceivedEmailContent,
): { to: string; subject: string; text: string } | null {
  const inbox = extractEmailAddress(outbound.from_email) ?? outbound.from_email.toLowerCase();
  if (!isOutreachInbox(inbox)) return null;
  const to = personalForwardEmailForInbox(inbox);
  const from = extractEmailAddress(inbound.fromEmail) ?? inbound.fromEmail.toLowerCase();
  if (from === to) return null;
  if (isOutreachInbox(from)) return null;
  const originalSubject = inbound.subject?.trim() || outbound.subject?.trim() || `reply from ${from}`;
  const subject = /^fwd:/i.test(originalSubject) ? originalSubject : `Fwd: ${originalSubject}`;
  const body = inbound.textBody?.trim()
    || stripHtml(inbound.htmlBody)
    || '(no text body)';
  const text = [
    'Forwarded lead reply to your Helios outreach.',
    `From: ${inbound.fromEmail}`,
    `To: ${(inbound.toEmails.length ? inbound.toEmails : [outbound.from_email]).join(', ')}`,
    `Original To: ${outbound.to_email}`,
    `Subject: ${originalSubject}`,
    '',
    body,
  ].join('\n');
  return { to, subject, text };
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
  _providerEmailId: string,
  _fallbackReceivedAt: string,
): Promise<ReceivedEmailContent | null> {
  return null;
}

async function forwardInboundToSender(
  outbound: OutboundSendContext,
  inbound: ReceivedEmailContent,
): Promise<boolean> {
  const payload = buildInboundForwardPayload(outbound, inbound);
  if (!payload) return false;
  const inboxId = extractEmailAddress(outbound.from_email) ?? outbound.from_email;
  try {
    await agentMailSendOutreach({
      inboxId,
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      labels: [INBOUND_FORWARD_LABEL, 'helios-outreach-forward'],
    });
    return true;
  } catch (error) {
    console.warn(
      `[inbound-forward] failed ${inboxId} → ${payload.to}:`,
      error instanceof Error ? error.message : error,
    );
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
  content?: ReceivedEmailContent | null;
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

  let inbound = input.content ?? await fetchReceivedEmailContent(providerEmailId, input.eventAt);
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

  const fromEmail = extractEmailAddress(inbound.fromEmail) ?? inbound.fromEmail.toLowerCase();
  inbound = { ...inbound, fromEmail };

  // Never auto-respond to our own addresses.
  if (fromEmail === outbound.from_email.toLowerCase() || isOutreachInbox(fromEmail)) {
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

  const headers = { ...inbound.headers };
  if (inbound.subject && !headers.subject) headers.subject = inbound.subject;
  const autoSkip = autoReplySkipReason(headers, inbound.fromEmail);
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
