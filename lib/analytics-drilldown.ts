/**
 * Analytics Drill-Down Engine — generates trend points, campaign comparisons,
 * and individual lead/email item rows for any selected statistic.
 */

import {
  completeUtcDaysInWindow,
  loadAnthropicBilledBreakdown,
  loadAnthropicBilledByModel,
  loadAnthropicBilledDaily,
  loadAttributedCostByCampaign,
  loadAttributedCostDaily,
} from '@/lib/analytics-attributed-cost';
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

function attributedDayTotal(row: {
  enrichment_cost: string;
  drafting_cost: string;
  replies_cost: string;
  extraction_cost: string;
  dashboards_cost: string;
}): number {
  return (
    Number(row.enrichment_cost)
    + Number(row.drafting_cost)
    + Number(row.replies_cost)
    + Number(row.extraction_cost)
    + Number(row.dashboards_cost)
  );
}

export async function getMetricDrilldown(input: AnalyticsDrilldownInput): Promise<AnalyticsDrilldownData> {
  const window = resolveAnalyticsWindow(input);
  const excludedRunIds = await loadExcludedRunIds();
  const excludedLeads = await loadExcludedLeadIds(excludedRunIds);

  const cleanCampaignIds = input.campaignIds?.filter(Boolean) ?? [];
  const cleanTags = input.tags?.map((t) => t.trim().toLowerCase()).filter(Boolean) ?? [];
  const cleanUserId = input.userId?.trim() || null;

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
  const billedDays = completeUtcDaysInWindow(window);

  if (metricKey === 'anthropic_billed' || metricKey === 'spend_variance') {
    return billedDrilldown(metricKey, window, billedDays, safeCampaignIds, excludedLeads, excludedRunIds);
  }

  let title = 'Statistic Overview';
  let unit: 'usd' | 'percent' | 'count' = 'usd';
  let totalFormatted = '—';

  const [dailyCost, sendDaily] = await Promise.all([
    loadAttributedCostDaily({
      from: window.from,
      to: window.to,
      campaignIds: safeCampaignIds,
      excludedLeadIds: excludedLeads,
      excludedRunIds,
    }),
    dbQuery<{
      day: string;
      sent_count: string;
      delivered_count: string;
      opened_count: string;
      clicked_count: string;
      replied_count: string;
    }>(
      `WITH days AS (
         SELECT generate_series($1::timestamptz, $2::timestamptz, interval '1 day')::date AS day
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
              coalesce(s.sent_count, 0)::text AS sent_count,
              coalesce(s.delivered_count, 0)::text AS delivered_count,
              coalesce(s.opened_count, 0)::text AS opened_count,
              coalesce(s.clicked_count, 0)::text AS clicked_count,
              coalesce(s.replied_count, 0)::text AS replied_count
         FROM days d
    LEFT JOIN send_daily s ON s.day = d.day
     ORDER BY d.day ASC`,
      [window.from, window.to, safeCampaignIds, excludedLeads.length ? excludedLeads : null],
    ),
  ]);

  const sendByDay = new Map(sendDaily.rows.map((r) => [r.day, r]));
  const trend: DailyTrendPoint[] = dailyCost.map((r) => {
    const send = sendByDay.get(r.day);
    const sent = Number(send?.sent_count ?? 0);
    const deliv = Number(send?.delivered_count ?? 0);
    const totalC = attributedDayTotal(r);
    const draftC = Number(r.drafting_cost);
    const enrichC = Number(r.enrichment_cost);
    let val = 0;
    if (metricKey === 'spend_per_lead' || metricKey === 'total_spend' || metricKey === 'hub_attributed') val = totalC;
    else if (metricKey === 'cost_per_drafting' || metricKey === 'aggregated_drafting') val = draftC;
    else if (metricKey === 'cost_per_enrichment' || metricKey === 'aggregated_enrichment') val = enrichC;
    else if (metricKey === 'delivery_rate') val = sent > 0 ? deliv / sent : 0;
    else if (metricKey === 'open_rate') val = deliv > 0 ? Number(send?.opened_count ?? 0) / deliv : 0;
    else if (metricKey === 'click_rate') val = deliv > 0 ? Number(send?.clicked_count ?? 0) / deliv : 0;
    else if (metricKey === 'reply_rate') val = deliv > 0 ? Number(send?.replied_count ?? 0) / deliv : 0;
    else if (metricKey === 'emails_sent') val = sent;
    else if (metricKey === 'campaigns_count') val = safeCampaignIds[0] === '00000000-0000-0000-0000-000000000000' ? 0 : safeCampaignIds.length;
    return { date: r.day, value: val };
  });

  const [campRows, costByCampaign] = await Promise.all([
    dbQuery<{
      campaign_id: string;
      campaign_name: string;
      lead_count: string;
      emails_sent: string;
      emails_delivered: string;
      emails_opened: string;
      emails_clicked: string;
      emails_replied: string;
    }>(
      `SELECT c.id::text AS campaign_id,
              c.name AS campaign_name,
              coalesce((SELECT count(DISTINCT cl.lead_id)::text FROM outreach.campaign_leads cl WHERE cl.campaign_id = c.id), '0') AS lead_count,
              coalesce(sum(CASE WHEN i.delivery_snapshot ? 'sentAt' OR i.delivery_snapshot ? 'gmailMessageId' OR s.status = 'sent' THEN 1 ELSE 0 END), 0)::text AS emails_sent,
              coalesce(sum(CASE WHEN s.delivered_at IS NOT NULL THEN 1 ELSE 0 END), 0)::text AS emails_delivered,
              coalesce(sum(CASE WHEN s.opened_at IS NOT NULL THEN 1 ELSE 0 END), 0)::text AS emails_opened,
              coalesce(sum(CASE WHEN s.clicked_at IS NOT NULL THEN 1 ELSE 0 END), 0)::text AS emails_clicked,
              coalesce(sum(CASE WHEN s.replied_at IS NOT NULL THEN 1 ELSE 0 END), 0)::text AS emails_replied
         FROM outreach.campaigns c
    LEFT JOIN outreach.drafting_workspaces w ON w.campaign_id = c.id
    LEFT JOIN outreach.drafting_items i ON i.workspace_id = w.id AND i.updated_at >= $1::timestamptz AND i.updated_at <= $2::timestamptz
    LEFT JOIN outreach.email_sends s ON s.drafting_item_id = i.id AND s.status = 'sent'
        WHERE c.id = ANY($3::uuid[])
     GROUP BY c.id, c.name`,
      [window.from, window.to, safeCampaignIds],
    ),
    loadAttributedCostByCampaign({
      from: window.from,
      to: window.to,
      campaignIds: safeCampaignIds,
      excludedLeadIds: excludedLeads,
      excludedRunIds,
    }),
  ]);

  const costMap = new Map(costByCampaign.map((row) => [row.campaign_id, row]));

  const campaigns: DrilldownCampaignRow[] = campRows.rows.map((r) => {
    const lCount = Number(r.lead_count);
    const sent = Number(r.emails_sent);
    const deliv = Number(r.emails_delivered);
    const opened = Number(r.emails_opened);
    const clicked = Number(r.emails_clicked);
    const replied = Number(r.emails_replied);
    const cost = costMap.get(r.campaign_id);
    const enrichC = Number(cost?.enrichment_cost ?? 0);
    const draftC = Number(cost?.drafting_cost ?? 0);
    const repliesC = Number(cost?.replies_cost ?? 0);
    const extractC = Number(cost?.extraction_cost ?? 0);
    const enrichJobs = Number(cost?.enrichment_jobs ?? 0);
    const totalS = enrichC + draftC + repliesC + extractC;

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
      val = enrichJobs > 0 ? enrichC / enrichJobs : 0;
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
    } else if (metricKey === 'total_spend' || metricKey === 'hub_attributed') {
      title = metricKey === 'hub_attributed' ? 'Hub Attributed Claude' : 'Total Campaign Spend';
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
      const baseDenom = deliv > 0 ? deliv : sent;
      val = baseDenom > 0 ? opened / baseDenom : 0;
      fmt = formatPct(val);
    } else if (metricKey === 'click_rate') {
      title = 'Email Click Rate';
      unit = 'percent';
      const baseDenom = deliv > 0 ? deliv : sent;
      val = baseDenom > 0 ? clicked / baseDenom : 0;
      fmt = formatPct(val);
    } else if (metricKey === 'reply_rate') {
      title = 'Email Reply Rate';
      unit = 'percent';
      const baseDenom = deliv > 0 ? deliv : sent;
      val = baseDenom > 0 ? replied / baseDenom : 0;
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

  const totalLeads = campRows.rows.reduce((acc, r) => acc + Number(r.lead_count), 0);
  const totalSent = campRows.rows.reduce((acc, r) => acc + Number(r.emails_sent), 0);
  const totalDelivered = campRows.rows.reduce((acc, r) => acc + Number(r.emails_delivered), 0);
  const totalOpened = campRows.rows.reduce((acc, r) => acc + Number(r.emails_opened), 0);
  const totalClicked = campRows.rows.reduce((acc, r) => acc + Number(r.emails_clicked), 0);
  const totalReplied = campRows.rows.reduce((acc, r) => acc + Number(r.emails_replied), 0);
  const totalEnrichmentCost = costByCampaign.reduce((acc, r) => acc + Number(r.enrichment_cost), 0);
  const totalDraftingCost = costByCampaign.reduce((acc, r) => acc + Number(r.drafting_cost), 0);
  const totalReplyCost = costByCampaign.reduce((acc, r) => acc + Number(r.replies_cost), 0);
  const totalExtractionCost = costByCampaign.reduce((acc, r) => acc + Number(r.extraction_cost), 0);
  const totalEnrichmentJobs = costByCampaign.reduce((acc, r) => acc + Number(r.enrichment_jobs), 0);
  const dashboardCost = dailyCost.reduce((acc, r) => acc + Number(r.dashboards_cost), 0);
  const totalSpend = totalEnrichmentCost + totalDraftingCost + totalReplyCost + totalExtractionCost + dashboardCost;

  if (metricKey === 'spend_per_lead') {
    totalFormatted = totalLeads > 0 ? formatUsd(totalSpend / totalLeads) : '$0.00';
  } else if (metricKey === 'cost_per_drafting') {
    totalFormatted = totalSent > 0 ? formatUsd(totalDraftingCost / totalSent) : '$0.00';
  } else if (metricKey === 'cost_per_enrichment') {
    totalFormatted = totalEnrichmentJobs > 0 ? formatUsd(totalEnrichmentCost / totalEnrichmentJobs) : '$0.00';
  } else if (metricKey === 'aggregated_drafting') {
    totalFormatted = formatUsd(totalDraftingCost);
  } else if (metricKey === 'aggregated_enrichment') {
    totalFormatted = formatUsd(totalEnrichmentCost);
  } else if (metricKey === 'total_spend' || metricKey === 'hub_attributed') {
    totalFormatted = formatUsd(totalSpend);
  } else if (metricKey === 'delivery_rate') {
    totalFormatted = totalSent > 0 ? formatPct(totalDelivered / totalSent) : '—';
  } else if (metricKey === 'open_rate') {
    const baseDenom = totalDelivered > 0 ? totalDelivered : totalSent;
    totalFormatted = baseDenom > 0 ? formatPct(totalOpened / baseDenom) : '—';
  } else if (metricKey === 'click_rate') {
    const baseDenom = totalDelivered > 0 ? totalDelivered : totalSent;
    totalFormatted = baseDenom > 0 ? formatPct(totalClicked / baseDenom) : '—';
  } else if (metricKey === 'reply_rate') {
    const baseDenom = totalDelivered > 0 ? totalDelivered : totalSent;
    totalFormatted = baseDenom > 0 ? formatPct(totalReplied / baseDenom) : '—';
  } else if (metricKey === 'emails_sent') {
    totalFormatted = formatCount(totalSent);
  } else if (metricKey === 'campaigns_count') {
    totalFormatted = formatCount(campaigns.length);
  }

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
    notes: [
      'Attributed Claude is a UNION of drafting events, company research jobs, reply drafts, extraction, and dashboard summaries.',
      'Shared company research jobs appear under every intersecting campaign; org totals count each job once.',
    ],
  };
}

async function billedDrilldown(
  metricKey: string,
  window: { from: string; to: string },
  billedDays: { fromDay: string; toDay: string } | null,
  safeCampaignIds: string[],
  excludedLeads: string[],
  excludedRunIds: string[],
): Promise<AnalyticsDrilldownData> {
  const isVariance = metricKey === 'spend_variance';
  const title = isVariance ? 'Billed − Attributed Variance' : 'Anthropic Billed (Cost API)';
  const notes = [
    'Billed totals come from Anthropic Cost API daily buckets (complete UTC days only).',
    'Today is excluded because the current UTC day is incomplete and Cost API can lag ~5 minutes.',
    'Billed is org-wide and does not split by campaign. Playground and unrecorded calls show up here only.',
  ];

  if (!billedDays) {
    return {
      metricKey,
      title,
      unit: 'usd',
      totalFormatted: '$0.00',
      trend: [],
      campaigns: [],
      items: [],
      notes: [...notes, 'No complete UTC days in this window yet.'],
    };
  }

  const [billedDaily, billedByModel, billedItems, attributedDaily] = await Promise.all([
    loadAnthropicBilledDaily(billedDays.fromDay, billedDays.toDay),
    loadAnthropicBilledByModel(billedDays.fromDay, billedDays.toDay),
    loadAnthropicBilledBreakdown(billedDays.fromDay, billedDays.toDay),
    isVariance
      ? loadAttributedCostDaily({
          from: window.from,
          to: window.to,
          campaignIds: safeCampaignIds,
          excludedLeadIds: excludedLeads,
          excludedRunIds,
        })
      : Promise.resolve([]),
  ]);

  const billedByDay = new Map(billedDaily.map((r) => [r.day, Number(r.billed)]));
  const attributedByDay = new Map(
    attributedDaily.map((r) => [r.day, attributedDayTotal(r)]),
  );

  const trendDays: string[] = [];
  for (let d = new Date(`${billedDays.fromDay}T00:00:00.000Z`); d.toISOString().slice(0, 10) <= billedDays.toDay; d.setUTCDate(d.getUTCDate() + 1)) {
    trendDays.push(d.toISOString().slice(0, 10));
  }

  const trend: DailyTrendPoint[] = trendDays.map((day) => {
    const billed = billedByDay.get(day) ?? 0;
    const attributed = attributedByDay.get(day) ?? 0;
    return { date: day, value: isVariance ? billed - attributed : billed };
  });

  const billedTotal = billedDaily.reduce((acc, r) => acc + Number(r.billed), 0);
  const attributedTotal = attributedDaily.reduce((acc, r) => acc + attributedDayTotal(r), 0);
  const total = isVariance ? billedTotal - attributedTotal : billedTotal;

  const campaigns: DrilldownCampaignRow[] = billedByModel.map((row) => ({
    campaign_id: row.model,
    campaign_name: row.model,
    metric_value: Number(row.amount_usd),
    formatted_value: formatUsd(Number(row.amount_usd)),
    lead_count: 0,
    emails_sent: 0,
    total_spend_usd: Number(row.amount_usd),
  }));

  const items: DrilldownItemRow[] = billedItems.map((row, index) => ({
    id: `${row.day}:${row.model ?? ''}:${row.token_type ?? ''}:${index}`,
    lead_name: row.token_type || '(no token type)',
    lead_company: row.model,
    lead_email: null,
    campaign_name: row.model || '(unspecified model)',
    status_or_event: row.cost_type || 'tokens',
    cost_usd: Number(row.amount_usd),
    occurred_at: `${row.day}T00:00:00.000Z`,
    details: row.description,
  }));

  return {
    metricKey,
    title,
    unit: 'usd',
    totalFormatted: formatUsd(total),
    trend,
    campaigns,
    items,
    notes,
  };
}
