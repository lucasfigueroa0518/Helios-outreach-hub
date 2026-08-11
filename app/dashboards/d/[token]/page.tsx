import type { Metadata } from 'next';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { differenceInCalendarDays, format, formatDistanceToNow } from 'date-fns';
import { CircleCheck, GitCommit, GitPullRequest } from 'lucide-react';

import DaysProgressBar from '@/components/dashboards/dashboard/DaysProgressBar';
import GitHubEmptyState from '@/components/dashboards/dashboard/GitHubEmptyState';
import Eyebrow from '@/components/dashboards/Eyebrow';
import SourceChip from '@/components/dashboards/SourceChip';
import { getDashboardData } from '@/lib/dashboards/data';
import type { RepoEvent } from '@/lib/dashboards/types';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

function EventTypeIcon({ type }: { type: RepoEvent['type'] }) {
  const cls = 'h-4 w-4 shrink-0';
  if (type === 'COMMIT') return <GitCommit className={`${cls} text-fg-muted`} />;
  if (type === 'PR_MERGED') return <GitPullRequest className={`${cls} text-[#138510]`} />;
  return <CircleCheck className={`${cls} text-[#FF5E1A]`} />;
}

export default async function ClientDashboardPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const data = await getDashboardData(token);
  if (!data) notFound();

  const { project, latestUpdate, recentEvents, eventsById } = data;
  const deckSrc = `/api/dashboards/deck/${project.accessToken}`;

  if (project.status === 'ARCHIVED') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-page px-6 text-center font-body">
        <div>
          <Eyebrow color="ink" className="mb-4">Project Archived</Eyebrow>
          <p className="text-body font-light text-fg-2">
            This project has been archived and is no longer active.
          </p>
        </div>
      </div>
    );
  }

  const today = new Date();
  const daysRemaining = differenceInCalendarDays(project.targetEndDate, today);

  return (
    <div className="min-h-screen bg-bg-page font-body">
      {project.status === 'PAUSED' && (
        <div className="bg-[#FFF8F5] border-b border-[#FFCFB8] px-6 py-3 text-center">
          <p className="text-sm font-medium text-[#C94C00]">
            This project is currently paused. The next update will appear when work resumes.
          </p>
        </div>
      )}
      {project.status === 'COMPLETE' && project.completedAt && (
        <div className="bg-[#F0FAF0] border-b border-[#A8D9A7] px-6 py-3 text-center">
          <p className="text-sm font-medium text-[#138510]">
            This project completed on {format(project.completedAt, 'MMMM d, yyyy')}. Final summary below.
          </p>
        </div>
      )}

      <header className="sticky top-0 z-50 border-b border-border-soft bg-white/95 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1280px] items-center justify-between px-6">
          <Image
            src="/dashboards/helios-logo.png"
            alt="Helios Marketing"
            width={100}
            height={32}
            className="h-7 w-auto"
            priority
          />
          <p className="absolute left-1/2 -translate-x-1/2 text-sm font-medium text-fg-1 hidden sm:block truncate max-w-[40%]">
            {project.name}
          </p>
          <div className="w-[100px]" />
        </div>
      </header>

      <section className="py-16">
        <div className="mx-auto max-w-[1280px] px-6">
          <div
            className="rounded-card-lg border border-border-soft bg-white p-8 shadow-[0_1px_3px_rgba(0,0,0,0.04)] animate-fade-in-up md:p-12"
            style={{ animationDelay: '0s' }}
          >
            <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Eyebrow color="green">Latest Update</Eyebrow>
                {project.cronStatus === 'RUNNING' && (
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#138510]">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#138510] opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-[#138510]" />
                    </span>
                    Updating…
                  </span>
                )}
                {!project.cronEnabled && project.cronStatus !== 'RUNNING' && (
                  <span className="text-[11px] font-light text-fg-muted">● Updates paused</span>
                )}
              </div>
              {latestUpdate && (
                <p className="text-xs font-light text-fg-3">
                  {format(latestUpdate.generatedAt, 'MMMM d, yyyy')} · {daysRemaining} days remaining
                </p>
              )}
            </div>

            {latestUpdate ? (
              <ul className="space-y-6">
                {latestUpdate.bullets.bullets.map((bullet, i) => {
                  const sourceEvents = bullet.sources
                    .map((s) => eventsById[s.eventId])
                    .filter(Boolean);
                  return (
                    <li
                      key={i}
                      className="animate-fade-in-up"
                      style={{ animationDelay: `${0.1 + i * 0.1}s` }}
                    >
                      <div className="flex gap-3">
                        <span className="mt-[10px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#138510]" />
                        <div className="space-y-2">
                          <p className="text-body font-light leading-relaxed text-fg-1">
                            {bullet.text}
                          </p>
                          {sourceEvents.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                              {sourceEvents.map((event) => (
                                <SourceChip key={event.id} event={event} />
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="py-8 text-center">
                <Eyebrow color="green" className="mb-3">Welcome</Eyebrow>
                <p className="text-body font-light text-fg-2">
                  Updates will appear here after our first review cycle. Check back tomorrow.
                </p>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="py-12">
        <div className="mx-auto max-w-[1280px] px-6">
          <div className="animate-fade-in-up" style={{ animationDelay: '0.1s' }}>
            <DaysProgressBar
              startDate={project.startDate}
              targetEndDate={project.targetEndDate}
              mvpDelivered={project.mvpDelivered}
            />
          </div>
        </div>
      </section>

      <section className="bg-bg-alt py-16">
        <div className="mx-auto max-w-[1280px] px-6">
          <div className="animate-fade-in-up" style={{ animationDelay: '0.2s' }}>
            <Eyebrow color="orange" className="mb-3">About This Project</Eyebrow>
            <h2 className="font-heading mb-8 text-[clamp(24px,2.4vw,36px)] font-bold tracking-tight text-fg-1">
              {project.name} — {project.client.name}
            </h2>
          </div>

          {project.deckPdfUrl || project.deckStoragePath ? (
            <div
              className="animate-fade-in-up overflow-hidden rounded-card-lg border border-border-soft shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
              style={{ animationDelay: '0.3s' }}
            >
              <a
                href={deckSrc}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 bg-white p-4 text-sm font-medium text-accent hover:underline md:hidden"
              >
                Open project deck ↗
              </a>
              <iframe
                src={`${deckSrc}#toolbar=0&navpanes=0&view=FitH`}
                title="Project deck"
                className="hidden h-[70vh] min-h-[480px] w-full md:block"
              />
            </div>
          ) : (
            <p className="text-body-sm font-light text-fg-muted">
              About this project — coming soon. Reach out to your project lead in the meantime.
            </p>
          )}
        </div>
      </section>

      <section className="bg-bg-alt py-16">
        <div className="mx-auto max-w-[1280px] px-6">
          <div className="animate-fade-in-up mb-8" style={{ animationDelay: '0.1s' }}>
            <Eyebrow color="ink" className="mb-3">Recent Activity</Eyebrow>
            <h2 className="font-heading text-[clamp(24px,2.4vw,36px)] font-bold tracking-tight text-fg-1">
              Last 14 Days
            </h2>
          </div>

          {!project.githubRepo ? (
            <GitHubEmptyState />
          ) : recentEvents.length === 0 ? (
            <p className="text-body-sm font-light text-fg-muted">
              No recent activity in the project repo.
            </p>
          ) : (
            <ul className="divide-y divide-border-soft">
              {recentEvents.map((event, i) => (
                <li
                  key={event.id}
                  className="animate-fade-in-up flex items-start gap-4 py-4"
                  style={{ animationDelay: `${0.1 + i * 0.05}s` }}
                >
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
                    <EventTypeIcon type={event.type} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <a
                      href={event.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium text-fg-1 hover:text-accent transition-colors line-clamp-2"
                    >
                      {event.title}
                    </a>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                      {event.authorAvatarUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={event.authorAvatarUrl}
                          alt={event.authorName}
                          className="h-4 w-4 rounded-full"
                        />
                      )}
                      <span className="text-xs font-light text-fg-3">{event.authorName}</span>
                      <span className="text-xs font-light text-fg-muted">·</span>
                      <span className="text-xs font-light text-fg-muted">
                        {formatDistanceToNow(event.occurredAt, { addSuffix: true })}
                      </span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <footer className="border-t border-border-soft bg-white py-10">
        <div className="mx-auto max-w-[1280px] px-6 text-center">
          <p className="text-sm font-light text-fg-3">
            Questions?{' '}
            <a
              href="mailto:lucas@heliosmarketing.org"
              className="text-fg-2 underline-offset-2 hover:text-accent hover:underline transition-colors"
            >
              lucas@heliosmarketing.org
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
