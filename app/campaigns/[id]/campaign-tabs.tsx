'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

type TabKey = 'review' | 'draft';

type Notice = {
  message: string;
  leaving: boolean;
};

export function CampaignTabs({
  campaignId,
  active,
  reviewEnabled: reviewEnabledInitial,
  draftEnabled: draftEnabledInitial = false,
  showReview = true,
}: {
  campaignId: string;
  active: 'upload' | 'review' | 'draft';
  reviewEnabled: boolean;
  draftEnabled?: boolean;
  /** Pre-enriched campaigns hide Review entirely (Upload → Draft only). */
  showReview?: boolean;
}) {
  const [reviewEnabled, setReviewEnabled] = useState(reviewEnabledInitial);
  const [draftEnabled, setDraftEnabled] = useState(draftEnabledInitial);
  const [shakingItem, setShakingItem] = useState<TabKey | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  useEffect(() => {
    setReviewEnabled(reviewEnabledInitial);
  }, [reviewEnabledInitial]);

  useEffect(() => {
    setDraftEnabled(draftEnabledInitial);
  }, [draftEnabledInitial]);

  // Keep Review unlocked after enrichment finishes — server render is stale on the Upload tab.
  useEffect(() => {
    if (!showReview || reviewEnabled) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/campaigns/${campaignId}/uploads`);
        const data = await response.json();
        if (!cancelled && data.review_enabled) setReviewEnabled(true);
      } catch {
        // Ignore transient fetch errors; next poll will retry.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [campaignId, reviewEnabled, showReview]);

  const blockNavigation = useCallback(
    (key: TabKey, message: string) => {
      clearTimers();
      setShakingItem(key);
      setNotice({ message, leaving: false });
      timers.current = [
        setTimeout(() => setShakingItem(null), 420),
        setTimeout(() => setNotice((prev) => (prev ? { ...prev, leaving: true } : null)), 2600),
        setTimeout(() => setNotice(null), 3000),
      ];
    },
    [clearTimers],
  );

  return (
    <div className="segmented segmented--nav" aria-label="Campaign sections">
      <Link
        href={`/campaigns/${campaignId}`}
        className={`segmented__item${active === 'upload' ? ' segmented__item--active' : ''}`}
      >
        Upload
      </Link>
      {showReview && (
        reviewEnabled ? (
          <Link
            href={`/campaigns/${campaignId}/review`}
            className={`segmented__item${active === 'review' ? ' segmented__item--active' : ''}`}
          >
            Review
          </Link>
        ) : (
          <button
            type="button"
            className={`segmented__item segmented__item--disabled${shakingItem === 'review' ? ' segmented__item--shake' : ''}`}
            aria-disabled="true"
            onClick={() => blockNavigation('review', 'Upload files and run enrichment first')}
          >
            Review
          </button>
        )
      )}
      {draftEnabled ? (
        <Link
          href={`/campaigns/${campaignId}/draft`}
          className={`segmented__item${active === 'draft' ? ' segmented__item--active' : ''}`}
        >
          Draft
        </Link>
      ) : (
        <button
          type="button"
          className={`segmented__item segmented__item--disabled${shakingItem === 'draft' ? ' segmented__item--shake' : ''}`}
          aria-disabled="true"
          onClick={() =>
            blockNavigation(
              'draft',
              showReview
                ? (reviewEnabled
                  ? 'Open Review and click Go to Drafting to start email drafts'
                  : 'Upload files and run enrichment first')
                : 'Upload your sheet and click Go to Draft',
            )
          }
        >
          Draft
        </button>
      )}
      {notice && (
        <div className={`segmented__notice${notice.leaving ? ' segmented__notice--leaving' : ''}`} role="status">
          {notice.message}
        </div>
      )}
    </div>
  );
}
