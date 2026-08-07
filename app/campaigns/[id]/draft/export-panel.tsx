'use client';

import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';

import type { DraftingSnapshot } from '@/app/campaigns/[id]/draft/types';

export type ExportPulse = {
  id: number;
  recipientLabel: string;
  approvedCount: number;
} | null;

export function ExportPanel({
  campaignId,
  snapshot,
  exportPulse,
  onSwitchToLeads,
  onRefresh,
}: {
  campaignId: string;
  snapshot: DraftingSnapshot;
  exportPulse: ExportPulse;
  onSwitchToLeads: () => void;
  onRefresh: () => void;
}) {
  const { exports: exportState, sends: sendState, counts, workspace } = snapshot;
  const unresolvedLeads = counts.leads_attention + counts.verifying_mailbox + counts.waiting_for_enrichment;
  const [pulseVisible, setPulseVisible] = useState(false);
  const [pulseKey, setPulseKey] = useState(0);
  const [bulkSendState, setBulkSendState] = useState<'idle' | 'sending' | 'error'>('idle');
  const [bulkSendMessage, setBulkSendMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!exportPulse) return;
    setPulseKey(exportPulse.id);
    setPulseVisible(true);
    const timer = window.setTimeout(() => setPulseVisible(false), 2200);
    return () => window.clearTimeout(timer);
  }, [exportPulse]);

  if (!workspace.generation_complete && counts.generated === 0) return null;

  const exportReadyCount = counts.approved;
  const sentCount = counts.sent;
  const deliveredCount = counts.delivered ?? 0;
  const openedCount = counts.opened ?? 0;
  const repliedCount = counts.replied ?? 0;
  const bouncedCount = counts.bounced ?? 0;
  const pendingSendCount = sendState.pending;
  const generatedForReview = Math.max(counts.generated, exportReadyCount);
  const exportPct = generatedForReview > 0
    ? Math.min(100, Math.round((exportReadyCount / generatedForReview) * 100))
    : 0;

  return (
    <section
      className={`drafting-export card${pulseVisible ? ' drafting-export--pulse' : ''}`}
      aria-labelledby="drafting-export-heading"
    >
      <div className="card__header">
        <div>
          <div className="card__title" id="drafting-export-heading">
            {exportState.available ? 'Ready to export' : 'Review progress'}
          </div>
          <div className="card__subtitle">
            {exportState.available
              ? `${counts.approved} downloaded draft${counts.approved === 1 ? '' : 's'} will be exported.`
              : exportState.blocking_reasons.join(' · ')}
          </div>
        </div>
      </div>
      <div className="card__body drafting-export__body">
        <div className="drafting-export__queue" aria-live="polite">
          <div className="drafting-export__queue-head">
            <span className="drafting-export__queue-label">Export queue</span>
            <strong
              key={`approved-${exportReadyCount}-${pulseKey}`}
              className={`drafting-export__queue-count${pulseVisible ? ' drafting-export__queue-count--bump' : ''}`}
            >
              {exportReadyCount}
            </strong>
            <span className="drafting-export__queue-meta">
              downloaded · {sentCount} sent
              {sentCount > 0
                ? ` · ${deliveredCount} delivered · ${openedCount} opened · ${repliedCount} replied${bouncedCount > 0 ? ` · ${bouncedCount} bounced` : ''}`
                : ''}
              {' · '}{pendingSendCount} ready (no retry)
              {typeof sendState.queued_count === 'number' && sendState.queued_count > 0
                ? ` · ${sendState.queued_count} queued`
                : ''}
              {typeof sendState.today_remaining === 'number'
                ? ` · ${sendState.today_remaining} left today`
                : ''}
            </span>
          </div>
          <div
            className="drafting-export__queue-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={generatedForReview || 1}
            aria-valuenow={exportReadyCount}
            aria-valuetext={`${exportReadyCount} of ${generatedForReview} drafts downloaded for export`}
          >
            <div
              className="drafting-export__queue-fill"
              style={{ width: `${exportPct}%` }}
            />
          </div>
          {pulseVisible && exportPulse ? (
            <p key={pulseKey} className="drafting-export__toast" role="status">
              <span className="drafting-export__toast-check" aria-hidden="true"><Check size={12} /></span>
              <span>
                <strong>{exportPulse.recipientLabel}</strong>
                {' '}queued for export
              </span>
            </p>
          ) : (
            <p className="drafting-export__queue-hint">
              Each download lands here and can be exported immediately.
            </p>
          )}
        </div>

        {unresolvedLeads > 0 ? (
          <p className="drafting-export__leads-note">
            {unresolvedLeads} lead{unresolvedLeads === 1 ? '' : 's'} still need verification or correction.{' '}
            <button type="button" className="drafting-link-btn" onClick={onSwitchToLeads}>
              View in Leads mode
            </button>
          </p>
        ) : null}
        <div className="drafting-export__actions">
          <button
            type="button"
            className={`btn btn--primary${sendState.available ? '' : ' btn--disabled-link'}`}
            disabled={!sendState.available || bulkSendState === 'sending'}
            onClick={() => {
              if (!sendState.available || bulkSendState === 'sending') return;
              setBulkSendState('sending');
              setBulkSendMessage(null);
              void (async () => {
                try {
                  const response = await fetch(`/api/campaigns/${campaignId}/drafting/send`, {
                    method: 'POST',
                  });
                  const data = await response.json().catch(() => ({}));
                  if (!response.ok) {
                    setBulkSendState('error');
                    setBulkSendMessage(typeof data.error === 'string' ? data.error : 'Send failed');
                    onRefresh();
                    return;
                  }
                  setBulkSendState('idle');
                  const parts = [
                    data.sent ? `Sent ${data.sent} now` : null,
                    data.queued ? `Queued ${data.queued}` : null,
                    data.failed ? `${data.failed} failed` : null,
                  ].filter(Boolean);
                  setBulkSendMessage(parts.length > 0 ? parts.join(' · ') : 'Nothing to send');
                  onRefresh();
                } catch (error) {
                  setBulkSendState('error');
                  setBulkSendMessage(error instanceof Error ? error.message : 'Send failed');
                  onRefresh();
                }
              })();
            }}
          >
            {bulkSendState === 'sending'
              ? 'Sending…'
              : pendingSendCount > 0
                ? `Send All Ready (${pendingSendCount})`
                : 'Send All Ready'}
          </button>
          <a
            className={`btn btn--primary${exportState.available ? '' : ' btn--disabled-link'}`}
            href={exportState.available ? `/api/campaigns/${campaignId}/drafting/export?type=mail` : undefined}
            aria-disabled={!exportState.available}
            onClick={(event) => {
              if (!exportState.available) event.preventDefault();
            }}
          >
            Export mail-ready CSV
          </a>
          <a
            className={`btn btn--secondary${exportState.available ? '' : ' btn--disabled-link'}`}
            href={exportState.available ? `/api/campaigns/${campaignId}/drafting/export?type=cowork` : undefined}
            aria-disabled={!exportState.available}
            onClick={(event) => {
              if (!exportState.available) event.preventDefault();
            }}
          >
            Export Claude Cowork prompt
          </a>
        </div>
        {bulkSendMessage ? (
          <p className="text-muted drafting-export__timestamp" role="status">{bulkSendMessage}</p>
        ) : null}
        {!sendState.configured ? (
          <p className="text-muted drafting-export__timestamp">
            Add RESEND_API_KEY to .env.local to enable sending.
          </p>
        ) : null}
        {workspace.review_complete ? (
          <p className="text-muted drafting-export__timestamp">
            Last updated {new Date(workspace.updated_at).toLocaleString()}
          </p>
        ) : null}
      </div>
    </section>
  );
}
