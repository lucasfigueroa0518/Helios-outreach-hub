import { subDays } from 'date-fns';

import { dbQuery } from '@/lib/db';
import { findProjectByAccessToken } from '@/lib/dashboards/repository';
import type {
  ContextUpdateBullets,
  DashboardPageData,
  GenSource,
  RepoEvent,
} from '@/lib/dashboards/types';

const JUNK_COMMIT_RE =
  /^(merge|wip|fixup!|squashed|revert "merge|chore: bump version|update readme$|^\.+$)/i;

function isJunk(title: string) {
  return JUNK_COMMIT_RE.test(title) || title.trim().length < 5;
}

type EventRow = {
  id: string;
  project_id: string;
  type: string;
  external_id: string;
  title: string;
  body: string | null;
  author_name: string;
  author_login: string | null;
  author_avatar_url: string | null;
  url: string;
  occurred_at: Date;
};

function toRepoEvent(e: EventRow): RepoEvent {
  return {
    id: e.id,
    projectId: e.project_id,
    type: e.type as RepoEvent['type'],
    externalId: e.external_id,
    title: e.title,
    body: e.body,
    authorName: e.author_name,
    authorLogin: e.author_login,
    authorAvatarUrl: e.author_avatar_url,
    url: e.url,
    occurredAt: e.occurred_at,
  };
}

export async function getDashboardData(
  token: string,
): Promise<DashboardPageData | null> {
  const project = await findProjectByAccessToken(token);
  if (!project) return null;

  const { rows: clientRows } = await dbQuery<{ id: string; name: string }>(
    `SELECT id, name FROM dashboards.clients WHERE id = $1`,
    [project.clientId],
  );
  const client = clientRows[0];
  if (!client) return null;

  const now = new Date();
  const fourteenDaysAgo = subDays(now, 14);

  const [latestUpdateResult, recentEventsResult] = await Promise.all([
    dbQuery<{
      id: string;
      project_id: string;
      bullets: ContextUpdateBullets;
      window_start: Date;
      window_end: Date;
      generated_at: Date;
      generated_by: GenSource;
    }>(
      `SELECT id, project_id, bullets, window_start, window_end, generated_at, generated_by
       FROM dashboards.context_updates
       WHERE project_id = $1
       ORDER BY generated_at DESC
       LIMIT 1`,
      [project.id],
    ),
    dbQuery<EventRow>(
      `SELECT id, project_id, type, external_id, title, body, author_name,
              author_login, author_avatar_url, url, occurred_at
       FROM dashboards.repo_events
       WHERE project_id = $1
         AND occurred_at >= $2
         AND type IN ('COMMIT', 'PR_MERGED', 'ISSUE_CLOSED')
       ORDER BY occurred_at DESC
       LIMIT 30`,
      [project.id, fourteenDaysAgo],
    ),
  ]);

  const latestUpdate = latestUpdateResult.rows[0] ?? null;
  const recentEvents = recentEventsResult.rows
    .filter((e) => e.type !== 'COMMIT' || !isJunk(e.title))
    .map(toRepoEvent);

  const citedIds = new Set<string>();
  if (latestUpdate) {
    const b = latestUpdate.bullets as ContextUpdateBullets;
    for (const bullet of b.bullets ?? []) {
      for (const s of bullet.sources ?? []) citedIds.add(s.eventId);
    }
  }

  const recentIds = new Set(recentEvents.map((e) => e.id));
  const missingIds = [...citedIds].filter((id) => !recentIds.has(id));

  const sourceEvents =
    missingIds.length > 0
      ? (
          await dbQuery<EventRow>(
            `SELECT id, project_id, type, external_id, title, body, author_name,
                    author_login, author_avatar_url, url, occurred_at
             FROM dashboards.repo_events
             WHERE id = ANY($1::text[])`,
            [missingIds],
          )
        ).rows.map(toRepoEvent)
      : [];

  const eventsById: Record<string, RepoEvent> = {};
  for (const e of [...recentEvents, ...sourceEvents]) {
    eventsById[e.id] = e;
  }

  const hasDeck = Boolean(project.deckStoragePath || project.deckPdfUrl);
  // Always serve through our API so clients never need Blob credentials.
  const deckApiUrl = hasDeck
    ? `/api/dashboards/deck/${project.accessToken}`
    : null;

  return {
    project: {
      id: project.id,
      name: project.name,
      status: project.status,
      startDate: project.startDate,
      targetEndDate: project.targetEndDate,
      completedAt: project.completedAt,
      accessToken: project.accessToken,
      deckPdfUrl: deckApiUrl,
      deckStoragePath: project.deckStoragePath,
      githubRepo: project.githubRepo,
      cronEnabled: project.cronEnabled,
      cronStatus: project.cronStatus,
      mvpDelivered: project.mvpDelivered,
      client: { id: client.id, name: client.name },
    },
    latestUpdate: latestUpdate
      ? {
          id: latestUpdate.id,
          projectId: latestUpdate.project_id,
          bullets: latestUpdate.bullets as ContextUpdateBullets,
          windowStart: latestUpdate.window_start,
          windowEnd: latestUpdate.window_end,
          generatedAt: latestUpdate.generated_at,
          generatedBy: latestUpdate.generated_by,
        }
      : null,
    recentEvents,
    eventsById,
  };
}
