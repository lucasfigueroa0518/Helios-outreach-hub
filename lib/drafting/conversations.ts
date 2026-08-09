import { dbQuery } from '@/lib/db';

export type ConversationFilter = 'all' | 'awaiting' | 'sent' | 'failed';

export type ConversationListItem = {
  email_send_id: string;
  drafting_item_id: string;
  campaign_id: string;
  campaign_name: string;
  lead_name: string | null;
  lead_company: string | null;
  lead_email: string;
  outbound_subject: string;
  last_inbound_preview: string | null;
  last_inbound_at: string;
  reply_status: string | null;
  reply_scheduled_for: string | null;
  reply_sent_at: string | null;
};

export type ConversationThreadMessage = {
  id: string;
  role: 'outbound' | 'inbound' | 'auto_reply' | 'scheduled_followup';
  subject: string | null;
  body_text: string | null;
  at: string;
  status?: string | null;
  error_message?: string | null;
  kind?: string | null;
  disposition?: string | null;
  defer_until?: string | null;
  defer_reason?: string | null;
};

export type ConversationThread = {
  email_send_id: string;
  drafting_item_id: string;
  campaign_id: string;
  campaign_name: string;
  campaign_href: string;
  lead_name: string | null;
  lead_company: string | null;
  lead_email: string;
  messages: ConversationThreadMessage[];
  reply_status: string | null;
  reply_suppressed: boolean;
};

export type ConversationStats = {
  conversations: number;
  awaiting: number;
  sent: number;
  failed: number;
};

function previewText(value: string | null | undefined, max = 120): string | null {
  if (!value?.trim()) return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export async function listConversationStats(ownerId: string, campaignId?: string | null): Promise<ConversationStats> {
  const params: unknown[] = [ownerId];
  let campaignClause = '';
  if (campaignId) {
    params.push(campaignId);
    campaignClause = ` AND ib.campaign_id = $2::uuid`;
  }
  const { rows } = await dbQuery<{
    conversations: string;
    awaiting: string;
    sent: string;
    failed: string;
  }>(
    `WITH threads AS (
       SELECT DISTINCT ON (ib.email_send_id)
              ib.email_send_id,
              rs.status AS reply_status
         FROM outreach.inbound_emails ib
         LEFT JOIN LATERAL (
           SELECT status
             FROM outreach.reply_sends
            WHERE email_send_id = ib.email_send_id
              AND status <> 'cancelled'
            ORDER BY coalesce(sent_at, scheduled_for, created_at) DESC
            LIMIT 1
         ) rs ON true
        WHERE ib.owner_id = $1::uuid
          ${campaignClause}
        ORDER BY ib.email_send_id, ib.received_at DESC
     )
     SELECT count(*)::text AS conversations,
            count(*) FILTER (
              WHERE reply_status IN ('queued', 'drafting', 'scheduled') OR reply_status IS NULL
            )::text AS awaiting,
            count(*) FILTER (WHERE reply_status = 'sent')::text AS sent,
            count(*) FILTER (WHERE reply_status IN ('failed', 'skipped'))::text AS failed
       FROM threads`,
    params,
  );
  const row = rows[0];
  return {
    conversations: Number(row?.conversations ?? 0),
    awaiting: Number(row?.awaiting ?? 0),
    sent: Number(row?.sent ?? 0),
    failed: Number(row?.failed ?? 0),
  };
}

export async function listConversations(input: {
  ownerId: string;
  campaignId?: string | null;
  filter?: ConversationFilter;
  limit?: number;
}): Promise<{ stats: ConversationStats; items: ConversationListItem[] }> {
  const stats = await listConversationStats(input.ownerId, input.campaignId);
  const params: unknown[] = [input.ownerId];
  const clauses = ['ib.owner_id = $1::uuid'];
  if (input.campaignId) {
    params.push(input.campaignId);
    clauses.push(`ib.campaign_id = $${params.length}::uuid`);
  }

  const filter = input.filter ?? 'all';
  let having = '';
  if (filter === 'awaiting') {
    having = `AND (rs.status IN ('queued', 'drafting', 'scheduled') OR rs.status IS NULL)`;
  } else if (filter === 'sent') {
    having = `AND rs.status = 'sent'`;
  } else if (filter === 'failed') {
    having = `AND rs.status IN ('failed', 'skipped')`;
  }

  params.push(Math.min(200, Math.max(1, input.limit ?? 100)));
  const limitIdx = params.length;

  const { rows } = await dbQuery<{
    email_send_id: string;
    drafting_item_id: string;
    campaign_id: string;
    campaign_name: string;
    lead_name: string | null;
    lead_company: string | null;
    lead_email: string;
    outbound_subject: string;
    last_inbound_preview: string | null;
    last_inbound_at: string;
    reply_status: string | null;
    reply_scheduled_for: string | null;
    reply_sent_at: string | null;
  }>(
    `WITH latest AS (
       SELECT DISTINCT ON (ib.email_send_id)
              ib.email_send_id,
              ib.drafting_item_id,
              ib.campaign_id,
              ib.text_body,
              ib.html_body,
              ib.received_at
         FROM outreach.inbound_emails ib
        WHERE ${clauses.join(' AND ')}
        ORDER BY ib.email_send_id, ib.received_at DESC
     )
     SELECT latest.email_send_id::text,
            latest.drafting_item_id::text,
            latest.campaign_id::text,
            c.name AS campaign_name,
            coalesce(
              nullif(trim(i.input_snapshot #>> '{lead,fullName}'), ''),
              nullif(trim(i.input_snapshot #>> '{lead,firstName}'), '')
            ) AS lead_name,
            nullif(trim(i.input_snapshot #>> '{lead,company}'), '') AS lead_company,
            s.to_email AS lead_email,
            s.subject AS outbound_subject,
            coalesce(latest.text_body, latest.html_body) AS last_inbound_preview,
            latest.received_at::text AS last_inbound_at,
            rs.status AS reply_status,
            rs.scheduled_for::text AS reply_scheduled_for,
            rs.sent_at::text AS reply_sent_at
       FROM latest
       JOIN outreach.email_sends s ON s.id = latest.email_send_id
       JOIN outreach.campaigns c ON c.id = latest.campaign_id
       JOIN outreach.drafting_items i ON i.id = latest.drafting_item_id
       LEFT JOIN LATERAL (
         SELECT status, scheduled_for, sent_at
           FROM outreach.reply_sends
          WHERE email_send_id = latest.email_send_id
            AND status <> 'cancelled'
          ORDER BY coalesce(sent_at, scheduled_for, created_at) DESC
          LIMIT 1
       ) rs ON true
      WHERE true
        ${having}
      ORDER BY latest.received_at DESC
      LIMIT $${limitIdx}`,
    params,
  );

  const items = rows.map((row) => ({
    ...row,
    last_inbound_preview: previewText(row.last_inbound_preview),
  }));

  return { stats, items };
}

export async function getConversationThread(input: {
  ownerId: string;
  emailSendId: string;
}): Promise<ConversationThread | null> {
  const { rows } = await dbQuery<{
    email_send_id: string;
    drafting_item_id: string;
    campaign_id: string;
    campaign_name: string;
    lead_name: string | null;
    lead_company: string | null;
    lead_email: string;
    outbound_subject: string;
    outbound_body: string | null;
    outbound_at: string;
    reply_suppressed: boolean;
  }>(
    `SELECT s.id::text AS email_send_id,
            s.drafting_item_id::text,
            w.campaign_id::text,
            c.name AS campaign_name,
            coalesce(
              nullif(trim(i.input_snapshot #>> '{lead,fullName}'), ''),
              nullif(trim(i.input_snapshot #>> '{lead,firstName}'), '')
            ) AS lead_name,
            nullif(trim(i.input_snapshot #>> '{lead,company}'), '') AS lead_company,
            s.to_email AS lead_email,
            s.subject AS outbound_subject,
            d.body_text AS outbound_body,
            coalesce(s.sent_at, s.created_at)::text AS outbound_at,
            (s.reply_suppressed_at IS NOT NULL) AS reply_suppressed
       FROM outreach.email_sends s
       JOIN outreach.drafting_items i ON i.id = s.drafting_item_id
       JOIN outreach.drafting_workspaces w ON w.id = i.workspace_id
       JOIN outreach.campaigns c ON c.id = w.campaign_id
       LEFT JOIN LATERAL (
         SELECT body_text
           FROM outreach.email_drafts
          WHERE drafting_item_id = s.drafting_item_id
          ORDER BY content_revision DESC
          LIMIT 1
       ) d ON true
      WHERE s.id = $1::uuid
        AND c.owner_id = $2::uuid
      LIMIT 1`,
    [input.emailSendId, input.ownerId],
  );
  const head = rows[0];
  if (!head) return null;

  const { rows: inbounds } = await dbQuery<{
    id: string;
    subject: string | null;
    text_body: string | null;
    html_body: string | null;
    received_at: string;
  }>(
    `SELECT id::text, subject, text_body, html_body, received_at::text
       FROM outreach.inbound_emails
      WHERE email_send_id = $1::uuid
        AND owner_id = $2::uuid
      ORDER BY received_at ASC`,
    [input.emailSendId, input.ownerId],
  );

  if (inbounds.length === 0) return null;

  const { rows: replies } = await dbQuery<{
    id: string;
    subject: string | null;
    body_text: string | null;
    sent_at: string | null;
    scheduled_for: string;
    status: string;
    kind: string;
    disposition: string | null;
    defer_until: string | null;
    defer_reason: string | null;
    error_message: string | null;
  }>(
    `SELECT id::text, subject, body_text, sent_at::text, scheduled_for::text,
            status, kind, disposition, defer_until::text, defer_reason, error_message
       FROM outreach.reply_sends
      WHERE email_send_id = $1::uuid
        AND status <> 'cancelled'
      ORDER BY coalesce(sent_at, scheduled_for, created_at) ASC`,
    [input.emailSendId],
  );

  const messages: ConversationThreadMessage[] = [
    {
      id: `outbound:${head.email_send_id}`,
      role: 'outbound',
      subject: head.outbound_subject,
      body_text: head.outbound_body,
      at: head.outbound_at,
    },
  ];

  for (const inbound of inbounds) {
    messages.push({
      id: inbound.id,
      role: 'inbound',
      subject: inbound.subject,
      body_text: inbound.text_body
        || inbound.html_body?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        || null,
      at: inbound.received_at,
    });
  }

  let latestReplyStatus: string | null = null;
  for (const reply of replies) {
    latestReplyStatus = reply.status;
    const isScheduledFollowup = reply.kind === 'followup' && reply.status === 'scheduled';
    messages.push({
      id: reply.id,
      role: isScheduledFollowup ? 'scheduled_followup' : 'auto_reply',
      subject: reply.subject,
      body_text: reply.body_text
        || (isScheduledFollowup
          ? `Scheduled follow-up${reply.defer_until ? ` for ${reply.defer_until}` : ''}${
            reply.defer_reason ? ` · ${reply.defer_reason}` : ''
          }`
          : null),
      at: reply.sent_at ?? reply.scheduled_for,
      status: reply.status,
      error_message: reply.error_message,
      kind: reply.kind,
      disposition: reply.disposition,
      defer_until: reply.defer_until,
      defer_reason: reply.defer_reason,
    });
  }

  messages.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  return {
    email_send_id: head.email_send_id,
    drafting_item_id: head.drafting_item_id,
    campaign_id: head.campaign_id,
    campaign_name: head.campaign_name,
    campaign_href: `/campaigns/${head.campaign_id}/draft`,
    lead_name: head.lead_name,
    lead_company: head.lead_company,
    lead_email: head.lead_email,
    messages,
    reply_status: latestReplyStatus,
    reply_suppressed: head.reply_suppressed,
  };
}
