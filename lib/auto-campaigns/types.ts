export const CAMPAIGN_KINDS = ['manual', 'auto'] as const;
export type CampaignKind = (typeof CAMPAIGN_KINDS)[number];

export const AUTO_STATUSES = [
  'pending_sender',
  'live',
  'paused',
  'exhausted',
  'error',
] as const;
export type AutoStatus = (typeof AUTO_STATUSES)[number];

export const MAX_EXPANSION_STEP = 4;
export const EXPANSION_LABELS = [
  'Exact profile',
  'Widened geography',
  'Widened company size',
  'Widened industry',
  'Widened seniority',
] as const;

export const AUTO_QUEUE_COLORS = [
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'chart-6',
  'chart-7',
  'chart-8',
] as const;
export type AutoQueueColor = (typeof AUTO_QUEUE_COLORS)[number];

export type LeadAttributes = {
  industry: string;
  seniority: string;
  geography: string;
  business_size: string;
};

export type PeopleSearchParams = {
  person_titles?: string[];
  person_seniorities?: string[];
  person_locations?: string[];
  q_keywords?: string;
  organization_num_employees_ranges?: string[];
};

export type PeopleSearchHit = {
  apolloPersonId: string;
  linkedinUrl?: string | null;
  name?: string | null;
  title?: string | null;
  organizationName?: string | null;
};

export type EnrichedPerson = {
  apolloPersonId: string;
  fullName: string;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
  emailVerified: boolean;
};

export type ProspectLogEntry = {
  at: string;
  kind: 'search' | 'enrich' | 'skip' | 'cursor' | 'map' | 'expand' | 'error' | 'result';
  message: string;
  page?: number;
  count?: number;
  ids?: string[];
};

export type ProspectCycleStats = {
  page_start: number;
  page_end: number;
  searches: number;
  enrich_attempted: number;
  enrich_verified: number;
  skipped_known: number;
  leads_attached: number;
  expansion_step: number;
  log: ProspectLogEntry[];
};
