'use server';

import { randomBytes } from 'node:crypto';

import { Octokit } from '@octokit/rest';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { generateUpdate } from '@/lib/dashboards/ai';
import { deckApiPath, removeDeckObject, uploadDeckObject } from '@/lib/dashboards/deck-storage';
import { syncProject } from '@/lib/dashboards/github-sync';
import {
  createClient,
  createProject as createProjectRow,
  deleteProject as deleteProjectRow,
  findClientById,
  findProjectById,
  updateProject as updateProjectRow,
  updateProjectAccessToken,
  updateProjectDeck,
} from '@/lib/dashboards/repository';
import { scrubError } from '@/lib/dashboards/scrub-logs';
import { getTokenForRepo } from '@/lib/dashboards/tokens';
import type { ProjectStatus } from '@/lib/dashboards/types';
import { getSession } from '@/lib/session';

async function assertAdmin(): Promise<{ userId: string; email: string }> {
  const session = await getSession();
  if (!session) throw new Error('Not authorized');
  return session;
}

export type ActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
};

function parseGithubRepo(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim().replace(/\.git$/, '');
  const urlMatch = trimmed.match(
    /github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)/,
  );
  if (urlMatch) return { owner: urlMatch[1]!, repo: urlMatch[2]! };
  const parts = trimmed.split('/');
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { owner: parts[0], repo: parts[1] };
  }
  return null;
}

async function validateRepo(
  repoInput: string,
): Promise<{ repoSlug: string } | { error: string }> {
  const parsed = parseGithubRepo(repoInput);
  if (!parsed) {
    return { error: "Invalid repo format. Use 'owner/repo' or a full GitHub URL." };
  }

  const repoSlug = `${parsed.owner}/${parsed.repo}`;
  const githubToken = await getTokenForRepo(repoSlug);
  if (!githubToken) {
    return { repoSlug };
  }

  try {
    const octokit = new Octokit({ auth: githubToken });
    await octokit.repos.get({ owner: parsed.owner, repo: parsed.repo });
    return { repoSlug };
  } catch (err: unknown) {
    if ((err as { status?: number }).status === 404) {
      return {
        error:
          'Repo not found or not accessible with the stored PAT for this owner.',
      };
    }
    return { error: 'Could not verify repo access. Check the stored GitHub PAT.' };
  }
}

async function resolveClient(
  clientId: string | null,
  clientName: string | null,
): Promise<{ id: string } | { error: string }> {
  if (clientId) {
    const existing = await findClientById(clientId);
    if (existing) return { id: existing.id };
  }
  if (clientName?.trim()) {
    const created = await createClient(clientName.trim());
    return { id: created.id };
  }
  return { error: 'Client is required.' };
}

export async function createProject(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await assertAdmin();

  const name = (formData.get('name') as string)?.trim();
  const clientId = (formData.get('clientId') as string) || null;
  const clientName = (formData.get('clientName') as string) || null;
  const githubRepoRaw = (formData.get('githubRepo') as string)?.trim();
  const githubBranch = ((formData.get('githubBranch') as string)?.trim()) || 'main';
  const startDateStr = formData.get('startDate') as string;
  const targetEndDateStr = formData.get('targetEndDate') as string;
  const status = (formData.get('status') as string) || 'ACTIVE';
  const mvpDelivered = formData.get('mvpDelivered') === 'on';

  if (!name) return { fieldErrors: { name: 'Project name is required.' } };
  if (!startDateStr) return { fieldErrors: { startDate: 'Start date is required.' } };
  if (!targetEndDateStr) {
    return { fieldErrors: { targetEndDate: 'Target end date is required.' } };
  }

  let repoSlug: string | null = null;
  if (githubRepoRaw) {
    const repoResult = await validateRepo(githubRepoRaw);
    if ('error' in repoResult) return { fieldErrors: { githubRepo: repoResult.error } };
    repoSlug = repoResult.repoSlug;
  }

  const clientResult = await resolveClient(clientId, clientName);
  if ('error' in clientResult) return { fieldErrors: { clientId: clientResult.error } };

  const startDate = new Date(startDateStr);
  const targetEndDate = new Date(targetEndDateStr);
  if (isNaN(startDate.getTime())) {
    return { fieldErrors: { startDate: 'Invalid start date.' } };
  }
  if (isNaN(targetEndDate.getTime())) {
    return { fieldErrors: { targetEndDate: 'Invalid target end date.' } };
  }
  if (targetEndDate <= startDate) {
    return {
      fieldErrors: { targetEndDate: 'Target end date must be after start date.' },
    };
  }

  const accessToken = randomBytes(32).toString('base64url');

  const project = await createProjectRow({
    name,
    clientId: clientResult.id,
    status: status as ProjectStatus,
    startDate,
    targetEndDate,
    accessToken,
    githubRepo: repoSlug ?? '',
    githubBranch,
    mvpDelivered,
  });

  revalidatePath('/dashboards');
  redirect(`/dashboards/projects/${project.id}`);
}

export async function updateProject(
  id: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await assertAdmin();

  const name = (formData.get('name') as string)?.trim();
  const clientId = (formData.get('clientId') as string) || null;
  const clientName = (formData.get('clientName') as string) || null;
  const githubRepoRaw = (formData.get('githubRepo') as string)?.trim();
  const githubBranch = ((formData.get('githubBranch') as string)?.trim()) || 'main';
  const startDateStr = formData.get('startDate') as string;
  const targetEndDateStr = formData.get('targetEndDate') as string;
  const status = formData.get('status') as string;
  const completedAtStr = formData.get('completedAt') as string;
  const cronEnabled = formData.get('cronEnabled') === 'on';
  const mvpDelivered = formData.get('mvpDelivered') === 'on';

  if (!name) return { fieldErrors: { name: 'Project name is required.' } };

  let repoSlug: string | null = null;
  if (githubRepoRaw) {
    const repoResult = await validateRepo(githubRepoRaw);
    if ('error' in repoResult) return { fieldErrors: { githubRepo: repoResult.error } };
    repoSlug = repoResult.repoSlug;
  }

  const clientResult = await resolveClient(clientId, clientName);
  if ('error' in clientResult) return { fieldErrors: { clientId: clientResult.error } };

  const startDate = new Date(startDateStr);
  const targetEndDate = new Date(targetEndDateStr);
  if (isNaN(startDate.getTime())) {
    return { fieldErrors: { startDate: 'Invalid start date.' } };
  }
  if (isNaN(targetEndDate.getTime())) {
    return { fieldErrors: { targetEndDate: 'Invalid target end date.' } };
  }

  const completedAt =
    status === 'COMPLETE' && completedAtStr ? new Date(completedAtStr) : null;

  await updateProjectRow(id, {
    name,
    clientId: clientResult.id,
    status: status as ProjectStatus,
    startDate,
    targetEndDate,
    completedAt,
    githubRepo: repoSlug ?? '',
    githubBranch,
    cronEnabled,
    mvpDelivered,
  });

  revalidatePath(`/dashboards/projects/${id}`);
  revalidatePath('/dashboards');
  return {};
}

export async function regenerateToken(id: string): Promise<{ newToken: string }> {
  await assertAdmin();
  const newToken = randomBytes(32).toString('base64url');
  await updateProjectAccessToken(id, newToken);

  const project = await findProjectById(id);
  if (project?.deckStoragePath) {
    await updateProjectDeck(id, project.deckStoragePath, deckApiPath(newToken));
  }

  revalidatePath(`/dashboards/projects/${id}`);
  revalidatePath('/dashboards');
  return { newToken };
}

const MAX_DECK_BYTES = 25 * 1024 * 1024;

export async function uploadDeck(
  id: string,
  formData: FormData,
): Promise<{ url: string } | { error: string }> {
  await assertAdmin();

  const file = formData.get('deck') as File | null;
  if (!file || file.size === 0) return { error: 'No file selected.' };
  if (file.type !== 'application/pdf') return { error: 'File must be a PDF.' };
  if (file.size > MAX_DECK_BYTES) {
    return {
      error: `File must be 25 MB or smaller (got ${(file.size / 1024 / 1024).toFixed(1)} MB).`,
    };
  }

  const project = await findProjectById(id);
  if (!project) return { error: 'Project not found.' };

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `decks/${id}/${Date.now()}-${safeName}`;
  const bytes = Buffer.from(await file.arrayBuffer());

  try {
    if (project.deckStoragePath) {
      try {
        await removeDeckObject(project.deckStoragePath);
      } catch {
        // Non-fatal
      }
    }
    await uploadDeckObject(storagePath, bytes, 'application/pdf');
  } catch (e: unknown) {
    console.error('[uploadDeck] storage failed:', scrubError(e));
    return { error: `Upload failed: ${scrubError(e)}` };
  }

  const url = deckApiPath(project.accessToken);
  try {
    await updateProjectDeck(id, storagePath, url);
  } catch (e: unknown) {
    console.error('[uploadDeck] DB update failed:', scrubError(e));
    return { error: `Uploaded to storage but failed to save path: ${scrubError(e)}` };
  }

  revalidatePath(`/dashboards/projects/${id}`);
  revalidatePath('/dashboards');
  return { url };
}

export async function removeDeck(
  id: string,
  _existingUrl: string | null,
): Promise<void> {
  await assertAdmin();
  const project = await findProjectById(id);
  if (project?.deckStoragePath) {
    try {
      await removeDeckObject(project.deckStoragePath);
    } catch {
      // Non-fatal
    }
  }
  await updateProjectDeck(id, null, null);
  revalidatePath(`/dashboards/projects/${id}`);
  revalidatePath('/dashboards');
}

export async function triggerSync(
  id: string,
): Promise<{ synced: number; skipped: number; error?: string }> {
  await assertAdmin();
  try {
    const result = await syncProject(id);
    revalidatePath(`/dashboards/projects/${id}`);
    return result;
  } catch (e: unknown) {
    return { synced: 0, skipped: 0, error: scrubError(e) };
  }
}

export async function deleteProject(
  id: string,
): Promise<{ error: string } | void> {
  try {
    await assertAdmin();

    const project = await findProjectById(id);
    if (!project) return { error: 'Project not found.' };

    if (project.deckStoragePath) {
      try {
        await removeDeckObject(project.deckStoragePath);
      } catch {
        // Non-fatal
      }
    }

    await deleteProjectRow(id);
  } catch (e: unknown) {
    return { error: scrubError(e) };
  }

  revalidatePath('/dashboards');
  redirect('/dashboards');
}

export async function generateUpdateAction(id: string): Promise<{
  generated: boolean;
  source?: 'ai' | 'fallback';
  aiError?: string;
  hasPriorUpdate?: boolean;
  error?: string;
}> {
  await assertAdmin();
  try {
    const outcome = await generateUpdate(id, { manual: true });
    if (outcome.status === 'generated') {
      revalidatePath(`/dashboards/projects/${id}`);
      return { generated: true, source: outcome.source, aiError: outcome.aiError };
    }
    return { generated: false, hasPriorUpdate: outcome.hasPriorUpdate };
  } catch (e: unknown) {
    return { generated: false, error: scrubError(e) };
  }
}
