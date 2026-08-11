import { dbQuery } from '@/lib/db';
import { newDashboardsId } from '@/lib/dashboards/ids';
import type {
  AdminClient,
  ContextUpdateBullets,
  GenSource,
  GithubTokenMeta,
  ProjectStatus,
  RepoEventType,
} from '@/lib/dashboards/types';

type ClientRow = {
  id: string;
  name: string;
  contact_email: string | null;
  created_at: Date;
};

type ProjectRow = {
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
  readme_fetched_at: Date | null;
  deck_pdf_url: string | null;
  deck_storage_path: string | null;
  cron_enabled: boolean;
  cron_status: string;
  mvp_delivered: boolean;
  created_at: Date;
  updated_at: Date;
};

type TokenRow = {
  id: string;
  github_handle: string;
  encrypted_token: string;
  iv: string;
  auth_tag: string;
  token_suffix: string;
  added_by_user_id: string;
  added_by_email: string;
  last_used_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type ProjectRecord = {
  id: string;
  clientId: string;
  name: string;
  status: ProjectStatus;
  startDate: Date;
  targetEndDate: Date;
  completedAt: Date | null;
  accessToken: string;
  githubRepo: string;
  githubBranch: string;
  githubLastSyncAt: Date | null;
  lastSyncError: string | null;
  readmeMarkdown: string | null;
  deckPdfUrl: string | null;
  deckStoragePath: string | null;
  cronEnabled: boolean;
  cronStatus: string;
  mvpDelivered: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function mapClient(row: ClientRow): AdminClient {
  return {
    id: row.id,
    name: row.name,
    contactEmail: row.contact_email,
    createdAt: row.created_at,
  };
}

function mapProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    status: row.status,
    startDate: row.start_date,
    targetEndDate: row.target_end_date,
    completedAt: row.completed_at,
    accessToken: row.access_token,
    githubRepo: row.github_repo,
    githubBranch: row.github_branch,
    githubLastSyncAt: row.github_last_sync_at,
    lastSyncError: row.last_sync_error,
    readmeMarkdown: row.readme_markdown,
    deckPdfUrl: row.deck_pdf_url,
    deckStoragePath: row.deck_storage_path,
    cronEnabled: row.cron_enabled,
    cronStatus: row.cron_status,
    mvpDelivered: row.mvp_delivered,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTokenMeta(row: TokenRow): GithubTokenMeta {
  return {
    id: row.id,
    githubHandle: row.github_handle,
    tokenSuffix: row.token_suffix,
    addedByUserId: row.added_by_user_id,
    addedByEmail: row.added_by_email,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function findClientById(id: string): Promise<AdminClient | null> {
  const { rows } = await dbQuery<ClientRow>(
    `SELECT id, name, contact_email, created_at FROM dashboards.clients WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapClient(rows[0]) : null;
}

export async function listClients(): Promise<AdminClient[]> {
  const { rows } = await dbQuery<ClientRow>(
    `SELECT id, name, contact_email, created_at
     FROM dashboards.clients
     ORDER BY name ASC`,
  );
  return rows.map(mapClient);
}

export async function createClient(name: string): Promise<AdminClient> {
  const id = newDashboardsId();
  const { rows } = await dbQuery<ClientRow>(
    `INSERT INTO dashboards.clients (id, name)
     VALUES ($1, $2)
     RETURNING id, name, contact_email, created_at`,
    [id, name],
  );
  return mapClient(rows[0]!);
}

export async function listProjects(): Promise<ProjectRecord[]> {
  const { rows } = await dbQuery<ProjectRow>(
    `SELECT * FROM dashboards.projects ORDER BY created_at DESC`,
  );
  return rows.map(mapProject);
}

export async function findProjectById(id: string): Promise<ProjectRecord | null> {
  const { rows } = await dbQuery<ProjectRow>(
    `SELECT * FROM dashboards.projects WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapProject(rows[0]) : null;
}

export async function findProjectByAccessToken(
  token: string,
): Promise<ProjectRecord | null> {
  const { rows } = await dbQuery<ProjectRow>(
    `SELECT * FROM dashboards.projects WHERE access_token = $1`,
    [token],
  );
  return rows[0] ? mapProject(rows[0]) : null;
}

export type CreateProjectInput = {
  name: string;
  clientId: string;
  status: ProjectStatus;
  startDate: Date;
  targetEndDate: Date;
  accessToken: string;
  githubRepo: string;
  githubBranch: string;
  mvpDelivered: boolean;
};

export async function createProject(input: CreateProjectInput): Promise<ProjectRecord> {
  const id = newDashboardsId();
  const { rows } = await dbQuery<ProjectRow>(
    `INSERT INTO dashboards.projects (
       id, client_id, name, status, start_date, target_end_date, access_token,
       github_repo, github_branch, mvp_delivered
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      id,
      input.clientId,
      input.name,
      input.status,
      input.startDate,
      input.targetEndDate,
      input.accessToken,
      input.githubRepo,
      input.githubBranch,
      input.mvpDelivered,
    ],
  );
  return mapProject(rows[0]!);
}

export type UpdateProjectInput = {
  name: string;
  clientId: string;
  status: ProjectStatus;
  startDate: Date;
  targetEndDate: Date;
  completedAt: Date | null;
  githubRepo: string;
  githubBranch: string;
  cronEnabled: boolean;
  mvpDelivered: boolean;
};

export async function updateProject(
  id: string,
  input: UpdateProjectInput,
): Promise<void> {
  await dbQuery(
    `UPDATE dashboards.projects SET
       name = $2,
       client_id = $3,
       status = $4,
       start_date = $5,
       target_end_date = $6,
       completed_at = $7,
       github_repo = $8,
       github_branch = $9,
       cron_enabled = $10,
       mvp_delivered = $11,
       updated_at = now()
     WHERE id = $1`,
    [
      id,
      input.name,
      input.clientId,
      input.status,
      input.startDate,
      input.targetEndDate,
      input.completedAt,
      input.githubRepo,
      input.githubBranch,
      input.cronEnabled,
      input.mvpDelivered,
    ],
  );
}

export async function updateProjectAccessToken(
  id: string,
  accessToken: string,
): Promise<void> {
  await dbQuery(
    `UPDATE dashboards.projects
     SET access_token = $2, updated_at = now()
     WHERE id = $1`,
    [id, accessToken],
  );
}

export async function updateProjectDeck(
  id: string,
  deckStoragePath: string | null,
  deckPdfUrl: string | null,
): Promise<void> {
  await dbQuery(
    `UPDATE dashboards.projects
     SET deck_storage_path = $2, deck_pdf_url = $3, updated_at = now()
     WHERE id = $1`,
    [id, deckStoragePath, deckPdfUrl],
  );
}

export async function updateProjectSyncState(
  id: string,
  data: {
    lastSyncError?: string | null;
    githubLastSyncAt?: Date | null;
    cronStatus?: string;
  },
): Promise<void> {
  await dbQuery(
    `UPDATE dashboards.projects SET
       last_sync_error = COALESCE($2, last_sync_error),
       github_last_sync_at = COALESCE($3, github_last_sync_at),
       cron_status = COALESCE($4, cron_status),
       updated_at = now()
     WHERE id = $1`,
    [
      id,
      data.lastSyncError === undefined ? null : data.lastSyncError,
      data.githubLastSyncAt === undefined ? null : data.githubLastSyncAt,
      data.cronStatus === undefined ? null : data.cronStatus,
    ],
  );
}

/** Set sync fields explicitly (including clearing last_sync_error). */
export async function setProjectSyncResult(
  id: string,
  data: {
    lastSyncError: string | null;
    githubLastSyncAt?: Date | null;
  },
): Promise<void> {
  if (data.githubLastSyncAt !== undefined) {
    await dbQuery(
      `UPDATE dashboards.projects
       SET last_sync_error = $2, github_last_sync_at = $3, updated_at = now()
       WHERE id = $1`,
      [id, data.lastSyncError, data.githubLastSyncAt],
    );
    return;
  }
  await dbQuery(
    `UPDATE dashboards.projects
     SET last_sync_error = $2, updated_at = now()
     WHERE id = $1`,
    [id, data.lastSyncError],
  );
}

export async function setProjectCronStatus(
  id: string,
  cronStatus: string,
): Promise<void> {
  await dbQuery(
    `UPDATE dashboards.projects
     SET cron_status = $2, updated_at = now()
     WHERE id = $1`,
    [id, cronStatus],
  );
}

export async function deleteProject(id: string): Promise<void> {
  await dbQuery(`DELETE FROM dashboards.projects WHERE id = $1`, [id]);
}

export async function listActiveProjectsForDaily(): Promise<
  Array<{ id: string; name: string; cronEnabled: boolean }>
> {
  const { rows } = await dbQuery<{
    id: string;
    name: string;
    cron_enabled: boolean;
  }>(
    `SELECT id, name, cron_enabled
     FROM dashboards.projects
     WHERE status = 'ACTIVE'`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    cronEnabled: r.cron_enabled,
  }));
}

export async function latestUpdateGeneratedAt(
  projectId: string,
): Promise<Date | null> {
  const { rows } = await dbQuery<{ generated_at: Date }>(
    `SELECT generated_at FROM dashboards.context_updates
     WHERE project_id = $1
     ORDER BY generated_at DESC
     LIMIT 1`,
    [projectId],
  );
  return rows[0]?.generated_at ?? null;
}

export async function latestUpdateWindowEnd(
  projectId: string,
): Promise<Date | null> {
  const { rows } = await dbQuery<{ window_end: Date }>(
    `SELECT window_end FROM dashboards.context_updates
     WHERE project_id = $1
     ORDER BY generated_at DESC
     LIMIT 1`,
    [projectId],
  );
  return rows[0]?.window_end ?? null;
}

export async function createContextUpdate(input: {
  projectId: string;
  bullets: ContextUpdateBullets;
  windowStart: Date;
  windowEnd: Date;
  generatedBy: GenSource;
}): Promise<{
  id: string;
  projectId: string;
  windowStart: Date;
  windowEnd: Date;
  generatedAt: Date;
  generatedBy: GenSource;
}> {
  const id = newDashboardsId();
  const { rows } = await dbQuery<{
    id: string;
    project_id: string;
    window_start: Date;
    window_end: Date;
    generated_at: Date;
    generated_by: GenSource;
  }>(
    `INSERT INTO dashboards.context_updates
       (id, project_id, bullets, window_start, window_end, generated_by)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6)
     RETURNING id, project_id, window_start, window_end, generated_at, generated_by`,
    [
      id,
      input.projectId,
      JSON.stringify(input.bullets),
      input.windowStart,
      input.windowEnd,
      input.generatedBy,
    ],
  );
  const row = rows[0]!;
  return {
    id: row.id,
    projectId: row.project_id,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    generatedAt: row.generated_at,
    generatedBy: row.generated_by,
  };
}

export async function existingRepoEventExternalIds(
  projectId: string,
  type: RepoEventType,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { rows } = await dbQuery<{ external_id: string }>(
    `SELECT external_id FROM dashboards.repo_events
     WHERE project_id = $1 AND type = $2 AND external_id = ANY($3::text[])`,
    [projectId, type, ids],
  );
  return new Set(rows.map((r) => r.external_id));
}

export async function upsertRepoEvent(input: {
  projectId: string;
  type: RepoEventType | 'RELEASE';
  externalId: string;
  title: string;
  body: string | null;
  authorName: string;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  url: string;
  occurredAt: Date;
  meta: unknown;
}): Promise<'inserted' | 'exists'> {
  const id = newDashboardsId();
  const { rowCount } = await dbQuery(
    `INSERT INTO dashboards.repo_events (
       id, project_id, type, external_id, title, body, author_name,
       author_login, author_avatar_url, url, occurred_at, meta
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
     ON CONFLICT (project_id, type, external_id) DO NOTHING`,
    [
      id,
      input.projectId,
      input.type,
      input.externalId,
      input.title,
      input.body,
      input.authorName,
      input.authorLogin,
      input.authorAvatarUrl,
      input.url,
      input.occurredAt,
      JSON.stringify(input.meta ?? {}),
    ],
  );
  return (rowCount ?? 0) > 0 ? 'inserted' : 'exists';
}

export async function countTokensForUser(userId: string): Promise<number> {
  const { rows } = await dbQuery<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM dashboards.github_tokens
     WHERE added_by_user_id = $1::uuid`,
    [userId],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function listGithubTokenMeta(): Promise<GithubTokenMeta[]> {
  const { rows } = await dbQuery<TokenRow>(
    `SELECT id, github_handle, encrypted_token, iv, auth_tag, token_suffix,
            added_by_user_id::text, added_by_email, last_used_at, expires_at,
            created_at, updated_at
     FROM dashboards.github_tokens
     ORDER BY created_at DESC`,
  );
  return rows.map(mapTokenMeta);
}

export async function findGithubTokenByHandle(
  handle: string,
): Promise<TokenRow | null> {
  const { rows } = await dbQuery<TokenRow>(
    `SELECT id, github_handle, encrypted_token, iv, auth_tag, token_suffix,
            added_by_user_id::text, added_by_email, last_used_at, expires_at,
            created_at, updated_at
     FROM dashboards.github_tokens
     WHERE lower(github_handle) = lower($1)
     LIMIT 1`,
    [handle],
  );
  return rows[0] ?? null;
}

export async function insertGithubToken(input: {
  githubHandle: string;
  encryptedToken: string;
  iv: string;
  authTag: string;
  tokenSuffix: string;
  addedByUserId: string;
  addedByEmail: string;
  expiresAt?: Date | null;
}): Promise<GithubTokenMeta> {
  const { rows } = await dbQuery<TokenRow>(
    `INSERT INTO dashboards.github_tokens (
       github_handle, encrypted_token, iv, auth_tag, token_suffix,
       added_by_user_id, added_by_email, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6::uuid, $7, $8)
     ON CONFLICT (github_handle) DO UPDATE SET
       encrypted_token = EXCLUDED.encrypted_token,
       iv = EXCLUDED.iv,
       auth_tag = EXCLUDED.auth_tag,
       token_suffix = EXCLUDED.token_suffix,
       added_by_user_id = EXCLUDED.added_by_user_id,
       added_by_email = EXCLUDED.added_by_email,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()
     RETURNING id, github_handle, encrypted_token, iv, auth_tag, token_suffix,
               added_by_user_id::text, added_by_email, last_used_at, expires_at,
               created_at, updated_at`,
    [
      input.githubHandle,
      input.encryptedToken,
      input.iv,
      input.authTag,
      input.tokenSuffix,
      input.addedByUserId,
      input.addedByEmail,
      input.expiresAt ?? null,
    ],
  );
  return mapTokenMeta(rows[0]!);
}

export async function deleteGithubToken(id: string): Promise<boolean> {
  const { rowCount } = await dbQuery(
    `DELETE FROM dashboards.github_tokens WHERE id = $1::uuid`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

export async function touchGithubTokenLastUsed(id: string): Promise<void> {
  await dbQuery(
    `UPDATE dashboards.github_tokens SET last_used_at = now(), updated_at = now()
     WHERE id = $1::uuid`,
    [id],
  ).catch(() => {});
}
