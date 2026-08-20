/**
 * Apollo credit rule:
 * - people search is free and may repeat
 * - enrich is paid
 * - our code, not Claude, chooses who to enrich
 * - drop known apollo_person_ids (and known LinkedIn URLs) BEFORE any enrich
 * - keep enriching never-seen IDs until `emails_per_day` verified emails attach
 * - never enrich someone already stored
 * - organization search is opt-in paid (1 credit/page) and off by default
 * - stopping at N enrich attempts when fewer than N verified emails attached is a defect
 */
import type { PeopleSearchHit } from '@/lib/auto-campaigns/types';

export const APOLLO_SEARCH_PER_PAGE = 100;
export const APOLLO_ENRICH_BATCH = 10;
export const APOLLO_MAX_SEARCH_PAGES_PER_CYCLE = 40;

export function normalizeLinkedinUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim().toLowerCase().replace(/\/+$/, '');
  const match = trimmed.match(/linkedin\.com\/in\/([^/?#]+)/);
  if (!match) return null;
  return `linkedin.com/in/${match[1]}`;
}

export function organizationSearchAllowed(): boolean {
  return process.env.AUTO_APOLLO_ORG_SEARCH?.trim() === '1';
}

export function assertPeopleSearchTool(toolName: string): void {
  const name = toolName.trim().toLowerCase();
  if (name === 'search_organizations' || name === 'search_organization') {
    if (!organizationSearchAllowed()) {
      throw new Error(
        'Organization search spends 1 Apollo credit per page and is disabled. Set AUTO_APOLLO_ORG_SEARCH=1 only if you intend to spend that credit.',
      );
    }
    return;
  }
  if (name === 'enrich_people' || name === 'enrich_person' || name === 'bulk_enrich_people') {
    throw new Error('Claude must not call Apollo enrich. Our code enriches after dropping stored IDs.');
  }
  if (name !== 'search_people' && name !== 'search_person') {
    throw new Error(`Unsupported Apollo tool "${toolName}". Auto prospecting may people-search only.`);
  }
}

export function selectIdsToEnrich(input: {
  hits: PeopleSearchHit[];
  knownApolloIds: Set<string>;
  knownLinkedinUrls: Set<string>;
  quota: number;
}): {
  toEnrich: string[];
  skippedKnown: number;
  leftoverNew: number;
  pageExhausted: boolean;
} {
  const quota = Math.max(0, Math.floor(input.quota));
  const toEnrich: string[] = [];
  let skippedKnown = 0;
  let leftoverNew = 0;

  for (const hit of input.hits) {
    const id = hit.apolloPersonId?.trim();
    if (!id) {
      skippedKnown += 1;
      continue;
    }
    const linkedin = normalizeLinkedinUrl(hit.linkedinUrl);
    const known = input.knownApolloIds.has(id)
      || (linkedin != null && input.knownLinkedinUrls.has(linkedin));
    if (known) {
      skippedKnown += 1;
      continue;
    }
    if (toEnrich.length >= quota) {
      leftoverNew += 1;
      continue;
    }
    toEnrich.push(id);
  }

  return {
    toEnrich,
    skippedKnown,
    leftoverNew,
    pageExhausted: leftoverNew === 0,
  };
}

/** Advance the persisted people-search page only after this page has no unused new IDs. */
export function nextSearchPage(currentPage: number, pageExhausted: boolean): number {
  const page = Math.max(1, Math.floor(currentPage) || 1);
  if (!pageExhausted) return page;
  return page + 1;
}

export function chunkIds(ids: string[], size = APOLLO_ENRICH_BATCH): string[][] {
  const out: string[][] = [];
  const n = Math.max(1, size);
  for (let i = 0; i < ids.length; i += n) out.push(ids.slice(i, i + n));
  return out;
}
