/**
 * Outreach Analytics Hub engine with multi-filtering and spend + conversion metrics.
 */

import { dbQuery } from '@/lib/db';

export type AnalyticsPeriod = 'week' | 'month' | 'custom';

export type AnalyticsWindow = {
  period: AnalyticsPeriod;
  from: string;
  to: string;
};

export type AnalyticsMetricBlock = {
  // Volume & Conversion
  emails_sent: number;
  emails_delivered: number;
  emails_opened: number;
  emails_clicked: number;
  emails_replied: number;
  delivery_rate: number | null;
  open_rate: number | null;
  click_rate: number | null;
  reply_rate: number | null;
  campaigns_count: number;
  total_leads: number;

  // Review & Edit stats
  drafts_reviewed: number;
  drafts_approved: number;
  drafts_denied: number;
  approval_rate: number | null;
  drafts_revised: number;
  edit_rate: number | null;

  // Spend & Costs
  enrichment_cost_usd: number;
  drafting_cost_usd: number;
  unattributed_cost_usd: number;
  total_spend_usd: number;
  spend_per_lead_usd: number | null;
  cost_per_email_usd: number | null;
  cost_per_enrichment_usd: number | null;
  cost_per_drafting_usd: number | null;
  enrichment_lead_events: number;
  drafting_lead_events: number;

  // Orchestration Jobs
  orch_jobs_total: number;
  orch_jobs_retried: number;
  retry_rate: number | null;
};

export type AnalyticsUserRow = AnalyticsMetricBlock & {
  user_id: string;
  user_email: string | null;
  user_name: string | null;
};

export type AnalyticsCampaignRow = {
  campaign_id: string;
  campaign_name: string;
  owner_id: string;
  owner_name: string | null;
  owner_email: string | null;
  tags: string[];
  tag_details?: { tag: string; color: string | null }[];
  lead_count: number;
  emails_sent: number;
  emails_delivered: number;
  emails_opened: number;
  emails_clicked: number;
  emails_replied: number;
  delivery_rate: number | null;
  open_rate: number | null;
  click_rate: number | null;
  reply_rate: number | null;
  enrichment_cost_usd: number;
  drafting_cost_usd: number;
  total_spend_usd: number;
  spend_per_lead_usd: number | null;
  created_at: string;
};

export type AnalyticsSummaryFilters = {
  campaignIds?: string[] | null;
  tags?: string[] | null;
  userId?: string | null;
};

export type AnalyticsSummary = {
  window: AnalyticsWindow;
  filters: {
    campaignIds: string[];
    tags: string[];
    userId: string | null;
  };
  aggregate: AnalyticsMetricBlock;
  by_user: AnalyticsUserRow[];
  by_campaign: AnalyticsCampaignRow[];
  available_tags: string[];
  available_campaigns: { id: string; name: string; tags: string[] }[];
  available_users: { id: string; name: string; email: string }[];
  excluded_run_ids: string[];
  notes: string[];
};

export type AnalyticsRunRow = {
  id: string;
  campaign_id: string;
  campaign_name: string;
  run_type: string;
  status: string;
  created_by: string;
  created_by_email: string | null;
  created_by_name: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  lead_count: number;
  excluded: boolean;
  excluded_at: string | null;
  excluded_by: string | null;
  reason: string | null;
};

function emptyMetrics(): AnalyticsMetricBlock {
  return {
    emails_sent: 0,
    emails_delivered: 0,
    emails_opened: 0,
    emails_clicked: 0,
    emails_replied: 0,
    delivery_rate: null,
    open_rate: null,
    click_rate: null,
    reply_rate: null,
    campaigns_count: 0,
    total_leads: 0,
    drafts_reviewed: 0,
    drafts_approved: 0,
    drafts_denied: 0,
    approval_rate: null,
    drafts_revised: 0,
    edit_rate: null,
    enrichment_cost_usd: 0,
    drafting_cost_usd: 0,
    unattributed_cost_usd: 0,
    total_spend_usd: 0,
    spend_per_lead_usd: null,
    cost_per_email_usd: null,
    cost_per_enrichment_usd: null,
    cost_per_drafting_usd: null,
    enrichment_lead_events: 0,
    drafting_lead_events: 0,
    orch_jobs_total: 0,
    orch_jobs_retried: 0,
    retry_rate: null,
  };
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

function perUnit(total: number, count: number): number | null {
  if (count <= 0) return null;
  return total / count;
}

function finalizeMetrics<T extends AnalyticsMetricBlock>(m: T): T {
  const total_spend = m.drafting_cost_usd + m.enrichment_cost_usd;
  const baseDenominator = m.emails_delivered > 0 ? m.emails_delivered : m.emails_sent;
  return {
    ...m,
    total_spend_usd: total_spend,
    delivery_rate: rate(m.emails_delivered, m.emails_sent),
    open_rate: rate(m.emails_opened, baseDenominator),
    click_rate: rate(m.emails_clicked, baseDenominator),
    reply_rate: rate(m.emails_replied, baseDenominator),
    spend_per_lead_usd: perUnit(total_spend, m.total_leads),
    approval_rate: rate(m.drafts_approved, m.drafts_reviewed),
    cost_per_email_usd: perUnit(total_spend, m.emails_sent),
    cost_per_enrichment_usd: perUnit(m.enrichment_cost_usd, m.enrichment_lead_events),
    cost_per_drafting_usd: perUnit(m.drafting_cost_usd, m.drafting_lead_events),
    retry_rate: rate(m.orch_jobs_retried, m.orch_jobs_total),
    edit_rate: rate(m.drafts_revised, Math.max(m.drafts_reviewed, m.drafts_revised)),
  };
}

function toIsoDayStart(d: Date): string {
  const copy = new Date(d);
  copy.setUTCHours(0, 0, 0, 0);
  return copy.toISOString();
}

function toIsoDayEnd(d: Date): string {
  const copy = new Date(d);
  copy.setUTCHours(23, 59, 59, 999);
  return copy.toISOString();
}

export function resolveAnalyticsWindow(input: {
  period?: string | null;
  from?: string | null;
  to?: string | null;
  now?: Date;
}): AnalyticsWindow {
  const now = input.now ?? new Date();
  const periodRaw = (input.period ?? 'week').toLowerCase();
  if (periodRaw === 'custom') {
    if (!input.from || !input.to) throw new Error('Custom range requires from and to (ISO dates)');
    const from = new Date(input.from);
    const to = new Date(input.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new Error('Invalid from/to date');
    }
    if (from.getTime() > to.getTime()) throw new Error('from must be on or before to');
    return { period: 'custom', from: toIsoDayStart(from), to: toIsoDayEnd(to) };
  }
  if (periodRaw === 'month') {
    const from = new Date(now);
    from.setUTCDate(from.getUTCDate() - 29);
    return { period: 'month', from: toIsoDayStart(from), to: toIsoDayEnd(now) };
  }
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - 6);
  return { period: 'week', from: toIsoDayStart(from), to: toIsoDayEnd(now) };
}

async function loadExcludedRunIds(): Promise<string[]> {
  const { rows } = await dbQuery<{ run_id: string }>(
    `SELECT run_id::text AS run_id FROM outreach.analytics_run_exclusions`,
  );
  return rows.map((r) => r.run_id);
}

async function loadExcludedLeadIds(excludedRunIds: string[]): Promise<string[]> {
  if (!excludedRunIds.length) return [];
  const { rows } = await dbQuery<{ lead_id: string }>(
    `SELECT DISTINCT cl.lead_id::text AS lead_id
       FROM outreach.campaign_leads cl
      WHERE cl.run_id = ANY($1::uuid[])
     UNION
     SELECT DISTINCT l.id::text AS lead_id
       FROM outreach.leads l
      WHERE l.source_run_id = ANY($1::uuid[])`,
    [excludedRunIds],
  );
  return rows.map((r) => r.lead_id);
}

function ensureUser(
  map: Map<string, AnalyticsUserRow>,
  userId: string,
  email: string | null = null,
  name: string | null = null,
): AnalyticsUserRow {
  let row = map.get(userId);
  if (!row) {
    row = { user_id: userId, user_email: email, user_name: name, ...emptyMetrics() };
    map.set(userId, row);
  } else {
    if (!row.user_email && email) row.user_email = email;
    if (!row.user_name && name) row.user_name = name;
  }
  return row;
}

export async function getAnalyticsSummary(input: {
  period?: string | null;
  from?: string | null;
  to?: string | null;
  campaignIds?: string[] | null;
  tags?: string[] | null;
  userId?: string | null;
}): Promise<AnalyticsSummary> {
  const window = resolveAnalyticsWindow(input);
  const excludedRunIds = await loadExcludedRunIds();
  const excludedLeadList = await loadExcludedLeadIds(excludedRunIds);

  const cleanCampaignIds = input.campaignIds?.filter(Boolean) ?? [];
  const cleanTags = input.tags?.map((t) => t.trim().toLowerCase()).filter(Boolean) ?? [];
  const cleanUserId = input.userId?.trim() || null;

  // 1. Fetch available filter options (tags, active campaigns, users)
  const [tagsRes, campaignsRes, usersRes] = await Promise.all([
    dbQuery<{ tag: string }>(`SELECT DISTINCT tag FROM outreach.campaign_tags ORDER BY tag ASC`),
    dbQuery<{ id: string; name: string; tags: string[] }>(
      `SELECT c.id::text AS id, c.name,
              COALESCE((SELECT array_agg(ct.tag ORDER BY ct.tag) FROM outreach.campaign_tags ct WHERE ct.campaign_id = c.id), '{}'::text[]) AS tags
         FROM outreach.campaigns c
        WHERE c.status = 'active'
        ORDER BY c.name ASC`,
    ),
    dbQuery<{ id: string; name: string; email: string }>(
      `SELECT id::text AS id, display_name AS name, email FROM outreach.users ORDER BY display_name ASC, email ASC`,
    ),
  ]);

  const available_tags = tagsRes.rows.map((r) => r.tag);
  const available_campaigns = campaignsRes.rows;
  const available_users = usersRes.rows;

  // 2. Resolve matching campaign IDs based on filters
  const { rows: matchingCampaigns } = await dbQuery<{
    id: string;
    name: string;
    owner_id: string;
    owner_name: string | null;
    owner_email: string | null;
    created_at: Date;
    tags: string[];
    tag_details: { tag: string; color: string | null }[];
    lead_count: string;
  }>(
    `SELECT
       c.id::text AS id,
       c.name,
       c.owner_id::text AS owner_id,
       u.display_name AS owner_name,
       u.email AS owner_email,
       c.created_at,
       COALESCE((SELECT array_agg(ct.tag ORDER BY ct.tag) FROM outreach.campaign_tags ct WHERE ct.campaign_id = c.id), '{}'::text[]) AS tags,
       COALESCE((SELECT json_agg(json_build_object('tag', ct.tag, 'color', ct.color) ORDER BY ct.tag) FROM outreach.campaign_tags ct WHERE ct.campaign_id = c.id), '[]'::json) AS tag_details,
       COALESCE((SELECT count(DISTINCT cl.lead_id)::text FROM outreach.campaign_leads cl WHERE cl.campaign_id = c.id), '0') AS lead_count
     FROM outreach.campaigns c
     JOIN outreach.users u ON u.id = c.owner_id
     WHERE ($1::uuid IS NULL OR c.owner_id = $1::uuid)
       AND ($2::uuid[] IS NULL OR cardinality($2::uuid[]) = 0 OR c.id = ANY($2::uuid[]))
       AND ($3::text[] IS NULL OR cardinality($3::text[]) = 0 OR c.id IN (
         SELECT ct.campaign_id FROM outreach.campaign_tags ct WHERE lower(ct.tag) = ANY($3::text[])
       ))
     ORDER BY c.updated_at DESC`,
    [
      cleanUserId,
      cleanCampaignIds.length ? cleanCampaignIds : null,
      cleanTags.length ? cleanTags : null,
    ],
  );

  const matchedCampaignIds = matchingCampaigns.map((c) => c.id);

  // 3. Draft & Engagement statistics grouped by campaign & user
  const { rows: draftRows } = await dbQuery<{
    campaign_id: string;
    user_id: string;
    user_email: string | null;
    user_name: string | null;
    emails_sent: string;
    emails_delivered: string;
    emails_opened: string;
    emails_clicked: string;
    emails_replied: string;
    drafts_approved: string;
    drafts_denied: string;
    drafts_edited: string;
  }>(
    `SELECT
       c.id::text AS campaign_id,
       c.owner_id::text AS user_id,
       u.email AS user_email,
       u.display_name AS user_name,
       count(*) FILTER (
         WHERE i.delivery_snapshot ? 'sentAt' OR i.delivery_snapshot ? 'gmailMessageId' OR s.status = 'sent'
       )::text AS emails_sent,
       count(*) FILTER (WHERE s.delivered_at IS NOT NULL)::text AS emails_delivered,
       count(*) FILTER (WHERE s.opened_at IS NOT NULL)::text AS emails_opened,
       count(*) FILTER (WHERE s.clicked_at IS NOT NULL)::text AS emails_clicked,
       count(*) FILTER (WHERE s.replied_at IS NOT NULL)::text AS emails_replied,
       count(*) FILTER (WHERE i.state = 'approved')::text AS drafts_approved,
       count(*) FILTER (
         WHERE i.state IN ('queued_rewrite', 'rewriting', 'failed_rewrite')
       )::text AS drafts_denied,
       count(*) FILTER (WHERE d.manually_edited)::text AS drafts_edited
     FROM outreach.drafting_items i
     JOIN outreach.drafting_workspaces w ON w.id = i.workspace_id
     JOIN outreach.campaigns c ON c.id = w.campaign_id
     JOIN outreach.users u ON u.id = c.owner_id
     LEFT JOIN outreach.email_drafts d ON d.drafting_item_id = i.id
     LEFT JOIN outreach.email_sends s ON s.drafting_item_id = i.id AND s.status = 'sent'
     WHERE i.updated_at >= $1::timestamptz
       AND i.updated_at <= $2::timestamptz
       AND ($3::uuid[] IS NULL OR cardinality($3::uuid[]) = 0 OR c.id = ANY($3::uuid[]))
       AND ($4::uuid[] IS NULL OR cardinality($4::uuid[]) = 0 OR i.lead_id <> ALL($4::uuid[]))
     GROUP BY c.id, c.owner_id, u.email, u.display_name`,
    [
      window.from,
      window.to,
      matchedCampaignIds.length ? matchedCampaignIds : ['00000000-0000-0000-0000-000000000000'],
      excludedLeadList.length ? excludedLeadList : null,
    ],
  );

  // 4. Cost Statistics grouped by campaign & user
  const { rows: costRows } = await dbQuery<{
    campaign_id: string;
    user_id: string;
    phase: 'enrichment' | 'drafting';
    cost_usd: string;
    event_count: string;
    unattributed_cost_usd: string;
  }>(
    `WITH cost_rows AS (
       SELECT
         c.id::text AS campaign_id,
         c.owner_id::text AS user_id,
         'enrichment'::text AS phase,
         e.actual_cost_usd AS cost_usd,
         e.lead_id,
         0::numeric AS unattributed_cost_usd
       FROM outreach.lead_cost_events e
       JOIN outreach.campaigns c ON c.id = e.campaign_id
       WHERE e.created_at >= $1::timestamptz
         AND e.created_at <= $2::timestamptz
         AND e.phase = 'enrichment'
         AND ($3::uuid[] IS NULL OR cardinality($3::uuid[]) = 0 OR c.id = ANY($3::uuid[]))
         AND ($4::uuid[] IS NULL OR cardinality($4::uuid[]) = 0 OR e.lead_id <> ALL($4::uuid[]))
       UNION ALL
       SELECT
         c.id::text AS campaign_id,
         c.owner_id::text,
         'drafting'::text,
         event.actual_cost_usd,
         item.lead_id,
         0::numeric
       FROM outreach.drafting_job_cost_events event
       JOIN outreach.drafting_items item ON item.id = event.drafting_item_id
       JOIN outreach.drafting_workspaces workspace ON workspace.id = item.workspace_id
       JOIN outreach.campaigns c ON c.id = workspace.campaign_id
       WHERE event.created_at >= $1::timestamptz
         AND event.created_at <= $2::timestamptz
         AND ($3::uuid[] IS NULL OR cardinality($3::uuid[]) = 0 OR c.id = ANY($3::uuid[]))
         AND ($4::uuid[] IS NULL OR cardinality($4::uuid[]) = 0 OR item.lead_id <> ALL($4::uuid[]))
       UNION ALL
       SELECT
         c.id::text AS campaign_id,
         c.owner_id::text,
         'drafting'::text,
         opening.actual_cost_usd,
         NULL::uuid,
         opening.actual_cost_usd
       FROM outreach.drafting_run_cost_opening_balances opening
       JOIN outreach.campaigns c ON c.id = opening.campaign_id
       WHERE opening.occurred_at >= $1::timestamptz
         AND opening.occurred_at <= $2::timestamptz
         AND ($3::uuid[] IS NULL OR cardinality($3::uuid[]) = 0 OR c.id = ANY($3::uuid[]))
     )
     SELECT
       campaign_id,
       user_id,
       phase,
       coalesce(sum(cost_usd), 0)::text AS cost_usd,
       count(DISTINCT lead_id)::text AS event_count,
       coalesce(sum(unattributed_cost_usd), 0)::text AS unattributed_cost_usd
     FROM cost_rows
     GROUP BY campaign_id, user_id, phase`,
    [
      window.from,
      window.to,
      matchedCampaignIds.length ? matchedCampaignIds : ['00000000-0000-0000-0000-000000000000'],
      excludedLeadList.length ? excludedLeadList : null,
    ],
  );

  // 5. Orchestration Job Statistics
  const { rows: jobRows } = await dbQuery<{
    campaign_id: string;
    user_id: string;
    jobs_total: string;
    jobs_retried: string;
  }>(
    `SELECT
       c.id::text AS campaign_id,
       c.owner_id::text AS user_id,
       count(*)::text AS jobs_total,
       count(*) FILTER (WHERE coalesce(j.attempt_count, 1) > 1)::text AS jobs_retried
     FROM outreach.drafting_jobs j
     JOIN outreach.drafting_items i ON i.id = j.drafting_item_id
     JOIN outreach.drafting_workspaces w ON w.id = i.workspace_id
     JOIN outreach.campaigns c ON c.id = w.campaign_id
     WHERE j.created_at >= $1::timestamptz
       AND j.created_at <= $2::timestamptz
       AND ($3::uuid[] IS NULL OR cardinality($3::uuid[]) = 0 OR c.id = ANY($3::uuid[]))
       AND ($4::uuid[] IS NULL OR cardinality($4::uuid[]) = 0 OR i.lead_id <> ALL($4::uuid[]))
     GROUP BY c.id, c.owner_id`,
    [
      window.from,
      window.to,
      matchedCampaignIds.length ? matchedCampaignIds : ['00000000-0000-0000-0000-000000000000'],
      excludedLeadList.length ? excludedLeadList : null,
    ],
  );

  const byUser = new Map<string, AnalyticsUserRow>();
  const campaignMetrics = new Map<string, {
    emails_sent: number;
    emails_delivered: number;
    emails_opened: number;
    emails_clicked: number;
    emails_replied: number;
    enrichment_cost_usd: number;
    drafting_cost_usd: number;
  }>();

  const aggregate = emptyMetrics();
  aggregate.campaigns_count = matchingCampaigns.length;

  // Process Lead Counts
  for (const camp of matchingCampaigns) {
    const lCount = Number(camp.lead_count);
    aggregate.total_leads += lCount;
  }

  for (const row of draftRows) {
    const user = ensureUser(byUser, row.user_id, row.user_email, row.user_name);
    const sent = Number(row.emails_sent);
    const delivered = Number(row.emails_delivered);
    const opened = Number(row.emails_opened);
    const clicked = Number(row.emails_clicked);
    const replied = Number(row.emails_replied);
    const approved = Number(row.drafts_approved);
    const denied = Number(row.drafts_denied);
    const edited = Number(row.drafts_edited);

    user.emails_sent += sent;
    user.emails_delivered += delivered;
    user.emails_opened += opened;
    user.emails_clicked += clicked;
    user.emails_replied += replied;
    user.drafts_approved += approved;
    user.drafts_denied += denied;
    user.drafts_reviewed += approved + denied;
    user.drafts_revised += edited;

    aggregate.emails_sent += sent;
    aggregate.emails_delivered += delivered;
    aggregate.emails_opened += opened;
    aggregate.emails_clicked += clicked;
    aggregate.emails_replied += replied;
    aggregate.drafts_approved += approved;
    aggregate.drafts_denied += denied;
    aggregate.drafts_reviewed += approved + denied;
    aggregate.drafts_revised += edited;

    const cm = campaignMetrics.get(row.campaign_id) ?? {
      emails_sent: 0,
      emails_delivered: 0,
      emails_opened: 0,
      emails_clicked: 0,
      emails_replied: 0,
      enrichment_cost_usd: 0,
      drafting_cost_usd: 0,
    };
    cm.emails_sent += sent;
    cm.emails_delivered += delivered;
    cm.emails_opened += opened;
    cm.emails_clicked += clicked;
    cm.emails_replied += replied;
    campaignMetrics.set(row.campaign_id, cm);
  }

  for (const row of costRows) {
    const user = ensureUser(byUser, row.user_id);
    const cost = Number(row.cost_usd);
    const events = Number(row.event_count);
    const unattributedCost = Number(row.unattributed_cost_usd);

    const cm = campaignMetrics.get(row.campaign_id) ?? {
      emails_sent: 0,
      emails_delivered: 0,
      emails_opened: 0,
      emails_clicked: 0,
      emails_replied: 0,
      enrichment_cost_usd: 0,
      drafting_cost_usd: 0,
    };

    if (row.phase === 'enrichment') {
      user.enrichment_cost_usd += cost;
      user.enrichment_lead_events += events;
      aggregate.enrichment_cost_usd += cost;
      aggregate.enrichment_lead_events += events;
      cm.enrichment_cost_usd += cost;
    } else {
      user.drafting_cost_usd += cost;
      user.unattributed_cost_usd += unattributedCost;
      user.drafting_lead_events += events;
      aggregate.drafting_cost_usd += cost;
      aggregate.unattributed_cost_usd += unattributedCost;
      aggregate.drafting_lead_events += events;
      cm.drafting_cost_usd += cost;
    }
    campaignMetrics.set(row.campaign_id, cm);
  }

  for (const row of jobRows) {
    const user = ensureUser(byUser, row.user_id);
    const total = Number(row.jobs_total);
    const retried = Number(row.jobs_retried);
    user.orch_jobs_total += total;
    user.orch_jobs_retried += retried;
    aggregate.orch_jobs_total += total;
    aggregate.orch_jobs_retried += retried;
  }

  // Calculate user total leads
  for (const camp of matchingCampaigns) {
    const user = byUser.get(camp.owner_id);
    if (user) {
      user.total_leads += Number(camp.lead_count);
    }
  }

  const by_campaign: AnalyticsCampaignRow[] = matchingCampaigns.map((camp) => {
    const cm = campaignMetrics.get(camp.id) ?? {
      emails_sent: 0,
      emails_delivered: 0,
      emails_opened: 0,
      emails_clicked: 0,
      emails_replied: 0,
      enrichment_cost_usd: 0,
      drafting_cost_usd: 0,
    };
    const leadCount = Number(camp.lead_count);
    const totalSpend = cm.enrichment_cost_usd + cm.drafting_cost_usd;
    const baseDenominator = cm.emails_delivered > 0 ? cm.emails_delivered : cm.emails_sent;

    return {
      campaign_id: camp.id,
      campaign_name: camp.name,
      owner_id: camp.owner_id,
      owner_name: camp.owner_name,
      owner_email: camp.owner_email,
      tags: camp.tags,
      tag_details: camp.tag_details,
      lead_count: leadCount,
      emails_sent: cm.emails_sent,
      emails_delivered: cm.emails_delivered,
      emails_opened: cm.emails_opened,
      emails_clicked: cm.emails_clicked,
      emails_replied: cm.emails_replied,
      delivery_rate: rate(cm.emails_delivered, cm.emails_sent),
      open_rate: rate(cm.emails_opened, baseDenominator),
      click_rate: rate(cm.emails_clicked, baseDenominator),
      reply_rate: rate(cm.emails_replied, baseDenominator),
      enrichment_cost_usd: cm.enrichment_cost_usd,
      drafting_cost_usd: cm.drafting_cost_usd,
      total_spend_usd: totalSpend,
      spend_per_lead_usd: perUnit(totalSpend, leadCount),
      created_at: camp.created_at ? new Date(camp.created_at).toISOString() : new Date().toISOString(),
    };
  });

  return {
    window,
    filters: {
      campaignIds: cleanCampaignIds,
      tags: cleanTags,
      userId: cleanUserId,
    },
    aggregate: finalizeMetrics(aggregate),
    by_user: [...byUser.values()]
      .map((row) => finalizeMetrics(row))
      .sort((a, b) => (b.drafting_cost_usd + b.enrichment_cost_usd) - (a.drafting_cost_usd + a.enrichment_cost_usd)),
    by_campaign,
    available_tags,
    available_campaigns,
    available_users,
    excluded_run_ids: excludedRunIds,
    notes: [
      'Edit rate uses email_drafts.manually_edited.',
      'Sent count uses drafting_items.delivery_snapshot and email_sends (sent status).',
      'Denied proxy = rewrite-path drafting item states (queued_rewrite / rewriting / failed_rewrite).',
      'Excluded runs drop leads via campaign_leads.run_id and leads.source_run_id.',
      'Drafting totals include immutable legacy_unattributed opening balances; per-lead counts never receive that historical residual.',
    ],
  };
}

export async function listAnalyticsRuns(): Promise<AnalyticsRunRow[]> {
  const { rows } = await dbQuery<{
    id: string;
    campaign_id: string;
    campaign_name: string;
    status: string;
    created_by: string;
    created_by_email: string | null;
    created_by_name: string | null;
    started_at: Date | null;
    finished_at: Date | null;
    created_at: Date;
    lead_count: string;
    excluded: boolean;
    excluded_at: Date | null;
    excluded_by: string | null;
    reason: string | null;
  }>(
    `SELECT
       r.id::text AS id,
       r.campaign_id::text AS campaign_id,
       c.name AS campaign_name,
       r.status,
       r.user_id::text AS created_by,
       u.email AS created_by_email,
       u.display_name AS created_by_name,
       r.started_at,
       r.finished_at,
       r.started_at AS created_at,
       coalesce((
         SELECT count(*)::text FROM outreach.campaign_leads cl WHERE cl.run_id = r.id
       ), '0') AS lead_count,
       (x.run_id IS NOT NULL) AS excluded,
       x.excluded_at,
       x.excluded_by::text AS excluded_by,
       x.reason
     FROM outreach.runs r
     JOIN outreach.campaigns c ON c.id = r.campaign_id
     LEFT JOIN outreach.users u ON u.id = r.user_id
     LEFT JOIN outreach.analytics_run_exclusions x ON x.run_id = r.id
     ORDER BY r.started_at DESC
     LIMIT 200`,
  );

  return rows.map((row) => ({
    id: row.id,
    campaign_id: row.campaign_id,
    campaign_name: row.campaign_name,
    run_type: 'enrichment',
    status: row.status,
    created_by: row.created_by,
    created_by_email: row.created_by_email,
    created_by_name: row.created_by_name,
    started_at: row.started_at?.toISOString() ?? null,
    completed_at: row.finished_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    lead_count: Number(row.lead_count),
    excluded: row.excluded,
    excluded_at: row.excluded_at?.toISOString() ?? null,
    excluded_by: row.excluded_by,
    reason: row.reason,
  }));
}

export async function excludeAnalyticsRuns(input: {
  runIds: string[];
  userId: string;
  reason?: string | null;
}): Promise<{ excluded: number }> {
  const ids = [...new Set(input.runIds.filter(Boolean))];
  if (!ids.length) return { excluded: 0 };
  const reason = input.reason?.trim() || null;
  if (reason && reason.length > 500) {
    throw new Error('Exclusion reason must be 500 characters or fewer');
  }
  const { rowCount } = await dbQuery(
    `INSERT INTO outreach.analytics_run_exclusions (run_id, excluded_by, reason)
     SELECT r.id, $2::uuid, $3
       FROM outreach.runs r
      WHERE r.id = ANY($1::uuid[])
     ON CONFLICT (run_id) DO UPDATE SET
       excluded_by = EXCLUDED.excluded_by,
       excluded_at = now(),
       reason = EXCLUDED.reason`,
    [ids, input.userId, reason],
  );
  return { excluded: rowCount ?? 0 };
}

export async function includeAnalyticsRuns(input: {
  runIds: string[];
}): Promise<{ included: number }> {
  const ids = [...new Set(input.runIds.filter(Boolean))];
  if (!ids.length) return { included: 0 };
  const { rowCount } = await dbQuery(
    `DELETE FROM outreach.analytics_run_exclusions WHERE run_id = ANY($1::uuid[])`,
    [ids],
  );
  return { included: rowCount ?? 0 };
}
