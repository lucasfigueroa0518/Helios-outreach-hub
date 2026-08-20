/**
 * Daily send queue — budget, enqueue, manage, and worker delivery.
 */
import { dbQuery, dbTransaction } from '@/lib/db';
import {
  AGENTMAIL_ACCOUNT_PAUSE_RETRY_MS,
  isAgentMailAccountSendingPausedError,
  nextAgentMailPauseRetryAt,
} from '@/lib/drafting/agentmail-send-errors';
import {
  DraftingConflictError,
  DraftingNotFoundError,
  DraftingValidationError,
} from '@/lib/drafting/errors';
import type { SenderIdentitySlug } from '@/lib/agentmail-inboxes';
import { inferIdentitySlug } from '@/lib/agentmail-inboxes';
import { extractFirstName } from '@/lib/drafting/normalize';
import {
  isEmailSendConfigured,
  resolveSendToEmail,
  sendOutreachEmail,
} from '@/lib/drafting/send';
import {
  getDailyInboxCap,
  getSenderIdentityBySlug,
  listSenderInboxes,
  type SenderInboxRow,
} from '@/lib/drafting/sender-identities';
import {
  DAILY_SEND_CAP,
  SEND_QUEUE_TIMEZONE,
  addCalendarDays,
  allocateInboxSlots,
  allocationStartNy,
  formatNyDate,
  formatNyDateLabel,
  inboxUsageKey,
  randomNySendTime,
  remainingCapacity,
} from '@/lib/drafting/send-queue-schedule';
import {
  cancelWorkByIds,
  enqueueWork,
  reschedulePendingWork,
} from '@/lib/orchestration/repository';

export {
  DAILY_SEND_CAP,
  SEND_QUEUE_TIMEZONE,
  formatNyDate,
  formatNyDateLabel,
  remainingCapacity,
};

export type EmailSendQueueStatus = 'queued' | 'sending' | 'sent' | 'cancelled' | 'failed';

export type EmailSendQueueRow = {
  id: string;
  owner_id: string;
  drafting_item_id: string;
  campaign_id: string;
  scheduled_for: string;
  schedule_date: string;
  status: EmailSendQueueStatus;
  to_email: string;
  subject: string;
  recipient_name: string | null;
  orchestration_job_id: string | null;
  error_message: string | null;
  sender_identity_id: string | null;
  sender_inbox_id: string | null;
  from_email: string | null;
  created_at: string;
  updated_at: string;
};

export type QueueListItem = EmailSendQueueRow & {
  campaign_name: string;
  overdue: boolean;
  identity_slug: SenderIdentitySlug | null;
  inbox_email: string | null;
  /** NY calendar date the send actually went out, when status is sent. */
  sent_date?: string | null;
};

export type QueueInboxDayStat = {
  inbox_id: string;
  email: string;
  identity_slug: SenderIdentitySlug;
  used: number;
  capacity: number;
  remaining: number;
  sent_count: number;
  queued_count: number;
  over_cap: boolean;
};

export type QueueDayBucket = {
  schedule_date: string;
  used: number;
  capacity: number;
  remaining: number;
  sent_count: number;
  queued_count: number;
  over_cap: boolean;
  items: QueueListItem[];
  inboxes: QueueInboxDayStat[];
};

export type ActiveQueueInfo = {
  queue_id: string;
  schedule_date: string;
  status: EmailSendQueueStatus;
  scheduled_for: string;
};

const QUEUE_ROW_SELECT = `
  id, owner_id, drafting_item_id, campaign_id,
  scheduled_for::text, schedule_date::text, status,
  to_email, subject, recipient_name, orchestration_job_id,
  error_message, sender_identity_id::text, sender_inbox_id::text,
  from_email, created_at::text, updated_at::text
`;

async function recordEmailSend(input: {
  itemId: string;
  status: 'sent' | 'failed';
  fromEmail: string;
  toEmail: string;
  subject: string;
  provider?: 'agentmail' | 'resend';
  providerMessageId?: string | null;
  providerRfcMessageId?: string | null;
  providerThreadId?: string | null;
  senderInboxId?: string | null;
  errorMessage?: string | null;
}): Promise<void> {
  await dbQuery(
    `INSERT INTO outreach.email_sends (
       drafting_item_id, provider, provider_message_id, provider_rfc_message_id,
       provider_thread_id, sender_inbox_id, status,
       from_email, to_email, subject, error_message, sent_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      input.itemId,
      input.provider ?? 'agentmail',
      input.providerMessageId ?? null,
      input.providerRfcMessageId ?? null,
      input.providerThreadId ?? null,
      input.senderInboxId ?? null,
      input.status,
      input.fromEmail,
      input.toEmail,
      input.subject,
      input.errorMessage ?? null,
      input.status === 'sent' ? new Date().toISOString() : null,
    ],
  );
}

export async function inboxUsageFromDate(fromDate: string): Promise<Map<string, number>> {
  const usage = new Map<string, number>();

  const queued = await dbQuery<{ sender_inbox_id: string; schedule_date: string; count: number }>(
    `SELECT sender_inbox_id::text, schedule_date::text AS schedule_date, count(*)::int AS count
       FROM outreach.email_send_queue
      WHERE sender_inbox_id IS NOT NULL
        AND schedule_date >= $1::date
        AND status IN ('queued', 'sending')
      GROUP BY sender_inbox_id, schedule_date`,
    [fromDate],
  );
  for (const row of queued.rows) {
    const key = inboxUsageKey(row.sender_inbox_id, row.schedule_date);
    usage.set(key, (usage.get(key) ?? 0) + Number(row.count));
  }

  const sent = await dbQuery<{ sender_inbox_id: string; schedule_date: string; count: number }>(
    `SELECT coalesce(s.sender_inbox_id::text, ib.id::text) AS sender_inbox_id,
            (timezone($2, s.sent_at))::date::text AS schedule_date,
            count(*)::int AS count
       FROM outreach.email_sends s
       LEFT JOIN outreach.sender_inboxes ib ON lower(ib.email) = lower(s.from_email)
      WHERE s.status = 'sent'
        AND s.sent_at IS NOT NULL
        AND (timezone($2, s.sent_at))::date >= $1::date
        AND coalesce(s.sender_inbox_id, ib.id) IS NOT NULL
      GROUP BY 1, 2`,
    [fromDate, SEND_QUEUE_TIMEZONE],
  );
  for (const row of sent.rows) {
    const key = inboxUsageKey(row.sender_inbox_id, row.schedule_date);
    usage.set(key, (usage.get(key) ?? 0) + Number(row.count));
  }

  return usage;
}

export async function countInboxSentOnNyDate(inboxId: string, scheduleDate: string): Promise<number> {
  const { rows } = await dbQuery<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM outreach.email_sends s
      WHERE s.status = 'sent'
        AND s.sent_at IS NOT NULL
        AND (timezone($3, s.sent_at))::date = $2::date
        AND (
          s.sender_inbox_id = $1::uuid
          OR (
            s.sender_inbox_id IS NULL
            AND EXISTS (
              SELECT 1 FROM outreach.sender_inboxes ib
               WHERE ib.id = $1::uuid AND lower(ib.email) = lower(s.from_email)
            )
          )
        )`,
    [inboxId, scheduleDate, SEND_QUEUE_TIMEZONE],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function todayRemainingForInbox(inboxId: string, now = new Date()): Promise<number> {
  const today = formatNyDate(now);
  const cap = await getDailyInboxCap();
  const usage = await inboxUsageFromDate(today);
  return remainingCapacity(usage.get(inboxUsageKey(inboxId, today)) ?? 0, cap);
}

/** Profile-level remaining today (sum of inbox remainings). */
export async function todayRemaining(
  _ownerId?: string,
  now = new Date(),
  identitySlug?: SenderIdentitySlug | null,
): Promise<number> {
  const today = formatNyDate(now);
  const cap = await getDailyInboxCap();
  const inboxes = await listSenderInboxes({ identitySlug: identitySlug ?? undefined });
  const usage = await inboxUsageFromDate(today);
  return inboxes.reduce((sum, inbox) => (
    sum + remainingCapacity(usage.get(inboxUsageKey(inbox.id, today)) ?? 0, cap)
  ), 0);
}

export async function loadActiveQueueByItemIds(
  itemIds: string[],
): Promise<Map<string, ActiveQueueInfo>> {
  if (itemIds.length === 0) return new Map();
  const { rows } = await dbQuery<{
    id: string;
    drafting_item_id: string;
    schedule_date: string;
    status: EmailSendQueueStatus;
    scheduled_for: string;
  }>(
    `SELECT id, drafting_item_id, schedule_date::text AS schedule_date, status, scheduled_for::text
       FROM outreach.email_send_queue
      WHERE drafting_item_id = ANY($1::uuid[])
        AND status IN ('queued', 'sending')`,
    [itemIds],
  );
  return new Map(rows.map((row) => [row.drafting_item_id, {
    queue_id: row.id,
    schedule_date: row.schedule_date,
    status: row.status,
    scheduled_for: row.scheduled_for,
  }]));
}

export async function ownerQueueStats(
  _ownerId?: string,
  identitySlug?: SenderIdentitySlug | null,
): Promise<{
  today_remaining: number;
  queued_count: number;
  next_schedule_date: string | null;
}> {
  const today = formatNyDate();
  const remaining = await todayRemaining(undefined, new Date(), identitySlug);
  const params: unknown[] = [];
  let identityClause = '';
  if (identitySlug) {
    params.push(identitySlug);
    identityClause = `AND EXISTS (
      SELECT 1 FROM outreach.sender_identities si
       WHERE si.id = q.sender_identity_id AND si.slug = $${params.length}
    )`;
  }
  const { rows } = await dbQuery<{
    queued_count: number;
    next_schedule_date: string | null;
  }>(
    `SELECT count(*)::int AS queued_count,
            min(schedule_date)::text AS next_schedule_date
       FROM outreach.email_send_queue q
      WHERE q.status IN ('queued', 'sending')
        ${identityClause}`,
    params,
  );
  return {
    today_remaining: remaining,
    queued_count: Number(rows[0]?.queued_count ?? 0),
    next_schedule_date: rows[0]?.next_schedule_date && rows[0].next_schedule_date >= today
      ? rows[0].next_schedule_date
      : rows[0]?.next_schedule_date ?? null,
  };
}

async function resolveItemIdentity(itemId: string): Promise<{
  slug: SenderIdentitySlug;
  identityId: string;
  inboxes: SenderInboxRow[];
  displayName: string;
  title: string;
  companyName: string;
  headshotStoragePath: string | null;
}> {
  const { rows } = await dbQuery<{
    identity_slug: string | null;
    work_email: string | null;
    display_name: string | null;
    title: string | null;
    company_name: string | null;
    headshot_storage_path: string | null;
  }>(
    `SELECT nullif(trim(i.input_snapshot #>> '{sender,identitySlug}'), '') AS identity_slug,
            nullif(trim(i.input_snapshot #>> '{sender,workEmail}'), '') AS work_email,
            nullif(trim(i.input_snapshot #>> '{sender,displayName}'), '') AS display_name,
            nullif(trim(i.input_snapshot #>> '{sender,title}'), '') AS title,
            nullif(trim(i.input_snapshot #>> '{sender,companyName}'), '') AS company_name,
            nullif(trim(i.input_snapshot #>> '{sender,headshotStoragePath}'), '') AS headshot_storage_path
       FROM outreach.drafting_items i
      WHERE i.id = $1`,
    [itemId],
  );
  const slug = inferIdentitySlug({
    identitySlug: rows[0]?.identity_slug,
    workEmail: rows[0]?.work_email,
    displayName: rows[0]?.display_name,
  });
  const identity = await getSenderIdentityBySlug(slug);
  if (!identity) throw new Error(`Sender identity ${slug} is not configured`);
  const inboxes = await listSenderInboxes({ identitySlug: slug });
  if (inboxes.length === 0) throw new Error(`No outreach inboxes configured for ${slug}`);
  return {
    slug,
    identityId: identity.id,
    inboxes,
    displayName: rows[0]?.display_name || identity.display_name,
    title: rows[0]?.title || identity.title,
    companyName: rows[0]?.company_name || identity.company_name,
    headshotStoragePath: rows[0]?.headshot_storage_path ?? null,
  };
}

async function insertQueueRow(input: {
  ownerId: string;
  itemId: string;
  campaignId: string;
  scheduleDate: string;
  scheduledFor: Date;
  toEmail: string;
  subject: string;
  recipientName: string | null;
  senderIdentityId: string;
  senderInboxId: string;
  fromEmail: string;
}): Promise<EmailSendQueueRow> {
  const { rows } = await dbQuery<EmailSendQueueRow>(
    `INSERT INTO outreach.email_send_queue (
       owner_id, drafting_item_id, campaign_id, scheduled_for, schedule_date,
       status, to_email, subject, recipient_name,
       sender_identity_id, sender_inbox_id, from_email
     ) VALUES ($1, $2, $3, $4::timestamptz, $5::date, 'queued', $6, $7, $8, $9, $10, $11)
     RETURNING ${QUEUE_ROW_SELECT}`,
    [
      input.ownerId,
      input.itemId,
      input.campaignId,
      input.scheduledFor.toISOString(),
      input.scheduleDate,
      input.toEmail,
      input.subject,
      input.recipientName,
      input.senderIdentityId,
      input.senderInboxId,
      input.fromEmail,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('Failed to insert email_send_queue row');

  const jobId = await enqueueWork({
    kind: 'email.send',
    payload: { queueId: row.id },
    dedupeKey: `email-send:${row.id}`,
    scopeKey: `email-send:${row.id}`,
    availableAt: input.scheduledFor,
    reviveTerminal: true,
  });

  const { rows: updated } = await dbQuery<EmailSendQueueRow>(
    `UPDATE outreach.email_send_queue
        SET orchestration_job_id = $2, updated_at = now()
      WHERE id = $1
      RETURNING ${QUEUE_ROW_SELECT}`,
    [row.id, jobId],
  );
  return updated[0] ?? { ...row, orchestration_job_id: jobId };
}

export type EnqueueSendInput = {
  ownerId: string;
  itemId: string;
  campaignId: string;
  toEmail: string;
  subject: string;
  recipientName: string | null;
};

async function loadQueueRow(id: string): Promise<EmailSendQueueRow | null> {
  const { rows } = await dbQuery<EmailSendQueueRow>(
    `SELECT ${QUEUE_ROW_SELECT} FROM outreach.email_send_queue WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function enqueueOverflowSend(input: EnqueueSendInput): Promise<EmailSendQueueRow> {
  const [row] = await enqueueOverflowBatch(input.ownerId, [input]);
  if (!row) throw new Error('Failed to enqueue send');
  return row;
}

export async function enqueueOverflowBatch(
  ownerId: string,
  items: EnqueueSendInput[],
): Promise<EmailSendQueueRow[]> {
  if (items.length === 0) return [];
  const rows: EmailSendQueueRow[] = [];
  const pending: EnqueueSendInput[] = [];

  for (const item of items) {
    const existing = await loadActiveQueueByItemIds([item.itemId]);
    const active = existing.get(item.itemId);
    if (active) {
      const found = await loadQueueRow(active.queue_id);
      if (found) {
        rows.push(found);
        continue;
      }
    }
    pending.push(item);
  }
  if (pending.length === 0) return rows;

  const firstIdentity = await resolveItemIdentity(pending[0]!.itemId);
  const grouped = new Map<SenderIdentitySlug, EnqueueSendInput[]>();
  grouped.set(firstIdentity.slug, []);
  for (const item of pending) {
    const identity = await resolveItemIdentity(item.itemId);
    const list = grouped.get(identity.slug) ?? [];
    list.push(item);
    grouped.set(identity.slug, list);
  }

  const startNy = allocationStartNy();
  const cap = await getDailyInboxCap();
  const usage = await inboxUsageFromDate(startNy);

  for (const [slug, group] of grouped) {
    const identity = await getSenderIdentityBySlug(slug);
    if (!identity) throw new Error(`Sender identity ${slug} is not configured`);
    const inboxes = await listSenderInboxes({ identitySlug: slug });
    const slots = allocateInboxSlots({
      count: group.length,
      inboxes: inboxes.map((inbox) => ({ id: inbox.id, email: inbox.email })),
      usage,
      startNy,
      cap,
    });
    for (let i = 0; i < group.length; i += 1) {
      const item = group[i]!;
      const slot = slots[i]!;
      usage.set(
        inboxUsageKey(slot.inboxId, slot.scheduleDate),
        (usage.get(inboxUsageKey(slot.inboxId, slot.scheduleDate)) ?? 0) + 1,
      );
      rows.push(await insertQueueRow({
        ownerId,
        itemId: item.itemId,
        campaignId: item.campaignId,
        scheduleDate: slot.scheduleDate,
        scheduledFor: slot.scheduledFor,
        toEmail: item.toEmail,
        subject: item.subject,
        recipientName: item.recipientName,
        senderIdentityId: identity.id,
        senderInboxId: slot.inboxId,
        fromEmail: slot.email,
      }));
    }
  }
  return rows;
}

async function parkQueueForAgentMailPause(input: {
  queueId: string;
  errorMessage: string;
  retryAt: Date;
  enqueue: boolean;
}): Promise<string> {
  const scheduleDate = formatNyDate(input.retryAt);
  await dbQuery(
    `UPDATE outreach.email_send_queue
        SET status = 'queued',
            scheduled_for = $2::timestamptz,
            schedule_date = $3::date,
            error_message = $4,
            updated_at = now()
      WHERE id = $1`,
    [
      input.queueId,
      input.retryAt.toISOString(),
      scheduleDate,
      input.errorMessage.slice(0, 1000),
    ],
  );
  if (!input.enqueue) return scheduleDate;

  const jobId = await enqueueWork({
    kind: 'email.send',
    payload: { queueId: input.queueId },
    dedupeKey: `email-send:${input.queueId}`,
    scopeKey: `email-send:${input.queueId}`,
    availableAt: input.retryAt,
    reviveTerminal: true,
  });
  await dbQuery(
    `UPDATE outreach.email_send_queue
        SET orchestration_job_id = $2, updated_at = now()
      WHERE id = $1 AND status = 'queued'`,
    [input.queueId, jobId],
  );
  return scheduleDate;
}

function releaseRowsFromUsage(usage: Map<string, number>, rows: EmailSendQueueRow[]): void {
  for (const row of rows) {
    if (!row.sender_inbox_id) continue;
    if (row.status !== 'queued' && row.status !== 'sending') continue;
    const key = inboxUsageKey(row.sender_inbox_id, row.schedule_date);
    usage.set(key, Math.max(0, (usage.get(key) ?? 0) - 1));
  }
}

/**
 * Spread queued rows across every identity inbox: fill each address to the
 * daily cap, then the next address, then the next day. Preserves pause errors
 * and same-day retry times.
 */
async function assignInboxWaterfall(rows: EmailSendQueueRow[]): Promise<EmailSendQueueRow[]> {
  if (rows.length === 0) return rows;
  const startNy = allocationStartNy();
  const cap = await getDailyInboxCap();
  const allInboxes = await listSenderInboxes();
  const usage = await inboxUsageFromDate(startNy);
  releaseRowsFromUsage(usage, rows);

  const grouped = new Map<SenderIdentitySlug, EmailSendQueueRow[]>();
  for (const row of rows) {
    const inbox = allInboxes.find((entry) => (
      entry.id === row.sender_inbox_id || entry.identity_id === row.sender_identity_id
    ));
    const slug = inbox?.identity_slug ?? (await resolveItemIdentity(row.drafting_item_id)).slug;
    const list = grouped.get(slug) ?? [];
    list.push(row);
    grouped.set(slug, list);
  }

  const updatedIds: string[] = [];
  for (const [slug, group] of grouped) {
    const identity = await getSenderIdentityBySlug(slug);
    const inboxes = allInboxes.filter((inbox) => inbox.identity_slug === slug);
    if (!identity || inboxes.length === 0) continue;
    const ordered = [...group].sort((a, b) => (
      a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
    ));
    const slots = allocateInboxSlots({
      count: ordered.length,
      inboxes: inboxes.map((inbox) => ({ id: inbox.id, email: inbox.email })),
      usage,
      startNy,
      cap,
    });
    for (let i = 0; i < ordered.length; i += 1) {
      const row = ordered[i]!;
      const slot = slots[i];
      if (!slot) continue;
      usage.set(
        inboxUsageKey(slot.inboxId, slot.scheduleDate),
        (usage.get(inboxUsageKey(slot.inboxId, slot.scheduleDate)) ?? 0) + 1,
      );
      const sameDay = slot.scheduleDate === row.schedule_date;
      const scheduledFor = sameDay ? new Date(row.scheduled_for) : slot.scheduledFor;
      const inboxChanged = row.sender_inbox_id !== slot.inboxId || row.from_email !== slot.email;
      const dateChanged = !sameDay;
      if (!inboxChanged && !dateChanged) continue;
      await dbQuery(
        `UPDATE outreach.email_send_queue
            SET sender_identity_id = $2,
                sender_inbox_id = $3,
                from_email = $4,
                schedule_date = $5::date,
                scheduled_for = $6::timestamptz,
                updated_at = now()
          WHERE id = $1`,
        [
          row.id,
          identity.id,
          slot.inboxId,
          slot.email,
          slot.scheduleDate,
          scheduledFor.toISOString(),
        ],
      );
      if (dateChanged) {
        if (row.orchestration_job_id) {
          const moved = await reschedulePendingWork(row.orchestration_job_id, scheduledFor);
          if (!moved) {
            const jobId = await enqueueWork({
              kind: 'email.send',
              payload: { queueId: row.id },
              dedupeKey: `email-send:${row.id}`,
              scopeKey: `email-send:${row.id}`,
              availableAt: scheduledFor,
              reviveTerminal: true,
            });
            await dbQuery(
              `UPDATE outreach.email_send_queue
                  SET orchestration_job_id = $2, updated_at = now()
                WHERE id = $1 AND status = 'queued'`,
              [row.id, jobId],
            );
          }
        }
      }
      updatedIds.push(row.id);
    }
  }

  if (updatedIds.length === 0) return rows;
  const ownerId = rows[0]?.owner_id;
  if (!ownerId) return rows;
  return loadOwnedQueueRows(ownerId, rows.map((row) => row.id));
}

export async function rebalanceOverCapSendQueue(): Promise<number> {
  const startNy = allocationStartNy();
  const cap = await getDailyInboxCap();
  const usage = await inboxUsageFromDate(startNy);
  const overInboxIds = new Set<string>();
  for (const [key, count] of usage) {
    if (count > cap) overInboxIds.add(key.split(':')[0]!);
  }
  if (overInboxIds.size === 0) return 0;

  const { rows } = await dbQuery<EmailSendQueueRow>(
    `SELECT ${QUEUE_ROW_SELECT}
       FROM outreach.email_send_queue
      WHERE status = 'queued'
        AND sender_inbox_id = ANY($1::uuid[])
      ORDER BY created_at ASC`,
    [[...overInboxIds]],
  );
  if (rows.length === 0) return 0;
  const identityIds = [...new Set(rows.map((row) => row.sender_identity_id).filter(Boolean))];
  const { rows: identityRows } = identityIds.length > 0
    ? await dbQuery<EmailSendQueueRow>(
      `SELECT ${QUEUE_ROW_SELECT}
         FROM outreach.email_send_queue
        WHERE status = 'queued'
          AND sender_identity_id = ANY($1::uuid[])
        ORDER BY created_at ASC`,
      [identityIds],
    )
    : { rows };
  const before = identityRows.map((row) => `${row.id}:${row.sender_inbox_id}:${row.schedule_date}`).join('|');
  const afterRows = await assignInboxWaterfall(identityRows);
  const after = afterRows.map((row) => `${row.id}:${row.sender_inbox_id}:${row.schedule_date}`).join('|');
  return before === after ? 0 : afterRows.length;
}

export async function executeImmediateResend(input: {
  itemId: string;
  campaignId: string;
  fromName: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  bodyText: string;
  title?: string | null;
  companyName?: string | null;
  senderProfileId?: string | null;
  headshotStoragePath?: string | null;
  senderInboxId?: string | null;
  identitySlug?: SenderIdentitySlug | null;
  inReplyToMessageId?: string | null;
  recipientName?: string | null;
}): Promise<{
  status: 'sent' | 'failed';
  providerMessageId?: string;
  providerThreadId?: string;
  error?: string;
  transient?: boolean;
  providerUnavailable?: boolean;
}> {
  const { isTransientSendError } = await import('@/lib/drafting/provider-admission');
  const toEmail = resolveSendToEmail(input.campaignId, input.toEmail);
  try {
    const result = await sendOutreachEmail({
      fromName: input.fromName,
      fromEmail: input.fromEmail,
      toEmail,
      subject: input.subject,
      bodyText: input.bodyText,
      itemId: input.itemId,
      campaignId: input.campaignId,
      title: input.title,
      companyName: input.companyName,
      senderProfileId: input.senderProfileId,
      headshotStoragePath: input.headshotStoragePath,
      identitySlug: input.identitySlug,
      inReplyToMessageId: input.inReplyToMessageId,
      firstName: extractFirstName(input.recipientName),
    });

    await recordEmailSend({
      itemId: input.itemId,
      status: 'sent',
      fromEmail: input.fromEmail,
      toEmail,
      subject: input.subject,
      provider: result.provider,
      providerMessageId: result.providerMessageId,
      providerThreadId: result.providerThreadId,
      senderInboxId: input.senderInboxId,
    });
    return {
      status: 'sent',
      providerMessageId: result.providerMessageId,
      providerThreadId: result.providerThreadId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isAgentMailAccountSendingPausedError(message)) {
      return { status: 'failed', error: message, providerUnavailable: true };
    }
    if (isTransientSendError(message)) {
      return { status: 'failed', error: message, transient: true };
    }
    await recordEmailSend({
      itemId: input.itemId,
      status: 'failed',
      fromEmail: input.fromEmail,
      toEmail,
      subject: input.subject,
      senderInboxId: input.senderInboxId,
      errorMessage: message,
    });
    return { status: 'failed', error: message };
  }
}

async function loadOwnedQueueRows(
  _ownerId: string,
  ids: string[],
): Promise<EmailSendQueueRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await dbQuery<EmailSendQueueRow>(
    `SELECT ${QUEUE_ROW_SELECT}
       FROM outreach.email_send_queue
      WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return rows;
}

export async function listSendQueue(input: {
  ownerId?: string;
  from: string;
  to: string;
  campaignId?: string | null;
  identitySlug?: SenderIdentitySlug | null;
  inboxEmail?: string | null;
}): Promise<{
  days: QueueDayBucket[];
  today: string;
  from: string;
  to: string;
  today_remaining: number;
  daily_inbox_cap: number;
  identities: Array<{ slug: SenderIdentitySlug; display_name: string }>;
  inboxes: Array<{
    id: string;
    email: string;
    identity_slug: SenderIdentitySlug;
    is_primary: boolean;
    today_used: number;
    today_remaining: number;
  }>;
}> {
  await backfillQueueIdentities();
  const today = formatNyDate();
  const cap = await getDailyInboxCap();
  const allInboxes = await listSenderInboxes({
    identitySlug: input.identitySlug ?? undefined,
  });
  const usage = await inboxUsageFromDate(input.from);
  const params: unknown[] = [input.from, input.to, SEND_QUEUE_TIMEZONE];
  const clauses = [
    `(
      (
        q.status IN ('queued', 'sending', 'failed')
        AND q.schedule_date >= $1::date
        AND q.schedule_date <= $2::date
      )
      OR (
        q.status = 'sent'
        AND coalesce((timezone($3, es.sent_at))::date, q.schedule_date) >= $1::date
        AND coalesce((timezone($3, es.sent_at))::date, q.schedule_date) <= $2::date
      )
    )`,
  ];
  if (input.campaignId) {
    params.push(input.campaignId);
    clauses.push(`q.campaign_id = $${params.length}::uuid`);
  }
  if (input.identitySlug) {
    params.push(input.identitySlug);
    clauses.push(`si.slug = $${params.length}`);
  }
  if (input.inboxEmail) {
    params.push(input.inboxEmail.toLowerCase());
    clauses.push(`lower(coalesce(q.from_email, ib.email)) = $${params.length}`);
  }

  const { rows } = await dbQuery<QueueListItem>(
    `SELECT q.id, q.owner_id, q.drafting_item_id, q.campaign_id,
            q.scheduled_for::text, q.schedule_date::text, q.status,
            q.to_email, q.subject, q.recipient_name, q.orchestration_job_id,
            q.error_message, q.sender_identity_id::text, q.sender_inbox_id::text,
            q.from_email, q.created_at::text, q.updated_at::text,
            c.name AS campaign_name,
            (q.status = 'queued' AND q.scheduled_for < now()) AS overdue,
            si.slug AS identity_slug,
            lower(coalesce(q.from_email, ib.email)) AS inbox_email,
            (timezone($3, es.sent_at))::date::text AS sent_date
       FROM outreach.email_send_queue q
       JOIN outreach.campaigns c ON c.id = q.campaign_id
       LEFT JOIN outreach.sender_identities si ON si.id = q.sender_identity_id
       LEFT JOIN outreach.sender_inboxes ib ON ib.id = q.sender_inbox_id
       LEFT JOIN LATERAL (
         SELECT sent_at
           FROM outreach.email_sends es
          WHERE es.drafting_item_id = q.drafting_item_id
            AND es.status = 'sent'
            AND es.sent_at IS NOT NULL
          ORDER BY es.sent_at DESC
          LIMIT 1
       ) es ON true
      WHERE ${clauses.join(' AND ')}
      ORDER BY q.schedule_date ASC, q.scheduled_for ASC`,
    params,
  );

  const byDate = new Map<string, QueueListItem[]>();
  for (const row of rows) {
    const boardDate = row.status === 'sent'
      ? (row.sent_date ?? row.schedule_date)
      : row.schedule_date;
    const list = byDate.get(boardDate) ?? [];
    list.push(row);
    byDate.set(boardDate, list);
  }

  const days: QueueDayBucket[] = [];
  let cursor = input.from;
  while (cursor <= input.to) {
    const items = byDate.get(cursor) ?? [];
    const inboxStats: QueueInboxDayStat[] = allInboxes.map((inbox) => {
      const used = usage.get(inboxUsageKey(inbox.id, cursor)) ?? 0;
      const queuedCount = items.filter((item) => (
        item.sender_inbox_id === inbox.id
        && (item.status === 'queued' || item.status === 'sending')
      )).length;
      return {
        inbox_id: inbox.id,
        email: inbox.email,
        identity_slug: inbox.identity_slug,
        used,
        capacity: cap,
        remaining: remainingCapacity(used, cap),
        sent_count: Math.max(0, used - queuedCount),
        queued_count: queuedCount,
        over_cap: used > cap,
      };
    });
    const used = inboxStats.reduce((sum, row) => sum + row.used, 0);
    const capacity = cap * Math.max(1, allInboxes.length);
    const queuedCount = items.filter((i) => i.status === 'queued' || i.status === 'sending').length;
    days.push({
      schedule_date: cursor,
      used,
      capacity,
      remaining: remainingCapacity(used, capacity),
      sent_count: inboxStats.reduce((sum, row) => sum + row.sent_count, 0),
      queued_count: queuedCount,
      over_cap: inboxStats.some((row) => row.over_cap),
      items,
      inboxes: inboxStats,
    });
    cursor = addCalendarDays(cursor, 1);
  }

  const identities = [...new Map(allInboxes.map((inbox) => [inbox.identity_slug, inbox.identity_slug])).keys()]
    .map((slug) => ({
      slug,
      display_name: slug === 'lucas' ? 'Lucas Figueroa' : 'Thomas Pozo',
    }));

  return {
    days,
    today,
    from: input.from,
    to: input.to,
    today_remaining: await todayRemaining(undefined, new Date(), input.identitySlug),
    daily_inbox_cap: cap,
    identities,
    inboxes: allInboxes.map((inbox) => ({
      id: inbox.id,
      email: inbox.email,
      identity_slug: inbox.identity_slug,
      is_primary: inbox.is_primary,
      today_used: usage.get(inboxUsageKey(inbox.id, today)) ?? 0,
      today_remaining: remainingCapacity(usage.get(inboxUsageKey(inbox.id, today)) ?? 0, cap),
    })),
  };
}

export async function backfillQueueIdentities(): Promise<number> {
  const { rows } = await dbQuery<{ id: string; drafting_item_id: string }>(
    `SELECT id::text, drafting_item_id::text
       FROM outreach.email_send_queue
      WHERE status IN ('queued', 'sending', 'failed')
        AND (sender_inbox_id IS NULL OR from_email IS NULL)
      ORDER BY created_at ASC
      LIMIT 200`,
  );
  if (rows.length === 0) return 0;
  const startNy = allocationStartNy();
  const cap = await getDailyInboxCap();
  const usage = await inboxUsageFromDate(startNy);
  let updated = 0;
  for (const row of rows) {
    const identity = await resolveItemIdentity(row.drafting_item_id);
    const [slot] = allocateInboxSlots({
      count: 1,
      inboxes: identity.inboxes.map((inbox) => ({ id: inbox.id, email: inbox.email })),
      usage,
      startNy,
      cap,
    });
    if (!slot) continue;
    usage.set(
      inboxUsageKey(slot.inboxId, slot.scheduleDate),
      (usage.get(inboxUsageKey(slot.inboxId, slot.scheduleDate)) ?? 0) + 1,
    );
    await dbQuery(
      `UPDATE outreach.email_send_queue
          SET sender_identity_id = $2,
              sender_inbox_id = $3,
              from_email = $4,
              schedule_date = CASE WHEN sender_inbox_id IS NULL THEN $5::date ELSE schedule_date END,
              scheduled_for = CASE WHEN sender_inbox_id IS NULL THEN $6::timestamptz ELSE scheduled_for END,
              updated_at = now()
        WHERE id = $1`,
      [row.id, identity.identityId, slot.inboxId, slot.email, slot.scheduleDate, slot.scheduledFor.toISOString()],
    );
    updated += 1;
  }
  return updated;
}

export async function getSendQueueDetail(
  ownerId: string,
  queueId: string,
): Promise<{
  item: QueueListItem;
  body_text: string | null;
  campaign_href: string;
}> {
  const { rows } = await dbQuery<QueueListItem & { body_text: string | null }>(
    `SELECT q.id, q.owner_id, q.drafting_item_id, q.campaign_id,
            q.scheduled_for::text, q.schedule_date::text, q.status,
            q.to_email, q.subject, q.recipient_name, q.orchestration_job_id,
            q.error_message, q.sender_identity_id::text, q.sender_inbox_id::text,
            q.from_email, q.created_at::text, q.updated_at::text,
            c.name AS campaign_name,
            (q.status = 'queued' AND q.scheduled_for < now()) AS overdue,
            si.slug AS identity_slug,
            lower(coalesce(q.from_email, ib.email)) AS inbox_email,
            d.body_text
       FROM outreach.email_send_queue q
       JOIN outreach.campaigns c ON c.id = q.campaign_id
       LEFT JOIN outreach.sender_identities si ON si.id = q.sender_identity_id
       LEFT JOIN outreach.sender_inboxes ib ON ib.id = q.sender_inbox_id
       LEFT JOIN LATERAL (
         SELECT body_text
           FROM outreach.email_drafts ed
          WHERE ed.drafting_item_id = q.drafting_item_id
          ORDER BY ed.content_revision DESC
          LIMIT 1
       ) d ON true
      WHERE q.id = $1`,
    [queueId],
  );
  const row = rows[0];
  if (!row) throw new DraftingNotFoundError('Queue item not found');
  const { body_text, ...item } = row;
  return {
    item,
    body_text,
    campaign_href: `/campaigns/${item.campaign_id}/draft?item=${item.drafting_item_id}`,
  };
}

const SHARE_OCCUPANCY_DAYS = 5;

export type ShareTargetUser = {
  id: string;
  email: string;
  display_name: string;
  backlog_count: number;
  day_occupancy: boolean[];
};

export type ShareTargetIdentity = {
  slug: SenderIdentitySlug;
  display_name: string;
  backlog_count: number;
  day_occupancy: boolean[];
};

async function loadMovableBacklog(identitySlug?: SenderIdentitySlug | null): Promise<EmailSendQueueRow[]> {
  const params: unknown[] = [];
  let identityClause = '';
  if (identitySlug) {
    params.push(identitySlug);
    identityClause = `AND EXISTS (
      SELECT 1 FROM outreach.sender_identities si
       WHERE si.id = q.sender_identity_id AND si.slug = $1
    )`;
  }
  const { rows } = await dbQuery<EmailSendQueueRow>(
    `SELECT ${QUEUE_ROW_SELECT}
       FROM outreach.email_send_queue q
      WHERE q.status IN ('queued', 'failed')
        ${identityClause}
      ORDER BY q.schedule_date DESC, q.scheduled_for DESC, q.created_at DESC`,
    params,
  );
  return rows;
}

async function applyQueueItemSchedule(input: {
  row: EmailSendQueueRow;
  ownerId: string;
  scheduleDate: string;
  scheduledFor: Date;
}): Promise<void> {
  const now = new Date();
  const scheduledFor = input.scheduledFor.getTime() < now.getTime()
    ? now
    : input.scheduledFor;

  await dbQuery(
    `UPDATE outreach.email_send_queue
        SET owner_id = $2,
            schedule_date = $3::date,
            scheduled_for = $4::timestamptz,
            status = 'queued',
            error_message = NULL,
            updated_at = now()
      WHERE id = $1`,
    [input.row.id, input.ownerId, input.scheduleDate, scheduledFor.toISOString()],
  );

  if (input.row.orchestration_job_id) {
    const updated = await reschedulePendingWork(input.row.orchestration_job_id, scheduledFor);
    if (updated) return;
  }

  const jobId = await enqueueWork({
    kind: 'email.send',
    payload: { queueId: input.row.id },
    dedupeKey: `email-send:${input.row.id}`,
    scopeKey: `email-send:${input.row.id}`,
    availableAt: scheduledFor,
    reviveTerminal: true,
  });
  await dbQuery(
    `UPDATE outreach.email_send_queue
        SET orchestration_job_id = $2, updated_at = now()
      WHERE id = $1`,
    [input.row.id, jobId],
  );
}

/** Repack movable backlog onto the earliest open inbox/day slots. */
export async function packOwnerSendQueue(
  ownerId: string,
  identitySlug?: SenderIdentitySlug | null,
): Promise<number> {
  const startNy = allocationStartNy();
  const movable = await loadMovableBacklog(identitySlug);
  if (movable.length === 0) return 0;

  const cap = await getDailyInboxCap();
  const usage = await inboxUsageFromDate(startNy);
  for (const row of movable) {
    if (row.status !== 'queued' || !row.sender_inbox_id) continue;
    const key = inboxUsageKey(row.sender_inbox_id, row.schedule_date);
    usage.set(key, Math.max(0, (usage.get(key) ?? 0) - 1));
  }

  const grouped = new Map<SenderIdentitySlug, EmailSendQueueRow[]>();
  for (const row of [...movable].reverse()) {
    const identity = await resolveItemIdentity(row.drafting_item_id);
    const list = grouped.get(identity.slug) ?? [];
    list.push(row);
    grouped.set(identity.slug, list);
  }

  let packed = 0;
  for (const [slug, group] of grouped) {
    const identity = await getSenderIdentityBySlug(slug);
    if (!identity) continue;
    const inboxes = await listSenderInboxes({ identitySlug: slug });
    const slots = allocateInboxSlots({
      count: group.length,
      inboxes: inboxes.map((inbox) => ({ id: inbox.id, email: inbox.email })),
      usage,
      startNy,
      cap,
    });
    for (let i = 0; i < group.length; i += 1) {
      const row = group[i]!;
      const slot = slots[i]!;
      usage.set(
        inboxUsageKey(slot.inboxId, slot.scheduleDate),
        (usage.get(inboxUsageKey(slot.inboxId, slot.scheduleDate)) ?? 0) + 1,
      );
      await dbQuery(
        `UPDATE outreach.email_send_queue
            SET sender_identity_id = $2,
                sender_inbox_id = $3,
                from_email = $4,
                updated_at = now()
          WHERE id = $1`,
        [row.id, identity.id, slot.inboxId, slot.email],
      );
      await applyQueueItemSchedule({
        row,
        ownerId: row.owner_id || ownerId,
        scheduleDate: slot.scheduleDate,
        scheduledFor: slot.scheduledFor,
      });
      packed += 1;
    }
  }
  return packed;
}

export async function listSendQueueShareTargets(
  fromSlug: SenderIdentitySlug,
): Promise<ShareTargetIdentity[]> {
  const today = formatNyDate();
  const other: SenderIdentitySlug = fromSlug === 'lucas' ? 'tommy' : 'lucas';
  const identity = await getSenderIdentityBySlug(other);
  if (!identity) return [];
  const movable = await loadMovableBacklog(other);
  const occupied = new Set(movable.map((row) => row.schedule_date));
  return [{
    slug: other,
    display_name: identity.display_name,
    backlog_count: movable.length,
    day_occupancy: Array.from({ length: SHARE_OCCUPANCY_DAYS }, (_, i) => (
      occupied.has(addCalendarDays(today, i))
    )),
  }];
}

/**
 * Re-allocate selected (or furthest) backlog items onto the other sender identity.
 */
export async function shareSendQueueWithUser(input: {
  sharerId: string;
  targetUserId?: string;
  fromIdentity?: SenderIdentitySlug;
  targetIdentity?: SenderIdentitySlug;
  ids?: string[];
}): Promise<{
  transferred: number;
  sharer_backlog: number;
  recipient_backlog: number;
  packed_sharer: number;
  packed_recipient: number;
}> {
  const fromSlug = input.fromIdentity ?? 'lucas';
  const targetSlug = input.targetIdentity ?? (fromSlug === 'lucas' ? 'tommy' : 'lucas');
  if (fromSlug === targetSlug) {
    throw new DraftingValidationError('Choose the other sender profile');
  }
  const target = await getSenderIdentityBySlug(targetSlug);
  if (!target) throw new DraftingNotFoundError('Target sender profile not found');

  const sharerMovable = input.ids?.length
    ? await loadOwnedQueueRows(input.sharerId, input.ids)
    : await loadMovableBacklog(fromSlug);
  if (sharerMovable.length === 0) {
    throw new DraftingConflictError('No queue items could be transferred', 'share_empty');
  }

  const transferIds = sharerMovable.map((row) => row.id);
  const { rowCount: transferredRows } = await dbQuery(
    `UPDATE outreach.email_send_queue
        SET sender_identity_id = $2, updated_at = now()
      WHERE id = ANY($1::uuid[])
        AND status IN ('queued', 'failed')`,
    [transferIds, target.id],
  );
  const transferred = transferredRows ?? 0;
  if (transferred === 0) {
    throw new DraftingConflictError('No queue items could be transferred', 'share_empty');
  }

  const packed_recipient = await packOwnerSendQueue(input.sharerId, targetSlug);
  const packed_sharer = await packOwnerSendQueue(input.sharerId, fromSlug);

  return {
    transferred,
    sharer_backlog: (await loadMovableBacklog(fromSlug)).length,
    recipient_backlog: (await loadMovableBacklog(targetSlug)).length,
    packed_sharer,
    packed_recipient,
  };
}

export async function moveSendQueueItems(input: {
  ownerId: string;
  ids: string[];
  targetDate: string;
}): Promise<{ moved: number; schedule_date: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.targetDate)) {
    throw new DraftingValidationError('target_date must be YYYY-MM-DD');
  }
  if (input.ids.length === 0) {
    throw new DraftingValidationError('ids are required');
  }

  const rows = await loadOwnedQueueRows(input.ownerId, input.ids);
  if (rows.length !== input.ids.length) {
    throw new DraftingNotFoundError('One or more queue items were not found');
  }
  if (rows.some((r) => r.status === 'sending')) {
    throw new DraftingConflictError('Cannot move items that are currently sending', 'sending');
  }
  if (rows.some((r) => r.status !== 'queued' && r.status !== 'failed')) {
    throw new DraftingConflictError('Only queued or failed items can be moved', 'invalid_status');
  }

  const cap = await getDailyInboxCap();
  const usage = await inboxUsageFromDate(input.targetDate);
  const movingOntoTarget = rows.filter((r) => r.schedule_date !== input.targetDate);
  const addedByInbox = new Map<string, number>();
  for (const row of movingOntoTarget) {
    if (!row.sender_inbox_id) {
      throw new DraftingConflictError('Queue item is missing an outreach inbox', 'missing_inbox');
    }
    addedByInbox.set(row.sender_inbox_id, (addedByInbox.get(row.sender_inbox_id) ?? 0) + 1);
  }
  for (const [inboxId, added] of addedByInbox) {
    const currentUsed = usage.get(inboxUsageKey(inboxId, input.targetDate)) ?? 0;
    if (currentUsed + added > cap) {
      const need = currentUsed + added - cap;
      throw new DraftingConflictError(
        `Not enough capacity on ${formatNyDateLabel(input.targetDate)} for that inbox — need ${need} more slot${need === 1 ? '' : 's'}`,
        'capacity_exceeded',
      );
    }
  }

  const occupiedTimes: Date[] = [];
  for (const row of rows) {
    let scheduledFor = randomNySendTime(input.targetDate);
    let attempts = 0;
    while (
      occupiedTimes.some((t) => Math.abs(t.getTime() - scheduledFor.getTime()) < 120_000)
      && attempts < 30
    ) {
      scheduledFor = randomNySendTime(input.targetDate);
      attempts += 1;
    }
    occupiedTimes.push(scheduledFor);

    await dbQuery(
      `UPDATE outreach.email_send_queue
          SET schedule_date = $2::date,
              scheduled_for = $3::timestamptz,
              status = 'queued',
              error_message = NULL,
              updated_at = now()
        WHERE id = $1`,
      [row.id, input.targetDate, scheduledFor.toISOString()],
    );

    if (row.orchestration_job_id) {
      const updated = await reschedulePendingWork(row.orchestration_job_id, scheduledFor);
      if (!updated) {
        const jobId = await enqueueWork({
          kind: 'email.send',
          payload: { queueId: row.id },
          dedupeKey: `email-send:${row.id}`,
          scopeKey: `email-send:${row.id}`,
          availableAt: scheduledFor,
          reviveTerminal: true,
        });
        await dbQuery(
          `UPDATE outreach.email_send_queue
              SET orchestration_job_id = $2, updated_at = now()
            WHERE id = $1`,
          [row.id, jobId],
        );
      }
    } else {
      const jobId = await enqueueWork({
        kind: 'email.send',
        payload: { queueId: row.id },
        dedupeKey: `email-send:${row.id}`,
        scopeKey: `email-send:${row.id}`,
        availableAt: scheduledFor,
        reviveTerminal: true,
      });
      await dbQuery(
        `UPDATE outreach.email_send_queue
            SET orchestration_job_id = $2, updated_at = now()
          WHERE id = $1`,
        [row.id, jobId],
      );
    }
  }

  return { moved: rows.length, schedule_date: input.targetDate };
}

export async function cancelSendQueueItems(input: {
  ownerId: string;
  ids: string[];
}): Promise<{ cancelled: number }> {
  if (input.ids.length === 0) {
    throw new DraftingValidationError('ids are required');
  }
  const rows = await loadOwnedQueueRows(input.ownerId, input.ids);
  if (rows.length !== input.ids.length) {
    throw new DraftingNotFoundError('One or more queue items were not found');
  }
  if (rows.some((r) => r.status === 'sending')) {
    throw new DraftingConflictError('Cannot cancel items that are currently sending', 'sending');
  }
  if (rows.some((r) => r.status !== 'queued' && r.status !== 'failed')) {
    throw new DraftingConflictError('Only queued or failed items can be cancelled', 'invalid_status');
  }

  const jobIds = rows
    .map((r) => r.orchestration_job_id)
    .filter((id): id is string => Boolean(id));
  if (jobIds.length > 0) await cancelWorkByIds(jobIds);

  await dbQuery(
    `UPDATE outreach.email_send_queue
        SET status = 'cancelled', updated_at = now()
      WHERE id = ANY($1::uuid[])`,
    [input.ids],
  );
  return { cancelled: rows.length };
}

type SendableDraftPayload = {
  itemId: string;
  campaignId: string;
  fromName: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  bodyText: string;
  recipientName: string;
  title: string | null;
  companyName: string | null;
  senderProfileId: string | null;
  headshotStoragePath: string | null;
  senderInboxId: string | null;
  identitySlug: SenderIdentitySlug | null;
};

async function loadLatestSendablePayload(itemId: string): Promise<SendableDraftPayload | null> {
  const { rows } = await dbQuery<{
    item_id: string;
    campaign_id: string;
    to_email: string;
    subject: string;
    body_text: string;
    from_name: string;
    from_email: string;
    recipient_name: string | null;
    title: string | null;
    company_name: string | null;
    sender_profile_id: string | null;
    headshot_storage_path: string | null;
    sender_inbox_id: string | null;
    identity_slug: string | null;
    state: string;
  }>(
    `SELECT i.id AS item_id,
            w.campaign_id,
            coalesce(
              nullif(trim(i.input_overrides ->> 'email'), ''),
              nullif(trim(i.input_snapshot #>> '{lead,email}'), ''),
              ''
            ) AS to_email,
            d.subject,
            d.body_text,
            coalesce(nullif(trim(i.input_snapshot #>> '{sender,displayName}'), ''), '') AS from_name,
            coalesce(
              q.from_email,
              nullif(trim(i.input_snapshot #>> '{sender,workEmail}'), ''),
              ''
            ) AS from_email,
            nullif(trim(i.input_snapshot #>> '{lead,fullName}'), '') AS recipient_name,
            nullif(trim(i.input_snapshot #>> '{sender,title}'), '') AS title,
            nullif(trim(i.input_snapshot #>> '{sender,companyName}'), '') AS company_name,
            nullif(trim(i.input_snapshot #>> '{sender,profileId}'), '') AS sender_profile_id,
            coalesce(
              nullif(trim(i.input_snapshot #>> '{sender,headshotStoragePath}'), ''),
              sp.headshot_storage_path
            ) AS headshot_storage_path,
            q.sender_inbox_id::text AS sender_inbox_id,
            coalesce(si.slug, nullif(trim(i.input_snapshot #>> '{sender,identitySlug}'), '')) AS identity_slug,
            i.state
       FROM outreach.drafting_items i
       JOIN outreach.drafting_workspaces w ON w.id = i.workspace_id
       LEFT JOIN LATERAL (
         SELECT from_email, sender_inbox_id, sender_identity_id
           FROM outreach.email_send_queue eq
          WHERE eq.drafting_item_id = i.id
            AND eq.status IN ('queued', 'sending', 'failed')
          ORDER BY eq.updated_at DESC
          LIMIT 1
       ) q ON true
       LEFT JOIN outreach.sender_identities si ON si.id = q.sender_identity_id
       LEFT JOIN LATERAL (
         SELECT p.headshot_storage_path
           FROM outreach.sender_profiles p
          WHERE (
                  nullif(trim(i.input_snapshot #>> '{sender,profileId}'), '') IS NOT NULL
                  AND p.id::text = trim(i.input_snapshot #>> '{sender,profileId}')
                )
             OR (
                  nullif(trim(i.input_snapshot #>> '{sender,workEmail}'), '') IS NOT NULL
                  AND lower(p.work_email) = lower(trim(i.input_snapshot #>> '{sender,workEmail}'))
                )
          ORDER BY
            CASE
              WHEN nullif(trim(i.input_snapshot #>> '{sender,profileId}'), '') IS NOT NULL
                   AND p.id::text = trim(i.input_snapshot #>> '{sender,profileId}')
              THEN 0 ELSE 1
            END,
            p.is_default DESC,
            p.updated_at DESC
          LIMIT 1
       ) sp ON true
       JOIN LATERAL (
         SELECT subject, body_text
           FROM outreach.email_drafts ed
          WHERE ed.drafting_item_id = i.id
          ORDER BY ed.content_revision DESC
          LIMIT 1
       ) d ON true
      WHERE i.id = $1
        AND i.removed_at IS NULL`,
    [itemId],
  );
  const row = rows[0];
  if (!row) return null;
  if (!row.to_email || !row.subject || !row.body_text) return null;
  const identity = await resolveItemIdentity(row.item_id);
  const fromEmail = row.from_email && !row.from_email.endsWith('@heliosgroup.ai')
    ? row.from_email
    : identity.inboxes[0]!.email;
  return {
    itemId: row.item_id,
    campaignId: row.campaign_id,
    fromName: row.from_name || identity.displayName,
    fromEmail,
    toEmail: resolveSendToEmail(row.campaign_id, row.to_email),
    subject: row.subject,
    bodyText: row.body_text,
    recipientName: row.recipient_name || row.to_email,
    title: row.title || identity.title,
    companyName: row.company_name || identity.companyName,
    senderProfileId: row.sender_profile_id,
    headshotStoragePath: row.headshot_storage_path || identity.headshotStoragePath,
    senderInboxId: row.sender_inbox_id || identity.inboxes.find((inbox) => inbox.email === fromEmail)?.id || identity.inboxes[0]!.id,
    identitySlug: identity.slug,
  };
}

export async function sendNowQueueItems(input: {
  ownerId: string;
  ids: string[];
}): Promise<{
  sent: number;
  failed: number;
  queued: number;
  results: Array<{
    queue_id: string;
    item_id: string;
    status: 'sent' | 'failed' | 'queued';
    error?: string;
    schedule_date?: string;
  }>;
}> {
  if (!isEmailSendConfigured()) {
    throw new DraftingValidationError('AGENT_MAIL_API is not configured');
  }
  if (input.ids.length === 0) {
    throw new DraftingValidationError('ids are required');
  }

  const loadedRows = await loadOwnedQueueRows(input.ownerId, input.ids);
  if (loadedRows.length !== input.ids.length) {
    throw new DraftingNotFoundError('One or more queue items were not found');
  }
  if (loadedRows.some((r) => r.status === 'sending')) {
    throw new DraftingConflictError('Cannot send items that are currently sending', 'sending');
  }
  if (loadedRows.some((r) => r.status !== 'queued' && r.status !== 'failed')) {
    throw new DraftingConflictError('Only queued or failed items can be sent now', 'invalid_status');
  }

  const today = formatNyDate();
  const cap = await getDailyInboxCap();
  const rows = await assignInboxWaterfall(loadedRows);
  const sendRows = rows.filter((row) => row.schedule_date === today);
  const deferredRows = rows.filter((row) => row.schedule_date !== today);

  const usage = await inboxUsageFromDate(today);
  releaseRowsFromUsage(usage, sendRows.filter((row) => row.status === 'queued' || row.status === 'sending'));
  const needed = new Map<string, number>();
  for (const row of sendRows) {
    if (!row.sender_inbox_id) {
      throw new DraftingConflictError('Queue item is missing an outreach inbox', 'missing_inbox');
    }
    needed.set(row.sender_inbox_id, (needed.get(row.sender_inbox_id) ?? 0) + 1);
  }
  for (const [inboxId, count] of needed) {
    const remaining = remainingCapacity(usage.get(inboxUsageKey(inboxId, today)) ?? 0, cap);
    if (remaining < count) {
      throw new DraftingConflictError(
        `Not enough capacity today for that inbox — ${remaining} slot${remaining === 1 ? '' : 's'} remaining, need ${count}`,
        'capacity_exceeded',
      );
    }
  }

  const jobIds = sendRows
    .map((r) => r.orchestration_job_id)
    .filter((id): id is string => Boolean(id));
  if (jobIds.length > 0) await cancelWorkByIds(jobIds);

  const results: Array<{
    queue_id: string;
    item_id: string;
    status: 'sent' | 'failed' | 'queued';
    error?: string;
    schedule_date?: string;
  }> = deferredRows.map((row) => ({
    queue_id: row.id,
    item_id: row.drafting_item_id,
    status: 'queued' as const,
    schedule_date: row.schedule_date,
  }));

  for (const row of sendRows) {
    await dbQuery(
      `UPDATE outreach.email_send_queue
          SET status = 'sending', updated_at = now()
        WHERE id = $1`,
      [row.id],
    );

    const payload = await loadLatestSendablePayload(row.drafting_item_id);
    if (!payload) {
      await dbQuery(
        `UPDATE outreach.email_send_queue
            SET status = 'failed',
                error_message = $2,
                updated_at = now()
          WHERE id = $1`,
        [row.id, 'Draft is no longer sendable'],
      );
      results.push({
        queue_id: row.id,
        item_id: row.drafting_item_id,
        status: 'failed',
        error: 'Draft is no longer sendable',
      });
      continue;
    }

    const sendResult = await executeImmediateResend(payload);
    if (sendResult.status === 'sent') {
      await dbQuery(
        `UPDATE outreach.email_send_queue
            SET status = 'sent',
                subject = $2,
                to_email = $3,
                recipient_name = $4,
                error_message = NULL,
                updated_at = now()
          WHERE id = $1`,
        [row.id, payload.subject, payload.toEmail, payload.recipientName],
      );
      results.push({
        queue_id: row.id,
        item_id: row.drafting_item_id,
        status: 'sent',
      });
    } else if (
      sendResult.providerUnavailable
      || isAgentMailAccountSendingPausedError(sendResult.error ?? '')
    ) {
      const errorMessage = sendResult.error ?? 'Send failed';
      const retryAt = nextAgentMailPauseRetryAt();
      const scheduleDate = await parkQueueForAgentMailPause({
        queueId: row.id,
        errorMessage,
        retryAt,
        enqueue: true,
      });
      results.push({
        queue_id: row.id,
        item_id: row.drafting_item_id,
        status: 'queued',
        error: errorMessage,
        schedule_date: scheduleDate,
      });
    } else {
      await dbQuery(
        `UPDATE outreach.email_send_queue
            SET status = 'failed',
                error_message = $2,
                updated_at = now()
          WHERE id = $1`,
        [row.id, sendResult.error ?? 'Send failed'],
      );
      results.push({
        queue_id: row.id,
        item_id: row.drafting_item_id,
        status: 'failed',
        error: sendResult.error,
      });
    }
  }

  return {
    sent: results.filter((r) => r.status === 'sent').length,
    failed: results.filter((r) => r.status === 'failed').length,
    queued: results.filter((r) => r.status === 'queued').length,
    results,
  };
}

export async function retryFailedQueueItems(input: {
  ownerId: string;
  ids: string[];
}): Promise<{
  sent_now: number;
  requeued: number;
  results: Array<{
    queue_id: string;
    status: 'sent' | 'queued';
    schedule_date?: string;
  }>;
}> {
  if (input.ids.length === 0) {
    throw new DraftingValidationError('ids are required');
  }
  const rows = await loadOwnedQueueRows(input.ownerId, input.ids);
  if (rows.length !== input.ids.length) {
    throw new DraftingNotFoundError('One or more queue items were not found');
  }
  if (rows.some((r) => r.status !== 'failed')) {
    throw new DraftingConflictError('Only failed items can be retried', 'invalid_status');
  }

  const sendNowIds: string[] = [];
  const overflow: EmailSendQueueRow[] = [];
  for (const row of rows) {
    if (row.sender_inbox_id && (await todayRemainingForInbox(row.sender_inbox_id)) > 0) {
      sendNowIds.push(row.id);
    } else {
      overflow.push(row);
    }
  }

  const results: Array<{
    queue_id: string;
    status: 'sent' | 'queued';
    schedule_date?: string;
  }> = [];

  let sentNow = 0;
  let pausedNow = 0;
  if (sendNowIds.length > 0) {
    const nowResult = await sendNowQueueItems({ ownerId: input.ownerId, ids: sendNowIds });
    sentNow = nowResult.sent;
    pausedNow = nowResult.queued;
    for (const r of nowResult.results) {
      if (r.status === 'sent') {
        results.push({ queue_id: r.queue_id, status: 'sent' });
      } else if (r.status === 'queued') {
        results.push({
          queue_id: r.queue_id,
          status: 'queued',
          schedule_date: r.schedule_date,
        });
      }
    }
  }

  const startNy = allocationStartNy();
  const cap = await getDailyInboxCap();
  const usage = await inboxUsageFromDate(startNy);
  const overflowSlots: Array<{ row: EmailSendQueueRow; scheduleDate: string; scheduledFor: Date }> = [];
  for (const row of overflow) {
    const identity = await resolveItemIdentity(row.drafting_item_id);
    const [slot] = allocateInboxSlots({
      count: 1,
      inboxes: identity.inboxes.map((inbox) => ({ id: inbox.id, email: inbox.email })),
      usage,
      startNy,
      cap,
    });
    if (!slot) continue;
    usage.set(
      inboxUsageKey(slot.inboxId, slot.scheduleDate),
      (usage.get(inboxUsageKey(slot.inboxId, slot.scheduleDate)) ?? 0) + 1,
    );
    await dbQuery(
      `UPDATE outreach.email_send_queue
          SET sender_identity_id = $2, sender_inbox_id = $3, from_email = $4, updated_at = now()
        WHERE id = $1`,
      [row.id, identity.identityId, slot.inboxId, slot.email],
    );
    overflowSlots.push({ row, scheduleDate: slot.scheduleDate, scheduledFor: slot.scheduledFor });
  }

  for (const { row, scheduleDate, scheduledFor } of overflowSlots) {
    const slot = { scheduleDate, scheduledFor };
    await dbQuery(
      `UPDATE outreach.email_send_queue
          SET status = 'queued',
              schedule_date = $2::date,
              scheduled_for = $3::timestamptz,
              error_message = NULL,
              updated_at = now()
        WHERE id = $1`,
      [row.id, slot.scheduleDate, slot.scheduledFor.toISOString()],
    );
    const jobId = await enqueueWork({
      kind: 'email.send',
      payload: { queueId: row.id },
      dedupeKey: `email-send:${row.id}`,
      scopeKey: `email-send:${row.id}`,
      availableAt: slot.scheduledFor,
      reviveTerminal: true,
    });
    await dbQuery(
      `UPDATE outreach.email_send_queue
          SET orchestration_job_id = $2, updated_at = now()
        WHERE id = $1`,
      [row.id, jobId],
    );
    results.push({
      queue_id: row.id,
      status: 'queued',
      schedule_date: slot.scheduleDate,
    });
  }

  return {
    sent_now: sentNow,
    requeued: overflow.length + pausedNow,
    results,
  };
}

const STALE_SENDING_RECLAIM_MINUTES = 15;

/** Worker entry: deliver one queued email when its orch job becomes available. */
export async function processQueuedEmailSend(queueId: string): Promise<{
  status: 'sent' | 'failed' | 'skipped' | 'transient' | 'provider_paused';
  error?: string;
  retryDelayMs?: number;
}> {
  const { isTransientSendError } = await import('@/lib/drafting/provider-admission');
  const { jitteredBackoffMs } = await import('@/lib/orchestration/config');

  const claimed = await dbTransaction(async (client) => {
    const locked = await client.query<EmailSendQueueRow>(
      `SELECT ${QUEUE_ROW_SELECT}
         FROM outreach.email_send_queue
        WHERE id = $1
        FOR UPDATE`,
      [queueId],
    );
    const row = locked.rows[0];
    if (!row) return null;
    if (row.status === 'sent' || row.status === 'cancelled') {
      return { skip: true as const, row };
    }
    if (row.status === 'sending') {
      // Allow reclaim of crash-stuck sends; fresh sending stays skipped.
      const stale = await client.query<{ stale: boolean }>(
        `SELECT (updated_at < now() - make_interval(mins => $2)) AS stale
           FROM outreach.email_send_queue
          WHERE id = $1`,
        [queueId, STALE_SENDING_RECLAIM_MINUTES],
      );
      if (!stale.rows[0]?.stale) {
        return { skip: true as const, row };
      }
    }
    if (row.status !== 'queued' && row.status !== 'failed' && row.status !== 'sending') {
      return { skip: true as const, row };
    }
    await client.query(
      `UPDATE outreach.email_send_queue
          SET status = 'sending',
              error_message = CASE
                WHEN status = 'sending' THEN 'reclaimed_stale_sending'
                ELSE error_message
              END,
              updated_at = now()
        WHERE id = $1`,
      [queueId],
    );
    return { skip: false as const, row };
  });

  if (!claimed) return { status: 'skipped', error: 'Queue row not found' };
  if (claimed.skip) return { status: 'skipped' };

  if (!isEmailSendConfigured()) {
    await dbQuery(
      `UPDATE outreach.email_send_queue
          SET status = 'failed',
              error_message = $2,
              updated_at = now()
        WHERE id = $1`,
      [queueId, 'AGENT_MAIL_API is not configured'],
    );
    return { status: 'failed', error: 'AGENT_MAIL_API is not configured' };
  }

  const payload = await loadLatestSendablePayload(claimed.row.drafting_item_id);
  if (!payload) {
    await dbQuery(
      `UPDATE outreach.email_send_queue
          SET status = 'failed',
              error_message = $2,
              updated_at = now()
        WHERE id = $1`,
      [queueId, 'Draft is no longer sendable'],
    );
    return { status: 'failed', error: 'Draft is no longer sendable' };
  }

  const sendResult = await executeImmediateResend(payload);
  if (sendResult.status === 'sent') {
    await dbQuery(
      `UPDATE outreach.email_send_queue
          SET status = 'sent',
              subject = $2,
              to_email = $3,
              recipient_name = $4,
              error_message = NULL,
              updated_at = now()
        WHERE id = $1`,
      [queueId, payload.subject, payload.toEmail, payload.recipientName],
    );
    return { status: 'sent' };
  }

  const errorMessage = sendResult.error ?? 'Send failed';
  if (
    sendResult.providerUnavailable
    || isAgentMailAccountSendingPausedError(errorMessage)
  ) {
    const retryAt = nextAgentMailPauseRetryAt();
    await parkQueueForAgentMailPause({
      queueId,
      errorMessage,
      retryAt,
      enqueue: false,
    });
    await rebalanceOverCapSendQueue().catch(() => 0);
    return {
      status: 'provider_paused',
      error: errorMessage,
      retryDelayMs: AGENTMAIL_ACCOUNT_PAUSE_RETRY_MS,
    };
  }
  if (sendResult.transient || isTransientSendError(errorMessage)) {
    // Put back to queued so orch RetryableWorkError can re-deliver; do not
    // leave status=sending or mark a permanent user-facing failure.
    await dbQuery(
      `UPDATE outreach.email_send_queue
          SET status = 'queued',
              error_message = $2,
              updated_at = now()
        WHERE id = $1`,
      [queueId, errorMessage.slice(0, 1000)],
    );
    return {
      status: 'transient',
      error: errorMessage,
      retryDelayMs: jitteredBackoffMs(1),
    };
  }

  await dbQuery(
    `UPDATE outreach.email_send_queue
        SET status = 'failed',
            error_message = $2,
            updated_at = now()
      WHERE id = $1`,
    [queueId, errorMessage],
  );
  return { status: 'failed', error: sendResult.error };
}

/** Reconcile: revive overdue queued rows + reclaim crash-stuck sending rows. */
export async function reconcileEmailSendQueue(limit = 50): Promise<number> {
  const pageLimit = Math.max(1, Math.min(200, Math.floor(limit)));

  const pausedFailed = await dbQuery<{ id: string; error_message: string; updated_at: string }>(
    `SELECT q.id, q.error_message, q.updated_at::text
       FROM outreach.email_send_queue q
      WHERE q.status = 'failed'
        AND q.error_message ~* 'sending paused for this account|AccountSendingPaused'
      ORDER BY q.updated_at ASC
      LIMIT $1`,
    [pageLimit],
  );
  let revived = 0;
  for (const row of pausedFailed.rows) {
    if (!isAgentMailAccountSendingPausedError(row.error_message)) continue;
    const failedAt = new Date(row.updated_at);
    const retryAt = nextAgentMailPauseRetryAt(failedAt);
    const when = retryAt.getTime() > Date.now() ? retryAt : new Date();
    await parkQueueForAgentMailPause({
      queueId: row.id,
      errorMessage: row.error_message,
      retryAt: when,
      enqueue: true,
    });
    revived += 1;
  }

  // Crash mid-send: free the daily slot and revive orch delivery.
  const staleSending = await dbQuery<{ id: string; scheduled_for: string }>(
    `SELECT q.id, q.scheduled_for::text
       FROM outreach.email_send_queue q
      WHERE q.status = 'sending'
        AND q.updated_at < now() - make_interval(mins => $2)
        AND (
          q.orchestration_job_id IS NULL
          OR NOT EXISTS (
            SELECT 1
              FROM outreach.orchestration_jobs oj
             WHERE oj.id = q.orchestration_job_id
               AND oj.status IN ('pending', 'in_flight')
          )
        )
      ORDER BY q.updated_at ASC
      LIMIT $1`,
    [pageLimit, STALE_SENDING_RECLAIM_MINUTES],
  );
  for (const row of staleSending.rows) {
    await dbQuery(
      `UPDATE outreach.email_send_queue
          SET status = 'queued',
              error_message = coalesce(error_message, 'reclaimed_stale_sending'),
              updated_at = now()
        WHERE id = $1 AND status = 'sending'`,
      [row.id],
    );
  }

  const { rows } = await dbQuery<{ id: string; scheduled_for: string }>(
    `SELECT q.id, q.scheduled_for::text
       FROM outreach.email_send_queue q
      WHERE q.status = 'queued'
        AND (
          q.orchestration_job_id IS NULL
          OR NOT EXISTS (
            SELECT 1
              FROM outreach.orchestration_jobs oj
             WHERE oj.id = q.orchestration_job_id
               AND oj.status IN ('pending', 'in_flight')
          )
        )
      ORDER BY q.scheduled_for ASC
      LIMIT $1`,
    [pageLimit],
  );

  for (const row of rows) {
    const availableAt = new Date(row.scheduled_for);
    const jobId = await enqueueWork({
      kind: 'email.send',
      payload: { queueId: row.id },
      dedupeKey: `email-send:${row.id}`,
      scopeKey: `email-send:${row.id}`,
      availableAt: availableAt < new Date() ? new Date() : availableAt,
      reviveTerminal: true,
    });
    await dbQuery(
      `UPDATE outreach.email_send_queue
          SET orchestration_job_id = $2, updated_at = now()
        WHERE id = $1 AND status = 'queued'`,
      [row.id, jobId],
    );
    revived += 1;
  }
  return revived + await rebalanceOverCapSendQueue();
}

/** Cancel active queue row for a drafting item (draft workspace unqueue). */
export async function cancelQueueForItem(
  ownerId: string,
  itemId: string,
): Promise<{ cancelled: boolean; queue_id?: string }> {
  const active = await loadActiveQueueByItemIds([itemId]);
  const info = active.get(itemId);
  if (!info) return { cancelled: false };
  const { rows } = await dbQuery<{ owner_id: string }>(
    `SELECT owner_id FROM outreach.email_send_queue WHERE id = $1`,
    [info.queue_id],
  );
  await cancelSendQueueItems({ ownerId, ids: [info.queue_id] });
  return { cancelled: true, queue_id: info.queue_id };
}

export async function sendNowForItem(
  ownerId: string,
  itemId: string,
): Promise<{ sent: boolean; queue_id?: string }> {
  const active = await loadActiveQueueByItemIds([itemId]);
  const info = active.get(itemId);
  if (!info) throw new DraftingNotFoundError('Item is not queued');
  const result = await sendNowQueueItems({ ownerId, ids: [info.queue_id] });
  return {
    sent: result.sent > 0,
    queue_id: info.queue_id,
  };
}
