import {
  agentMailGetMessage,
  agentMailInboxId,
  agentMailListMessages,
  agentMailSendProbe,
  type AgentMailMessageItem,
  type AgentMailSendResult,
} from '@/lib/agentmail';
import { assertVerifyInbox } from '@/lib/agentmail-inboxes';
import { isAgentMailAccountSendingPausedError } from '@/lib/drafting/agentmail-send-errors';
import { dbQuery } from '@/lib/db';
import {
  buildDisambiguation,
  researchJobKey,
  type ResearchPerson,
} from '@/lib/research-types';

export type MailboxVerificationStatus = 'valid' | 'invalid' | 'unknown' | 'rate_limited';

export function isAgentMailRateLimitError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b/.test(message)
    || /rate.?limit/i.test(message)
    || /daily send limit/i.test(message);
}

/** AgentMail permanently blocked/bounced the recipient — treat as invalid, do not retry. */
export function isAgentMailRecipientBlockedError(error: unknown) {
  if (isAgentMailAccountSendingPausedError(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /message_rejected/i.test(message)
    || /recipient\(s\) blocked/i.test(message)
    || /MessageRejectedError/i.test(message);
}

const BOUNCE_FROM_PATTERNS = [
  /mailer-daemon/i,
  /mail delivery/i,
  /postmaster/i,
  /mail delivery subsystem/i,
  /microsoft exchange/i,
  /mailerdaemon/i,
];

const BOUNCE_SUBJECT_PATTERNS = [
  /undeliver/i,
  /delivery status/i,
  /delivery failure/i,
  /returned mail/i,
  /mail delivery failed/i,
  /failure notice/i,
  /could not be delivered/i,
  /delivery has failed/i,
  /address rejected/i,
];

export function mailboxVerifyWaitMs() {
  const parsed = Number(process.env.AGENTMAIL_VERIFY_WAIT_MS ?? 30_000);
  return Number.isFinite(parsed) ? Math.max(5_000, Math.min(120_000, Math.floor(parsed))) : 30_000;
}

export function shouldScheduleMailboxVerification(emailStatus: string | null | undefined) {
  return (
    emailStatus === 'direct'
    || emailStatus === 'inferred'
    || emailStatus === 'format_guess'
    || emailStatus === 'from_embark_db'
  );
}

/** True once any lead on this enrichment run already hit AgentMail rate limits. */
export async function runHasMailboxRateLimit(runId: string): Promise<boolean> {
  const { rows } = await dbQuery<{ hit: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM outreach.campaign_leads cl
         JOIN outreach.leads l ON l.id = cl.lead_id
        WHERE cl.run_id = $1
          AND l.email_verification = 'rate_limited'
     ) AS hit`,
    [runId],
  );
  return Boolean(rows[0]?.hit);
}

/**
 * Stop further AgentMail probes for this run and fail-open remaining leads so
 * drafting can proceed with an unvalidated mailbox signal.
 */
export async function failOpenRemainingMailboxVerificationsForRun(runId: string): Promise<number> {
  await dbQuery(
    `UPDATE outreach.orchestration_jobs
        SET status = 'cancelled',
            lease_owner = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            finished_at = now(),
            updated_at = now()
      WHERE scope_key = $1
        AND kind IN ('mailbox.lead', 'mailbox.run')
        AND status = 'pending'`,
    [runId],
  );

  const { rows } = await dbQuery<{ id: string }>(
    `UPDATE outreach.leads l
        SET email_verification = 'rate_limited',
            email_verified_at = now(),
            updated_at = now()
       FROM outreach.campaign_leads cl
      WHERE cl.lead_id = l.id
        AND cl.run_id = $1
        AND l.email_primary IS NOT NULL
        AND (
          l.email_verification IS NULL
          OR l.email_verification IN ('pending', 'unknown')
        )
      RETURNING l.id`,
    [runId],
  );

  if (rows.length) {
    await incrementEnrichmentStat(runId, 'mailbox_rate_limited', rows.length);
  }

  try {
    const { promoteDraftingItemsForVerifiedLead } = await import('@/lib/drafting/repository');
    for (const row of rows) {
      await promoteDraftingItemsForVerifiedLead(row.id);
    }
  } catch {
    // Enrichment must not fail closed if drafting promote is unavailable.
  }

  return rows.length;
}

export function mailboxCandidateEmails(lead: {
  email_primary: string | null;
  email_alt_1: string | null;
  email_alt_2: string | null;
}) {
  return [lead.email_primary, lead.email_alt_1, lead.email_alt_2]
    .map((email) => email?.trim().toLowerCase() ?? '')
    .filter(Boolean);
}

export type LeadMailboxCandidates = {
  lead_id: string;
  email_status: string;
  email_verification: string | null;
  email_primary: string | null;
  email_alt_1: string | null;
  email_alt_2: string | null;
  provisional: boolean;
  emails: string[];
};

export async function loadLeadMailboxCandidates(leadId: string): Promise<LeadMailboxCandidates | null> {
  const { rows } = await dbQuery<{
    id: string;
    email_status: string;
    email_verification: string | null;
    email_primary: string | null;
    email_alt_1: string | null;
    email_alt_2: string | null;
    provisional: boolean;
  }>(
    `SELECT id, email_status, email_verification,
            email_primary, email_alt_1, email_alt_2,
            coalesce((direct_email_evidence->>'provisional')::boolean, false) AS provisional
     FROM outreach.leads
     WHERE id = $1`,
    [leadId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    lead_id: row.id,
    email_status: row.email_status,
    email_verification: row.email_verification,
    email_primary: row.email_primary,
    email_alt_1: row.email_alt_1,
    email_alt_2: row.email_alt_2,
    provisional: row.provisional,
    emails: mailboxCandidateEmails(row),
  };
}

export function mailboxVerificationTransition(input: {
  verification: MailboxVerificationStatus;
  emailStatus: string;
  provisionalDirect: boolean;
}) {
  if (input.verification === 'invalid' && input.provisionalDirect) {
    return { emailStatus: 'not_found', clearEmail: true, enqueueRescue: true };
  }
  if (input.verification === 'valid' && input.emailStatus === 'format_guess') {
    return { emailStatus: 'inferred', clearEmail: false, enqueueRescue: false };
  }
  return { emailStatus: input.emailStatus, clearEmail: false, enqueueRescue: false };
}

async function incrementEnrichmentStat(runId: string, key: string, amount = 1) {
  await dbQuery(
    `UPDATE outreach.runs
     SET stats = stats || jsonb_build_object(
       'enrichment',
       coalesce(stats->'enrichment', '{}'::jsonb)
         || jsonb_build_object($2::text, coalesce((stats->'enrichment'->>$2)::int, 0) + $3::int)
     )
     WHERE id = $1`,
    [runId, key, amount],
  );
}

function messageHaystack(message: AgentMailMessageItem) {
  return [
    message.subject,
    message.preview,
    message.text,
    message.html,
    ...(message.to ?? []),
  ].filter(Boolean).join(' ').toLowerCase();
}

function normalizeMailboxAddress(value: string) {
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] ?? value).trim().toLowerCase();
}

function isProbeSender(from: string | undefined, inboxId: string) {
  return normalizeMailboxAddress(from ?? '') === inboxId.toLowerCase();
}

export function isBounceForTarget(
  message: AgentMailMessageItem,
  targetEmail: string,
  sent: Pick<AgentMailSendResult, 'message_id'>,
  inboxId: string,
) {
  if (isProbeSender(message.from, inboxId)) return false;

  const haystack = messageHaystack(message);
  const target = targetEmail.toLowerCase();
  const mentionsTarget = haystack.includes(target);
  const referencesSent = message.in_reply_to === sent.message_id
    || (message.references ?? []).includes(sent.message_id);
  const bounceSender = BOUNCE_FROM_PATTERNS.some((pattern) => pattern.test(message.from ?? ''));
  const bounceSubject = BOUNCE_SUBJECT_PATTERNS.some((pattern) => pattern.test(message.subject ?? ''));

  if (referencesSent && (bounceSender || bounceSubject || mentionsTarget)) return true;
  if (bounceSender && mentionsTarget) return true;
  if (bounceSubject && mentionsTarget) return true;
  return false;
}

export async function findBounceForProbe(
  targetEmail: string,
  sent: AgentMailSendResult,
  inboxId: string,
  listMessages: typeof agentMailListMessages = agentMailListMessages,
  getMessage: typeof agentMailGetMessage = agentMailGetMessage,
) {
  const after = new Date(new Date(sent.sent_at).getTime() - 5_000).toISOString();
  const messages = await listMessages({ after, limit: 25 });
  for (const message of messages) {
    if (isBounceForTarget(message, targetEmail, sent, inboxId)) {
      return message;
    }
    if (!message.preview && !message.text && message.message_id) {
      try {
        const full = await getMessage(message.message_id);
        if (isBounceForTarget(full, targetEmail, sent, inboxId)) return full;
      } catch {
        continue;
      }
    }
  }
  return null;
}

export async function markMailboxVerificationRateLimited(leadId: string, runId: string) {
  const result = await dbQuery(
    `UPDATE outreach.leads
     SET email_verification = 'rate_limited',
         email_verified_at = now(),
         updated_at = now()
     WHERE id = $1
       AND (
         email_verification IS NULL
         OR email_verification IN ('pending', 'unknown', 'rate_limited')
       )`,
    [leadId],
  );
  if (result.rowCount) {
    await incrementEnrichmentStat(runId, 'mailbox_rate_limited');
  }

  // Fail-open into drafting: refresh delivery snapshots and queue research.
  try {
    const { promoteDraftingItemsForVerifiedLead } = await import('@/lib/drafting/repository');
    await promoteDraftingItemsForVerifiedLead(leadId);
  } catch {
    // Enrichment must not fail closed if drafting promote is unavailable.
  }

  // Once AgentMail is rate-limited, stop probing the rest of the run and
  // fail-open remaining pending/null verifications so drafting is not blocked.
  await failOpenRemainingMailboxVerificationsForRun(runId);
}

export async function markMailboxVerificationProviderError(
  leadId: string,
  runId: string,
) {
  await markMailboxVerificationUnknown(leadId, runId);
  await incrementEnrichmentStat(runId, 'mailbox_provider_errors');
}

export async function markMailboxVerificationUnknown(leadId: string, runId: string) {
  const result = await dbQuery(
    `UPDATE outreach.leads
     SET email_verification = 'unknown',
         email_verified_at = now(),
         updated_at = now()
     WHERE id = $1
       AND email_verification IN ('pending', 'unknown')`,
    [leadId],
  );
  if (result.rowCount) {
    await incrementEnrichmentStat(runId, 'mailbox_unknown');
  }
}

export async function promoteVerifiedMailboxEmail(
  leadId: string,
  verifiedEmail: string,
  runId: string,
  previousStatus: string,
) {
  const normalizedEmail = verifiedEmail.trim().toLowerCase();
  const result = await dbQuery(
    `UPDATE outreach.leads
     SET email_primary = $2,
         email_alt_1 = NULL,
         email_alt_2 = NULL,
         email_verification = 'valid',
         email_verified_at = now(),
         email_status = CASE
           WHEN email_status = 'format_guess' THEN 'inferred'
           ELSE email_status
         END,
         email_source_note = CASE
           WHEN email_status = 'format_guess'
             THEN regexp_replace(email_source_note, '^Rough guess', 'Mailbox-verified guess', 'i')
           ELSE email_source_note
         END,
         updated_at = now()
     WHERE id = $1
       AND email_verification IN ('pending', 'unknown')`,
    [leadId, normalizedEmail],
  );
  if (!result.rowCount) return false;

  if (previousStatus === 'format_guess') {
    await incrementEnrichmentStat(runId, 'format_guess', -1);
    await incrementEnrichmentStat(runId, 'inferred', 1);
  }
  await incrementEnrichmentStat(runId, 'mailbox_valid');

  // Late AgentMail success must promote any idle drafting items for this lead.
  try {
    const { promoteDraftingItemsForVerifiedLead } = await import('@/lib/drafting/repository');
    await promoteDraftingItemsForVerifiedLead(leadId);
  } catch {
    // Enrichment must not fail closed if drafting promote is unavailable.
  }

  return true;
}

export async function finalizeAllCandidatesInvalid(
  leadId: string,
  runId: string,
  lead: Pick<LeadMailboxCandidates, 'email_status' | 'provisional' | 'email_primary'>,
) {
  const transition = mailboxVerificationTransition({
    verification: 'invalid',
    emailStatus: lead.email_status,
    provisionalDirect: lead.provisional,
  });

  if (transition.enqueueRescue) {
    const rejectedEmail = lead.email_primary?.trim().toLowerCase() ?? '';
    const result = await dbQuery(
      `UPDATE outreach.leads
       SET email_primary = NULL,
           email_alt_1 = NULL,
           email_alt_2 = NULL,
           email_verification = 'invalid',
           email_verified_at = now(),
           email_status = 'not_found',
           email_source_note = 'Cited address bounced; targeted email rescue queued',
           updated_at = now()
       WHERE id = $1
         AND email_verification IN ('pending', 'unknown')`,
      [leadId],
    );
    if (!result.rowCount) return false;
    await incrementEnrichmentStat(runId, 'mailbox_invalid');
    await incrementEnrichmentStat(runId, 'direct', -1);
    await incrementEnrichmentStat(runId, 'not_found');
    await incrementEnrichmentStat(runId, 'provisional_direct_rejected');
    if (rejectedEmail) {
      await enqueueProvisionalBounceRescue(leadId, rejectedEmail, runId);
    }
    return true;
  }

  const result = await dbQuery(
    `UPDATE outreach.leads
     SET email_verification = 'invalid',
         email_verified_at = now(),
         updated_at = now()
     WHERE id = $1
       AND email_verification IN ('pending', 'unknown')`,
    [leadId],
  );
  if (!result.rowCount) return false;
  await incrementEnrichmentStat(runId, 'mailbox_invalid');
  return true;
}

/** @deprecated Use cascade helpers directly; kept for transitional call sites. */
export async function applyMailboxVerificationResult(
  leadId: string,
  email: string,
  runId: string,
  status: MailboxVerificationStatus,
) {
  if (status === 'unknown') {
    await markMailboxVerificationUnknown(leadId, runId);
    return true;
  }
  const lead = await loadLeadMailboxCandidates(leadId);
  if (!lead) return false;
  if (status === 'valid') {
    return promoteVerifiedMailboxEmail(leadId, email, runId, lead.email_status);
  }
  return finalizeAllCandidatesInvalid(leadId, runId, lead);
}

async function enqueueProvisionalBounceRescue(leadId: string, rejectedEmail: string, runId: string) {
  const { rows } = await dbQuery<ResearchPerson & { company_name: string | null }>(
    `SELECT id AS lead_id, full_name, coalesce(first_name, '') AS first_name,
            coalesce(last_name, '') AS last_name, title, location, linkedin_url,
            company_name, email_primary AS email, email_status
     FROM outreach.leads
     WHERE id = $1`,
    [leadId],
  );
  const lead = rows[0];
  if (!lead?.company_name?.trim()) return;
  const domain = rejectedEmail.split('@')[1]?.toLowerCase() ?? null;
  let rescue = buildDisambiguation(lead.company_name, [{
    lead_id: lead.lead_id,
    full_name: lead.full_name,
    first_name: lead.first_name,
    last_name: lead.last_name,
    title: lead.title,
    location: lead.location,
    linkedin_url: lead.linkedin_url,
    email: null,
    email_status: 'not_found',
    requested_fields: [],
  }]);
  rescue = {
    ...rescue,
    research_pass: 'email_rescue',
    candidate_domain: domain,
    email_rescue_context: {
      parent_job_id: `mailbox-rejection:${leadId}`,
      domain,
      domain_evidence: 'domain from bounced cited direct address',
      company_notes: 'AgentMail rejected a provisional direct address',
      prior_literal_emails: [],
      prior_formats: [],
      checked_paths: [],
      search_budget: 5,
      searches_used: 0,
      attempted_query_families: ['target_literal'],
      deferred_queries: [{
        person_name: lead.full_name,
        family: 'target_literal',
        query: `"${lead.full_name}" "@${domain ?? lead.company_name}"`,
      }],
      rejected_direct_literals: [{
        person_name: lead.full_name,
        email: rejectedEmail,
        source_url: '',
        reason: 'AgentMail bounce',
      }],
      failed_high_value_paths: [],
      scraper_outcomes: [],
    },
  };
  const queued = await dbQuery<{ enqueue: string }>(
    `SELECT public.enqueue($1, $2::jsonb, $3, 'email_rescue')`,
    [researchJobKey(rescue), JSON.stringify(rescue), runId],
  );
  if (queued.rows[0]?.enqueue) {
    await dbQuery(
      `UPDATE outreach.company_research_jobs
       SET search_budget = 5, updated_at = now()
       WHERE id = $1 AND status = 'pending' AND searches_used = 0`,
      [queued.rows[0].enqueue],
    );
  }
  await incrementEnrichmentStat(runId, 'companies_total');
  await incrementEnrichmentStat(runId, 'companies_remaining');
  await incrementEnrichmentStat(runId, 'email_rescue_jobs');
  await incrementEnrichmentStat(runId, 'email_rescue_people');
}

export async function probeMailboxEmail(
  email: string,
  leadId: string,
  options: {
    sleep?: (ms: number) => Promise<void>;
    sendProbe?: typeof agentMailSendProbe;
    listMessages?: typeof agentMailListMessages;
    getMessage?: typeof agentMailGetMessage;
    inboxId?: string;
  } = {},
): Promise<
  | { status: 'valid' | 'invalid'; bounce_message_id: string | null; sent_message_id: string }
  | { status: 'rate_limited'; reason: string; error?: string }
  | { status: 'unknown'; reason: string; error?: string }
> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(normalizedEmail)) {
    return { status: 'unknown', reason: 'invalid_email' };
  }

  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const sendProbe = options.sendProbe ?? agentMailSendProbe;
  const inboxId = assertVerifyInbox(options.inboxId ?? agentMailInboxId());

  let sent: AgentMailSendResult;
  try {
    sent = await sendProbe(normalizedEmail, leadId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isAgentMailRateLimitError(error)) {
      return { status: 'rate_limited', reason: 'rate_limited', error: message };
    }
    // Permanently blocked/bounced at AgentMail — fail closed as invalid, never retry forever.
    if (isAgentMailRecipientBlockedError(error)) {
      return { status: 'invalid', bounce_message_id: null, sent_message_id: 'agentmail-blocked' };
    }
    return { status: 'unknown', reason: 'send_failed', error: message };
  }

  await sleep(mailboxVerifyWaitMs());

  try {
    const bounce = await findBounceForProbe(
      normalizedEmail,
      sent,
      inboxId,
      options.listMessages,
      options.getMessage,
    );
    return {
      status: bounce ? 'invalid' : 'valid',
      bounce_message_id: bounce?.message_id ?? null,
      sent_message_id: sent.message_id,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'unknown', reason: 'inbox_check_failed', error: message };
  }
}

export async function runMailboxVerificationCascadeForLead(
  leadId: string,
  runId: string,
  options: {
    sleep?: (ms: number) => Promise<void>;
    sendProbe?: typeof agentMailSendProbe;
    listMessages?: typeof agentMailListMessages;
    getMessage?: typeof agentMailGetMessage;
    inboxId?: string;
  } = {},
) {
  if (!process.env.AGENT_MAIL_API?.trim()) {
    return { status: 'unknown' as const, reason: 'provider_not_configured' };
  }

  const lead = await loadLeadMailboxCandidates(leadId);
  if (!lead) {
    return { status: 'skipped' as const, reason: 'lead_not_found' };
  }
  if (!lead.emails.length) {
    return { status: 'skipped' as const, reason: 'no_candidates' };
  }
  if (!['pending', 'unknown'].includes(lead.email_verification ?? 'pending')) {
    return { status: 'skipped' as const, reason: 'already_verified' };
  }

  // Another lead on this run already rate-limited AgentMail — do not send more probes.
  if (await runHasMailboxRateLimit(runId)) {
    await markMailboxVerificationRateLimited(leadId, runId);
    return { status: 'rate_limited' as const, reason: 'run_already_rate_limited', attempts: [] };
  }

  const attempts: Array<{ email: string; status: string }> = [];
  for (const email of lead.emails) {
    // Re-check before every probe — a sibling may have rate-limited mid-cascade.
    if (await runHasMailboxRateLimit(runId)) {
      await markMailboxVerificationRateLimited(leadId, runId);
      return { status: 'rate_limited' as const, reason: 'run_already_rate_limited', attempts };
    }
    const probe = await probeMailboxEmail(email, leadId, options);
    if (probe.status === 'rate_limited') {
      await markMailboxVerificationRateLimited(leadId, runId);
      return { status: 'rate_limited' as const, reason: probe.reason, error: probe.error, attempts };
    }
    if (probe.status === 'unknown') {
      await markMailboxVerificationProviderError(leadId, runId);
      return { status: 'unknown' as const, reason: probe.reason, error: probe.error, attempts };
    }

    attempts.push({ email, status: probe.status });
    if (probe.status === 'valid') {
      await promoteVerifiedMailboxEmail(leadId, email, runId, lead.email_status);
      return {
        status: 'valid' as const,
        verified_email: email.trim().toLowerCase(),
        attempts,
        sent_message_id: probe.sent_message_id,
        bounce_message_id: probe.bounce_message_id,
      };
    }
  }

  await finalizeAllCandidatesInvalid(leadId, runId, lead);
  return {
    status: 'invalid' as const,
    attempts,
    candidate_count: lead.emails.length,
  };
}

export async function runMailboxVerificationForLead(
  leadId: string,
  _email: string,
  runId: string,
  options: {
    sleep?: (ms: number) => Promise<void>;
    sendProbe?: typeof agentMailSendProbe;
    listMessages?: typeof agentMailListMessages;
    getMessage?: typeof agentMailGetMessage;
    inboxId?: string;
  } = {},
) {
  return runMailboxVerificationCascadeForLead(leadId, runId, options);
}

export async function sweepPendingMailboxVerifications(runId: string) {
  // If this run already hit AgentMail rate limits, fail-open remaining leads
  // instead of enqueueing more probes.
  if (await runHasMailboxRateLimit(runId)) {
    return failOpenRemainingMailboxVerificationsForRun(runId);
  }

  const { rows } = await dbQuery<{
    lead_id: string;
    email_primary: string;
    email_status: string;
  }>(
    `SELECT l.id AS lead_id, l.email_primary, l.email_status
     FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     WHERE cl.run_id = $1
       AND l.email_primary IS NOT NULL
       AND (
         l.email_verification IS NULL
         OR l.email_verification IN ('pending', 'unknown')
       )
       AND l.email_status IN ('direct', 'inferred', 'format_guess', 'from_embark_db')`,
    [runId],
  );
  const { scheduleLeadMailboxVerification } = await import('@/lib/mailbox-verify-schedule');
  for (const row of rows) {
    await scheduleLeadMailboxVerification({
      leadId: row.lead_id,
      runId,
      emailStatus: row.email_status,
    });
  }
  return rows.length;
}
