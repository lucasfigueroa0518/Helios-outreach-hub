'use client';

import { useState } from 'react';
import type { DraftingSnapshot, WorkspaceActivityPhase } from '@/app/campaigns/[id]/draft/types';

function phaseLabel(phase: WorkspaceActivityPhase, state: string): string {
  if (phase === 'research') {
    if (state === 'researching') return 'Researching';
    if (state === 'waiting_company_research') return 'Waiting on company research';
    return 'Queued for research';
  }
  if (phase === 'writing') {
    return state === 'writing' ? 'Drafting email' : 'Queued to draft';
  }
  if (phase === 'repair') return 'Repairing draft';
  if (phase === 'rewrite') {
    return state === 'rewriting' ? 'Rewriting' : 'Queued to rewrite';
  }
  return state === 'verifying_mailbox' ? 'Verifying mailbox' : 'Queued to verify';
}

function phaseClass(phase: WorkspaceActivityPhase): string {
  return `drafting-activity-item__phase--${phase}`;
}

function leadLabel(item: DraftingSnapshot['activity']['items'][number]): string {
  const name = item.lead_name ?? 'Unknown lead';
  const detail = [item.title, item.company].filter(Boolean).join(' · ');
  return detail ? `${name} — ${detail}` : name;
}

export function DraftingActivityPanel({ snapshot }: { snapshot: DraftingSnapshot }) {
  const [expanded, setExpanded] = useState(false);
  const { activity, progress, workspace, counts } = snapshot;
  const generationActive = (!workspace.generation_complete && progress.mailbox_valid_total > 0)
    || activity.items.length > 0
    || counts.running > 0;
  if (!generationActive && activity.items.length === 0) return null;

  const workerCount = activity.active_workers;
  const workerLimit = activity.worker_limit;

  return (
    <section className="drafting-activity-panel" aria-live="polite" aria-label="Drafting activity">
      <header className="drafting-activity-panel__header">
        <div>
          <strong>Live drafting activity</strong>
          <p>
            {workerCount > 0
              ? `${workerCount} worker${workerCount === 1 ? '' : 's'} running`
              : 'Workers idle — queue catching up'}
            {workerLimit > 0 ? ` · up to ${workerLimit} parallel` : ''}
          </p>
        </div>
        {workerCount > 0 ? (
          <span className="drafting-activity-panel__pulse" aria-hidden="true">
            <span className="loading-spinner" />
          </span>
        ) : null}
      </header>

      {activity.items.length > 0 ? (
        <>
          <div className={`drafting-activity-list-wrapper ${expanded ? 'drafting-activity-list-wrapper--expanded' : 'drafting-activity-list-wrapper--collapsed'}`}>
            <ul className="drafting-activity-list">
              {activity.items.map((item) => (
                <li className="drafting-activity-item" key={item.item_id}>
                  <div className="drafting-activity-item__head">
                    <span className="drafting-activity-item__ordinal">#{item.ordinal}</span>
                    <span className="drafting-activity-item__lead">{leadLabel(item)}</span>
                    <span className={`drafting-activity-item__phase ${phaseClass(item.phase)}`}>
                      {phaseLabel(item.phase, item.state)}
                    </span>
                  </div>
                  {item.snippet ? (
                    <blockquote className="drafting-activity-item__snippet">
                      {item.snippet}
                    </blockquote>
                  ) : item.phase === 'research' || item.phase === 'writing' ? (
                    <p className="drafting-activity-item__waiting">
                      {item.phase === 'research'
                        ? 'Gathering prospect and company context…'
                        : 'Turning research into a personalized draft…'}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
            {!expanded && activity.items.length > 2 ? (
              <div className="drafting-activity-list-fade" />
            ) : null}
          </div>
          {activity.items.length > 2 ? (
            <button
              type="button"
              className="btn btn--quiet drafting-activity-toggle-btn"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          ) : null}
        </>
      ) : (
        <p className="drafting-activity-panel__empty">
          Queueing mailbox-valid leads — active jobs will appear here as workers pick them up.
        </p>
      )}
    </section>
  );
}
