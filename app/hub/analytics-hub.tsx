'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Filter, X, Plus, ChevronRight, DollarSign, Send, CheckCircle2, Eye, MousePointer, MessageSquare, Tag, User as UserIcon } from 'lucide-react';
import { TagBadge } from '@/app/components/tag-badge';
import { TagInputPopover } from '@/app/components/tag-input-popover';
import { requestJson } from '@/lib/client-request';
import { AnalyticsSummary, AnalyticsCampaignRow } from '@/lib/analytics';
import { AnalyticsDrilldownDrawer } from '@/app/hub/analytics-drilldown-drawer';

type Period = 'week' | 'month' | 'custom';
type ViewMode = 'campaigns' | 'per_user';

type RunRow = {
  id: string;
  campaign_name: string;
  run_type: string;
  status: string;
  lead_count: number;
  created_at: string;
  excluded: boolean;
  reason: string | null;
};

function formatUsd(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return '—';
  return `$${value.toFixed(2)}`;
}

function formatPct(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

export function AnalyticsHub() {
  const [period, setPeriod] = useState<Period>('week');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  // Filters
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>('');

  const [viewMode, setViewMode] = useState<ViewMode>('campaigns');
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [selectedExclusions, setSelectedExclusions] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Drilldown state
  const [drilldownMetricKey, setDrilldownMetricKey] = useState<string | null>(null);

  // Inline Tagging state for Campaign Matrix
  const [editingTagCampaignId, setEditingTagCampaignId] = useState<string | null>(null);

  const summaryEnabled = period !== 'custom' || (Boolean(customFrom) && Boolean(customTo));

  const activeFilterCount =
    (selectedCampaignIds.length ? 1 : 0) +
    (selectedTags.length ? 1 : 0) +
    (selectedUserId ? 1 : 0) +
    (period === 'custom' ? 1 : 0);

  async function load() {
    if (!summaryEnabled) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ period });
      if (period === 'custom') {
        params.set('from', customFrom);
        params.set('to', customTo);
      }
      if (selectedCampaignIds.length) {
        params.set('campaignIds', selectedCampaignIds.join(','));
      }
      if (selectedTags.length) {
        params.set('tags', selectedTags.join(','));
      }
      if (selectedUserId) {
        params.set('userId', selectedUserId);
      }

      const [summaryData, runsData] = await Promise.all([
        requestJson<AnalyticsSummary>(`/api/analytics/summary?${params.toString()}`),
        requestJson<{ runs: RunRow[] }>('/api/analytics/runs'),
      ]);
      setSummary(summaryData);
      setRuns(runsData.runs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load analytics');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, customFrom, customTo, selectedCampaignIds, selectedTags, selectedUserId]);

  const selectedExcluded = useMemo(
    () => [...selectedExclusions].every((id) => runs.find((r) => r.id === id)?.excluded),
    [selectedExclusions, runs],
  );

  function toggleExclusion(id: string) {
    setSelectedExclusions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function excludeSelected() {
    setBusy(true);
    try {
      await requestJson('/api/analytics/runs/exclude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runIds: [...selectedExclusions] }),
      });
      setSelectedExclusions(new Set());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to exclude runs');
    } finally {
      setBusy(false);
    }
  }

  async function includeSelected() {
    setBusy(true);
    try {
      await requestJson('/api/analytics/runs/include', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runIds: [...selectedExclusions] }),
      });
      setSelectedExclusions(new Set());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to include runs');
    } finally {
      setBusy(false);
    }
  }

  function resetFilters() {
    setPeriod('week');
    setCustomFrom('');
    setCustomTo('');
    setSelectedCampaignIds([]);
    setSelectedTags([]);
    setSelectedUserId('');
  }

  function toggleTagFilter(tag: string) {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  }

  function toggleCampaignFilter(id: string) {
    setSelectedCampaignIds((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id],
    );
  }

  async function handleAddTag(campaignId: string, tagName: string, colorId: string) {
    try {
      await requestJson(`/api/campaigns/${campaignId}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: tagName, color: colorId }),
      });
      setEditingTagCampaignId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to add tag');
    }
  }

  async function handleRemoveTag(campaignId: string, tag: string) {
    try {
      await requestJson(`/api/campaigns/${campaignId}/tags?tag=${encodeURIComponent(tag)}`, {
        method: 'DELETE',
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to remove tag');
    }
  }

  const metrics = summary?.aggregate;

  return (
    <main className="app-shell">
      <section className="card">
        <div className="card__header">
          <div>
            <div className="card__title">Analytics Hub</div>
            <div className="card__subtitle">Cold outreach campaign spend & conversion actuals</div>
          </div>
          <Link href="/hub" className="btn btn--secondary">← Outreach Hub</Link>
        </div>

        <div className="card__body analytics-hub">
          {error && <p className="field__error">{error}</p>}

          {/* ──────────────── 1. Top Filter Toolbar ──────────────── */}
          <section
            className="analytics-toolbar card"
            style={{
              padding: 'var(--space-4)',
              marginBottom: 'var(--space-6)',
              background: 'var(--color-surface-2)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-3)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Filter size={16} style={{ color: 'var(--color-primary)' }} />
                <span style={{ fontWeight: 'bold', fontSize: 'var(--font-size-sm)' }}>Analytics Filters</span>
                {activeFilterCount > 0 && (
                  <span className="pill" style={{ background: 'var(--color-primary)', color: 'white', fontSize: '11px', fontWeight: 'bold' }}>
                    {activeFilterCount} Active
                  </span>
                )}
              </div>

              {activeFilterCount > 0 && (
                <button type="button" className="btn btn--quiet" style={{ fontSize: 'var(--font-size-xs)' }} onClick={resetFilters}>
                  Clear all filters
                </button>
              )}
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)', alignItems: 'center' }}>
              {/* Date Range Selector */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-subtle)', fontWeight: 'bold' }}>Date Range</span>
                <div className="segmented">
                  {([
                    ['week', '1 week'],
                    ['month', '1 month'],
                    ['custom', 'Custom'],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={period === value ? 'segmented__item segmented__item--active' : 'segmented__item'}
                      onClick={() => setPeriod(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {period === 'custom' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-subtle)', fontWeight: 'bold' }}>Custom Bounds</span>
                  <div className="analytics-hub__dates">
                    <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
                    <span>to</span>
                    <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
                  </div>
                </div>
              )}

              {/* User Filter */}
              {summary?.available_users?.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-subtle)', fontWeight: 'bold' }}>User Owner</span>
                  <select
                    className="field__input"
                    style={{ height: '32px', padding: '0 8px', fontSize: 'var(--font-size-xs)', minWidth: '150px' }}
                    value={selectedUserId}
                    onChange={(e) => setSelectedUserId(e.target.value)}
                  >
                    <option value="">All Users</option>
                    {summary.available_users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name || u.email}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {/* Campaign Multiselect Filter */}
              {summary?.available_campaigns?.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: '200px' }}>
                  <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-subtle)', fontWeight: 'bold' }}>Campaigns</span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', maxHeight: '64px', overflowY: 'auto' }}>
                    {summary.available_campaigns.map((c) => {
                      const isSelected = selectedCampaignIds.includes(c.id);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => toggleCampaignFilter(c.id)}
                          style={{
                            border: '1px solid var(--color-border)',
                            background: isSelected ? 'var(--color-primary-soft)' : 'var(--color-surface)',
                            color: isSelected ? 'var(--color-primary)' : 'var(--color-text-muted)',
                            fontWeight: isSelected ? 'bold' : 'normal',
                            borderRadius: 'var(--radius-pill)',
                            padding: '2px 8px',
                            fontSize: '11px',
                            cursor: 'pointer',
                          }}
                        >
                          {isSelected ? '✓ ' : ''}{c.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>

            {/* Custom Tag Pills Filter */}
            {summary?.available_tags?.length ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingTop: '4px', borderTop: '1px solid var(--color-border)' }}>
                <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-subtle)', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Tag size={12} /> Tags:
                </span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {summary.available_tags.map((tag) => {
                    const isSelected = selectedTags.includes(tag);
                    return (
                      <TagBadge
                        key={tag}
                        tag={tag}
                        isSelected={isSelected}
                        onClick={() => toggleTagFilter(tag)}
                        size="sm"
                      />
                    );
                  })}
                </div>
              </div>
            ) : null}
          </section>

          {loading && <p className="text-muted">Loading analytics…</p>}

          {!loading && metrics && (
            <>
              {/* ──────────────── 2. Spend Analytics Section ──────────────── */}
              <section style={{ marginBottom: 'var(--space-6)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: 'var(--space-3)' }}>
                  <DollarSign size={18} style={{ color: 'var(--color-primary)' }} />
                  <h3 style={{ fontSize: 'var(--font-size-md)', fontWeight: 'bold', margin: 0 }}>Spend Analytics</h3>
                  <span className="text-muted" style={{ fontSize: 'var(--font-size-xs)' }}>(Click any stat to drill down)</span>
                </div>

                <div className="analytics-hub__stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
                  <DrillableTile
                    label="Spend per lead"
                    value={formatUsd(metrics.spend_per_lead_usd)}
                    sub={`Across ${metrics.total_leads} leads`}
                    metricKey="spend_per_lead"
                    onClick={() => setDrilldownMetricKey('spend_per_lead')}
                  />
                  <DrillableTile
                    label="Total spend / drafting"
                    value={formatUsd(metrics.cost_per_drafting_usd)}
                    sub={`${metrics.drafting_lead_events} drafting events`}
                    metricKey="cost_per_drafting"
                    onClick={() => setDrilldownMetricKey('cost_per_drafting')}
                  />
                  <DrillableTile
                    label="Per enrichment"
                    value={formatUsd(metrics.cost_per_enrichment_usd)}
                    sub={`${metrics.enrichment_lead_events} enrichment events`}
                    metricKey="cost_per_enrichment"
                    onClick={() => setDrilldownMetricKey('cost_per_enrichment')}
                  />
                  <DrillableTile
                    label="Aggregated drafting"
                    value={formatUsd(metrics.drafting_cost_usd)}
                    sub="Total LLM drafting cost"
                    metricKey="aggregated_drafting"
                    onClick={() => setDrilldownMetricKey('aggregated_drafting')}
                  />
                  <DrillableTile
                    label="Aggregated enrichment"
                    value={formatUsd(metrics.enrichment_cost_usd)}
                    sub="Total web research cost"
                    metricKey="aggregated_enrichment"
                    onClick={() => setDrilldownMetricKey('aggregated_enrichment')}
                  />
                  <DrillableTile
                    label="Total spend"
                    value={formatUsd(metrics.total_spend_usd)}
                    sub="Combined actuals"
                    metricKey="total_spend"
                    onClick={() => setDrilldownMetricKey('total_spend')}
                  />
                </div>
              </section>

              {/* ──────────────── 3. Conversion Analytics Section ──────────────── */}
              <section style={{ marginBottom: 'var(--space-6)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: 'var(--space-3)' }}>
                  <Send size={18} style={{ color: 'var(--color-positive)' }} />
                  <h3 style={{ fontSize: 'var(--font-size-md)', fontWeight: 'bold', margin: 0 }}>Conversion Analytics</h3>
                  <span className="text-muted" style={{ fontSize: 'var(--font-size-xs)' }}>(Click any stat to drill down)</span>
                </div>

                <div className="analytics-hub__stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
                  <DrillableTile
                    label="Delivery rate"
                    value={formatPct(metrics.delivery_rate)}
                    sub={`${metrics.emails_delivered} delivered`}
                    metricKey="delivery_rate"
                    onClick={() => setDrilldownMetricKey('delivery_rate')}
                  />
                  <DrillableTile
                    label="Open rate"
                    value={formatPct(metrics.open_rate)}
                    sub={`${metrics.emails_opened} opens`}
                    metricKey="open_rate"
                    onClick={() => setDrilldownMetricKey('open_rate')}
                  />
                  <DrillableTile
                    label="Click rate"
                    value={formatPct(metrics.click_rate)}
                    sub={`${metrics.emails_clicked} clicks`}
                    metricKey="click_rate"
                    onClick={() => setDrilldownMetricKey('click_rate')}
                  />
                  <DrillableTile
                    label="Reply rate"
                    value={formatPct(metrics.reply_rate)}
                    sub={`${metrics.emails_replied} replies`}
                    metricKey="reply_rate"
                    onClick={() => setDrilldownMetricKey('reply_rate')}
                  />
                  <DrillableTile
                    label="Emails sent"
                    value={String(metrics.emails_sent)}
                    sub="Total outbound sends"
                    metricKey="emails_sent"
                    onClick={() => setDrilldownMetricKey('emails_sent')}
                  />
                  <DrillableTile
                    label="Campaigns done"
                    value={String(metrics.campaigns_count)}
                    sub="Matching campaigns"
                    metricKey="campaigns_count"
                    onClick={() => setDrilldownMetricKey('campaigns_count')}
                  />
                </div>
              </section>

              {/* ──────────────── 4. Campaign Matrix or Per-User View ──────────────── */}
              <section style={{ marginBottom: 'var(--space-6)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-3)' }}>
                  <h3 style={{ fontSize: 'var(--font-size-md)', fontWeight: 'bold', margin: 0 }}>
                    {viewMode === 'campaigns' ? 'Campaign Performance Matrix' : 'Per-User Performance'}
                  </h3>
                  <div className="segmented">
                    <button
                      type="button"
                      className={viewMode === 'campaigns' ? 'segmented__item segmented__item--active' : 'segmented__item'}
                      onClick={() => setViewMode('campaigns')}
                    >
                      By Campaign
                    </button>
                    <button
                      type="button"
                      className={viewMode === 'per_user' ? 'segmented__item segmented__item--active' : 'segmented__item'}
                      onClick={() => setViewMode('per_user')}
                    >
                      By User
                    </button>
                  </div>
                </div>

                {viewMode === 'campaigns' && summary && (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Campaign</th>
                          <th>Owner</th>
                          <th>Tags</th>
                          <th>Leads</th>
                          <th>Sent</th>
                          <th>Delivery %</th>
                          <th>Open %</th>
                          <th>Click %</th>
                          <th>Reply %</th>
                          <th>Spend / Lead</th>
                          <th>Total Spend</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.by_campaign.length === 0 && (
                          <tr>
                            <td colSpan={11} className="text-muted">No campaigns matched current filter criteria.</td>
                          </tr>
                        )}
                        {summary.by_campaign.map((row) => (
                          <tr key={row.campaign_id}>
                            <td>
                              <strong style={{ color: 'var(--color-primary)' }}>{row.campaign_name}</strong>
                            </td>
                            <td style={{ fontSize: 'var(--font-size-xs)' }}>
                              {row.owner_name || row.owner_email || row.owner_id.slice(0, 8)}
                            </td>
                            <td>
                              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px' }}>
                                {(row.tag_details?.length ? row.tag_details : row.tags.map((t) => ({ tag: t, color: null }))).map((item) => (
                                  <TagBadge
                                    key={item.tag}
                                    tag={item.tag}
                                    color={item.color}
                                    onRemove={() => void handleRemoveTag(row.campaign_id, item.tag)}
                                    size="sm"
                                  />
                                ))}

                                {editingTagCampaignId === row.campaign_id ? (
                                  <TagInputPopover
                                    onAddTag={(tagName, colorId) => handleAddTag(row.campaign_id, tagName, colorId)}
                                    onCancel={() => setEditingTagCampaignId(null)}
                                    excludeTags={
                                      (row.tag_details?.length ? row.tag_details : row.tags.map((t) => ({ tag: t })))
                                        .map((item) => item.tag)
                                    }
                                  />
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => setEditingTagCampaignId(row.campaign_id)}
                                    style={{
                                      border: '1px dashed var(--color-border)',
                                      background: 'none',
                                      borderRadius: 'var(--radius-pill)',
                                      padding: '1px 6px',
                                      fontSize: '10px',
                                      cursor: 'pointer',
                                      color: 'var(--color-text-subtle)',
                                    }}
                                  >
                                    + Tag
                                  </button>
                                )}
                              </div>
                            </td>
                            <td>{row.lead_count}</td>
                            <td>{row.emails_sent}</td>
                            <td>{formatPct(row.delivery_rate)}</td>
                            <td>{formatPct(row.open_rate)}</td>
                            <td>{formatPct(row.click_rate)}</td>
                            <td>{formatPct(row.reply_rate)}</td>
                            <td>{formatUsd(row.spend_per_lead_usd)}</td>
                            <td style={{ fontWeight: 'bold' }}>{formatUsd(row.total_spend_usd)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {viewMode === 'per_user' && summary && (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>User</th>
                          <th>Sent</th>
                          <th>Delivered</th>
                          <th>Opened</th>
                          <th>Clicked</th>
                          <th>Replied</th>
                          <th>$/email</th>
                          <th>$/enrich</th>
                          <th>$/draft</th>
                          <th>Total Spend</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.by_user.length === 0 && (
                          <tr><td colSpan={10}>No per-user activity in this window.</td></tr>
                        )}
                        {summary.by_user.map((row) => (
                          <tr key={row.user_id}>
                            <td><strong>{row.user_name ?? row.user_email ?? row.user_id}</strong></td>
                            <td>{row.emails_sent}</td>
                            <td>{row.emails_delivered}</td>
                            <td>{row.emails_opened}</td>
                            <td>{row.emails_clicked}</td>
                            <td>{row.emails_replied}</td>
                            <td>{formatUsd(row.cost_per_email_usd)}</td>
                            <td>{formatUsd(row.cost_per_enrichment_usd)}</td>
                            <td>{formatUsd(row.cost_per_drafting_usd)}</td>
                            <td style={{ fontWeight: 'bold' }}>{formatUsd(row.total_spend_usd)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}

          {/* ──────────────── 5. Run Exclusions Section ──────────────── */}
          <section className="analytics-hub__exclusions">
            <div className="analytics-hub__exclusions-head">
              <div>
                <strong>Run exclusions</strong>
                <p className="text-muted">Multi-select runs to drop from analytics calculations.</p>
              </div>
              <div className="analytics-hub__exclusions-actions">
                {selectedExclusions.size > 0 ? (
                  <span className="text-muted">{selectedExclusions.size} selected</span>
                ) : null}
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={busy || selectedExclusions.size === 0 || selectedExcluded}
                  onClick={() => void excludeSelected()}
                >
                  Exclude from analytics
                </button>
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={busy || selectedExclusions.size === 0 || !selectedExcluded}
                  onClick={() => void includeSelected()}
                >
                  Include in analytics
                </button>
              </div>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th />
                    <th>Campaign</th>
                    <th>Status</th>
                    <th>Leads</th>
                    <th>Created</th>
                    <th>Excluded</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id} className={run.excluded ? 'is-excluded' : undefined}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedExclusions.has(run.id)}
                          onChange={() => toggleExclusion(run.id)}
                        />
                      </td>
                      <td>{run.campaign_name}</td>
                      <td>{run.status}</td>
                      <td>{run.lead_count}</td>
                      <td>{new Date(run.created_at).toLocaleString()}</td>
                      <td>{run.excluded ? 'Yes' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {summary?.notes?.length ? (
            <ul className="analytics-hub__notes">
              {summary.notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          ) : null}
        </div>
      </section>

      {/* Slide-Over Drill-down Drawer */}
      {drilldownMetricKey && (
        <AnalyticsDrilldownDrawer
          metricKey={drilldownMetricKey}
          period={period}
          from={period === 'custom' ? customFrom : undefined}
          to={period === 'custom' ? customTo : undefined}
          campaignIds={selectedCampaignIds}
          tags={selectedTags}
          userId={selectedUserId}
          onClose={() => setDrilldownMetricKey(null)}
        />
      )}
    </main>
  );
}

function DrillableTile({
  label,
  value,
  sub,
  metricKey,
  onClick,
}: {
  label: string;
  value: string;
  sub?: string;
  metricKey: string;
  onClick: () => void;
}) {
  return (
    <div
      className="analytics-stat stat-tile"
      onClick={onClick}
      style={{
        cursor: 'pointer',
        position: 'relative',
        transition: 'all 0.15s ease-in-out',
        border: '1px solid var(--color-border)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="analytics-stat__label">{label}</span>
        <ChevronRight size={14} style={{ color: 'var(--color-primary)', opacity: 0.7 }} />
      </div>
      <strong className="analytics-stat__value" style={{ fontSize: 'var(--font-size-xl)' }}>{value}</strong>
      {sub && <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-subtle)' }}>{sub}</span>}
      <span style={{ fontSize: '10px', color: 'var(--color-primary)', fontWeight: 'bold', marginTop: '2px' }}>Drill down →</span>
    </div>
  );
}
