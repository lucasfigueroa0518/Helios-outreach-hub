import { dbQuery } from '@/lib/db';
import type { ReplyThreadMessage } from '@/lib/drafting/reply-prompt';

export async function loadReplyThread(emailSendId: string): Promise<{
  outboundSubject: string;
  outboundBody: string;
  messages: ReplyThreadMessage[];
}> {
  const { rows: outboundRows } = await dbQuery<{
    subject: string;
    body: string | null;
    at: string;
  }>(
    `SELECT s.subject,
            d.body_text AS body,
            coalesce(s.sent_at, s.created_at)::text AS at
       FROM outreach.email_sends s
       LEFT JOIN LATERAL (
         SELECT body_text
           FROM outreach.email_drafts
          WHERE drafting_item_id = s.drafting_item_id
          ORDER BY content_revision DESC
          LIMIT 1
       ) d ON true
      WHERE s.id = $1::uuid
      LIMIT 1`,
    [emailSendId],
  );
  const outbound = outboundRows[0];
  if (!outbound) {
    return { outboundSubject: '', outboundBody: '', messages: [] };
  }

  const messages: ReplyThreadMessage[] = [
    {
      role: 'outbound',
      at: outbound.at,
      subject: outbound.subject,
      body: outbound.body ?? '',
    },
  ];

  const { rows: inbounds } = await dbQuery<{
    subject: string | null;
    text_body: string | null;
    html_body: string | null;
    received_at: string;
  }>(
    `SELECT subject, text_body, html_body, received_at::text
       FROM outreach.inbound_emails
      WHERE email_send_id = $1::uuid
      ORDER BY received_at ASC`,
    [emailSendId],
  );

  const { rows: replies } = await dbQuery<{
    subject: string | null;
    body_text: string | null;
    sent_at: string | null;
    scheduled_for: string;
    status: string;
    kind: string;
  }>(
    `SELECT subject, body_text, sent_at::text, scheduled_for::text, status, kind
       FROM outreach.reply_sends
      WHERE email_send_id = $1::uuid
        AND status = 'sent'
        AND body_text IS NOT NULL
      ORDER BY coalesce(sent_at, created_at) ASC`,
    [emailSendId],
  );

  type Timed = { at: number; msg: ReplyThreadMessage };
  const timed: Timed[] = [];

  for (const inbound of inbounds) {
    timed.push({
      at: Date.parse(inbound.received_at),
      msg: {
        role: 'inbound',
        at: inbound.received_at,
        subject: inbound.subject,
        body: inbound.text_body
          || inbound.html_body?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
          || '',
      },
    });
  }
  for (const reply of replies) {
    const at = reply.sent_at ?? reply.scheduled_for;
    timed.push({
      at: Date.parse(at),
      msg: {
        role: 'auto_reply',
        at,
        subject: reply.subject,
        body: reply.body_text ?? '',
      },
    });
  }

  timed.sort((a, b) => a.at - b.at);
  // Outbound already first; append chronological inbound/auto_reply
  messages.push(...timed.map((entry) => entry.msg));

  return {
    outboundSubject: outbound.subject,
    outboundBody: outbound.body ?? '',
    messages,
  };
}

export async function countImmediateSentReplies(emailSendId: string): Promise<number> {
  const { rows } = await dbQuery<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM outreach.reply_sends
      WHERE email_send_id = $1::uuid
        AND kind = 'immediate'
        AND status = 'sent'`,
    [emailSendId],
  );
  return rows[0]?.n ?? 0;
}

export async function isThreadSuppressed(emailSendId: string): Promise<boolean> {
  const { rows } = await dbQuery<{ suppressed: boolean }>(
    `SELECT (reply_suppressed_at IS NOT NULL) AS suppressed
       FROM outreach.email_sends
      WHERE id = $1::uuid`,
    [emailSendId],
  );
  return Boolean(rows[0]?.suppressed);
}

export async function cancelScheduledFollowups(
  emailSendId: string,
  reason: string,
): Promise<number> {
  const { rowCount } = await dbQuery(
    `UPDATE outreach.reply_sends
        SET status = 'cancelled',
            cancelled_at = now(),
            cancel_reason = $2,
            updated_at = now()
      WHERE email_send_id = $1::uuid
        AND kind = 'followup'
        AND status = 'scheduled'`,
    [emailSendId, reason.slice(0, 500)],
  );
  return rowCount ?? 0;
}
