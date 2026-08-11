'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { CalendarClock, Send, SquareSplitVertical, Trash2, RotateCcw, X } from 'lucide-react';

import { hubGetJson, invalidateHubCache } from '@/app/hub/hub-data';
import { HubLoadingSpinner } from '@/app/hub/hub-loading';
import { requestJson } from '@/lib/client-request';
import { formatNyDateLabel } from '@/lib/drafting/send-queue-schedule';
import type { QueueDayBucket, QueueListItem, ShareTargetUser } from '@/lib/drafting/send-queue';

type QueueListResponse = {
  days: QueueDayBucket[];
  today: string;
  today_remaining: number;
};

type QueueDetailResponse = {
  item: QueueListItem;
  body_text: string | null;
  campaign_href: string;
};

type CampaignOption = { id: string; name: string };

export function SendQueueHub() {
  const [data, setData] = useState<QueueListResponse | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [campaignId, setCampaignId] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dragIds, setDragIds] = useState<string[] | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<QueueDetailResponse | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareTargets, setShareTargets] = useState<ShareTargetUser[] | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const shareMenuRef = useRef<HTMLDivElement>(null);
  const hasDataRef = useRef(false);

  const load = useCallback(async (force = false) => {
    if (!hasDataRef.current) setLoading(true);
    try {
      const params = new URLSearchParams();
      if (campaignId) params.set('campaign_id', campaignId);
      const qs = params.toString();
      const url = `/api/send-queue${qs ? `?${qs}` : ''}`;
      const result = await hubGetJson<QueueListResponse>(url, { force });
      setData(result);
      hasDataRef.current = true;
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load send queue');
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void hubGetJson<{ campaigns: CampaignOption[] }>('/api/campaigns')
      .then((res) => setCampaigns(res.campaigns.map((c) => ({ id: c.id, name: c.name }))))
      .catch(() => setCampaigns([]));
  }, []);

  useEffect(() => {
    if (!shareOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (!shareMenuRef.current?.contains(event.target as Node)) {
        setShareOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setShareOpen(false);
    }
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [shareOpen]);

  useEffect(() => {
    if (!detailId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void requestJson<QueueDetailResponse>(`/api/send-queue/${detailId}`)
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unable to load detail');
          setDetailId(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [detailId]);

  const selectedItems = useMemo(() => {
    if (!data) return [];
    return data.days.flatMap((day) => day.items).filter((item) => selected.has(item.id));
  }, [data, selected]);

  const canSendNow = selectedItems.length > 0
    && selectedItems.every((i) => i.status === 'queued' || i.status === 'failed')
    && (data?.today_remaining ?? 0) >= selectedItems.length;

  const canCancel = selectedItems.length > 0
    && selectedItems.every((i) => i.status === 'queued' || i.status === 'failed');

  const canRetry = selectedItems.length > 0
    && selectedItems.every((i) => i.status === 'failed');

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllDay(day: QueueDayBucket) {
    setSelected((prev) => {
      const next = new Set(prev);
      const ids = day.items.map((i) => i.id);
      const allSelected = ids.every((id) => next.has(id));
      if (allSelected) {
        for (const id of ids) next.delete(id);
      } else {
        for (const id of ids) next.add(id);
      }
      return next;
    });
  }

  async function runAction(action: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await action();
      setSelected(new Set());
      invalidateHubCache('/api/send-queue');
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  function onDragStart(item: QueueListItem, event: DragEvent) {
    const ids = selected.has(item.id)
      ? [...selected]
      : [item.id];
    setDragIds(ids);
    event.dataTransfer.setData('text/plain', ids.join(','));
    event.dataTransfer.effectAllowed = 'move';
  }

  async function onDropDay(targetDate: string, event: DragEvent) {
    event.preventDefault();
    const raw = event.dataTransfer.getData('text/plain');
    const ids = dragIds ?? (raw ? raw.split(',').filter(Boolean) : []);
    setDragIds(null);
    if (ids.length === 0) return;
    await runAction(async () => {
      await requestJson('/api/send-queue', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, target_date: targetDate }),
      });
      setMessage(`Moved ${ids.length} to ${formatNyDateLabel(targetDate)}`);
    });
  }

  const backlogCount = data?.days.reduce(
    (sum, day) => sum + day.items.filter((i) => i.status === 'queued' || i.status === 'failed' || i.status === 'sending').length,
    0,
  ) ?? 0;

  async function openShareMenu() {
    if (shareOpen) {
      setShareOpen(false);
      return;
    }
    setShareOpen(true);
    setShareLoading(true);
    try {
      const result = await requestJson<{ users: ShareTargetUser[] }>('/api/send-queue/share-targets');
      setShareTargets(result.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load teammates');
      setShareOpen(false);
    } finally {
      setShareLoading(false);
    }
  }

  async function shareWithUser(target: ShareTargetUser) {
    setShareOpen(false);
    await runAction(async () => {
      const result = await requestJson<{
        transferred: number;
        sharer_backlog: number;
        recipient_backlog: number;
      }>('/api/send-queue/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_user_id: target.id }),
      });
      setShareTargets(null);
      setMessage(
        `Pushed ${result.transferred} to ${target.email} · you ${result.sharer_backlog} · them ${result.recipient_backlog}`,
      );
    });
  }

  if (loading && !data) {
    return <HubLoadingSpinner label="Loading queue" />;
  }

  return (
    <main className="app-shell">
      <section className="card">
        <div className="card__header">
          <div>
            <div className="card__title">Send queue</div>
            <div className="card__subtitle">
              20 emails/day · America/New_York · drag to move by day
            </div>
          </div>
        </div>
        <div className="card__body">
          <div className="send-queue-toolbar">
            <div className="send-queue-toolbar__stats">
              <span>
                <CalendarClock size={14} aria-hidden="true" />
                {' '}Today remaining: <strong>{data?.today_remaining ?? '—'}</strong>
              </span>
              <span>Backlog: <strong>{backlogCount}</strong></span>
            </div>
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
            <div className="send-queue-toolbar__actions">
              <div className="send-queue-share" ref={shareMenuRef}>
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={busy || backlogCount === 0}
                  aria-expanded={shareOpen}
                  aria-haspopup="menu"
                  onClick={() => void openShareMenu()}
                >
                  <SquareSplitVertical size={14} aria-hidden="true" /> Push to
                </button>
                {shareOpen ? (
                  <div className="send-queue-share__menu" role="menu">
                    <div className="send-queue-share__hint">
                      Split backlog evenly with a teammate. Both queues pack to the earliest open days.
                    </div>
                    {shareLoading || !shareTargets ? (
                      <p className="send-queue-share__empty">Loading teammates…</p>
                    ) : shareTargets.length === 0 ? (
                      <p className="send-queue-share__empty">No other users found.</p>
                    ) : (
                      shareTargets.map((user) => (
                        <button
                          key={user.id}
                          type="button"
                          role="menuitem"
                          className="send-queue-share__option"
                          disabled={busy || user.backlog_count >= backlogCount}
                          onClick={() => void shareWithUser(user)}
                        >
                          <span className="send-queue-share__identity">
                            <span className="send-queue-share__email">{user.email}</span>
                            {user.display_name && user.display_name !== user.email ? (
                              <span className="send-queue-share__name">{user.display_name}</span>
                            ) : null}
                          </span>
                          <span
                            className="send-queue-share__days"
                            aria-label={`Next five days: ${user.day_occupancy.filter(Boolean).length} occupied`}
                          >
                            {user.day_occupancy.map((occupied, index) => (
                              <span
                                key={index}
                                className={`send-queue-share__day${occupied ? ' send-queue-share__day--full' : ''}`}
                              />
                            ))}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!canSendNow || busy}
                onClick={() => void runAction(async () => {
                  const result = await requestJson<{ sent: number }>('/api/send-queue/send-now', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids: [...selected] }),
                  });
                  setMessage(`Sent ${result.sent} now`);
                })}
              >
                <Send size={14} /> Send now
              </button>
              <button
                type="button"
                className="btn btn--secondary"
                disabled={!canRetry || busy}
                onClick={() => void runAction(async () => {
                  const result = await requestJson<{ sent_now: number; requeued: number }>(
                    '/api/send-queue/retry',
                    {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ ids: [...selected] }),
                    },
                  );
                  setMessage(`Retry: ${result.sent_now} sent · ${result.requeued} requeued`);
                })}
              >
                <RotateCcw size={14} /> Retry
              </button>
              <button
                type="button"
                className="btn btn--secondary"
                disabled={!canCancel || busy}
                onClick={() => void runAction(async () => {
                  const result = await requestJson<{ cancelled: number }>('/api/send-queue', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids: [...selected] }),
                  });
                  setMessage(`Cancelled ${result.cancelled}`);
                })}
              >
                <Trash2 size={14} /> Cancel
              </button>
            </div>
          </div>

          {error && <p className="field__error">{error}</p>}
          {message && <p className="field__notice">{message}</p>}

          {!loading && data && backlogCount === 0 && data.days.every((d) => d.items.length === 0) ? (
            <p className="send-queue-empty">
              No queued emails. Sends under today’s 20-cap go out immediately; overflow lands here.
            </p>
          ) : null}

          <div className="send-queue-board">
            {data?.days.map((day) => (
              <div
                key={day.schedule_date}
                className={`send-queue-day${day.schedule_date === data.today ? ' send-queue-day--today' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(e) => void onDropDay(day.schedule_date, e)}
              >
                <div className="send-queue-day__head">
                  <div>
                    <strong>
                      {day.schedule_date === data.today
                        ? 'Today'
                        : formatNyDateLabel(day.schedule_date)}
                    </strong>
                    <span className="send-queue-day__date">{day.schedule_date}</span>
                  </div>
                  <div className="send-queue-day__cap">
                    {day.used} / {day.capacity}
                    {day.sent_count > 0 ? ` · ${day.sent_count} sent` : ''}
                  </div>
                </div>
                {day.items.length > 0 ? (
                  <button
                    type="button"
                    className="send-queue-day__select-all"
                    onClick={() => selectAllDay(day)}
                  >
                    Select all
                  </button>
                ) : (
                  <p className="send-queue-day__empty">Drop here</p>
                )}
                <ul className="send-queue-cards">
                  {day.items.map((item) => (
                    <li
                      key={item.id}
                      className={`send-queue-card${selected.has(item.id) ? ' send-queue-card--selected' : ''}${item.overdue ? ' send-queue-card--overdue' : ''}`}
                      draggable={item.status === 'queued' || item.status === 'failed'}
                      onDragStart={(e) => onDragStart(item, e)}
                      onDragEnd={() => setDragIds(null)}
                    >
                      <label className="send-queue-card__check">
                        <input
                          type="checkbox"
                          checked={selected.has(item.id)}
                          onChange={() => toggleSelect(item.id)}
                        />
                      </label>
                      <button
                        type="button"
                        className="send-queue-card__body"
                        onClick={() => setDetailId(item.id)}
                      >
                        <span className="send-queue-card__name">
                          {item.recipient_name || item.to_email}
                        </span>
                        <span className="send-queue-card__subject">{item.subject}</span>
                        <span className="send-queue-card__meta">
                          {item.campaign_name}
                          {' · '}
                          {item.status}
                          {item.overdue ? ' · overdue' : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {detailId && detail ? (
        <div className="drawer-overlay" role="presentation" onClick={() => setDetailId(null)}>
          <div
            className="drawer"
            role="dialog"
            aria-label="Queued email detail"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer__header">
              <div>
                <div className="card__title">
                  {detail.item.recipient_name || detail.item.to_email}
                </div>
                <div className="card__subtitle">
                  {formatNyDateLabel(detail.item.schedule_date)} · {detail.item.status}
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
            <div className="drawer__body send-queue-detail">
              <p><strong>To:</strong> {detail.item.to_email}</p>
              <p><strong>Subject:</strong> {detail.item.subject}</p>
              <p>
                <strong>Campaign:</strong>{' '}
                <Link href={detail.campaign_href}>{detail.item.campaign_name}</Link>
              </p>
              {detail.item.error_message ? (
                <p className="field__error">{detail.item.error_message}</p>
              ) : null}
              <pre className="send-queue-detail__body">{detail.body_text ?? '(no draft body)'}</pre>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
