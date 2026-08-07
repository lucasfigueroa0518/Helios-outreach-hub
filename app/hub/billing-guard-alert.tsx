'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink, X } from 'lucide-react';

import { requestJson } from '@/lib/client-request';

type BillingGuard = {
  tripped: boolean;
  cost_amount: number | null;
  currency_code: string | null;
  alert_title: string | null;
  detail: string | null;
  console_url: string | null;
  tripped_at: string | null;
  acknowledged_at: string | null;
};

export function BillingGuardAlert() {
  const [guard, setGuard] = useState<BillingGuard | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const data = await requestJson<{ guard: BillingGuard }>('/api/billing-guard');
      setGuard(data.guard);
      if (data.guard.tripped && !data.guard.acknowledged_at) {
        setDismissed(false);
      }
    } catch {
      // Non-blocking — hub still works if the endpoint is briefly unavailable.
    }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!guard?.tripped) return null;

  const costLabel = guard.cost_amount != null
    ? `${guard.currency_code ?? 'USD'} ${guard.cost_amount.toFixed(4)}`
    : 'billable usage detected';

  const showModal = !dismissed && !guard.acknowledged_at;

  async function acknowledge() {
    setBusy(true);
    try {
      const data = await requestJson<{ guard: BillingGuard }>('/api/billing-guard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'acknowledge' }),
      });
      setGuard(data.guard);
      setDismissed(true);
    } catch {
      // keep modal open
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="billing-guard-banner" role="alert">
        <AlertTriangle size={16} aria-hidden="true" />
        <div className="billing-guard-banner__copy">
          <strong>{guard.alert_title ?? 'Cloud worker billing exceeded $0'}</strong>
          <span>
            Fail-closed: orchestration worker will not claim jobs.
            {' '}Reported: {costLabel}.
            {guard.tripped_at ? ` Tripped ${new Date(guard.tripped_at).toLocaleString()}.` : ''}
          </span>
        </div>
        {guard.console_url ? (
          <a
            className="btn btn--secondary"
            href={guard.console_url}
            target="_blank"
            rel="noreferrer"
          >
            Open GCP billing <ExternalLink size={14} />
          </a>
        ) : null}
      </div>

      {showModal ? (
        <div className="drawer-overlay billing-guard-modal-overlay" role="presentation">
          <div
            className="billing-guard-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="billing-guard-title"
            aria-describedby="billing-guard-desc"
          >
            <div className="billing-guard-modal__header">
              <AlertTriangle size={22} aria-hidden="true" />
              <h2 id="billing-guard-title">
                {guard.alert_title ?? 'Cloud worker billing exceeded $0'}
              </h2>
              <button
                type="button"
                className="drawer__close"
                aria-label="Dismiss for now"
                disabled={busy}
                onClick={() => void acknowledge()}
              >
                <X size={16} />
              </button>
            </div>
            <div className="billing-guard-modal__body" id="billing-guard-desc">
              <p>
                The always-on GCP worker reported billable usage above the $0 Always Free
                ceiling. The worker is <strong>fail-closed</strong>: it will not process
                enrichment, drafting, or queued email sends until an admin clears the guard
                after reviewing the bill.
              </p>
              <ul>
                <li>Reported cost: <strong>{costLabel}</strong></li>
                {guard.tripped_at ? (
                  <li>Tripped at: {new Date(guard.tripped_at).toLocaleString()}</li>
                ) : null}
                {guard.detail ? <li>{guard.detail}</li> : null}
              </ul>
            </div>
            <div className="billing-guard-modal__actions">
              {guard.console_url ? (
                <a
                  className="btn btn--primary"
                  href={guard.console_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Review GCP billing
                </a>
              ) : null}
              <button
                type="button"
                className="btn btn--secondary"
                disabled={busy}
                onClick={() => void acknowledge()}
              >
                I understand — keep fail-closed
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
