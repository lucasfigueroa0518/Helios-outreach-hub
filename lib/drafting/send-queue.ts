/**
 * Daily send queue — budget, enqueue, manage, and worker delivery.
 */
import { dbQuery, dbTransaction } from '@/lib/db';
import { isBillingGuardTripped } from '@/lib/billing-guard';
import {
  DraftingConflictError,
  DraftingNotFoundError,
  DraftingValidationError,
} from '@/lib/drafting/errors';

async function assertBillingGuardAllowsSend(): Promise<void> {
  if (await isBillingGuardTripped()) {
    throw new DraftingConflictError(
      'Cloud worker billing guard is tripped (GCP spend > $0). Sends are fail-closed until cleared.',
      'billing_guard_tripped',
    );
  }
}
import {
  createResendClient,
  isEmailSendConfigured,
  sendOutreachEmail,
} from '@/lib/drafting/send';
import {
  DAILY_SEND_CAP,
  SEND_QUEUE_TIMEZONE,
  allocateOverflowSlots,
  formatNyDate,
  formatNyDateLabel,
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
  created_at: string;
  updated_at: string;
};

export type QueueListItem = EmailSendQueueRow & {
  campaign_name: string;
  overdue: boolean;
};

export type QueueDayBucket = {
  schedule_date: string;
  used: number;
  capacity: number;
  remaining: number;
  sent_count: number;
  queued_count: number;
  items: QueueListItem[];
};

export type ActiveQueueInfo = {
  queue_id: string;
  schedule_date: string;
  status: EmailSendQueueStatus;
  scheduled_for: string;
};

async function recordEmailSend(input: {
  itemId: string;
  status: 'sent' | 'failed';
  fromEmail: string;
  toEmail: string;
  subject: string;
  providerMessageId?: string | null;
  providerRfcMessageId?: string | null;
  errorMessage?: string | null;
}): Promise<void> {
  await dbQuery(
    `INSERT INTO outreach.email_sends (
       drafting_item_id, provider, provider_message_id, provider_rfc_message_id, status,
       from_email, to_email, subject, error_message, sent_at
     ) VALUES ($1, 'resend', $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.itemId,
      input.providerMessageId ?? null,
      input.providerRfcMessageId ?? null,
      input.status,
      input.fromEmail,
      input.toEmail,
      input.subject,
      input.errorMessage ?? null,
      input.status === 'sent' ? new Date().toISOString() : null,
    ],
  );
}

export async function countSentOnNyDate(ownerId: string, scheduleDate: string): Promise<number> {
  const { rows } = await dbQuery<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM outreach.email_sends s
       JOIN outreach.drafting_items i ON i.id = s.drafting_item_id
       JOIN outreach.drafting_workspaces w ON w.id = i.workspace_id
       JOIN outreach.campaigns c ON c.id = w.campaign_id
      WHERE c.owner_id = $1
        AND s.status = 'sent'
        AND s.sent_at IS NOT NULL
        AND (timezone($3, s.sent_at))::date = $2::date`,
    [ownerId, scheduleDate, SEND_QUEUE_TIMEZONE],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function countQueuedOnNyDate(ownerId: string, scheduleDate: string): Promise<number> {
  const { rows } = await dbQuery<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM outreach.email_send_queue
      WHERE owner_id = $1
        AND schedule_date = $2::date
        AND status IN ('queued', 'sending')`,
    [ownerId, scheduleDate],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function dayUsageForOwner(
  ownerId: string,
  fromDate: string,
): Promise<Map<string, number>> {
  const usage = new Map<string, number>();

  const queued = await dbQuery<{ schedule_date: string; count: number }>(
    `SELECT schedule_date::text AS schedule_date, count(*)::int AS count
       FROM outreach.email_send_queue
      WHERE owner_id = $1
        AND schedule_date >= $2::date
        AND status IN ('queued', 'sending')
      GROUP BY schedule_date`,
    [ownerId, fromDate],
  );
  for (const row of queued.rows) {
    usage.set(row.schedule_date, (usage.get(row.schedule_date) ?? 0) + Number(row.count));
  }

  const sent = await dbQuery<{ schedule_date: string; count: number }>(
    `SELECT (timezone($3, s.sent_at))::date::text AS schedule_date, count(*)::int AS count
       FROM outreach.email_sends s
       JOIN outreach.drafting_items i ON i.id = s.drafting_item_id
       JOIN outreach.drafting_workspaces w ON w.id = i.workspace_id
       JOIN outreach.campaigns c ON c.id = w.campaign_id
      WHERE c.owner_id = $1
        AND s.status = 'sent'
        AND s.sent_at IS NOT NULL
        AND (timezone($3, s.sent_at))::date >= $2::date
      GROUP BY 1`,
    [ownerId, fromDate, SEND_QUEUE_TIMEZONE],
  );
  for (const row of sent.rows) {
    usage.set(row.schedule_date, (usage.get(row.schedule_date) ?? 0) + Number(row.count));
  }

  return usage;
}

export async function todayRemaining(ownerId: string, now = new Date()): Promise<number> {
  const today = formatNyDate(now);
  const used = (await countSentOnNyDate(ownerId, today))
    + (await countQueuedOnNyDate(ownerId, today));
  return remainingCapacity(used);
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

export async function ownerQueueStats(ownerId: string): Promise<{
  today_remaining: number;
  queued_count: number;
  next_schedule_date: string | null;
}> {
  const today = formatNyDate();
  const remaining = await todayRemaining(ownerId);
  const { rows } = await dbQuery<{
    queued_count: number;
    next_schedule_date: string | null;
  }>(
    `SELECT count(*)::int AS queued_count,
            min(schedule_date)::text AS next_schedule_date
       FROM outreach.email_send_queue
      WHERE owner_id = $1
        AND status IN ('queued', 'sending')`,
    [ownerId],
  );
  return {
    today_remaining: remaining,
    queued_count: Number(rows[0]?.queued_count ?? 0),
    next_schedule_date: rows[0]?.next_schedule_date && rows[0].next_schedule_date >= today
      ? rows[0].next_schedule_date
      : rows[0]?.next_schedule_date ?? null,
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
}): Promise<EmailSendQueueRow> {
  const { rows } = await dbQuery<EmailSendQueueRow>(
    `INSERT INTO outreach.email_send_queue (
       owner_id, drafting_item_id, campaign_id, scheduled_for, schedule_date,
       status, to_email, subject, recipient_name
     ) VALUES ($1, $2, $3, $4::timestamptz, $5::date, 'queued', $6, $7, $8)
     RETURNING id, owner_id, drafting_item_id, campaign_id,
               scheduled_for::text, schedule_date::text, status,
               to_email, subject, recipient_name, orchestration_job_id,
               error_message, created_at::text, updated_at::text`,
    [
      input.ownerId,
      input.itemId,
      input.campaignId,
      input.scheduledFor.toISOString(),
      input.scheduleDate,
      input.toEmail,
      input.subject,
      input.recipientName,
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
      RETURNING id, owner_id, drafting_item_id, campaign_id,
                scheduled_for::text, schedule_date::text, status,
                to_email, subject, recipient_name, orchestration_job_id,
                error_message, created_at::text, updated_at::text`,
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

export async function enqueueOverflowSend(input: EnqueueSendInput): Promise<EmailSendQueueRow> {
  await assertBillingGuardAllowsSend();
  const existing = await loadActiveQueueByItemIds([input.itemId]);
  const active = existing.get(input.itemId);
  if (active) {
    const { rows } = await dbQuery<EmailSendQueueRow>(
      `SELECT id, owner_id, drafting_item_id, campaign_id,
              scheduled_for::text, schedule_date::text, status,
              to_email, subject, recipient_name, orchestration_job_id,
              error_message, created_at::text, updated_at::text
         FROM outreach.email_send_queue
        WHERE id = $1`,
      [active.queue_id],
    );
    if (rows[0]) return rows[0];
  }

  const today = formatNyDate();
  const usage = await dayUsageForOwner(input.ownerId, today);
  const [slot] = allocateOverflowSlots({
    count: 1,
    dayUsage: usage,
    todayNy: today,
  });
  if (!slot) throw new Error('Failed to allocate overflow slot');

  return insertQueueRow({
    ownerId: input.ownerId,
    itemId: input.itemId,
    campaignId: input.campaignId,
    scheduleDate: slot.scheduleDate,
    scheduledFor: slot.scheduledFor,
    toEmail: input.toEmail,
    subject: input.subject,
    recipientName: input.recipientName,
  });
}

export async function enqueueOverflowBatch(
  ownerId: string,
  items: EnqueueSendInput[],
): Promise<EmailSendQueueRow[]> {
  if (items.length === 0) return [];
  await assertBillingGuardAllowsSend();
  const today = formatNyDate();
  const usage = await dayUsageForOwner(ownerId, today);
  const slots = allocateOverflowSlots({
    count: items.length,
    dayUsage: usage,
    todayNy: today,
  });

  const rows: EmailSendQueueRow[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const slot = slots[i]!;
    const existing = await loadActiveQueueByItemIds([item.itemId]);
    if (existing.has(item.itemId)) {
      const active = existing.get(item.itemId)!;
      const { rows: found } = await dbQuery<EmailSendQueueRow>(
        `SELECT id, owner_id, drafting_item_id, campaign_id,
                scheduled_for::text, schedule_date::text, status,
                to_email, subject, recipient_name, orchestration_job_id,
                error_message, created_at::text, updated_at::text
           FROM outreach.email_send_queue
          WHERE id = $1`,
        [active.queue_id],
      );
      if (found[0]) {
        rows.push(found[0]);
        continue;
      }
    }
    rows.push(await insertQueueRow({
      ownerId,
      itemId: item.itemId,
      campaignId: item.campaignId,
      scheduleDate: slot.scheduleDate,
      scheduledFor: slot.scheduledFor,
      toEmail: item.toEmail,
      subject: item.subject,
      recipientName: item.recipientName,
    }));
  }
  return rows;
}

export async function executeImmediateResend(input: {
  itemId: string;
  campaignId: string;
  fromName: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  bodyText: string;
}): Promise<{ status: 'sent' | 'failed'; providerMessageId?: string; error?: string }> {
  try {
    const result = await sendOutreachEmail({
      fromName: input.fromName,
      fromEmail: input.fromEmail,
      toEmail: input.toEmail,
      subject: input.subject,
      bodyText: input.bodyText,
      itemId: input.itemId,
      campaignId: input.campaignId,
    });

    let providerRfcMessageId: string | null = null;
    try {
      const details = await createResendClient().emails.get(result.providerMessageId);
      providerRfcMessageId = details.data?.message_id?.trim() || null;
    } catch {
      // RFC Message-ID often arrives on the first delivery webhook instead.
    }

    await recordEmailSend({
      itemId: input.itemId,
      status: 'sent',
      fromEmail: input.fromEmail,
      toEmail: input.toEmail,
      subject: input.subject,
      providerMessageId: result.providerMessageId,
      providerRfcMessageId,
    });
    return { status: 'sent', providerMessageId: result.providerMessageId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordEmailSend({
      itemId: input.itemId,
      status: 'failed',
      fromEmail: input.fromEmail,
      toEmail: input.toEmail,
      subject: input.subject,
      errorMessage: message,
    });
    return { status: 'failed', error: message };
  }
}

async function loadOwnedQueueRows(
  ownerId: string,
  ids: string[],
): Promise<EmailSendQueueRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await dbQuery<EmailSendQueueRow>(
    `SELECT id, owner_id, drafting_item_id, campaign_id,
            scheduled_for::text, schedule_date::text, status,
            to_email, subject, recipient_name, orchestration_job_id,
            error_message, created_at::text, updated_at::text
       FROM outreach.email_send_queue
      WHERE owner_id = $1 AND id = ANY($2::uuid[])`,
    [ownerId, ids],
  );
  return rows;
}

export async function listSendQueue(input: {
  ownerId: string;
  from: string;
  to: string;
  campaignId?: string | null;
}): Promise<{ days: QueueDayBucket[]; today: string; today_remaining: number }> {
  const today = formatNyDate();
  const params: unknown[] = [input.ownerId, input.from, input.to];
  let campaignClause = '';
  if (input.campaignId) {
    params.push(input.campaignId);
    campaignClause = ` AND q.campaign_id = $${params.length}::uuid`;
  }

  const { rows } = await dbQuery<QueueListItem>(
    `SELECT q.id, q.owner_id, q.drafting_item_id, q.campaign_id,
            q.scheduled_for::text, q.schedule_date::text, q.status,
            q.to_email, q.subject, q.recipient_name, q.orchestration_job_id,
            q.error_message, q.created_at::text, q.updated_at::text,
            c.name AS campaign_name,
            (q.status = 'queued' AND q.scheduled_for < now()) AS overdue
       FROM outreach.email_send_queue q
       JOIN outreach.campaigns c ON c.id = q.campaign_id
      WHERE q.owner_id = $1
        AND q.schedule_date >= $2::date
        AND q.schedule_date <= $3::date
        AND q.status IN ('queued', 'sending', 'failed')
        ${campaignClause}
      ORDER BY q.schedule_date ASC, q.scheduled_for ASC`,
    params,
  );

  const usage = await dayUsageForOwner(input.ownerId, input.from);
  const byDate = new Map<string, QueueListItem[]>();
  for (const row of rows) {
    const list = byDate.get(row.schedule_date) ?? [];
    list.push(row);
    byDate.set(row.schedule_date, list);
  }

  // Ensure every day in range appears (for calendar empty columns).
  const days: QueueDayBucket[] = [];
  let cursor = input.from;
  while (cursor <= input.to) {
    const items = byDate.get(cursor) ?? [];
    const sentCount = await countSentOnNyDate(input.ownerId, cursor);
    const queuedCount = items.filter((i) => i.status === 'queued' || i.status === 'sending').length;
    const used = usage.get(cursor) ?? (sentCount + queuedCount);
    days.push({
      schedule_date: cursor,
      used,
      capacity: DAILY_SEND_CAP,
      remaining: remainingCapacity(used),
      sent_count: sentCount,
      queued_count: queuedCount,
      items,
    });
    cursor = (() => {
      const [y, m, d] = cursor.split('-').map(Number);
      const next = new Date(Date.UTC(y, m - 1, d + 1));
      return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
    })();
  }

  return {
    days,
    today,
    today_remaining: await todayRemaining(input.ownerId),
  };
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
            q.error_message, q.created_at::text, q.updated_at::text,
            c.name AS campaign_name,
            (q.status = 'queued' AND q.scheduled_for < now()) AS overdue,
            d.body_text
       FROM outreach.email_send_queue q
       JOIN outreach.campaigns c ON c.id = q.campaign_id
       LEFT JOIN LATERAL (
         SELECT body_text
           FROM outreach.email_drafts ed
          WHERE ed.drafting_item_id = q.drafting_item_id
          ORDER BY ed.content_revision DESC
          LIMIT 1
       ) d ON true
      WHERE q.id = $1 AND q.owner_id = $2`,
    [queueId, ownerId],
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

  const today = formatNyDate();
  const usage = await dayUsageForOwner(input.ownerId, today);
  // Exclude rows already on the target date from capacity check; they don't add load.
  const movingOntoTarget = rows.filter((r) => r.schedule_date !== input.targetDate);
  const currentUsed = usage.get(input.targetDate) ?? 0;
  if (currentUsed + movingOntoTarget.length > DAILY_SEND_CAP) {
    const need = currentUsed + movingOntoTarget.length - DAILY_SEND_CAP;
    throw new DraftingConflictError(
      `Not enough capacity on ${formatNyDateLabel(input.targetDate)} — need ${need} more slot${need === 1 ? '' : 's'}`,
      'capacity_exceeded',
    );
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
        WHERE id = $1 AND owner_id = $4`,
      [row.id, input.targetDate, scheduledFor.toISOString(), input.ownerId],
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
      WHERE owner_id = $1 AND id = ANY($2::uuid[])`,
    [input.ownerId, input.ids],
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
    state: string;
  }>(
    `SELECT i.id AS item_id,
            w.campaign_id,
            coalesce(nullif(trim(i.input_snapshot #>> '{lead,email}'), ''), '') AS to_email,
            d.subject,
            d.body_text,
            coalesce(nullif(trim(i.input_snapshot #>> '{sender,displayName}'), ''), '') AS from_name,
            coalesce(nullif(trim(i.input_snapshot #>> '{sender,workEmail}'), ''), '') AS from_email,
            nullif(trim(i.input_snapshot #>> '{lead,fullName}'), '') AS recipient_name,
            i.state
       FROM outreach.drafting_items i
       JOIN outreach.drafting_workspaces w ON w.id = i.workspace_id
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
  if (!row.to_email || !row.from_email || !row.subject || !row.body_text) return null;
  return {
    itemId: row.item_id,
    campaignId: row.campaign_id,
    fromName: row.from_name || 'Helios',
    fromEmail: row.from_email,
    toEmail: row.to_email,
    subject: row.subject,
    bodyText: row.body_text,
    recipientName: row.recipient_name || row.to_email,
  };
}

export async function sendNowQueueItems(input: {
  ownerId: string;
  ids: string[];
}): Promise<{
  sent: number;
  failed: number;
  results: Array<{
    queue_id: string;
    item_id: string;
    status: 'sent' | 'failed';
    error?: string;
  }>;
}> {
  if (!isEmailSendConfigured()) {
    throw new DraftingValidationError('RESEND_API_KEY is not configured');
  }
  if (input.ids.length === 0) {
    throw new DraftingValidationError('ids are required');
  }

  const rows = await loadOwnedQueueRows(input.ownerId, input.ids);
  if (rows.length !== input.ids.length) {
    throw new DraftingNotFoundError('One or more queue items were not found');
  }
  if (rows.some((r) => r.status === 'sending')) {
    throw new DraftingConflictError('Cannot send items that are currently sending', 'sending');
  }
  if (rows.some((r) => r.status !== 'queued' && r.status !== 'failed')) {
    throw new DraftingConflictError('Only queued or failed items can be sent now', 'invalid_status');
  }

  const remaining = await todayRemaining(input.ownerId);
  if (remaining < rows.length) {
    throw new DraftingConflictError(
      `Not enough capacity today — ${remaining} slot${remaining === 1 ? '' : 's'} remaining, need ${rows.length}`,
      'capacity_exceeded',
    );
  }

  const jobIds = rows
    .map((r) => r.orchestration_job_id)
    .filter((id): id is string => Boolean(id));
  if (jobIds.length > 0) await cancelWorkByIds(jobIds);

  const results: Array<{
    queue_id: string;
    item_id: string;
    status: 'sent' | 'failed';
    error?: string;
  }> = [];

  for (const row of rows) {
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

  const remaining = await todayRemaining(input.ownerId);
  const sendNowIds = rows.slice(0, remaining).map((r) => r.id);
  const overflow = rows.slice(remaining);

  const results: Array<{
    queue_id: string;
    status: 'sent' | 'queued';
    schedule_date?: string;
  }> = [];

  let sentNow = 0;
  if (sendNowIds.length > 0) {
    const nowResult = await sendNowQueueItems({ ownerId: input.ownerId, ids: sendNowIds });
    sentNow = nowResult.sent;
    for (const r of nowResult.results) {
      if (r.status === 'sent') {
        results.push({ queue_id: r.queue_id, status: 'sent' });
      } else {
        // leave as failed; not counted as requeued
      }
    }
  }

  const today = formatNyDate();
  const usage = await dayUsageForOwner(input.ownerId, today);
  const slots = allocateOverflowSlots({
    count: overflow.length,
    dayUsage: usage,
    todayNy: today,
  });

  for (let i = 0; i < overflow.length; i += 1) {
    const row = overflow[i]!;
    const slot = slots[i]!;
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
    requeued: overflow.length,
    results,
  };
}

/** Worker entry: deliver one queued email when its orch job becomes available. */
export async function processQueuedEmailSend(queueId: string): Promise<{
  status: 'sent' | 'failed' | 'skipped';
  error?: string;
}> {
  if (await isBillingGuardTripped()) {
    return {
      status: 'skipped',
      error: 'Billing guard fail-closed: cloud worker spend exceeded $0',
    };
  }
  const claimed = await dbTransaction(async (client) => {
    const locked = await client.query<EmailSendQueueRow>(
      `SELECT id, owner_id, drafting_item_id, campaign_id,
              scheduled_for::text, schedule_date::text, status,
              to_email, subject, recipient_name, orchestration_job_id,
              error_message, created_at::text, updated_at::text
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
      return { skip: true as const, row };
    }
    if (row.status !== 'queued' && row.status !== 'failed') {
      return { skip: true as const, row };
    }
    await client.query(
      `UPDATE outreach.email_send_queue
          SET status = 'sending', updated_at = now()
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
      [queueId, 'RESEND_API_KEY is not configured'],
    );
    return { status: 'failed', error: 'RESEND_API_KEY is not configured' };
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

  await dbQuery(
    `UPDATE outreach.email_send_queue
        SET status = 'failed',
            error_message = $2,
            updated_at = now()
      WHERE id = $1`,
    [queueId, sendResult.error ?? 'Send failed'],
  );
  return { status: 'failed', error: sendResult.error };
}

/** Reconcile: revive overdue queued rows missing a live orch job. */
export async function reconcileEmailSendQueue(limit = 50): Promise<number> {
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
    [limit],
  );

  let revived = 0;
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
  return revived;
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
  if (rows[0]?.owner_id !== ownerId) {
    throw new DraftingNotFoundError('Queue item not found');
  }
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
