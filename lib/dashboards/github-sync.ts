import { Octokit } from '@octokit/rest';
import type { RestEndpointMethodTypes } from '@octokit/rest';

import {
  existingRepoEventExternalIds,
  findProjectById,
  setProjectSyncResult,
  upsertRepoEvent,
} from '@/lib/dashboards/repository';
import { scrubError } from '@/lib/dashboards/scrub-logs';
import { getTokenForRepo } from '@/lib/dashboards/tokens';

export type CommitItem =
  RestEndpointMethodTypes['repos']['listCommits']['response']['data'][number];

type RepoEventTypeStr = 'COMMIT' | 'PR_MERGED' | 'ISSUE_CLOSED';

const CONVERGE_N = 20;
const MAX_PAGES = 10;
const PER_PAGE = 100;

const JUNK_COMMIT_RE =
  /^(merge|wip|fixup!|squashed|revert "merge|chore: bump version|update readme$|^\.+$)/i;

export function isJunkCommit(title: string, authorLogin: string | null): boolean {
  if (authorLogin?.endsWith('[bot]')) return true;
  return JUNK_COMMIT_RE.test(title) || title.trim().length < 5;
}

function parseRepo(githubRepo: string): { owner: string; repo: string } | null {
  const parts = githubRepo.split('/');
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { owner: parts[0], repo: parts[1] };
  }
  return null;
}

function syncStamp(): string {
  return new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function syncErrorMessage(err: unknown, owner: string): string {
  const status = (err as { status?: number }).status;
  const at = `(Sync attempted at ${syncStamp()})`;
  if (status === 401) {
    return `GitHub token is invalid or expired. Rotate the PAT for @${owner} under Tokens. ${at}`;
  }
  if (status === 403 || status === 404) {
    return `Sync failed: PAT for @${owner} cannot access this repo. ${at}`;
  }
  const detail = scrubError(err);
  return `Sync failed: ${detail} ${at}`;
}

export async function upsertCommitEvent(
  projectId: string,
  c: CommitItem,
): Promise<void> {
  const title = c.commit.message.split('\n')[0] ?? '';
  const login = c.author?.login ?? null;
  await upsertRepoEvent({
    projectId,
    type: 'COMMIT',
    externalId: c.sha,
    title,
    body: c.commit.message.slice(title.length).trim() || null,
    authorName: c.commit.author?.name ?? login ?? 'Unknown',
    authorLogin: login,
    authorAvatarUrl: c.author?.avatar_url ?? null,
    url: c.html_url,
    occurredAt: new Date(c.commit.author?.date ?? Date.now()),
    meta: {},
  });
}

export async function syncProject(
  projectId: string,
): Promise<{ synced: number; skipped: number }> {
  const project = await findProjectById(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);

  const parsed = parseRepo(project.githubRepo);
  if (!parsed) {
    const msg = `Sync failed: "${project.githubRepo}" is not a valid owner/repo. (Sync attempted at ${syncStamp()})`;
    await setProjectSyncResult(projectId, { lastSyncError: msg });
    throw new Error(msg);
  }
  const { owner, repo } = parsed;

  const token = await getTokenForRepo(project.githubRepo);
  if (!token || token.trim() === '') {
    console.error(
      `[sync] no PAT for ${owner}/${repo} — failing fast (present=${token != null})`,
    );
    const msg = `Sync failed: No PAT stored for @${owner}. Add one under Tokens. (Sync attempted at ${syncStamp()})`;
    await setProjectSyncResult(projectId, { lastSyncError: msg });
    throw new Error(msg);
  }

  const octokit = new Octokit({ auth: token });

  try {
    await octokit.rest.repos.get({ owner, repo });
  } catch (err) {
    const status = (err as { status?: number }).status;
    console.error(
      `[sync] access check FAILED for ${owner}/${repo}: status=${status ?? 'unknown'} ` +
        `(tokenLen=${token.length})` +
        (status === 401 ? ' — PAT invalid or expired' : ''),
    );
    const msg = syncErrorMessage(err, owner);
    await setProjectSyncResult(projectId, { lastSyncError: msg });
    throw new Error(msg);
  }

  let synced = 0;
  let skipped = 0;
  const errors: string[] = [];

  try {
    let consecutiveKnown = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data: commits } = await octokit.rest.repos.listCommits({
        owner,
        repo,
        sha: project.githubBranch,
        per_page: PER_PAGE,
        page,
      });
      if (commits.length === 0) break;

      const known = await existingRepoEventExternalIds(
        projectId,
        'COMMIT',
        commits.map((c) => c.sha),
      );

      let converged = false;
      for (const c of commits) {
        if (known.has(c.sha)) {
          if (++consecutiveKnown >= CONVERGE_N) {
            converged = true;
            break;
          }
          continue;
        }
        consecutiveKnown = 0;
        const title = c.commit.message.split('\n')[0] ?? '';
        if (isJunkCommit(title, c.author?.login ?? null)) {
          skipped++;
          continue;
        }
        await upsertCommitEvent(projectId, c);
        synced++;
      }

      if (converged || commits.length < PER_PAGE) break;
    }
  } catch (e) {
    console.error(`[sync] commits error for ${owner}/${repo}:`, scrubError(e));
    errors.push(syncErrorMessage(e, owner));
  }

  try {
    let consecutiveKnown = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data: prs } = await octokit.rest.pulls.list({
        owner,
        repo,
        state: 'closed',
        sort: 'updated',
        direction: 'desc',
        per_page: PER_PAGE,
        page,
      });
      if (prs.length === 0) break;

      const known = await existingRepoEventExternalIds(
        projectId,
        'PR_MERGED',
        prs.map((pr) => String(pr.number)),
      );

      let converged = false;
      for (const pr of prs) {
        const id = String(pr.number);
        if (known.has(id)) {
          if (++consecutiveKnown >= CONVERGE_N) {
            converged = true;
            break;
          }
          continue;
        }
        if (!pr.merged_at) continue;
        consecutiveKnown = 0;
        const result = await upsertRepoEvent({
          projectId,
          type: 'PR_MERGED',
          externalId: id,
          title: pr.title,
          body: pr.body?.slice(0, 2000) ?? null,
          authorName: pr.user?.login ?? 'Unknown',
          authorLogin: pr.user?.login ?? null,
          authorAvatarUrl: pr.user?.avatar_url ?? null,
          url: pr.html_url,
          occurredAt: new Date(pr.merged_at),
          meta: {
            mergedSha: pr.merge_commit_sha ?? '',
            baseBranch: pr.base.ref,
          },
        });
        if (result === 'inserted') synced++;
      }

      if (converged || prs.length < PER_PAGE) break;
    }
  } catch (e) {
    console.error(`[sync] PRs error for ${owner}/${repo}:`, scrubError(e));
    errors.push(syncErrorMessage(e, owner));
  }

  try {
    let consecutiveKnown = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data: issues } = await octokit.rest.issues.listForRepo({
        owner,
        repo,
        state: 'closed',
        sort: 'updated',
        direction: 'desc',
        per_page: PER_PAGE,
        page,
      });
      if (issues.length === 0) break;

      const known = await existingRepoEventExternalIds(
        projectId,
        'ISSUE_CLOSED',
        issues.map((issue) => String(issue.number)),
      );

      let converged = false;
      for (const issue of issues) {
        const id = String(issue.number);
        if (known.has(id)) {
          if (++consecutiveKnown >= CONVERGE_N) {
            converged = true;
            break;
          }
          continue;
        }
        if (issue.pull_request || !issue.closed_at) continue;
        consecutiveKnown = 0;
        const result = await upsertRepoEvent({
          projectId,
          type: 'ISSUE_CLOSED',
          externalId: id,
          title: issue.title,
          body: issue.body?.slice(0, 2000) ?? null,
          authorName: issue.user?.login ?? 'Unknown',
          authorLogin: issue.user?.login ?? null,
          authorAvatarUrl: issue.user?.avatar_url ?? null,
          url: issue.html_url,
          occurredAt: new Date(issue.closed_at),
          meta: {
            labels: issue.labels.map((l) =>
              typeof l === 'string' ? l : (l.name ?? ''),
            ),
            closedBy: issue.closed_by?.login,
          },
        });
        if (result === 'inserted') synced++;
      }

      if (converged || issues.length < PER_PAGE) break;
    }
  } catch (e) {
    console.error(`[sync] issues error for ${owner}/${repo}:`, scrubError(e));
    errors.push(syncErrorMessage(e, owner));
  }

  if (errors.length > 0) {
    const msg = errors[0]!;
    await setProjectSyncResult(projectId, { lastSyncError: msg });
    throw new Error(msg);
  }

  await setProjectSyncResult(projectId, {
    lastSyncError: null,
    githubLastSyncAt: new Date(),
  });

  return { synced, skipped };
}
