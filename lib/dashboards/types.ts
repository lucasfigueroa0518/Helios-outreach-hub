// ContextUpdate bullet types (stored as JSON in DB)
export type BulletSource = { eventId: string };
export type Bullet = { text: string; sources: BulletSource[] };
export type ContextUpdateBullets = { bullets: Bullet[] };

// RepoEvent.meta discriminated union
export type CommitMeta = Record<string, never>;

export type PrMergedMeta = {
  mergedSha: string;
  baseBranch: string;
  additions?: number;
  deletions?: number;
};

export type IssueClosedMeta = {
  labels: string[];
  closedBy?: string;
  stateReason?: 'completed' | 'not_planned' | 'reopened';
};

export type RepoEventMeta = CommitMeta | PrMergedMeta | IssueClosedMeta;

export function isPrMergedMeta(meta: unknown): meta is PrMergedMeta {
  return typeof meta === 'object' && meta !== null && 'mergedSha' in meta;
}

export type RepoEventType = 'COMMIT' | 'PR_MERGED' | 'ISSUE_CLOSED';
export type ProjectStatus = 'ACTIVE' | 'PAUSED' | 'COMPLETE' | 'ARCHIVED';
export type GenSource = 'CRON' | 'MANUAL' | 'WORKER';

export type RepoEvent = {
  id: string;
  projectId: string;
  type: RepoEventType;
  externalId: string;
  title: string;
  body: string | null;
  authorName: string;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  url: string;
  occurredAt: Date;
};

export type ContextUpdate = {
  id: string;
  projectId: string;
  bullets: ContextUpdateBullets;
  windowStart: Date;
  windowEnd: Date;
  generatedAt: Date;
  generatedBy: GenSource;
};

export type DashboardProject = {
  id: string;
  name: string;
  status: ProjectStatus;
  startDate: Date;
  targetEndDate: Date;
  completedAt: Date | null;
  accessToken: string;
  deckPdfUrl: string | null;
  deckStoragePath: string | null;
  githubRepo: string;
  cronEnabled: boolean;
  cronStatus: string;
  mvpDelivered: boolean;
  client: { id: string; name: string };
};

export type DashboardPageData = {
  project: DashboardProject;
  latestUpdate: ContextUpdate | null;
  recentEvents: RepoEvent[];
  eventsById: Record<string, RepoEvent>;
};

export type AdminClient = {
  id: string;
  name: string;
  contactEmail: string | null;
  createdAt: Date;
};

export type AdminProject = {
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
  client: AdminClient;
  daysRemaining: number;
  lastUpdateAt: Date | null;
};

export type GithubTokenMeta = {
  id: string;
  githubHandle: string;
  tokenSuffix: string;
  addedByUserId: string;
  addedByEmail: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
