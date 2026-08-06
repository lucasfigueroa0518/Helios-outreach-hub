/**
 * Central model configuration. Automated development stays in `stub` mode:
 * no API call is made unless an operator explicitly sets
 * EXTRACTION_MODE=live after approving the expected cost.
 */
export const EXTRACTION_MODEL = 'claude-sonnet-5';
export const MAPPING_MODEL = 'claude-haiku-4-5-20251001';
export const RESEARCH_MODEL = 'claude-sonnet-5';

export type CanonicalField =
  | 'full_name' | 'first_name' | 'last_name' | 'title' | 'company'
  | 'location' | 'email' | 'email_alt_1' | 'email_alt_2' | 'phone' | 'linkedin_url';

const aliases: Record<CanonicalField, string[]> = {
  full_name: ['name', 'full name', 'contact name', 'person'],
  first_name: ['first name', 'firstname', 'given name'],
  last_name: ['last name', 'lastname', 'surname', 'family name'],
  title: ['title', 'job title', 'position', 'role'],
  company: ['company', 'employer', 'organization', 'firm', 'account'],
  location: ['location', 'city', 'region', 'geography'],
  email: ['email', 'email address', 'e-mail', 'primary email', 'work email'],
  email_alt_1: ['email alt 1', 'alt email 1', 'alternative email', 'alternative email 1', 'email 2', 'secondary email'],
  email_alt_2: ['email alt 2', 'alt email 2', 'alternative email 2', 'email 3', 'other email'],
  phone: ['phone', 'phone number', 'mobile'],
  linkedin_url: ['linkedin', 'linkedin url', 'linkedin profile'],
};

/** Deterministic offline column mapper used by tests and default local mode. */
export function mapColumnsOffline(headers: string[]): Record<string, CanonicalField> {
  const mapping: Record<string, CanonicalField> = {};
  for (const header of headers) {
    const normalized = header.trim().toLowerCase();
    const field = (Object.keys(aliases) as CanonicalField[]).find((key) =>
      aliases[key].includes(normalized),
    );
    if (field) mapping[header] = field;
  }
  return mapping;
}

/**
 * Canonical display label a recognized LinkedIn / CRM relationship-status column
 * is normalized to, so it lands under a stable key in the sheet and drafting input
 * regardless of how the uploaded file spelled the header.
 */
export const LINKEDIN_RELATIONSHIP_LABEL = 'LinkedIn Relationship';

/**
 * True when a column header denotes a LinkedIn/CRM relationship or connection status
 * (e.g. "LinkedIn Relationship", "Connection Status", "1st/2nd/3rd degree").
 * Deliberately conservative: only clear relationship/connection headers match so an
 * unrelated column named "Relationship" (to a spouse, an account, etc.) is not renamed.
 */
export function isLinkedinRelationshipHeader(header: string): boolean {
  const normalized = header.trim().toLowerCase();
  if (
    normalized.includes('linkedin')
    && /(relationship|connection|status|degree|network)/.test(normalized)
  ) {
    return true;
  }
  return [
    'connection status',
    'connection degree',
    'relationship status',
    'network degree',
  ].includes(normalized);
}

export function assertLiveExtractionAllowed() {
  if (process.env.EXTRACTION_MODE !== 'live') {
    throw new Error(
      'Live extraction is disabled. Set EXTRACTION_MODE=live only after approving the expected API spend.',
    );
  }
}

/** Drafting research/writer models — aligned with EXTRACTION_MODEL for consistency. */
export const DRAFTING_RESEARCH_MODEL = 'claude-sonnet-5';
export const DRAFTING_WRITER_MODEL = 'claude-sonnet-5';
/** Lightweight adversarial QA pass after research (disprove-then-keep). */
export const DRAFTING_ADVERSARIAL_MODEL = 'claude-haiku-4-5-20251001';

/** Hard ceiling for web searches per research job; env cannot exceed this. */
export const DRAFTING_MAX_SEARCHES = 3;
/** Default searches when env unset — prefer 2 for throughput; ceiling remains 3. */
export const DRAFTING_MAX_SEARCHES_DEFAULT = 2;
/** Hard ceiling for adversarial QA web searches; keep small — Haiku is a doubt pass. */
export const DRAFTING_ADVERSARIAL_MAX_SEARCHES = 1;

/**
 * True provider-call budget, including the final forced packet report.
 * Default is one auto search turn + one forced report; ceiling stays 3.
 */
export const DRAFTING_RESEARCH_MAX_CALLS_CEILING = 3;
export const DRAFTING_RESEARCH_MAX_CALLS_DEFAULT = 2;
/** Research max_tokens ceiling / default for configured env.
 * Forced report uses DRAFTING_RESEARCH_FORCED_REPORT_MAX_TOKENS (8192). */
export const DRAFTING_RESEARCH_MAX_TOKENS_CEILING = 8_192;
export const DRAFTING_RESEARCH_MAX_TOKENS_DEFAULT = 8_192;
/** Compact forced packet report. 4096 truncated mid-schema (sources missing); 8192 is the safe floor. */
export const DRAFTING_RESEARCH_FORCED_REPORT_MAX_TOKENS = 8_192;
/** Writer max_tokens ceiling / default. */
export const DRAFTING_WRITER_MAX_TOKENS_CEILING = 4_000;
export const DRAFTING_WRITER_MAX_TOKENS_DEFAULT = 2_000;
/** Adversarial multi-turn ceiling / default. */
export const DRAFTING_ADVERSARIAL_MAX_TURNS_CEILING = 8;
export const DRAFTING_ADVERSARIAL_MAX_TURNS_DEFAULT = 4;

export type DraftingMode = 'stub' | 'live';
export type DraftingPromptCacheTtl = '5m' | '1h';

export function getDraftingMode(): DraftingMode {
  return process.env.DRAFTING_MODE === 'live' ? 'live' : 'stub';
}

export function assertLiveDraftingAllowed(): void {
  if (getDraftingMode() !== 'live') {
    throw new Error(
      'Live drafting is disabled. Set DRAFTING_MODE=live only after a human authorizes drafting in the app.',
    );
  }
}

function resolveBoundedInt(
  envName: string,
  fallback: number,
  ceiling: number,
  floor = 0,
): number {
  const parsed = Number(process.env[envName] ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(floor, Math.min(ceiling, Math.floor(parsed)));
}

export function resolvedDraftingMaxSearches(): number {
  return resolveBoundedInt(
    'DRAFT_RESEARCH_MAX_SEARCHES',
    DRAFTING_MAX_SEARCHES_DEFAULT,
    DRAFTING_MAX_SEARCHES,
    1,
  );
}

export function resolvedDraftingAdversarialMaxSearches(): number {
  return resolveBoundedInt(
    'DRAFT_ADVERSARIAL_MAX_SEARCHES',
    DRAFTING_ADVERSARIAL_MAX_SEARCHES,
    DRAFTING_ADVERSARIAL_MAX_SEARCHES,
  );
}

export function resolvedDraftingResearchMaxCalls(): number {
  return resolveBoundedInt(
    'DRAFT_RESEARCH_MAX_CALLS',
    DRAFTING_RESEARCH_MAX_CALLS_DEFAULT,
    DRAFTING_RESEARCH_MAX_CALLS_CEILING,
    2,
  );
}

export function resolvedDraftingResearchMaxTokens(): number {
  return resolveBoundedInt(
    'DRAFT_RESEARCH_MAX_TOKENS',
    DRAFTING_RESEARCH_MAX_TOKENS_DEFAULT,
    DRAFTING_RESEARCH_MAX_TOKENS_CEILING,
    256,
  );
}

export function resolvedDraftingWriterMaxTokens(): number {
  return resolveBoundedInt(
    'DRAFT_WRITER_MAX_TOKENS',
    DRAFTING_WRITER_MAX_TOKENS_DEFAULT,
    DRAFTING_WRITER_MAX_TOKENS_CEILING,
    256,
  );
}

export function resolvedDraftingAdversarialMaxTurns(): number {
  return resolveBoundedInt(
    'DRAFT_ADVERSARIAL_MAX_TURNS',
    DRAFTING_ADVERSARIAL_MAX_TURNS_DEFAULT,
    DRAFTING_ADVERSARIAL_MAX_TURNS_CEILING,
    1,
  );
}

/** Prompt-cache TTL for static system blocks. Defaults to 1h per drafting runtime plan. */
export function resolvedDraftingPromptCacheTtl(): DraftingPromptCacheTtl {
  return process.env.DRAFTING_PROMPT_CACHE_TTL === '5m' ? '5m' : '1h';
}
