import { differenceInCalendarDays } from 'date-fns';

import { dbQuery } from '@/lib/db';
import {
  findClientById,
  findProjectById,
  listClients,
  type ProjectRecord,
} from '@/lib/dashboards/repository';
import type { AdminClient, AdminProject, ProjectStatus } from '@/lib/dashboards/types';

export async function getAllClients(): Promise<AdminClient[]> {
  return listClients();
}

export async function getAdminProjects(): Promise<AdminProject[]> {
  const { rows } = await dbQuery<{
    id: string;
    client_id: string;
    name: string;
    status: ProjectStatus;
    start_date: Date;
    target_end_date: Date;
    completed_at: Date | null;
    access_token: string;
    github_repo: string;
    github_branch: string;
    github_last_sync_at: Date | null;
    last_sync_error: string | null;
    readme_markdown: string | null;
    deck_pdf_url: string | null;
    deck_storage_path: string | null;
    cron_enabled: boolean;
    cron_status: string;
    mvp_delivered: boolean;
    created_at: Date;
    updated_at: Date;
    client_name: string;
    client_contact_email: string | null;
    client_created_at: Date;
    last_update_at: Date | null;
  }>(
    `SELECT p.*,
            c.name AS client_name,
            c.contact_email AS client_contact_email,
            c.created_at AS client_created_at,
            (
              SELECT cu.generated_at
              FROM dashboards.context_updates cu
              WHERE cu.project_id = p.id
              ORDER BY cu.generated_at DESC
              LIMIT 1
            ) AS last_update_at
     FROM dashboards.projects p
     JOIN dashboards.clients c ON c.id = p.client_id
     ORDER BY p.created_at DESC`,
  );

  return rows.map((p) => ({
    id: p.id,
    clientId: p.client_id,
    name: p.name,
    status: p.status,
    startDate: p.start_date,
    targetEndDate: p.target_end_date,
    completedAt: p.completed_at,
    accessToken: p.access_token,
    githubRepo: p.github_repo,
    githubBranch: p.github_branch,
    githubLastSyncAt: p.github_last_sync_at,
    lastSyncError: p.last_sync_error,
    readmeMarkdown: p.readme_markdown,
    deckPdfUrl: p.deck_pdf_url ?? (p.deck_storage_path ? `/api/dashboards/deck/${p.access_token}` : null),
    deckStoragePath: p.deck_storage_path,
    cronEnabled: p.cron_enabled,
    cronStatus: p.cron_status,
    mvpDelivered: p.mvp_delivered,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    client: {
      id: p.client_id,
      name: p.client_name,
      contactEmail: p.client_contact_email,
      createdAt: p.client_created_at,
    },
    daysRemaining: differenceInCalendarDays(p.target_end_date, new Date()),
    lastUpdateAt: p.last_update_at,
  }));
}

export async function getAdminProject(
  id: string,
): Promise<(ProjectRecord & { client: AdminClient }) | null> {
  const project = await findProjectById(id);
  if (!project) return null;
  const client = await findClientById(project.clientId);
  if (!client) return null;
  return {
    ...project,
    deckPdfUrl:
      project.deckPdfUrl
      ?? (project.deckStoragePath
        ? `/api/dashboards/deck/${project.accessToken}`
        : null),
    client,
  };
}
