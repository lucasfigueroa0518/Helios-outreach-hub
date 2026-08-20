/**
 * Worker-side: claim reply_sends → draft with disposition → send / defer / suppress.
 */

import { dbQuery } from '@/lib/db';
import { enqueueWork } from '@/lib/orchestration/repository';
import {
  AGENTMAIL_ACCOUNT_PAUSE_RETRY_MS,
  isAgentMailAccountSendingPausedError,
  nextAgentMailPauseRetryAt,
} from '@/lib/drafting/agentmail-send-errors';
import { extractFirstName, normalizeDraftBody } from '@/lib/drafting/normalize';
import {
  deferUntilToScheduledFor,
  resolveDeferUntil,
} from '@/lib/drafting/reply-defer';
import { lintReplyBody } from '@/lib/drafting/reply-lint';
import { runReplyWrite } from '@/lib/drafting/reply-provider';
import {
  cancelScheduledFollowups,
  countImmediateSentReplies,
  loadReplyThread,
} from '@/lib/drafting/reply-thread';
import { sendOutreachEmail } from '@/lib/drafting/send';

type ReplySendRow = {
  id: string;
  owner_id: string;
  campaign_id: string;
  inbound_email_id: string | null;
  drafting_item_id: string;
  email_send_id: string;
  status: string;
  scheduled_for: string;
  kind: string;
  defer_reason: string | null;
  followup_of_reply_id: string | null;
};

function replySubject(originalSubject: string): string {
  const cleaned = originalSubject.replace(/\r?\n/g, ' ').trim();
  if (!cleaned) return 'Re: quick chat';
  return /^re:/i.test(cleaned) ? cleaned : `Re: ${cleaned}`;
}

async function claimReplySend(
  replySendId: string,
  allowedStatuses: string[],
): Promise<ReplySendRow | null> {
  const { rows } = await dbQuery<ReplySendRow>(
    `UPDATE outreach.reply_sends
        SET status = 'drafting',
            updated_at = now()
      WHERE id = $1::uuid
        AND status = ANY($2::text[])
        AND scheduled_for <= now()
      RETURNING id, owner_id::text, campaign_id::text, inbound_email_id::text,
                drafting_item_id::text, email_send_id::text, status,
                scheduled_for::text, kind, defer_reason, followup_of_reply_id::text`,
    [replySendId, allowedStatuses],
  );
  return rows[0] ?? null;
}

async function markFailed(replySendId: string, message: string): Promise<void> {
  await dbQuery(
    `UPDATE outreach.reply_sends
        SET status = 'failed',
            error_message = $2,
            updated_at = now()
      WHERE id = $1`,
    [replySendId, message.slice(0, 4_000)],
  );
}

async function parkReplyForAgentMailPause(
  replySendId: string,
  message: string,
  resumeStatus: 'queued' | 'scheduled',
): Promise<void> {
  const retryAt = nextAgentMailPauseRetryAt();
  await dbQuery(
    `UPDATE outreach.reply_sends
        SET status = $2,
            scheduled_for = $3::timestamptz,
            error_message = $4,
            updated_at = now()
      WHERE id = $1`,
    [replySendId, resumeStatus, retryAt.toISOString(), message.slice(0, 4_000)],
  );
}

async function loadSenderContext(replySendId: string): Promise<{
  from_email: string;
  to_email: string;
  outbound_subject: string;
  provider_rfc_message_id: string | null;
  inbound_subject: string | null;
  inbound_text: string | null;
  inbound_html: string | null;
  from_name: string;
  sender_title: string | null;
  sender_company: string | null;
  sender_profile_id: string | null;
  headshot_storage_path: string | null;
  lead_name: string | null;
  lead_company: string | null;
} | null> {
  const { rows } = await dbQuery<{
    from_email: string;
    to_email: string;
    outbound_subject: string;
    provider_rfc_message_id: string | null;
    inbound_subject: string | null;
    inbound_text: string | null;
    inbound_html: string | null;
    from_name: string;
    sender_title: string | null;
    sender_company: string | null;
    sender_profile_id: string | null;
    headshot_storage_path: string | null;
    lead_name: string | null;
    lead_company: string | null;
  }>(
    `SELECT s.from_email,
            s.to_email,
            s.subject AS outbound_subject,
            coalesce(s.reply_provider_email_id, s.provider_message_id, s.provider_rfc_message_id) AS provider_rfc_message_id,
            ib.subject AS inbound_subject,
            ib.text_body AS inbound_text,
            ib.html_body AS inbound_html,
            coalesce(nullif(trim(i.input_snapshot #>> '{sender,displayName}'), ''), '') AS from_name,
            nullif(trim(i.input_snapshot #>> '{sender,title}'), '') AS sender_title,
            nullif(trim(i.input_snapshot #>> '{sender,companyName}'), '') AS sender_company,
            nullif(trim(i.input_snapshot #>> '{sender,profileId}'), '') AS sender_profile_id,
            nullif(trim(i.input_snapshot #>> '{sender,headshotStoragePath}'), '') AS headshot_storage_path,
            coalesce(
              nullif(trim(i.input_snapshot #>> '{lead,fullName}'), ''),
              nullif(trim(i.input_snapshot #>> '{lead,firstName}'), '')
            ) AS lead_name,
            nullif(trim(i.input_snapshot #>> '{lead,company}'), '') AS lead_company
       FROM outreach.reply_sends rs
       JOIN outreach.email_sends s ON s.id = rs.email_send_id
       JOIN outreach.drafting_items i ON i.id = rs.drafting_item_id
       LEFT JOIN outreach.inbound_emails ib ON ib.id = rs.inbound_email_id
      WHERE rs.id = $1`,
    [replySendId],
  );
  return rows[0] ?? null;
}

async function sendAndRecord(input: {
  claimed: ReplySendRow;
  ctx: NonNullable<Awaited<ReturnType<typeof loadSenderContext>>>;
  subject: string;
  bodyText: string;
  draft: Awaited<ReturnType<typeof runReplyWrite>>;
  disposition: string;
  includeCalendly: boolean;
  deferUntil?: string | null;
  deferReason?: string | null;
}): Promise<{ providerMessageId: string }> {
  const rfc = input.ctx.provider_rfc_message_id?.replace(/^<|>$/g, '').trim();
  const headers: Record<string, string> = {};
  if (rfc) {
    headers['In-Reply-To'] = `<${rfc}>`;
    headers.References = `<${rfc}>`;
  }

  const sendResult = await sendOutreachEmail({
    fromName: input.ctx.from_name || 'Helios',
    fromEmail: input.ctx.from_email,
    toEmail: input.ctx.to_email,
    subject: input.subject,
    bodyText: input.bodyText,
    itemId: input.claimed.drafting_item_id,
    campaignId: input.claimed.campaign_id,
    title: input.ctx.sender_title,
    companyName: input.ctx.sender_company,
    senderProfileId: input.ctx.sender_profile_id,
    headshotStoragePath: input.ctx.headshot_storage_path,
    headers,
    linkifyReplyBody: true,
    inReplyToMessageId: input.ctx.provider_rfc_message_id,
    firstName: extractFirstName(input.ctx.lead_name),
  });

  const providerRfcMessageId = sendResult.providerMessageId;

  await dbQuery(
    `UPDATE outreach.reply_sends
        SET status = 'sent',
            subject = $2,
            body_text = $3,
            provider_message_id = $4,
            provider_rfc_message_id = $5,
            sent_at = now(),
            disposition = $6,
            include_calendly = $7,
            defer_until = $8::date,
            defer_reason = $9,
            model_id = $10,
            prompt_version = $11,
            skill_version = $12,
            skill_sha256 = $13,
            used_tools = $14::jsonb,
            error_message = NULL,
            updated_at = now()
      WHERE id = $1`,
    [
      input.claimed.id,
      input.subject,
      input.bodyText,
      sendResult.providerMessageId,
      providerRfcMessageId,
      input.disposition,
      input.includeCalendly,
      input.deferUntil ?? null,
      input.deferReason ?? null,
      input.draft.modelId,
      input.draft.promptVersion,
      input.draft.skillVersion,
      input.draft.skillSha256,
      JSON.stringify(input.draft.usedTools),
    ],
  );

  return { providerMessageId: sendResult.providerMessageId };
}

async function queueFollowup(input: {
  parent: ReplySendRow;
  deferUntil: string;
  deferReason: string;
}): Promise<string> {
  const scheduledFor = deferUntilToScheduledFor(input.deferUntil);
  const { rows } = await dbQuery<{ id: string }>(
    `INSERT INTO outreach.reply_sends (
       owner_id, campaign_id, inbound_email_id, drafting_item_id, email_send_id,
       status, kind, disposition, include_calendly, defer_until, defer_reason,
       followup_of_reply_id, scheduled_for
     ) VALUES (
       $1,$2,NULL,$3,$4,
       'scheduled','followup','reply_now', true, $5::date, $6,
       $7, $8::timestamptz
     )
     RETURNING id::text`,
    [
      input.parent.owner_id,
      input.parent.campaign_id,
      input.parent.drafting_item_id,
      input.parent.email_send_id,
      input.deferUntil,
      input.deferReason.slice(0, 500),
      input.parent.id,
      scheduledFor.toISOString(),
    ],
  );
  const followupId = rows[0]!.id;
  const jobId = await enqueueWork({
    kind: 'reply.followup',
    payload: { replySendId: followupId },
    dedupeKey: followupId,
    scopeKey: input.parent.campaign_id,
    availableAt: scheduledFor,
    priority: 30,
  });
  await dbQuery(
    `UPDATE outreach.reply_sends
        SET orchestration_job_id = $2::uuid, updated_at = now()
      WHERE id = $1`,
    [followupId, jobId],
  );
  return followupId;
}

async function processClaimedReply(
  claimed: ReplySendRow,
  mode: 'immediate' | 'followup',
): Promise<{
  status: 'sent' | 'failed' | 'skipped';
  providerMessageId?: string;
  error?: string;
  followupId?: string;
}> {
  const ctx = await loadSenderContext(claimed.id);
  if (!ctx) {
    await markFailed(claimed.id, 'reply_context_missing');
    return { status: 'failed', error: 'reply_context_missing' };
  }

  const thread = await loadReplyThread(claimed.email_send_id);
  const inboundBody = (ctx.inbound_text?.trim()
    || ctx.inbound_html?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    || (mode === 'followup' ? '(deferred follow-up)' : '')).trim();

  // For follow-ups, use the original deferring inbound text if present via parent.
  let leadTextForDefer = inboundBody;
  if (mode === 'followup' && claimed.followup_of_reply_id) {
    const { rows } = await dbQuery<{ text: string | null; reason: string | null }>(
      `SELECT ib.text_body AS text, rs.defer_reason AS reason
         FROM outreach.reply_sends rs
         LEFT JOIN outreach.inbound_emails ib ON ib.id = rs.inbound_email_id
        WHERE rs.id = $1`,
      [claimed.followup_of_reply_id],
    );
    leadTextForDefer = rows[0]?.text || rows[0]?.reason || claimed.defer_reason || inboundBody;
  }

  const draft = await runReplyWrite({
    replySendId: claimed.id,
    senderDisplayName: ctx.from_name || 'Helios',
    senderEmail: ctx.from_email,
    leadName: ctx.lead_name,
    leadCompany: ctx.lead_company,
    leadEmail: ctx.to_email,
    originalSubject: thread.outboundSubject || ctx.outbound_subject,
    originalBody: thread.outboundBody,
    inboundSubject: ctx.inbound_subject,
    inboundBody: mode === 'followup' ? leadTextForDefer : inboundBody,
    thread: thread.messages,
    mode,
    deferReason: claimed.defer_reason,
  });

  await dbQuery(
    `UPDATE outreach.reply_sends
        SET actual_cost_usd = $2::numeric,
            usage = $3::jsonb,
            model_id = coalesce($4, model_id),
            prompt_version = coalesce($5, prompt_version),
            updated_at = now()
      WHERE id = $1`,
    [
      claimed.id,
      draft.usage.costUsd ?? '0.0000',
      JSON.stringify(draft.usage ?? {}),
      draft.modelId ?? null,
      draft.promptVersion ?? null,
    ],
  );

  // Follow-up drafts are forced to reply_now + calendly.
  const disposition = mode === 'followup' ? 'reply_now' : draft.disposition;
  const includeCalendly = mode === 'followup' ? true : draft.includeCalendly;

  const websiteToolUsed = draft.usedTools.includes('refer_helios_website');
  const findings = lintReplyBody(draft.bodyText, {
    websiteToolUsed,
    disposition,
    includeCalendly,
  });
  if (findings.length > 0) {
    const message = findings.map((f) => f.code).join(',');
    await markFailed(claimed.id, `lint:${message}`);
    return { status: 'failed', error: `lint:${message}` };
  }

  const subject = replySubject(thread.outboundSubject || ctx.outbound_subject);
  const bodyText = normalizeDraftBody(draft.bodyText, extractFirstName(ctx.lead_name));

  if (disposition === 'suppress') {
    await cancelScheduledFollowups(claimed.email_send_id, 'suppress');
    await dbQuery(
      `UPDATE outreach.email_sends
          SET reply_suppressed_at = coalesce(reply_suppressed_at, now()),
              reply_suppress_reason = coalesce(reply_suppress_reason, $2),
              updated_at = now()
        WHERE id = $1`,
      [claimed.email_send_id, (draft.notes || draft.bodyText).slice(0, 500)],
    );
    const sent = await sendAndRecord({
      claimed,
      ctx,
      subject,
      bodyText,
      draft,
      disposition,
      includeCalendly: false,
    });
    return { status: 'sent', providerMessageId: sent.providerMessageId };
  }

  if (disposition === 'defer' && mode === 'immediate') {
    await cancelScheduledFollowups(claimed.email_send_id, 'new_defer');
    const resolved = resolveDeferUntil({
      explicitIso: draft.deferUntil,
      leadText: inboundBody,
      deferReason: draft.deferReason,
    });
    const sent = await sendAndRecord({
      claimed,
      ctx,
      subject,
      bodyText,
      draft,
      disposition: 'defer',
      includeCalendly: false,
      deferUntil: resolved.deferUntil,
      deferReason: draft.deferReason || resolved.label,
    });
    const followupId = await queueFollowup({
      parent: claimed,
      deferUntil: resolved.deferUntil,
      deferReason: draft.deferReason || resolved.label,
    });
    return {
      status: 'sent',
      providerMessageId: sent.providerMessageId,
      followupId,
    };
  }

  const sent = await sendAndRecord({
    claimed,
    ctx,
    subject,
    bodyText,
    draft,
    disposition: 'reply_now',
    includeCalendly,
  });
  return { status: 'sent', providerMessageId: sent.providerMessageId };
}

export async function processReplyRespond(replySendId: string): Promise<{
  status: 'sent' | 'failed' | 'skipped' | 'not_ready' | 'provider_paused';
  providerMessageId?: string;
  error?: string;
  followupId?: string;
  retryDelayMs?: number;
}> {
  const claimed = await claimReplySend(replySendId, ['queued']);
  if (!claimed) {
    const { rows } = await dbQuery<{ status: string; scheduled_for: string }>(
      `SELECT status, scheduled_for::text FROM outreach.reply_sends WHERE id = $1`,
      [replySendId],
    );
    const row = rows[0];
    if (!row) return { status: 'skipped', error: 'reply_send_missing' };
    if (row.status === 'sent') return { status: 'sent' };
    if (row.status === 'queued' && new Date(row.scheduled_for).getTime() > Date.now()) {
      return { status: 'not_ready' };
    }
    return { status: 'skipped', error: `status_${row.status}` };
  }

  try {
    return await processClaimedReply(claimed, 'immediate');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isAgentMailAccountSendingPausedError(message)) {
      await parkReplyForAgentMailPause(claimed.id, message, 'queued');
      return {
        status: 'provider_paused',
        error: message,
        retryDelayMs: AGENTMAIL_ACCOUNT_PAUSE_RETRY_MS,
      };
    }
    await markFailed(claimed.id, message);
    return { status: 'failed', error: message };
  }
}

export async function processReplyFollowup(replySendId: string): Promise<{
  status: 'sent' | 'failed' | 'skipped' | 'not_ready' | 'provider_paused';
  providerMessageId?: string;
  error?: string;
  retryDelayMs?: number;
}> {
  const claimed = await claimReplySend(replySendId, ['scheduled']);
  if (!claimed) {
    const { rows } = await dbQuery<{ status: string; scheduled_for: string; kind: string }>(
      `SELECT status, scheduled_for::text, kind FROM outreach.reply_sends WHERE id = $1`,
      [replySendId],
    );
    const row = rows[0];
    if (!row) return { status: 'skipped', error: 'reply_send_missing' };
    if (row.status === 'sent') return { status: 'sent' };
    if (row.status === 'cancelled') return { status: 'skipped', error: 'cancelled' };
    if (row.status === 'scheduled' && new Date(row.scheduled_for).getTime() > Date.now()) {
      return { status: 'not_ready' };
    }
    return { status: 'skipped', error: `status_${row.status}` };
  }

  try {
    // If thread was suppressed or a newer human reply already arrived after schedule, skip.
    const { rows: suppressRows } = await dbQuery<{ suppressed: boolean }>(
      `SELECT (reply_suppressed_at IS NOT NULL) AS suppressed
         FROM outreach.email_sends WHERE id = $1`,
      [claimed.email_send_id],
    );
    if (suppressRows[0]?.suppressed) {
      await dbQuery(
        `UPDATE outreach.reply_sends
            SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'suppressed',
                updated_at = now()
          WHERE id = $1`,
        [claimed.id],
      );
      return { status: 'skipped', error: 'suppressed' };
    }

    if (claimed.followup_of_reply_id) {
      const { rows: newer } = await dbQuery<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM outreach.inbound_emails ib
           JOIN outreach.reply_sends parent ON parent.id = $2
          WHERE ib.email_send_id = $1
            AND ib.received_at > coalesce(
              (SELECT received_at FROM outreach.inbound_emails WHERE id = parent.inbound_email_id),
              parent.created_at
            )`,
        [claimed.email_send_id, claimed.followup_of_reply_id],
      );
      if ((newer[0]?.n ?? 0) > 0) {
        await dbQuery(
          `UPDATE outreach.reply_sends
              SET status = 'cancelled', cancelled_at = now(),
                  cancel_reason = 'superseded_by_newer_inbound', updated_at = now()
            WHERE id = $1`,
          [claimed.id],
        );
        return { status: 'skipped', error: 'superseded_by_newer_inbound' };
      }
    }

    const result = await processClaimedReply(claimed, 'followup');
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isAgentMailAccountSendingPausedError(message)) {
      await parkReplyForAgentMailPause(claimed.id, message, 'scheduled');
      return {
        status: 'provider_paused',
        error: message,
        retryDelayMs: AGENTMAIL_ACCOUNT_PAUSE_RETRY_MS,
      };
    }
    await markFailed(claimed.id, message);
    return { status: 'failed', error: message };
  }
}

export { countImmediateSentReplies };

export async function reconcilePausedReplySends(limit = 50): Promise<number> {
  const pageLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const { rows } = await dbQuery<{
    id: string;
    kind: string;
    campaign_id: string;
    scheduled_for: string;
    error_message: string | null;
  }>(
    `SELECT rs.id::text, rs.kind, rs.campaign_id::text,
            rs.scheduled_for::text, rs.error_message
       FROM outreach.reply_sends rs
      WHERE rs.status IN ('queued', 'scheduled')
        AND rs.error_message ~* 'sending paused for this account|AccountSendingPaused'
        AND (
          rs.orchestration_job_id IS NULL
          OR NOT EXISTS (
            SELECT 1
              FROM outreach.orchestration_jobs oj
             WHERE oj.id = rs.orchestration_job_id
               AND oj.status IN ('pending', 'in_flight')
          )
        )
      ORDER BY rs.scheduled_for ASC
      LIMIT $1`,
    [pageLimit],
  );

  let revived = 0;
  for (const row of rows) {
    if (!isAgentMailAccountSendingPausedError(row.error_message ?? '')) continue;
    const kind = row.kind === 'followup' ? 'reply.followup' : 'reply.respond';
    const availableAt = new Date(row.scheduled_for);
    const jobId = await enqueueWork({
      kind,
      payload: { replySendId: row.id },
      dedupeKey: row.id,
      scopeKey: row.campaign_id,
      availableAt: availableAt < new Date() ? new Date() : availableAt,
      reviveTerminal: true,
    });
    await dbQuery(
      `UPDATE outreach.reply_sends
          SET orchestration_job_id = $2::uuid, updated_at = now()
        WHERE id = $1`,
      [row.id, jobId],
    );
    revived += 1;
  }
  return revived;
}
