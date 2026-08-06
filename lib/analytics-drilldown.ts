/**
 * Analytics Drill-Down Engine — generates trend points, campaign comparisons,
 * and individual lead/email item rows for any selected statistic.
 */

import { dbQuery } from '@/lib/db';
import { resolveAnalyticsWindow } from '@/lib/analytics';

export type DailyTrendPoint = {
  date: string;
  value: number;
  secondary_value?: number | null;
};

export type DrilldownCampaignRow = {
  campaign_id: string;
  campaign_name: string;
  metric_value: number;
  formatted_value: string;
  lead_count: number;
  emails_sent: number;
  total_spend_usd: number;
};

export type DrilldownItemRow = {
  id: string;
  lead_name: string;
  lead_company: string | null;
  lead_email: string | null;
  campaign_name: string;
  status_or_event: string;
  cost_usd: number | null;
  occurred_at: string;
  subject?: string | null;
  details?: string | null;
};

export type AnalyticsDrilldownData = {
  metricKey: string;
  title: string;
  unit: 'usd' | 'percent' | 'count';
  totalFormatted: string;
  trend: DailyTrendPoint[];
  campaigns: DrilldownCampaignRow[];
  items: DrilldownItemRow[];
  notes?: string[];
};

export type AnalyticsDrilldownInput = {
  metricKey: string;
  period?: string | null;
  from?: string | null;
  to?: string | null;
  campaignIds?: string[] | null;
  tags?: string[] | null;
  userId?: string | null;
};

function formatUsd(num: number | null | undefined): string {
  if (num == null || Number.isNaN(num)) return '—';
  return `$${num.toFixed(2)}`;
}

function formatPct(num: number | null | undefined): string {
  if (num == null || Number.isNaN(num)) return '—';
  return `${(num * 100).toFixed(1)}%`;
}

function formatCount(num: number | null | undefined): string {
  if (num == null || Number.isNaN(num)) return '0';
  return num.toLocaleString();
}

async function loadExcludedLeadIds(): Promise<string[]> {
  const { rows: runRows } = await dbQuery<{ run_id: string }>(
    `SELECT run_id::text AS run_id FROM outreach.analytics_run_exclusions`,
  );
  if (!runRows.length) return [];
  const runIds = runRows.map((r) => r.run_id);
  const { rows } = await dbQuery<{ lead_id: string }>(
    `SELECT DISTINCT cl.lead_id::text AS lead_id
       FROM outreach.campaign_leads cl
      WHERE cl.run_id = ANY($1::uuid[])
     UNION
     SELECT DISTINCT l.id::text AS lead_id
       FROM outreach.leads l
      WHERE l.source_run_id = ANY($1::uuid[])`,
    [runIds],
  );
  return rows.map((r) => r.lead_id);
}

export async function getMetricDrilldown(input: AnalyticsDrilldownInput): Promise<AnalyticsDrilldownData> {
  const window = resolveAnalyticsWindow(input);
  const excludedLeads = await loadExcludedLeadIds();

  const cleanCampaignIds = input.campaignIds?.filter(Boolean) ?? [];
  const cleanTags = input.tags?.map((t) => t.trim().toLowerCase()).filter(Boolean) ?? [];
  const cleanUserId = input.userId?.trim() || null;

  // Resolve matching campaign IDs
  const { rows: matchingCampaigns } = await dbQuery<{ id: string; name: string }>(
    `SELECT c.id::text AS id, c.name
       FROM outreach.campaigns c
      WHERE ($1::uuid IS NULL OR c.owner_id = $1::uuid)
        AND ($2::uuid[] IS NULL OR cardinality($2::uuid[]) = 0 OR c.id = ANY($2::uuid[]))
        AND ($3::text[] IS NULL OR cardinality($3::text[]) = 0 OR c.id IN (
          SELECT ct.campaign_id FROM outreach.campaign_tags ct WHERE lower(ct.tag) = ANY($3::text[])
        ))`,
    [cleanUserId, cleanCampaignIds.length ? cleanCampaignIds : null, cleanTags.length ? cleanTags : null],
  );

  const campaignIds = matchingCampaigns.map((c) => c.id);
  const safeCampaignIds = campaignIds.length ? campaignIds : ['00000000-0000-0000-0000-000000000000'];

  const metricKey = input.metricKey || 'total_spend';

  let title = 'Statistic Overview';
  let unit: 'usd' | 'percent' | 'count' = 'usd';
  let totalFormatted = '—';

  // 1. Daily Trend Points query
  const { rows: dailyRows } = await dbQuery<{
    day: string;
    total_cost: string;
    enrichment_cost: string;
    drafting_cost: string;
    sent_count: string;
    delivered_count: string;
    opened_count: string;
    clicked_count: string;
    replied_count: string;
  }>(
    `WITH days AS (
       SELECT generate_series($1::timestamptz, $2::timestamptz, interval '1 day')::date AS day
     ),
     cost_daily AS (
       SELECT date_trunc('day', created_at)::date AS day,
              sum(actual_cost_usd) AS enrichment_cost,
              0::numeric AS drafting_cost
         FROM outreach.lead_cost_events e
        WHERE e.created_at >= $1::timestamptz AND e.created_at <= $2::timestamptz
          AND e.phase = 'enrichment'
          AND e.campaign_id = ANY($3::uuid[])
          AND ($4::uuid[] IS NULL OR cardinality($4::uuid[]) = 0 OR e.lead_id <> ALL($4::uuid[]))
        GROUP BY 1
       UNION ALL
       SELECT date_trunc('day', event.created_at)::date AS day,
              0::numeric AS enrichment_cost,
              sum(event.actual_cost_usd) AS drafting_cost
         FROM outreach.drafting_job_cost_events event
         JOIN outreach.drafting_items item ON item.id = event.drafting_item_id
         JOIN outreach.drafting_workspaces workspace ON workspace.id = item.workspace_id
        WHERE event.created_at >= $1::timestamptz AND event.created_at <= $2::timestamptz
          AND workspace.campaign_id = ANY($3::uuid[])
          AND ($4::uuid[] IS NULL OR cardinality($4::uuid[]) = 0 OR item.lead_id <> ALL($4::uuid[]))
        GROUP BY 1
       UNION ALL
       SELECT date_trunc('day', occurred_at)::date AS day,
              0::numeric AS enrichment_cost,
              sum(actual_cost_usd) AS drafting_cost
         FROM outreach.drafting_run_cost_opening_balances opening
        WHERE occurred_at >= $1::timestamptz AND occurred_at <= $2::timestamptz
          AND campaign_id = ANY($3::uuid[])
        GROUP BY 1
     ),
     send_daily AS (
       SELECT date_trunc('day', i.updated_at)::date AS day,
              count(*) FILTER (WHERE i.delivery_snapshot ? 'sentAt' OR i.delivery_snapshot ? 'gmailMessageId' OR s.status = 'sent') AS sent_count,
              count(*) FILTER (WHERE s.delivered_at IS NOT NULL) AS delivered_count,
              count(*) FILTER (WHERE s.opened_at IS NOT NULL) AS opened_count,
              count(*) FILTER (WHERE s.clicked_at IS NOT NULL) AS clicked_count,
              count(*) FILTER (WHERE s.replied_at IS NOT NULL) AS replied_count
         FROM outreach.drafting_items i
         JOIN outreach.drafting_workspaces w ON w.id = i.workspace_id
         LEFT JOIN outreach.email_sends s ON s.drafting_item_id = i.id AND s.status = 'sent'
        WHERE i.updated_at >= $1::timestamptz AND i.updated_at <= $2::timestamptz
          AND w.campaign_id = ANY($3::uuid[])
          AND ($4::uuid[] IS NULL OR cardinality($4::uuid[]) = 0 OR i.lead_id <> ALL($4::uuid[]))
        GROUP BY 1
     )
     SELECT d.day::text AS day,
            coalesce(sum(c.enrichment_cost + c.drafting_cost), 0)::text AS total_cost,
            coalesce(sum(c.enrichment_cost), 0)::text AS enrichment_cost,
            coalesce(sum(c.drafting_cost), 0)::text AS drafting_cost,
            coalesce(sum(s.sent_count), 0)::text AS sent_count,
            coalesce(sum(s.delivered_count), 0)::text AS delivered_count,
            coalesce(sum(s.opened_count), 0)::text AS opened_count,
            coalesce(sum(s.clicked_count), 0)::text AS clicked_count,
            coalesce(sum(s.replied_count), 0)::text AS replied_count
       FROM days d
  LEFT JOIN cost_daily c ON c.day = d.day
  LEFT JOIN send_daily s ON s.day = d.day
   GROUP BY d.day
   ORDER BY d.day ASC`,
    [window.from, window.to, safeCampaignIds, excludedLeads.length ? excludedLeads : null],
  );

  const trend: DailyTrendPoint[] = dailyRows.map((r) => {
    let val = 0;
    const sent = Number(r.sent_count);
    const deliv = Number(r.delivered_count);
    const totalC = Number(r.total_cost);
    const draftC = Number(r.drafting_cost);
    const enrichC = Number(r.enrichment_cost);

    if (metricKey === 'spend_per_lead' || metricKey === 'total_spend') val = totalC;
    else if (metricKey === 'cost_per_drafting' || metricKey === 'aggregated_drafting') val = draftC;
    else if (metricKey === 'cost_per_enrichment' || metricKey === 'aggregated_enrichment') val = enrichC;
    else if (metricKey === 'delivery_rate') val = sent > 0 ? deliv / sent : 0;
    else if (metricKey === 'open_rate') val = deliv > 0 ? Number(r.opened_count) / deliv : 0;
    else if (metricKey === 'click_rate') val = deliv > 0 ? Number(r.clicked_count) / deliv : 0;
    else if (metricKey === 'reply_rate') val = deliv > 0 ? Number(r.replied_count) / deliv : 0;
    else if (metricKey === 'emails_sent') val = sent;
    else if (metricKey === 'campaigns_count') val = safeCampaignIds.length;

    return {
      date: r.day,
      value: val,
    };
  });

  // 2. Campaign breakdown query
  const { rows: campRows } = await dbQuery<{
    campaign_id: string;
    campaign_name: string;
    lead_count: string;
    emails_sent: string;
    emails_delivered: string;
    emails_opened: string;
    emails_clicked: string;
    emails_replied: string;
    enrichment_cost: string;
    drafting_cost: string;
  }>(
    `SELECT c.id::text AS campaign_id,
            c.name AS campaign_name,
            coalesce((SELECT count(DISTINCT cl.lead_id)::text FROM outreach.campaign_leads cl WHERE cl.campaign_id = c.id), '0') AS lead_count,
            coalesce(sum(CASE WHEN i.delivery_snapshot ? 'sentAt' OR i.delivery_snapshot ? 'gmailMessageId' OR s.status = 'sent' THEN 1 ELSE 0 END), 0)::text AS emails_sent,
            coalesce(sum(CASE WHEN s.delivered_at IS NOT NULL THEN 1 ELSE 0 END), 0)::text AS emails_delivered,
            coalesce(sum(CASE WHEN s.opened_at IS NOT NULL THEN 1 ELSE 0 END), 0)::text AS emails_opened,
            coalesce(sum(CASE WHEN s.clicked_at IS NOT NULL THEN 1 ELSE 0 END), 0)::text AS emails_clicked,
            coalesce(sum(CASE WHEN s.replied_at IS NOT NULL THEN 1 ELSE 0 END), 0)::text AS emails_replied,
            coalesce((
              SELECT sum(e.actual_cost_usd)::text FROM outreach.lead_cost_events e
               WHERE e.campaign_id = c.id AND e.created_at >= $1::timestamptz AND e.created_at <= $2::timestamptz AND e.phase = 'enrichment'
            ), '0') AS enrichment_cost,
            coalesce((
              SELECT sum(event.actual_cost_usd)::text FROM outreach.drafting_job_cost_events event
                JOIN outreach.drafting_items item ON item.id = event.drafting_item_id
                JOIN outreach.drafting_workspaces workspace ON workspace.id = item.workspace_id
               WHERE workspace.campaign_id = c.id AND event.created_at >= $1::timestamptz AND event.created_at <= $2::timestamptz
            ), '0') AS drafting_cost
       FROM outreach.campaigns c
  LEFT JOIN outreach.drafting_workspaces w ON w.campaign_id = c.id
  LEFT JOIN outreach.drafting_items i ON i.workspace_id = w.id AND i.updated_at >= $1::timestamptz AND i.updated_at <= $2::timestamptz
  LEFT JOIN outreach.email_sends s ON s.drafting_item_id = i.id AND s.status = 'sent'
      WHERE c.id = ANY($3::uuid[])
   GROUP BY c.id, c.name`,
    [window.from, window.to, safeCampaignIds],
  );

  const campaigns: DrilldownCampaignRow[] = campRows.map((r) => {
    const lCount = Number(r.lead_count);
    const sent = Number(r.emails_sent);
    const deliv = Number(r.emails_delivered);
    const opened = Number(r.emails_opened);
    const clicked = Number(r.emails_clicked);
    const replied = Number(r.emails_replied);
    const enrichC = Number(r.enrichment_cost);
    const draftC = Number(r.drafting_cost);
    const totalS = enrichC + draftC;

    let val = 0;
    let fmt = '—';

    if (metricKey === 'spend_per_lead') {
      title = 'Spend Per Lead';
      unit = 'usd';
      val = lCount > 0 ? totalS / lCount : 0;
      fmt = formatUsd(val);
    } else if (metricKey === 'cost_per_drafting') {
      title = 'Cost Per Drafting Item';
      unit = 'usd';
      val = sent > 0 ? draftC / sent : 0;
      fmt = formatUsd(val);
    } else if (metricKey === 'cost_per_enrichment') {
      title = 'Cost Per Enrichment';
      unit = 'usd';
      val = lCount > 0 ? enrichC / lCount : 0;
      fmt = formatUsd(val);
    } else if (metricKey === 'aggregated_drafting') {
      title = 'Aggregated Drafting Cost';
      unit = 'usd';
      val = draftC;
      fmt = formatUsd(val);
    } else if (metricKey === 'aggregated_enrichment') {
      title = 'Aggregated Enrichment Cost';
      unit = 'usd';
      val = enrichC;
      fmt = formatUsd(val);
    } else if (metricKey === 'total_spend') {
      title = 'Total Campaign Spend';
      unit = 'usd';
      val = totalS;
      fmt = formatUsd(val);
    } else if (metricKey === 'delivery_rate') {
      title = 'Email Delivery Rate';
      unit = 'percent';
      val = sent > 0 ? deliv / sent : 0;
      fmt = formatPct(val);
    } else if (metricKey === 'open_rate') {
      title = 'Email Open Rate';
      unit = 'percent';
      val = deliv > 0 ? opened / deliv : 0;
      fmt = formatPct(val);
    } else if (metricKey === 'click_rate') {
      title = 'Email Click Rate';
      unit = 'percent';
      val = deliv > 0 ? clicked / deliv : 0;
      fmt = formatPct(val);
    } else if (metricKey === 'reply_rate') {
      title = 'Email Reply Rate';
      unit = 'percent';
      val = deliv > 0 ? replied / deliv : 0;
      fmt = formatPct(val);
    } else if (metricKey === 'emails_sent') {
      title = 'Emails Sent Volume';
      unit = 'count';
      val = sent;
      fmt = formatCount(val);
    } else if (metricKey === 'campaigns_count') {
      title = 'Campaigns Conducted';
      unit = 'count';
      val = 1;
      fmt = '1';
    }

    return {
      campaign_id: r.campaign_id,
      campaign_name: r.campaign_name,
      metric_value: val,
      formatted_value: fmt,
      lead_count: lCount,
      emails_sent: sent,
      total_spend_usd: totalS,
    };
  }).sort((a, b) => b.metric_value - a.metric_value);

  // Set total formatted summary
  if (unit === 'usd') {
    const tot = campaigns.reduce((acc, c) => acc + c.total_spend_usd, 0);
    totalFormatted = formatUsd(tot);
  } else if (unit === 'count') {
    const tot = campaigns.reduce((acc, c) => acc + c.emails_sent, 0);
    totalFormatted = metricKey === 'campaigns_count' ? formatCount(campaigns.length) : formatCount(tot);
  } else if (unit === 'percent') {
    const totalSent = campaigns.reduce((acc, c) => acc + c.emails_sent, 0);
    const avgPct = campaigns.length > 0 ? campaigns.reduce((acc, c) => acc + c.metric_value, 0) / campaigns.length : 0;
    totalFormatted = formatPct(avgPct);
  }

  // 3. Detailed lead / email item rows query
  const { rows: itemRows } = await dbQuery<{
    id: string;
    full_name: string;
    company_name: string | null;
    email_primary: string | null;
    campaign_name: string;
    state: string;
    created_at: Date;
    subject: string | null;
    delivered_at: Date | null;
    opened_at: Date | null;
    clicked_at: Date | null;
    replied_at: Date | null;
  }>(
    `SELECT i.id::text AS id,
            coalesce(l.full_name, 'Unknown Lead') AS full_name,
            l.company_name,
            l.email_primary,
            c.name AS campaign_name,
            i.state,
            i.updated_at AS created_at,
            s.subject,
            s.delivered_at,
            s.opened_at,
            s.clicked_at,
            s.replied_at
       FROM outreach.drafting_items i
       JOIN outreach.drafting_workspaces w ON w.id = i.workspace_id
       JOIN outreach.campaigns c ON c.id = w.campaign_id
       JOIN outreach.leads l ON l.id = i.lead_id
  LEFT JOIN outreach.email_sends s ON s.drafting_item_id = i.id AND s.status = 'sent'
      WHERE c.id = ANY($3::uuid[])
        AND i.updated_at >= $1::timestamptz AND i.updated_at <= $2::timestamptz
        AND ($4::uuid[] IS NULL OR cardinality($4::uuid[]) = 0 OR i.lead_id <> ALL($4::uuid[]))
      ORDER BY i.updated_at DESC
      LIMIT 100`,
    [window.from, window.to, safeCampaignIds, excludedLeads.length ? excludedLeads : null],
  );

  const items: DrilldownItemRow[] = itemRows.map((r) => {
    let status = r.state;
    if (r.replied_at) status = 'Replied';
    else if (r.clicked_at) status = 'Clicked';
    else if (r.opened_at) status = 'Opened';
    else if (r.delivered_at) status = 'Delivered';

    return {
      id: r.id,
      lead_name: r.full_name,
      lead_company: r.company_name,
      lead_email: r.email_primary,
      campaign_name: r.campaign_name,
      status_or_event: status,
      cost_usd: null,
      occurred_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
      subject: r.subject,
    };
  });

  return {
    metricKey,
    title,
    unit,
    totalFormatted,
    trend,
    campaigns,
    items,
  };
}
