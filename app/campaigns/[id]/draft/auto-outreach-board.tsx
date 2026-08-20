'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import { LivePulse } from '@/app/components/live-pulse';
import type { DraftingSnapshot } from '@/app/campaigns/[id]/draft/types';
import {
  attentionCount,
  buildOutreachSentence,
  sentTileSub,
  type OutreachCarouselFocus,
} from '@/lib/auto-campaigns/outreach-insight';
import { EXPANSION_LABELS } from '@/lib/auto-campaigns/types';
import { requestJson } from '@/lib/client-request';
import { formatNyDate, formatNyDateLabel } from '@/lib/drafting/send-queue-schedule';

export type { OutreachCarouselFocus };

type OutreachStatsPayload = {
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
  emails_per_day: number;
  next_cycle_at: string | null;
  auto_status: string | null;
  auto_error: string | null;
  expansion_step: number;
  by_day: Array<{ date: string; sent: number; attached: number }>;
};

function formatWhen(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function weekdayLabel(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  if (!year || !month || !day) return dateStr;
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function isWeekend(dateStr: string): boolean {
  const [year, month, day] = dateStr.split('-').map(Number);
  if (!year || !month || !day) return false;
  const weekday = new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

export function AutoOutreachBoard({
  campaignId,
  live,
  emailsPerDay,
  nextCycleAt,
  autoStatus,
  autoError,
  expansionStep,
  snapshot,
  launching = false,
  focus,
  onSelectFocus,
  pollError,
  rescueBusy,
  rescueNotice,
  pauseBusy,
  resumeBusy,
  pauseNotice,
  onRetryPoll,
  onRescue,
  onPause,
  onResume,
}: {
  campaignId: string;
  live: boolean;
  emailsPerDay: number;
  nextCycleAt: string | null;
  autoStatus: string | null;
  autoError: string | null;
  expansionStep: number;
  snapshot: DraftingSnapshot | null;
  launching?: boolean;
  focus: OutreachCarouselFocus | null;
  onSelectFocus: (focus: OutreachCarouselFocus | null) => void;
  pollError: string | null;
  rescueBusy?: boolean;
  rescueNotice?: string | null;
  pauseBusy?: boolean;
  resumeBusy?: boolean;
  pauseNotice?: string | null;
  onRetryPoll: () => void;
  onRescue?: () => void;
  onPause?: () => void;
  onResume?: () => void;
}) {
  const [stats, setStats] = useState<OutreachStatsPayload | null>(null);
  const [paceOpen, setPaceOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (document.hidden) return;
      void requestJson<OutreachStatsPayload>(`/api/campaigns/${campaignId}/outreach-stats`)
        .then((data) => {
          if (!cancelled) setStats(data);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [campaignId]);

  const quota = stats?.emails_per_day ?? emailsPerDay;
  const status = stats?.auto_status ?? autoStatus;
  const error = stats?.auto_error ?? autoError;
  const cycleAt = stats?.next_cycle_at ?? nextCycleAt;
  const step = stats?.expansion_step ?? expansionStep;
  const pulled = stats?.pulled ?? snapshot?.counts.total ?? 0;
  const attachedToday = stats?.attached_today ?? 0;
  const sent = stats?.sent ?? snapshot?.counts.sent ?? 0;
  const sentToday = stats?.sent_today ?? 0;
  const queued = stats?.queued ?? 0;
  const queuedToday = stats?.queued_today ?? 0;
  const drafted = snapshot?.counts.generated ?? 0;
  const drafting = launching || ((snapshot?.counts.running ?? 0) > 0 && !snapshot?.workspace.paused);
  const failed = stats?.failed ?? 0;
  const retrySuggested = stats?.retry_suggested ?? 0;
  const bounced = stats?.bounced ?? snapshot?.counts.bounced ?? 0;
  const replied = stats?.replied ?? snapshot?.counts.replied ?? 0;
  const opened = stats?.opened ?? snapshot?.counts.opened ?? 0;
  const needsYou = stats?.needs_you ?? attentionCount({ failed, retrySuggested, bounced });
  const attentionLabel = stats?.attention_label ?? null;
  const nextSendLabel = formatWhen(stats?.next_send_at ?? null);
  const nextCycleLabel = formatWhen(cycleAt);
  const draftingPaused = Boolean(snapshot?.workspace.paused || snapshot?.workspace.status === 'paused');
  const rescue = snapshot?.rescue;
  const showRescue = Boolean(rescue?.needed && onRescue && !draftingPaused);
  const showPause = Boolean(
    onPause
    && snapshot
    && !draftingPaused
    && !snapshot.workspace.generation_complete
    && snapshot.workspace.status === 'active',
  );
  const showResume = Boolean(onResume && draftingPaused);
  const isLive = (stats?.auto_status ?? autoStatus) === 'live' || live;

  const sentence = buildOutreachSentence({
    autoStatus: status,
    autoError: error,
    quota,
    attachedToday,
    pulled,
    drafted,
    drafting,
    queued,
    sent,
    failed,
    retrySuggested,
    bounced,
    replied,
    attentionLabel,
    nextCycleLabel,
    nextSendLabel,
    draftingPaused,
    launching,
  });

  const quotaPct = quota > 0 ? Math.min(100, Math.round((attachedToday / quota) * 100)) : 0;
  const days = useMemo(() => (stats?.by_day ?? []).slice(-7), [stats?.by_day]);
  const today = formatNyDate();
  const maxDaySent = Math.max(1, ...days.map((row) => row.sent), quota > 0 ? Math.ceil(quota / 4) : 1);
  const expansionLabel = EXPANSION_LABELS[Math.min(EXPANSION_LABELS.length - 1, Math.max(0, step))] ?? null;

  function toggleFocus(next: OutreachCarouselFocus) {
    onSelectFocus(focus === next ? null : next);
  }

  const boardClass = [
    'outreach-board',
    isLive && needsYou === 0 ? 'outreach-board--live' : '',
    needsYou > 0 || status === 'error' ? 'outreach-board--attention' : '',
  ].filter(Boolean).join(' ');

  return (
    <>
      <section className={boardClass} aria-label="Campaign outreach" aria-live="polite">
        <header className="outreach-board__lede">
          {isLive && status !== 'error' ? (
            <LivePulse live label="Live" />
          ) : (
            <span className="outreach-board__status-pill">
              {(status ?? 'off').replace(/_/g, ' ')}
            </span>
          )}
          <div>
            <p className="outreach-board__sentence">{sentence}</p>
            <p className="outreach-board__meta">
              {queued > 0 && nextSendLabel ? (
                <Link href="/hub/queue" className="outreach-board__meta-link">
                  Next send {nextSendLabel}
                </Link>
              ) : nextCycleLabel ? (
                <span>Next cycle {nextCycleLabel}</span>
              ) : (
                <span>{status?.replace(/_/g, ' ') ?? 'Auto'}</span>
              )}
              {expansionLabel && step > 0 ? <span> · {expansionLabel}</span> : null}
              {quota > 0 ? <span> · {quota}/day</span> : null}
            </p>
          </div>
        </header>

        <div className="outreach-board__tiles">
          <button
            type="button"
            className={`stat-tile${quota > 0 && attachedToday < quota ? ' stat-tile--warning' : quota > 0 && attachedToday >= quota ? ' stat-tile--positive' : ''}`}
            onClick={() => setPaceOpen(true)}
            title="Today’s verified leads vs quota"
          >
            <span className="stat-tile__label">Today</span>
            <span className="stat-tile__value">
              {stats ? attachedToday : '—'}
              {quota > 0 ? <span className="outreach-board__quota">/{quota}</span> : null}
            </span>
            <span className="stat-tile__sub">
              {quota > 0 && attachedToday < quota
                ? `${quota - attachedToday} still coming`
                : 'leads in today'}
            </span>
          </button>

          <button
            type="button"
            className={`stat-tile${focus === 'drafting' ? ' stat-tile--active' : ''}`}
            onClick={() => toggleFocus('drafting')}
            title="Unsent drafts"
          >
            <span className="stat-tile__label">Drafting</span>
            <span className="stat-tile__value">
              {snapshot ? drafted : '—'}
              {drafting ? <span className="outreach-board__tile-spin loading-spinner" aria-hidden="true" /> : null}
            </span>
            <span className="stat-tile__sub">
              {snapshot
                ? `of ${snapshot.progress.mailbox_valid_total || attachedToday || pulled} written`
                : 'waiting'}
            </span>
          </button>

          <button
            type="button"
            className={`stat-tile${focus === 'queued' ? ' stat-tile--active' : ''}`}
            onClick={() => toggleFocus('queued')}
            title="Emails waiting to go out"
          >
            <span className="stat-tile__label">Queue</span>
            <span className="stat-tile__value">{stats ? queued : '—'}</span>
            <span className="stat-tile__sub">
              {queued === 0
                ? 'nothing scheduled'
                : [queuedToday > 0 ? `${queuedToday} today` : null, nextSendLabel ? `next ${nextSendLabel}` : null]
                  .filter(Boolean)
                  .join(' · ') || 'waiting to send'}
            </span>
          </button>

          <button
            type="button"
            className={`stat-tile stat-tile--positive${focus === 'sent' ? ' stat-tile--active' : ''}`}
            onClick={() => toggleFocus('sent')}
            title="Emails that actually left"
          >
            <span className="stat-tile__label">Sent</span>
            <span className="stat-tile__value">{stats ? sent : '—'}</span>
            <span className="stat-tile__sub">
              {sentTileSub({
                sentToday,
                replied,
                opened,
                sent,
                pulled,
                attachedToday,
                quota,
              })}
            </span>
          </button>

          <button
            type="button"
            className={`stat-tile${needsYou > 0 ? ' stat-tile--negative' : ''}${focus === 'attention' ? ' stat-tile--active' : ''}`}
            onClick={() => toggleFocus('attention')}
            title="Send failures, rewrites, bounces"
          >
            <span className="stat-tile__label">Needs you</span>
            <span className="stat-tile__value">{stats ? needsYou : '—'}</span>
            <span className="stat-tile__sub">
              {needsYou > 0
                ? [failed ? `${failed} failed` : null, retrySuggested ? `${retrySuggested} rewrite` : null, bounced ? `${bounced} bounce` : null]
                  .filter(Boolean)
                  .join(' · ')
                : 'All clear'}
            </span>
          </button>
        </div>

        {quota > 0 ? (
          <div className="outreach-quota" title={`${attachedToday} of ${quota} leads in today`}>
            <div
              className="outreach-quota__track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={quota}
              aria-valuenow={attachedToday}
              aria-label="Today’s verified leads"
            >
              <div className="outreach-quota__fill" style={{ width: `${quotaPct}%` }} />
            </div>
            <span className="outreach-quota__label">
              {attachedToday} of {quota} leads today
            </span>
          </div>
        ) : null}

        {days.length > 0 ? (
          <div className="outreach-pace" role="list" aria-label="Sent by day">
            {days.map((row) => {
              const height = Math.max(8, Math.round((row.sent / maxDaySent) * 100));
              const isToday = row.date === today;
              return (
                <button
                  type="button"
                  role="listitem"
                  key={row.date}
                  className={`outreach-pace__day${isToday ? ' outreach-pace__day--today' : ''}${isWeekend(row.date) ? ' outreach-pace__day--weekend' : ''}`}
                  onClick={() => setPaceOpen(true)}
                  title={`${formatNyDateLabel(row.date)} · ${row.sent} sent · ${row.attached} leads`}
                >
                  <span className="outreach-pace__label">{weekdayLabel(row.date)}</span>
                  <span className="outreach-pace__bar" aria-hidden="true">
                    <span
                      className="outreach-pace__fill"
                      style={{ '--bar-height': `${height}%` } as CSSProperties}
                    />
                  </span>
                  <strong>{row.sent}</strong>
                </button>
              );
            })}
          </div>
        ) : null}

        {showRescue ? (
          <div className="drafting-rescue-notice" role="alert">
            <span>{rescue?.message || 'Drafting looks stuck.'}</span>
            <button
              type="button"
              className="btn btn--primary drafting-rescue-btn"
              disabled={rescueBusy}
              onClick={onRescue}
            >
              {rescueBusy ? 'Resuming…' : 'Resume drafting'}
            </button>
          </div>
        ) : null}

        {draftingPaused ? (
          <div className="drafting-rescue-notice drafting-rescue-notice--paused" role="status">
            <span>Drafting is paused. Resume when you are ready.</span>
            {showResume ? (
              <button
                type="button"
                className="btn btn--primary drafting-rescue-btn"
                disabled={resumeBusy}
                onClick={onResume}
              >
                {resumeBusy ? 'Resuming…' : 'Resume'}
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="outreach-board__foot">
          {showPause ? (
            <button
              type="button"
              className="drafting-link-btn"
              disabled={pauseBusy}
              onClick={onPause}
            >
              {pauseBusy ? 'Pausing…' : 'Pause drafting'}
            </button>
          ) : null}
          <Link href={`/campaigns/${campaignId}/prospect`} className="drafting-link-btn">
            Prospecting
          </Link>
          <Link href="/hub/queue" className="drafting-link-btn">
            Send queue
          </Link>
        </div>

        {pauseNotice ? <div className="drafting-rescue-success" role="status">{pauseNotice}</div> : null}
        {rescueNotice ? <div className="drafting-rescue-success" role="status">{rescueNotice}</div> : null}
        {pollError ? (
          <div className="drafting-poll-notice">
            <span>{pollError}</span>
            <button type="button" className="drafting-link-btn" onClick={onRetryPoll}>Retry</button>
          </div>
        ) : null}
      </section>

      {paceOpen && stats ? (
        <div className="dialog-overlay" role="presentation" onMouseDown={() => setPaceOpen(false)}>
          <section className="card dialog" role="dialog" aria-modal="true" aria-labelledby="outreach-pace-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="card__header">
              <div>
                <div className="card__title" id="outreach-pace-title">Daily pace</div>
                <div className="card__subtitle">{quota}/day target · last two weeks</div>
              </div>
              <button type="button" className="dialog__close" onClick={() => setPaceOpen(false)} aria-label="Close">×</button>
            </div>
            <div className="card__body">
              <div className="auto-sent-bars">
                {stats.by_day.map((row) => (
                  <div key={row.date} className="auto-sent-bars__row">
                    <span>{formatNyDateLabel(row.date)}</span>
                    <span
                      className="auto-sent-bars__fill"
                      style={{ '--bar-width': `${quota > 0 ? Math.min(100, (row.sent / quota) * 100) : 0}%` } as CSSProperties}
                    />
                    <strong>{row.sent} sent · {row.attached} in</strong>
                  </div>
                ))}
              </div>
              <p className="outreach-pace-dialog__foot">
                <Link href={`/campaigns/${campaignId}/prospect`} className="btn btn--secondary">
                  Open Prospect
                </Link>
              </p>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
