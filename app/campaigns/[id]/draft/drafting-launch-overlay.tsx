'use client';

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

export function clearDraftingLaunch(campaignId: string) {
  sessionStorage.removeItem(draftingLaunchStorageKey(campaignId));
}

export function DraftingLaunchOverlay({ campaignName }: { campaignName?: string }) {
  return (
    <div className="drafting-launch-overlay" role="status" aria-live="assertive" aria-busy="true">
      <div className="drafting-launch-overlay__panel">
        <span className="drafting-launch-overlay__spinner loading-spinner" aria-hidden="true" />
        <strong className="drafting-launch-overlay__title">Starting drafting</strong>
        <p className="drafting-launch-overlay__subtitle">
          {campaignName ? `${campaignName} · ` : ''}
          Queueing research and opening your workspace…
        </p>
      </div>
    </div>
  );
}
