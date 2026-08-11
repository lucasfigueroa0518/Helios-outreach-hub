import { GitCommit, GitPullRequest, CircleCheck } from 'lucide-react';

import type { RepoEvent } from '@/lib/dashboards/types';

function eventLabel(event: RepoEvent): string {
  if (event.type === 'COMMIT') return `commit ${event.externalId.slice(0, 7)}`;
  if (event.type === 'PR_MERGED') return `PR #${event.externalId}`;
  return `Issue #${event.externalId}`;
}

function EventIcon({ type }: { type: RepoEvent['type'] }) {
  const cls = 'h-3 w-3 shrink-0';
  if (type === 'COMMIT') return <GitCommit className={cls} />;
  if (type === 'PR_MERGED') return <GitPullRequest className={cls} />;
  return <CircleCheck className={cls} />;
}

export default function SourceChip({ event }: { event: RepoEvent }) {
  return (
    <a
      href={event.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-pill border border-border-soft bg-bg-alt px-2 py-0.5 text-[11px] font-medium text-fg-3 transition-colors hover:border-border hover:text-fg-2"
    >
      <EventIcon type={event.type} />
      {eventLabel(event)}
    </a>
  );
}
