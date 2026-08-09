'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { X } from 'lucide-react';

import { hubGetJson } from '@/app/hub/hub-data';
import { HubLoadingSpinner } from '@/app/hub/hub-loading';
import { requestJson } from '@/lib/client-request';
import type {
  ConversationFilter,
  ConversationListItem,
  ConversationStats,
  ConversationThread,
} from '@/lib/drafting/conversations';

type ListResponse = {
  stats: ConversationStats;
  items: ConversationListItem[];
};

type CampaignOption = { id: string; name: string };

function formatWhen(value: string | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function replyStatusLabel(status: string | null): string {
  if (!status) return 'No auto-reply';
  if (status === 'queued') return 'Queued';
  if (status === 'drafting') return 'Sending';
  if (status === 'sent') return 'Sent';
  if (status === 'scheduled') return 'Follow-up scheduled';
  if (status === 'failed') return 'Failed';
  if (status === 'skipped') return 'Skipped';
  if (status === 'cancelled') return 'Cancelled';
  return status;
}

function replyChipClass(status: string | null): string {
  if (status === 'sent') return 'drafting-status-chip drafting-status-chip--approved';
  if (status === 'queued' || status === 'drafting' || status === 'scheduled') {
    return 'drafting-status-chip drafting-status-chip--queued';
  }
  if (status === 'failed' || status === 'skipped' || status === 'cancelled') {
    return 'drafting-status-chip drafting-status-chip--failed';
  }
  return 'drafting-status-chip drafting-status-chip--attention';
}

function roleLabel(role: ConversationThread['messages'][number]['role']): string {
  if (role === 'outbound') return 'You (outbound)';
  if (role === 'inbound') return 'Lead';
  if (role === 'scheduled_followup') return 'Scheduled follow-up';
  return 'You (auto-reply)';
}

export function ConversationsHub() {
  const searchParams = useSearchParams();
  const threadParam = searchParams.get('thread');

  const [data, setData] = useState<ListResponse | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [campaignId, setCampaignId] = useState('');
  const [filter, setFilter] = useState<ConversationFilter>('all');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailId, setDetailId] = useState<string | null>(threadParam);
  const [thread, setThread] = useState<ConversationThread | null>(null);
  const hasDataRef = useRef(false);

  const load = useCallback(async () => {
    if (!hasDataRef.current) setLoading(true);
    try {
      const params = new URLSearchParams();
      if (campaignId) params.set('campaign_id', campaignId);
      if (filter !== 'all') params.set('filter', filter);
      const qs = params.toString();
      const result = await hubGetJson<ListResponse>(
        `/api/conversations${qs ? `?${qs}` : ''}`,
      );
      setData(result);
      hasDataRef.current = true;
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load conversations');
    } finally {
      setLoading(false);
    }
  }, [campaignId, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void hubGetJson<{ campaigns: CampaignOption[] }>('/api/campaigns')
      .then((res) => setCampaigns(res.campaigns.map((c) => ({ id: c.id, name: c.name }))))
      .catch(() => setCampaigns([]));
  }, []);

  useEffect(() => {
    if (threadParam) setDetailId(threadParam);
  }, [threadParam]);

  useEffect(() => {
    if (!detailId) {
      setThread(null);
      return;
    }
    let cancelled = false;
    void requestJson<{ thread: ConversationThread }>(`/api/conversations/${detailId}`)
      .then((res) => {
        if (!cancelled) setThread(res.thread);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unable to load thread');
          setDetailId(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [detailId]);

  const stats = data?.stats;
  const filters = useMemo(
    () => [
      { key: 'all' as const, label: 'Conversations', value: stats?.conversations ?? 0 },
      { key: 'awaiting' as const, label: 'Awaiting auto-reply', value: stats?.awaiting ?? 0 },
      { key: 'sent' as const, label: 'Auto-replied', value: stats?.sent ?? 0 },
      { key: 'failed' as const, label: 'Failed / skipped', value: stats?.failed ?? 0 },
    ],
    [stats],
  );

  if (loading && !data) {
    return <HubLoadingSpinner label="Loading conversations" />;
  }

  return (
    <main className="app-shell">
      <section className="card">
        <div className="card__header">
          <div>
            <div className="card__title">Conversations</div>
            <div className="card__subtitle">
              Lead replies and auto-responses · newest first
            </div>
          </div>
        </div>
        <div className="card__body">
          <div className="stat-tile-row" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            {filters.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className={`stat-tile${filter === entry.key ? ' stat-tile--active' : ''}`}
                onClick={() => setFilter(entry.key)}
                style={{ textAlign: 'left', cursor: 'pointer', minWidth: '8.5rem' }}
              >
                <div className="stat-tile__label">{entry.label}</div>
                <div className="stat-tile__value">{entry.value}</div>
              </button>
            ))}
          </div>

          <div className="send-queue-toolbar" style={{ marginBottom: '1rem' }}>
            <label className="send-queue-filter">
              <span>Campaign</span>
              <select
                value={campaignId}
                onChange={(e) => setCampaignId(e.target.value)}
                className="field__input"
              >
                <option value="">All campaigns</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
          </div>

          {error && <p className="field__error">{error}</p>}

          {!loading && data && data.items.length === 0 ? (
            <p className="send-queue-empty">
              No conversations yet. When a lead replies to outreach, the thread shows up here.
            </p>
          ) : null}

          {data && data.items.length > 0 ? (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Lead</th>
                    <th>Campaign</th>
                    <th>Latest reply</th>
                    <th>Auto-reply</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr
                      key={item.email_send_id}
                      style={{ cursor: 'pointer' }}
                      onClick={() => setDetailId(item.email_send_id)}
                    >
                      <td>
                        <strong>{item.lead_name || item.lead_email}</strong>
                        {item.lead_company ? (
                          <div className="muted">{item.lead_company}</div>
                        ) : null}
                      </td>
                      <td>{item.campaign_name}</td>
                      <td style={{ maxWidth: '22rem' }}>
                        {item.last_inbound_preview || item.outbound_subject}
                      </td>
                      <td>
                        <span className={replyChipClass(item.reply_status)}>
                          {replyStatusLabel(item.reply_status)}
                        </span>
                      </td>
                      <td>{formatWhen(item.last_inbound_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </section>

      {detailId && thread ? (
        <div className="drawer-overlay" role="presentation" onClick={() => setDetailId(null)}>
          <div
            className="drawer"
            role="dialog"
            aria-label="Conversation thread"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer__header">
              <div>
                <div className="card__title">
                  {thread.lead_name || thread.lead_email}
                </div>
                <div className="card__subtitle">
                  {thread.lead_company ? `${thread.lead_company} · ` : ''}
                  <Link href={thread.campaign_href}>{thread.campaign_name}</Link>
                </div>
              </div>
              <button
                type="button"
                className="drawer__close"
                aria-label="Close"
                onClick={() => setDetailId(null)}
              >
                <X size={16} />
              </button>
            </div>
            <div className="drawer__body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {thread.reply_suppressed ? (
                <p className="muted" style={{ margin: 0 }}>
                  Auto-replies suppressed for this thread (hard stop).
                </p>
              ) : null}
              {thread.messages.map((message) => (
                <article
                  key={message.id}
                  style={{
                    border: '1px solid var(--color-border, #d8dee8)',
                    borderRadius: '8px',
                    padding: '0.85rem 1rem',
                    background: message.role === 'inbound'
                      ? 'var(--color-surface-muted, #f5f7fa)'
                      : 'var(--color-surface, #fff)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.5rem' }}>
                    <strong>{roleLabel(message.role)}</strong>
                    <span className="muted">{formatWhen(message.at)}</span>
                  </div>
                  {message.subject ? (
                    <p style={{ margin: '0 0 0.5rem' }}>
                      <strong>Subject:</strong> {message.subject}
                    </p>
                  ) : null}
                  {message.role === 'auto_reply' || message.role === 'scheduled_followup' ? (
                    <p className="muted" style={{ margin: '0 0 0.5rem' }}>
                      {message.disposition ? `Disposition: ${message.disposition}` : null}
                      {message.disposition && message.status ? ' · ' : null}
                      {message.status ? `Status: ${replyStatusLabel(message.status)}` : null}
                      {message.defer_until ? ` · follow-up ${message.defer_until}` : ''}
                      {message.defer_reason ? ` · ${message.defer_reason}` : ''}
                      {message.error_message ? ` · ${message.error_message}` : ''}
                    </p>
                  ) : null}
                  <pre
                    className="send-queue-detail__body"
                    style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'inherit' }}
                  >
                    {message.body_text?.trim() || '(no body yet)'}
                  </pre>
                </article>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
