import { dbQuery } from '@/lib/db';
import { campaignSenderIdentity, inferIdentitySlug, type SenderIdentitySlug } from '@/lib/agentmail-inboxes';
import { isSenderProfileSignatureReady } from '@/lib/drafting/email-signature';
import { isNyWeekday } from '@/lib/auto-campaigns/schedule';
import { formatNyDate } from '@/lib/drafting/send-queue-schedule';
import {
  AUTO_QUEUE_COLORS,
  type AutoQueueColor,
  type AutoStatus,
  type CampaignKind,
  type LeadAttributes,
  type PeopleSearchParams,
  type ProspectCycleStats,
} from '@/lib/auto-campaigns/types';
import { normalizeLinkedinUrl } from '@/lib/auto-campaigns/credit-pipeline';
import type { CampaignSheetViewRow } from '@/lib/campaign-sheet';
import { toCampaignSheetViewRows, type CampaignSheetRow } from '@/lib/campaign-sheet';

export type AutoCampaignRow = {
  id: string;
  owner_id: string;
  name: string;
  kind: CampaignKind;
  auto_status: AutoStatus | null;
  auto_error: string | null;
  emails_per_day: number | null;
  follow_up_enabled: boolean;
  sender_identity_slug: SenderIdentitySlug;
  lead_attributes: LeadAttributes;
  expansion_step: number;
  queue_color: string | null;
  next_cycle_at: string | null;
  last_cycle_at: string | null;
  apollo_search_page: number;
  apollo_search_params: PeopleSearchParams | null;
  thin_days: number;
};

function parseAttributes(value: unknown): LeadAttributes {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    industry: typeof row.industry === 'string' ? row.industry : '',
    seniority: typeof row.seniority === 'string' ? row.seniority : '',
    geography: typeof row.geography === 'string' ? row.geography : '',
    business_size: typeof row.business_size === 'string' ? row.business_size : '',
  };
}

function parseSearchParams(value: unknown): PeopleSearchParams | null {
  if (!value || typeof value !== 'object') return null;
  return value as PeopleSearchParams;
}

export function parseLeadAttributes(value: unknown): LeadAttributes {
  return parseAttributes(value);
}

export async function ownerHasReadySender(
  ownerId: string,
  identitySlug?: SenderIdentitySlug | null,
): Promise<boolean> {
  const slug = identitySlug ? campaignSenderIdentity(identitySlug) : null;
  const { rows } = await dbQuery<{
    display_name: string;
    title: string;
    work_email: string;
    headshot_storage_path: string | null;
  }>(
    `SELECT display_name, title, work_email, headshot_storage_path
       FROM outreach.sender_profiles
      WHERE user_id = $1
      ORDER BY is_default DESC, updated_at DESC`,
    [ownerId],
  );
  const matching = slug
    ? rows.filter((row) => inferIdentitySlug({
      workEmail: row.work_email,
      displayName: row.display_name,
    }) === slug)
    : rows;
  const row = matching[0];
  if (row) return isSenderProfileSignatureReady(row);
  // Helios Lucas/Tommy inboxes are signature-ready even before a profile row exists.
  return slug === 'lucas' || slug === 'tommy';
}

export async function listUsedQueueColors(ownerId: string): Promise<string[]> {
  const { rows } = await dbQuery<{ queue_color: string | null }>(
    `SELECT queue_color FROM outreach.campaigns
      WHERE owner_id = $1 AND kind = 'auto' AND status = 'active' AND queue_color IS NOT NULL`,
    [ownerId],
  );
  return rows.flatMap((row) => row.queue_color ? [row.queue_color] : []);
}

export function pickQueueColor(used: string[]): AutoQueueColor {
  const taken = new Set(used);
  const free = AUTO_QUEUE_COLORS.find((color) => !taken.has(color));
  return free ?? AUTO_QUEUE_COLORS[used.length % AUTO_QUEUE_COLORS.length]!;
}

export async function loadKnownApolloIds(): Promise<Set<string>> {
  const { rows } = await dbQuery<{ apollo_person_id: string }>(
    `SELECT apollo_person_id FROM outreach.leads WHERE apollo_person_id IS NOT NULL`,
  );
  return new Set(rows.map((row) => row.apollo_person_id));
}

export async function loadKnownLinkedinUrls(): Promise<Set<string>> {
  const { rows } = await dbQuery<{ linkedin_url: string }>(
    `SELECT linkedin_url FROM outreach.leads WHERE linkedin_url IS NOT NULL AND length(trim(linkedin_url)) > 0`,
  );
  const urls = new Set<string>();
  for (const row of rows) {
    const normalized = normalizeLinkedinUrl(row.linkedin_url);
    if (normalized) urls.add(normalized);
  }
  return urls;
}

export async function loadQueuedOrSentEmails(ownerId: string): Promise<Set<string>> {
  const { rows } = await dbQuery<{ to_email: string }>(
    `SELECT DISTINCT lower(to_email) AS to_email
       FROM outreach.email_send_queue
      WHERE owner_id = $1 AND status IN ('queued', 'sending', 'sent')`,
    [ownerId],
  );
  return new Set(rows.map((row) => row.to_email));
}

export async function loadAttachedOnNyDate(campaignId: string, sourcedOn: string): Promise<number> {
  const { rows } = await dbQuery<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM outreach.campaign_leads
      WHERE campaign_id = $1
        AND sourced_on = $2::date`,
    [campaignId, sourcedOn],
  );
  return rows[0]?.n ?? 0;
}

export async function loadLiveAutoReservationSources(ownerId: string): Promise<Array<{
  campaignId: string;
  campaignName: string;
  emailsPerDay: number;
  queueColor: string | null;
  leadAttributes: LeadAttributes;
  expansionStep: number;
  queuedOrSentByDate: Record<string, number>;
}>> {
  const { rows } = await dbQuery<{
    id: string;
    name: string;
    emails_per_day: number | null;
    queue_color: string | null;
    lead_attributes: unknown;
    expansion_step: number;
  }>(
    `SELECT id, name, emails_per_day, queue_color, lead_attributes, expansion_step
       FROM outreach.campaigns
      WHERE owner_id = $1
        AND kind = 'auto'
        AND status = 'active'
        AND auto_status = 'live'`,
    [ownerId],
  );
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const counts = await dbQuery<{ campaign_id: string; schedule_date: string; n: number }>(
    `SELECT campaign_id::text, schedule_date::text, count(*)::int AS n
       FROM outreach.email_send_queue
      WHERE owner_id = $1
        AND campaign_id = ANY($2::uuid[])
        AND status IN ('queued', 'sending', 'sent')
      GROUP BY campaign_id, schedule_date`,
    [ownerId, ids],
  );
  const byCampaign = new Map<string, Record<string, number>>();
  for (const row of counts.rows) {
    const map = byCampaign.get(row.campaign_id) ?? {};
    map[row.schedule_date] = row.n;
    byCampaign.set(row.campaign_id, map);
  }
  return rows.map((row) => ({
    campaignId: row.id,
    campaignName: row.name,
    emailsPerDay: row.emails_per_day ?? 0,
    queueColor: row.queue_color,
    leadAttributes: parseAttributes(row.lead_attributes),
    expansionStep: row.expansion_step,
    queuedOrSentByDate: byCampaign.get(row.id) ?? {},
  }));
}

export async function loadDueLiveAutoCampaigns(now = new Date()): Promise<Array<{
  id: string;
  owner_id: string;
}>> {
  const today = formatNyDate(now);
  const { rows } = await dbQuery<{ id: string; owner_id: string }>(
    `SELECT c.id, c.owner_id
       FROM outreach.campaigns c
      WHERE c.kind = 'auto'
        AND c.status = 'active'
        AND c.auto_status = 'live'
        AND (
          (c.next_cycle_at IS NOT NULL AND c.next_cycle_at <= $1)
          OR (
            $3::boolean
            AND COALESCE(c.emails_per_day, 0) > 0
            AND (
              SELECT count(*)::int
                FROM outreach.campaign_leads cl
               WHERE cl.campaign_id = c.id
                 AND cl.sourced_on = $2::date
            ) < COALESCE(c.emails_per_day, 0)
          )
        )
      ORDER BY c.next_cycle_at ASC NULLS LAST`,
    [now.toISOString(), today, isNyWeekday(now)],
  );
  return rows;
}

export async function autoCycleInFlight(): Promise<boolean> {
  const { rows } = await dbQuery<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM outreach.orchestration_jobs
      WHERE kind = 'auto.cycle' AND status IN ('pending', 'in_flight')`,
  );
  return (rows[0]?.n ?? 0) > 0;
}

export async function createProspectRun(campaignId: string, ownerId: string): Promise<string> {
  const { rows } = await dbQuery<{ id: string }>(
    `INSERT INTO outreach.runs (campaign_id, user_id, status, stats)
     VALUES ($1, $2, 'prospecting', jsonb_build_object('prospect', jsonb_build_object('log', '[]'::jsonb)))
     RETURNING id`,
    [campaignId, ownerId],
  );
  return rows[0]!.id;
}

export async function saveProspectRunStats(
  runId: string,
  stats: ProspectCycleStats,
  error?: string | null,
): Promise<void> {
  await dbQuery(
    `UPDATE outreach.runs
        SET status = $3,
            error = $4,
            stats = jsonb_set(coalesce(stats, '{}'::jsonb), '{prospect}', $2::jsonb),
            finished_at = now()
      WHERE id = $1`,
    [runId, JSON.stringify(stats), error ? 'failed' : 'complete', error ?? null],
  );
}

export async function appendProspectLog(runId: string, stats: ProspectCycleStats): Promise<void> {
  await dbQuery(
    `UPDATE outreach.runs
        SET stats = jsonb_set(coalesce(stats, '{}'::jsonb), '{prospect}', $2::jsonb)
      WHERE id = $1`,
    [runId, JSON.stringify(stats)],
  );
}

export async function updateAutoCursor(input: {
  campaignId: string;
  page: number;
  searchParams?: PeopleSearchParams | null;
  expansionStep?: number;
  thinDays?: number;
  autoStatus?: AutoStatus;
  autoError?: string | null;
  nextCycleAt?: Date | null;
  lastCycleAt?: Date;
}): Promise<void> {
  await dbQuery(
    `UPDATE outreach.campaigns
        SET apollo_search_page = $2,
            apollo_search_params = COALESCE($3::jsonb, apollo_search_params),
            expansion_step = COALESCE($4, expansion_step),
            thin_days = COALESCE($5, thin_days),
            auto_status = COALESCE($6, auto_status),
            auto_error = CASE WHEN $7::boolean THEN $8 ELSE auto_error END,
            next_cycle_at = COALESCE($9::timestamptz, next_cycle_at),
            last_cycle_at = COALESCE($10::timestamptz, last_cycle_at),
            updated_at = now()
      WHERE id = $1`,
    [
      input.campaignId,
      input.page,
      input.searchParams ? JSON.stringify(input.searchParams) : null,
      input.expansionStep ?? null,
      input.thinDays ?? null,
      input.autoStatus ?? null,
      input.autoError !== undefined,
      input.autoError ?? null,
      input.nextCycleAt?.toISOString() ?? null,
      input.lastCycleAt?.toISOString() ?? null,
    ],
  );
}

export async function loadAutoCampaign(campaignId: string): Promise<AutoCampaignRow | null> {
  const { rows } = await dbQuery<{
    id: string;
    owner_id: string;
    name: string;
    kind: CampaignKind;
    auto_status: AutoStatus | null;
    auto_error: string | null;
    emails_per_day: number | null;
    follow_up_enabled: boolean;
    sender_identity_slug: string | null;
    lead_attributes: unknown;
    expansion_step: number;
    queue_color: string | null;
    next_cycle_at: string | null;
    last_cycle_at: string | null;
    apollo_search_page: number;
    apollo_search_params: unknown;
    thin_days: number;
  }>(
    `SELECT id, owner_id, name, kind, auto_status, auto_error, emails_per_day,
            follow_up_enabled, sender_identity_slug, lead_attributes, expansion_step, queue_color,
            next_cycle_at::text, last_cycle_at::text, apollo_search_page,
            apollo_search_params, thin_days
       FROM outreach.campaigns
      WHERE id = $1`,
    [campaignId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    sender_identity_slug: campaignSenderIdentity(row.sender_identity_slug),
    lead_attributes: parseAttributes(row.lead_attributes),
    apollo_search_params: parseSearchParams(row.apollo_search_params),
  };
}

export type ProspectDayPage = {
  sourced_on: string;
  leads: CampaignSheetViewRow[];
};

export async function loadProspectWorkspace(campaignId: string, ownerId: string): Promise<{
  days: string[];
  active_run: {
    id: string;
    status: string;
    stats: unknown;
    error: string | null;
    started_at: string;
  } | null;
  sent_count: number;
  pulled_count: number;
  cycle_job: 'pending' | 'in_flight' | null;
}> {
  const days = await dbQuery<{ sourced_on: string }>(
    `SELECT DISTINCT sourced_on::text AS sourced_on
       FROM outreach.campaign_leads
      WHERE campaign_id = $1 AND sourced_on IS NOT NULL
      ORDER BY sourced_on DESC`,
    [campaignId],
  );
  const run = await dbQuery<{
    id: string;
    status: string;
    stats: unknown;
    error: string | null;
    started_at: string;
  }>(
    `SELECT id, status, stats, error, started_at::text
       FROM outreach.runs
      WHERE campaign_id = $1
      ORDER BY started_at DESC
      LIMIT 1`,
    [campaignId],
  );
  const counts = await dbQuery<{ pulled: number; sent: number }>(
    `SELECT
        (SELECT count(*)::int FROM outreach.campaign_leads WHERE campaign_id = $1) AS pulled,
        (SELECT count(*)::int FROM outreach.email_send_queue
          WHERE campaign_id = $1 AND status = 'sent') AS sent`,
    [campaignId],
  );
  const job = await dbQuery<{ status: 'pending' | 'in_flight' }>(
    `SELECT status
       FROM outreach.orchestration_jobs
      WHERE kind = 'auto.cycle'
        AND payload->>'campaignId' = $1
        AND status IN ('pending', 'in_flight')
      ORDER BY available_at DESC
      LIMIT 1`,
    [campaignId],
  );
  return {
    days: days.rows.map((row) => row.sourced_on),
    active_run: run.rows[0] ?? null,
    sent_count: counts.rows[0]?.sent ?? 0,
    pulled_count: counts.rows[0]?.pulled ?? 0,
    cycle_job: job.rows[0]?.status ?? null,
  };
}

export async function loadProspectDayLeads(
  campaignId: string,
  ownerId: string,
  sourcedOn: string,
): Promise<CampaignSheetViewRow[]> {
  const { rows } = await dbQuery<CampaignSheetRow>(
    `SELECT l.id, l.sf_contact_id, l.first_name, l.last_name, l.credentials,
            l.email_primary, l.email_alt_1, l.email_alt_2, l.email_status,
            l.email_verification, l.email_mx_status,
            l.email_source_note, l.title, l.company_name,
            l.company_id, l.location, l.linkedin_url, l.profile_enrichment,
            cl.relationship_snapshot, cl.reused_from_prior_lead,
            cl.extra_fields
       FROM outreach.campaign_leads cl
       JOIN outreach.leads l ON l.id = cl.lead_id
       JOIN outreach.campaigns c ON c.id = cl.campaign_id
      WHERE cl.campaign_id = $1 AND c.owner_id = $2 AND cl.sourced_on = $3::date
      ORDER BY l.last_name NULLS LAST, l.first_name NULLS LAST`,
    [campaignId, ownerId, sourcedOn],
  );
  return toCampaignSheetViewRows(rows);
}

export type OutreachBoardStats = {
  pulled: number;
  attached_today: number;
  sent: number;
  sent_today: number;
  queued: number;
  queued_today: number;
  failed: number;
  retry_suggested: number;
  bounced: number;
  opened: number;
  replied: number;
  needs_you: number;
  next_send_at: string | null;
  attention_label: string | null;
  by_day: Array<{ date: string; sent: number; attached: number }>;
};

export async function loadOutreachSuccess(campaignId: string): Promise<OutreachBoardStats> {
  const today = formatNyDate();
  const { rows } = await dbQuery<{
    pulled: number;
    attached_today: number;
    sent: number;
    sent_today: number;
    queued: number;
    queued_today: number;
    failed: number;
    retry_suggested: number;
    bounced: number;
    opened: number;
    replied: number;
    needs_you: number;
    next_send_at: string | null;
    attention_label: string | null;
  }>(
    `WITH failed_items AS (
        SELECT q.drafting_item_id, q.recipient_name, q.to_email, q.updated_at
          FROM outreach.email_send_queue q
         WHERE q.campaign_id = $1
           AND q.status = 'failed'
           AND NOT EXISTS (
             SELECT 1 FROM outreach.email_sends s
              WHERE s.drafting_item_id = q.drafting_item_id
                AND s.status = 'sent'
           )
       ),
       retry_items AS (
        SELECT i.id AS drafting_item_id
          FROM outreach.drafting_items i
          JOIN outreach.drafting_workspaces w ON w.id = i.workspace_id
          JOIN outreach.email_drafts d ON d.drafting_item_id = i.id
         WHERE w.campaign_id = $1
           AND i.removed_at IS NULL
           AND i.state <> 'removed'
           AND EXISTS (
             SELECT 1
               FROM jsonb_array_elements(coalesce(d.lint_result -> 'hard', '[]'::jsonb)) AS finding
              WHERE finding->>'code' = 'OVERLOADED_SENTENCE'
           )
           AND NOT EXISTS (
             SELECT 1 FROM outreach.email_send_queue q
              WHERE q.drafting_item_id = i.id
                AND q.status IN ('queued', 'sending', 'sent')
           )
           AND NOT EXISTS (
             SELECT 1 FROM outreach.email_sends s
              WHERE s.drafting_item_id = i.id
                AND s.status = 'sent'
           )
       ),
       bounced_items AS (
        SELECT DISTINCT s.drafting_item_id
          FROM outreach.email_sends s
          JOIN outreach.drafting_items i ON i.id = s.drafting_item_id
          JOIN outreach.drafting_workspaces w ON w.id = i.workspace_id
         WHERE w.campaign_id = $1
           AND s.bounced_at IS NOT NULL
       )
     SELECT
        (SELECT count(*)::int FROM outreach.campaign_leads WHERE campaign_id = $1) AS pulled,
        (SELECT count(*)::int FROM outreach.campaign_leads
          WHERE campaign_id = $1 AND sourced_on = $2::date) AS attached_today,
        (SELECT count(*)::int FROM outreach.email_send_queue
          WHERE campaign_id = $1 AND status = 'sent') AS sent,
        (SELECT count(*)::int FROM outreach.email_send_queue
          WHERE campaign_id = $1 AND status = 'sent' AND schedule_date = $2::date) AS sent_today,
        (SELECT count(*)::int FROM outreach.email_send_queue
          WHERE campaign_id = $1 AND status IN ('queued', 'sending')) AS queued,
        (SELECT count(*)::int FROM outreach.email_send_queue
          WHERE campaign_id = $1
            AND status IN ('queued', 'sending')
            AND schedule_date = $2::date) AS queued_today,
        (SELECT count(*)::int FROM failed_items) AS failed,
        (SELECT count(*)::int FROM retry_items) AS retry_suggested,
        (SELECT count(*)::int FROM bounced_items) AS bounced,
        (SELECT count(*)::int
           FROM outreach.email_sends s
           JOIN outreach.drafting_items i ON i.id = s.drafting_item_id
           JOIN outreach.drafting_workspaces w ON w.id = i.workspace_id
          WHERE w.campaign_id = $1 AND s.opened_at IS NOT NULL) AS opened,
        (SELECT count(*)::int
           FROM outreach.email_sends s
           JOIN outreach.drafting_items i ON i.id = s.drafting_item_id
           JOIN outreach.drafting_workspaces w ON w.id = i.workspace_id
          WHERE w.campaign_id = $1 AND s.replied_at IS NOT NULL) AS replied,
        (SELECT count(DISTINCT drafting_item_id)::int
           FROM (
             SELECT drafting_item_id FROM failed_items
             UNION
             SELECT drafting_item_id FROM retry_items
             UNION
             SELECT drafting_item_id FROM bounced_items
           ) needs) AS needs_you,
        (SELECT min(scheduled_for)::text FROM outreach.email_send_queue
          WHERE campaign_id = $1 AND status IN ('queued', 'sending')) AS next_send_at,
        (SELECT COALESCE(nullif(recipient_name, ''), to_email)
           FROM failed_items
          ORDER BY updated_at DESC
          LIMIT 1) AS attention_label`,
    [campaignId, today],
  );
  const days = await dbQuery<{ date: string; sent: number; attached: number }>(
    `SELECT to_char(gs::date, 'YYYY-MM-DD') AS date,
            (SELECT count(*)::int FROM outreach.email_send_queue q
              WHERE q.campaign_id = $1 AND q.status = 'sent' AND q.schedule_date = gs::date) AS sent,
            (SELECT count(*)::int FROM outreach.campaign_leads cl
              WHERE cl.campaign_id = $1 AND cl.sourced_on = gs::date) AS attached
       FROM generate_series(($2::date - 13), $2::date, interval '1 day') AS gs
      ORDER BY gs ASC`,
    [campaignId, today],
  );
  const row = rows[0];
  return {
    pulled: row?.pulled ?? 0,
    attached_today: row?.attached_today ?? 0,
    sent: row?.sent ?? 0,
    sent_today: row?.sent_today ?? 0,
    queued: row?.queued ?? 0,
    queued_today: row?.queued_today ?? 0,
    failed: row?.failed ?? 0,
    retry_suggested: row?.retry_suggested ?? 0,
    bounced: row?.bounced ?? 0,
    opened: row?.opened ?? 0,
    replied: row?.replied ?? 0,
    needs_you: row?.needs_you ?? 0,
    next_send_at: row?.next_send_at ?? null,
    attention_label: row?.attention_label ?? null,
    by_day: days.rows,
  };
}

export function todayNy(): string {
  return formatNyDate();
}
