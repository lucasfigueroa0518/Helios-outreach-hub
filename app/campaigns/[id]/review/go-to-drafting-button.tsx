'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import {
  clearDraftingLaunch,
  DraftingLaunchOverlay,
  markDraftingLaunch,
} from '@/app/campaigns/[id]/draft/drafting-launch-overlay';
import { SenderSetupModal } from '@/app/campaigns/[id]/draft/sender-setup-modal';
import type { SenderProfile } from '@/app/campaigns/[id]/draft/types';

function idempotencyStorageKey(campaignId: string) {
  return `drafting-idempotency-${campaignId}`;
}

function readIdempotencyKey(campaignId: string) {
  const storageKey = idempotencyStorageKey(campaignId);
  let key = sessionStorage.getItem(storageKey);
  if (!key) {
    key = crypto.randomUUID();
    sessionStorage.setItem(storageKey, key);
  }
  return key;
}

type RuntimeReadiness = {
  ready: boolean;
  blockers: string[];
  batch_budget_usd: string;
  draft_research_concurrency: number;
};

export function GoToDraftingButton({
  campaignId,
  campaignName,
  defaultDisplayName,
  defaultWorkEmail,
}: {
  campaignId: string;
  campaignName?: string;
  defaultDisplayName: string;
  defaultWorkEmail: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<RuntimeReadiness | null>(null);
  const [senderModalOpen, setSenderModalOpen] = useState(false);
  const resumeAfterSender = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/campaigns/${campaignId}/drafting?readiness=1`);
        const data = await response.json();
        if (!cancelled && response.ok) setReadiness(data);
      } catch {
        // Keep button usable; startDrafting still surfaces runtime errors.
      }
    })();
    return () => { cancelled = true; };
  }, [campaignId]);

  const beginLaunch = useCallback(() => {
    flushSync(() => {
      setPending(true);
      setError(null);
    });
    markDraftingLaunch(campaignId);
  }, [campaignId]);

  const cancelLaunch = useCallback(() => {
    clearDraftingLaunch(campaignId);
    setPending(false);
  }, [campaignId]);

  const startDrafting = useCallback(async () => {
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/drafting`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotency_key: readIdempotencyKey(campaignId) }),
      });
      const data = await response.json();

      if (response.status === 422 && data.field_errors?.sender_profile) {
        cancelLaunch();
        resumeAfterSender.current = true;
        setSenderModalOpen(true);
        return;
      }
      if (response.status === 409 && data.code === 'idempotency_collision') {
        window.location.href = `/campaigns/${campaignId}/draft`;
        return;
      }
      if (!response.ok) {
        cancelLaunch();
        setError(data.error ?? 'Could not start drafting');
        return;
      }
      window.location.href = data.href ?? `/campaigns/${campaignId}/draft`;
    } catch {
      cancelLaunch();
      setError('Connection failed — try again.');
    }
  }, [campaignId, cancelLaunch]);

  const runtimeBlocked = Boolean(readiness && !readiness.ready);

  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => {
      cancelLaunch();
      setError('Starting drafting timed out — try again.');
    }, 120_000);
    return () => window.clearTimeout(timer);
  }, [pending, cancelLaunch]);

  async function ensureProfileAndStart() {
    if (pending || runtimeBlocked) return;
    beginLaunch();

    try {
      const profileResponse = await fetch('/api/sender-profiles');
      const profileData = await profileResponse.json();
      if (!profileResponse.ok) {
        setError(profileData.error ?? 'Could not load sender profile');
        cancelLaunch();
        return;
      }
      if (!profileData.profiles?.length) {
        cancelLaunch();
        resumeAfterSender.current = true;
        setSenderModalOpen(true);
        return;
      }
    } catch {
      setError('Connection failed — try again.');
      cancelLaunch();
      return;
    }
    await startDrafting();
  }

  function onSenderSaved(_profile: SenderProfile) {
    setSenderModalOpen(false);
    if (resumeAfterSender.current) {
      resumeAfterSender.current = false;
      beginLaunch();
      void startDrafting();
    }
  }

  return (
    <>
      {pending ? <DraftingLaunchOverlay campaignName={campaignName} /> : null}
      <div className="go-to-drafting">
        <button
          type="button"
          className={`btn btn--primary${pending ? ' btn--pending' : ''}`}
          disabled={pending || runtimeBlocked}
          aria-busy={pending}
          onClick={() => void ensureProfileAndStart()}
        >
          {pending ? 'Starting drafting…' : 'Go to Drafting'}
        </button>
        {runtimeBlocked && readiness?.blockers?.length ? (
          <p className="field__error" role="alert">{readiness.blockers.join(' · ')}</p>
        ) : null}
        {error ? <p className="field__error" role="alert">{error}</p> : null}
      </div>
      <SenderSetupModal
        defaultDisplayName={defaultDisplayName}
        defaultWorkEmail={defaultWorkEmail}
        open={senderModalOpen}
        onClose={() => {
          resumeAfterSender.current = false;
          setSenderModalOpen(false);
        }}
        onSaved={onSenderSaved}
      />
    </>
  );
}
