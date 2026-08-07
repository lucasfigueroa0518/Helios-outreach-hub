'use client';

import { useEffect, useState } from 'react';

export function draftingLaunchStorageKey(campaignId: string) {
  return `drafting-launch-${campaignId}`;
}

export function markDraftingLaunch(campaignId: string) {
  sessionStorage.setItem(draftingLaunchStorageKey(campaignId), String(Date.now()));
}

export function readDraftingLaunch(campaignId: string): boolean {
  if (typeof window === 'undefined') return false;
  return sessionStorage.getItem(draftingLaunchStorageKey(campaignId)) != null;
}

export function readDraftingLaunchStartedAt(campaignId: string): number | null {
  if (typeof window === 'undefined') return null;
  const raw = sessionStorage.getItem(draftingLaunchStorageKey(campaignId));
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function clearDraftingLaunch(campaignId: string) {
  sessionStorage.removeItem(draftingLaunchStorageKey(campaignId));
}

const PATIENCE_AFTER_MS = 10_000;

export function DraftingLaunchOverlay({
  campaignName,
  phaseLine,
  healthy = true,
}: {
  campaignName?: string;
  /** Optional progress line, e.g. "Extracting sheets 42/173". */
  phaseLine?: string | null;
  /** When false, patience copy is suppressed (error / stuck unknown). */
  healthy?: boolean;
}) {
  const [showPatience, setShowPatience] = useState(false);

  useEffect(() => {
    if (!healthy) {
      setShowPatience(false);
      return;
    }
    const timer = window.setTimeout(() => setShowPatience(true), PATIENCE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [healthy]);

  return (
    <div className="drafting-launch-overlay" role="status" aria-live="assertive" aria-busy="true">
      <div className="drafting-launch-overlay__panel">
        <span className="drafting-launch-overlay__spinner loading-spinner" aria-hidden="true" />
        <strong className="drafting-launch-overlay__title">Starting drafting</strong>
        <p className="drafting-launch-overlay__subtitle">
          {campaignName ? `${campaignName} · ` : ''}
          {phaseLine?.trim()
            || 'Queueing research and opening your workspace…'}
        </p>
        {showPatience && healthy ? (
          <p className="drafting-launch-overlay__patience">
            Be patient, your workspace will be ready soon.
          </p>
        ) : null}
      </div>
    </div>
  );
}
