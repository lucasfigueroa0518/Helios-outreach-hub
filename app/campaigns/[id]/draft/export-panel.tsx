'use client';

import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';

import type { DraftingSnapshot } from '@/app/campaigns/[id]/draft/types';

export type ExportPulse = {
  id: number;
  recipientLabel: string;
  approvedCount: number;
} | null;

/**
 * Download visual guide — only appears after the user downloads a draft for
 * export. Sending lives on the draft card; this panel is the export queue.
 */
export function ExportPanel({
  campaignId,
  snapshot,
  exportPulse,
  onSwitchToLeads,
}: {
  campaignId: string;
  snapshot: DraftingSnapshot;
  exportPulse: ExportPulse;
  onSwitchToLeads: () => void;
}) {
  const { exports: exportState, counts } = snapshot;
  const unresolvedLeads = counts.leads_attention + counts.verifying_mailbox + counts.waiting_for_enrichment;
  const [pulseVisible, setPulseVisible] = useState(false);
  const [pulseKey, setPulseKey] = useState(0);

  useEffect(() => {
    if (!exportPulse) return;
    setPulseKey(exportPulse.id);
    setPulseVisible(true);
    const timer = window.setTimeout(() => setPulseVisible(false), 2200);
    return () => window.clearTimeout(timer);
  }, [exportPulse]);

  const exportReadyCount = counts.approved;
  // Stay visible briefly after a download toast even if the optimistic count
  // has not landed yet; otherwise only show once something is queued for export.
  const showGuide = exportReadyCount > 0 || pulseVisible;
  if (!showGuide) return null;

  const generatedForReview = Math.max(counts.generated, exportReadyCount, 1);
  const exportPct = Math.min(100, Math.round((exportReadyCount / generatedForReview) * 100));

  return (
    <section
      className={`drafting-export card${pulseVisible ? ' drafting-export--pulse' : ''}`}
      aria-labelledby="drafting-export-heading"
    >
      <div className="card__header">
        <div>
          <div className="card__title" id="drafting-export-heading">
            {exportState.available ? 'Ready to export' : 'Export queue'}
          </div>
          <div className="card__subtitle">
            {exportReadyCount === 0
              ? 'Downloaded drafts land here for CSV or Cowork export.'
              : `${exportReadyCount} downloaded draft${exportReadyCount === 1 ? '' : 's'} ready to export.`}
          </div>
        </div>
      </div>
      <div className="card__body drafting-export__body">
        <div className="drafting-export__queue" aria-live="polite">
          <div className="drafting-export__queue-head">
            <span className="drafting-export__queue-label">Downloaded</span>
            <strong
              key={`approved-${exportReadyCount}-${pulseKey}`}
              className={`drafting-export__queue-count${pulseVisible ? ' drafting-export__queue-count--bump' : ''}`}
            >
              {exportReadyCount}
            </strong>
            <span className="drafting-export__queue-meta">
              of {generatedForReview} generated
            </span>
          </div>
          <div
            className="drafting-export__queue-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={generatedForReview}
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
              Use Download on a draft to add it here, then export when you are ready.
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
      </div>
    </section>
  );
}
