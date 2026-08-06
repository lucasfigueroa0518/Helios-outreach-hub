'use client';

import { DraftingProgressPlane } from '@/app/components/plane-flight';
import type { DraftingSnapshot } from '@/app/campaigns/[id]/draft/types';

function statusSentence(snapshot: DraftingSnapshot | null, launching: boolean) {
  if (launching && !snapshot) {
    return 'Starting drafting workspace…';
  }
  if (!snapshot) {
    return 'Loading drafting workspace…';
  }
  const { counts, workspace, progress, rescue } = snapshot;
  if (workspace.paused || workspace.status === 'paused') {
    return 'Drafting paused — click Resume to continue';
  }
  if (launching) {
    return 'Starting drafting workspace…';
  }
  if (workspace.review_complete && counts.mailbox_valid_total > 0) {
    return `All ${counts.mailbox_valid_total} valid-email drafts are downloaded`;
  }
  if (workspace.generation_complete) {
    return 'All valid emails drafted';
  }
  if (!rescue.worker_healthy && !workspace.generation_complete) {
    return 'Drafting paused — worker offline';
  }
  if (counts.running > 0) {
    const total = progress.mailbox_valid_total;
    return `Drafting ${total} valid email${total === 1 ? '' : 's'} · ${progress.generated} of ${total} drafted`;
  }
  if (progress.mailbox_valid_total > 0) {
    return `${progress.generated} of ${progress.mailbox_valid_total} valid emails drafted`;
  }
  return 'No mailbox-verified valid emails yet';
}

export function DraftingStatusStrip({
  snapshot,
  launching,
  leadsAttention,
  pollError,
  decisionsMade,
  rescueBusy,
  rescueNotice,
  pauseBusy,
  resumeBusy,
  cancelRunBusy,
  pauseNotice,
  onRetryPoll,
  onRescue,
  onPause,
  onResume,
  onCancelRun,
  onSelectEmail,
  onSelectLeads,
}: {
  snapshot: DraftingSnapshot | null;
  launching: boolean;
  leadsAttention: number;
  pollError: string | null;
  decisionsMade: number;
  rescueBusy?: boolean;
  rescueNotice?: string | null;
  pauseBusy?: boolean;
  resumeBusy?: boolean;
  cancelRunBusy?: boolean;
  pauseNotice?: string | null;
  onRetryPoll: () => void;
  onRescue?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onCancelRun?: () => void;
  onSelectEmail: () => void;
  onSelectLeads: () => void;
}) {
  const running = launching || ((snapshot?.counts.running ?? 0) > 0 && !snapshot?.workspace.paused);
  const progressMax = snapshot?.progress.mailbox_valid_total ?? 0;
  const progressValue = snapshot?.progress.generated ?? 0;
  const showPlane = running;
  const showTiles = Boolean(snapshot) || launching;
  const sentence = statusSentence(snapshot, launching);
  const rescue = snapshot?.rescue;
  const workspacePaused = Boolean(snapshot?.workspace.paused || snapshot?.workspace.status === 'paused');
  const showRescue = Boolean(rescue?.needed && onRescue && !workspacePaused);
  const showPause = Boolean(
    onPause
    && snapshot
    && !workspacePaused
    && !snapshot.workspace.generation_complete
    && snapshot.workspace.status === 'active',
  );
  const showResume = Boolean(onResume && workspacePaused);

  return (
    <div
      className={`drafting-status-strip${running ? ' drafting-status-strip--active' : ''}${launching ? ' drafting-status-strip--launching' : ''}`}
      role="status"
      aria-live="polite"
      aria-busy={running || Boolean(rescueBusy)}
    >
      {showPlane ? <DraftingProgressPlane /> : null}

      <div className="drafting-status-strip__content">
      <div className="drafting-status-strip__head">
        {running ? (
          <span className="drafting-status-strip__spinner loading-spinner" aria-hidden="true" />
        ) : null}
        <p className="drafting-status-strip__sentence">{sentence}</p>
      </div>

      <div className="drafting-animation-stage">
        <div className={`drafting-progress${running ? ' drafting-progress--active' : ''}`}>
          {progressMax === 0 ? (
            <>
              {running ? (
                <div className="drafting-progress__track drafting-progress__track--indeterminate" aria-hidden="true">
                  <div className="drafting-progress__fill drafting-progress__fill--indeterminate" />
                </div>
              ) : null}
              <span className="drafting-progress__label">
                {launching || running ? 'Queueing mailbox-valid leads…' : 'No mailbox-verified valid emails yet'}
              </span>
            </>
          ) : (
            <>
              <div
                className="drafting-progress__track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={progressMax}
                aria-valuenow={progressValue}
                aria-valuetext={`${progressValue} of ${progressMax} valid emails drafted`}
              >
                <div
                  className="drafting-progress__fill"
                  style={{ width: `${Math.min(100, (progressValue / progressMax) * 100)}%` }}
                />
              </div>
              <span className="drafting-progress__label">
                {progressValue} of {progressMax} valid emails drafted
              </span>
            </>
          )}
        </div>

        {showTiles ? (
          <div className="drafting-count-tiles">
            <button type="button" className="stat-tile" onClick={onSelectEmail}>
              <span className="stat-tile__label">Generated</span>
              <span className="stat-tile__value">{snapshot?.counts.generated ?? '—'}</span>
            </button>
            <button type="button" className="stat-tile stat-tile--positive" onClick={onSelectEmail}>
              <span className="stat-tile__label">Downloaded</span>
              <span className="stat-tile__value">{snapshot?.counts.approved ?? '—'}</span>
            </button>
            <button type="button" className="stat-tile stat-tile--warning" onClick={onSelectLeads}>
              <span className="stat-tile__label">Need Review</span>
              <span className="stat-tile__value">{snapshot ? leadsAttention : '—'}</span>
            </button>
          </div>
        ) : null}
      </div>

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

      {workspacePaused ? (
        <div className="drafting-rescue-notice drafting-rescue-notice--paused" role="status">
          <span>Drafting is paused. Item progress is saved — resume when you are ready, or cancel the run to start over from Review.</span>
          <div className="drafting-paused-actions">
            {showResume ? (
              <button
                type="button"
                className="btn btn--primary drafting-rescue-btn"
                disabled={resumeBusy || cancelRunBusy}
                onClick={onResume}
              >
                {resumeBusy ? 'Resuming…' : 'Resume'}
              </button>
            ) : null}
            {onCancelRun ? (
              <button
                type="button"
                className="btn btn--secondary drafting-cancel-run-btn"
                disabled={cancelRunBusy || resumeBusy}
                onClick={onCancelRun}
              >
                {cancelRunBusy ? 'Cancelling…' : 'Cancel Run'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {showPause ? (
        <div className="drafting-pause-actions">
          <button
            type="button"
            className="btn btn--secondary drafting-pause-btn"
            disabled={pauseBusy}
            onClick={onPause}
          >
            {pauseBusy ? 'Pausing…' : 'Pause drafting'}
          </button>
        </div>
      ) : null}

      {pauseNotice ? (
        <div className="drafting-rescue-success" role="status">
          {pauseNotice}
        </div>
      ) : null}

      {rescueNotice ? (
        <div className="drafting-rescue-success" role="status">
          {rescueNotice}
        </div>
      ) : null}

      {pollError ? (
        <div className="drafting-poll-notice">
          <span>{pollError}</span>
          <button type="button" className="drafting-link-btn" onClick={onRetryPoll}>
            Retry
          </button>
        </div>
      ) : null}
      {decisionsMade > 0 ? (
        <span className="drafting-decisions-pulse">{decisionsMade} decisions made this session</span>
      ) : null}
      </div>
    </div>
  );
}
