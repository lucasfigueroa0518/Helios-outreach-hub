'use client';

import { useEffect, useState } from 'react';
import { X, TrendingUp, BarChart2, Users, Mail } from 'lucide-react';
import { requestJson } from '@/lib/client-request';
import { AnalyticsDrilldownData } from '@/lib/analytics-drilldown';

export function AnalyticsDrilldownDrawer({
  metricKey,
  period,
  from,
  to,
  campaignIds,
  tags,
  userId,
  onClose,
}: {
  metricKey: string;
  period: string;
  from?: string;
  to?: string;
  campaignIds?: string[];
  tags?: string[];
  userId?: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<AnalyticsDrilldownData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'campaigns' | 'leads'>('campaigns');

  useEffect(() => {
    let cancelled = false;
    async function fetchDrilldown() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ metricKey, period });
        if (from) params.set('from', from);
        if (to) params.set('to', to);
        if (campaignIds?.length) params.set('campaignIds', campaignIds.join(','));
        if (tags?.length) params.set('tags', tags.join(','));
        if (userId) params.set('userId', userId);

        const result = await requestJson<AnalyticsDrilldownData>(`/api/analytics/drilldown?${params.toString()}`);

        if (!cancelled) {
          setData(result);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Error loading details');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchDrilldown();
    return () => {
      cancelled = true;
    };
  }, [metricKey, period, from, to, campaignIds, tags, userId]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const maxTrendValue = data?.trend?.length
    ? Math.max(...data.trend.map((t) => t.value), 0.00001)
    : 1;

  return (
    <div className="drawer-overlay" role="presentation" onClick={onClose}>
      <div
        className="drawer"
        style={{ width: '640px', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer__header">
          <div>
            <div style={{ fontSize: 'var(--font-size-xs)', textTransform: 'uppercase', color: 'var(--color-primary)', fontWeight: 'bold' }}>
              Drill-down Detail
            </div>
            <h2 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 'bold', margin: '4px 0 0' }}>
              {data?.title || 'Statistic Details'}
            </h2>
            {data && (
              <div style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 'bold', color: 'var(--color-text)', marginTop: '4px' }}>
                {data.totalFormatted}
              </div>
            )}
          </div>
          <button type="button" className="drawer__close" onClick={onClose} aria-label="Close drawer">
            <X size={18} />
          </button>
        </div>

        <div className="drawer__body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          {loading && <p className="text-muted">Loading statistic details…</p>}
          {error && <p className="field__error">{error}</p>}

          {!loading && data && (
            <>
              {/* Trend Chart Box */}
              <div className="card" style={{ padding: 'var(--space-4)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-3)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--font-size-sm)', fontWeight: 'bold' }}>
                    <TrendingUp size={16} style={{ color: 'var(--color-primary)' }} />
                    Daily Performance Trend
                  </div>
                  <span className="text-muted" style={{ fontSize: 'var(--font-size-xs)' }}>
                    {data.trend.length} days in window
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'flex-end', gap: '6px', height: '110px', paddingTop: '16px' }}>
                  {data.trend.map((point) => {
                    const pct = Math.round((point.value / maxTrendValue) * 100);
                    return (
                      <div
                        key={point.date}
                        style={{
                          flex: 1,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          height: '100%',
                          justifyContent: 'flex-end',
                        }}
                        title={`${point.date}: ${data.unit === 'usd' ? `$${point.value.toFixed(2)}` : data.unit === 'percent' ? `${(point.value * 100).toFixed(1)}%` : point.value.toLocaleString()}`}
                      >
                        <div
                          style={{
                            width: '100%',
                            minWidth: '6px',
                            height: `${Math.max(pct, 4)}%`,
                            backgroundColor: 'var(--color-primary)',
                            borderRadius: '3px 3px 0 0',
                            transition: 'height 0.2s ease',
                          }}
                        />
                        <span style={{ fontSize: '9px', color: 'var(--color-text-subtle)', marginTop: '4px' }}>
                          {point.date.slice(5)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Sub-tabs: Campaigns vs Leads */}
              <div className="segmented" style={{ width: 'fit-content' }}>
                <button
                  type="button"
                  className={`segmented__item${activeTab === 'campaigns' ? ' segmented__item--active' : ''}`}
                  onClick={() => setActiveTab('campaigns')}
                >
                  <BarChart2 size={14} style={{ marginRight: '6px', display: 'inline-block', verticalAlign: 'middle' }} />
                  By Campaign ({data.campaigns.length})
                </button>
                <button
                  type="button"
                  className={`segmented__item${activeTab === 'leads' ? ' segmented__item--active' : ''}`}
                  onClick={() => setActiveTab('leads')}
                >
                  <Users size={14} style={{ marginRight: '6px', display: 'inline-block', verticalAlign: 'middle' }} />
                  Lead & Email Rows ({data.items.length})
                </button>
              </div>

              {/* Tab Content: Campaigns */}
              {activeTab === 'campaigns' && (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Campaign</th>
                        <th>Stat Value</th>
                        <th>Leads</th>
                        <th>Emails Sent</th>
                        <th>Total Spend</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.campaigns.length === 0 && (
                        <tr>
                          <td colSpan={5} className="text-muted">No campaigns matched in this window.</td>
                        </tr>
                      )}
                      {data.campaigns.map((row) => (
                        <tr key={row.campaign_id}>
                          <td>
                            <strong>{row.campaign_name}</strong>
                          </td>
                          <td style={{ fontWeight: 'bold', color: 'var(--color-primary)' }}>
                            {row.formatted_value}
                          </td>
                          <td>{row.lead_count}</td>
                          <td>{row.emails_sent}</td>
                          <td>${row.total_spend_usd.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Tab Content: Leads */}
              {activeTab === 'leads' && (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Lead</th>
                        <th>Company</th>
                        <th>Campaign</th>
                        <th>Status</th>
                        <th>Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.length === 0 && (
                        <tr>
                          <td colSpan={5} className="text-muted">No detailed lead rows recorded for this statistic.</td>
                        </tr>
                      )}
                      {data.items.map((item) => (
                        <tr key={item.id}>
                          <td>
                            <div>
                              <strong>{item.lead_name}</strong>
                              {item.lead_email && (
                                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-subtle)' }}>
                                  {item.lead_email}
                                </div>
                              )}
                            </div>
                          </td>
                          <td>{item.lead_company || '—'}</td>
                          <td>{item.campaign_name}</td>
                          <td>
                            <span className="pill" style={{ background: 'var(--color-surface-2)', fontSize: '11px' }}>
                              {item.status_or_event}
                            </span>
                          </td>
                          <td style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-subtle)' }}>
                            {new Date(item.occurred_at).toLocaleDateString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
