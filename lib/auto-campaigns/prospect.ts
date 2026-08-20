import {
  APOLLO_MAX_SEARCH_PAGES_PER_CYCLE,
  APOLLO_SEARCH_PER_PAGE,
  chunkIds,
  nextSearchPage,
  normalizeLinkedinUrl,
  selectIdsToEnrich,
} from '@/lib/auto-campaigns/credit-pipeline';
import type { ApolloPeopleClient } from '@/lib/auto-campaigns/apollo';
import { applyExpansion } from '@/lib/auto-campaigns/expansion';
import type {
  EnrichedPerson,
  PeopleSearchParams,
  ProspectCycleStats,
  ProspectLogEntry,
} from '@/lib/auto-campaigns/types';

export type ProspectRunInput = {
  emailsPerDay: number;
  page: number;
  searchParams: PeopleSearchParams;
  expansionStep: number;
  knownApolloIds: Set<string>;
  knownLinkedinUrls: Set<string>;
  now?: Date;
};

export type ProspectRunResult = {
  pageEnd: number;
  attached: EnrichedPerson[];
  storedWithoutEmail: EnrichedPerson[];
  filled: boolean;
  inventoryExhausted: boolean;
  stats: ProspectCycleStats;
};

function log(
  entries: ProspectLogEntry[],
  kind: ProspectLogEntry['kind'],
  message: string,
  extra: Partial<ProspectLogEntry> = {},
  now = new Date(),
): void {
  entries.push({ at: now.toISOString(), kind, message, ...extra });
}

function rememberPerson(
  person: EnrichedPerson,
  knownIds: Set<string>,
  knownLinkedin: Set<string>,
): void {
  knownIds.add(person.apolloPersonId);
  const linkedin = normalizeLinkedinUrl(person.linkedinUrl);
  if (linkedin) knownLinkedin.add(linkedin);
}

/**
 * People-search → drop stored IDs → enrich until `emailsPerDay` verified emails
 * attach. Unverified enrich results are stored so they are never paid for again,
 * then search continues. Claude is not in this loop.
 */
export async function runPeopleSearchProspecting(
  client: ApolloPeopleClient,
  input: ProspectRunInput,
): Promise<ProspectRunResult> {
  const now = input.now ?? new Date();
  const quota = Math.max(0, Math.floor(input.emailsPerDay) || 0);
  const entries: ProspectLogEntry[] = [];
  const params = applyExpansion(input.searchParams, input.expansionStep);
  const knownIds = new Set(input.knownApolloIds);
  const knownLinkedin = new Set(
    [...input.knownLinkedinUrls].flatMap((url) => {
      const normalized = normalizeLinkedinUrl(url);
      return normalized ? [normalized] : [];
    }),
  );
  let page = Math.max(1, input.page || 1);
  let searches = 0;
  let skippedKnown = 0;
  let enrichAttempted = 0;
  const attached: EnrichedPerson[] = [];
  const storedWithoutEmail: EnrichedPerson[] = [];
  let inventoryExhausted = quota === 0;

  log(entries, 'expand', `Search at expansion step ${input.expansionStep}`, { count: input.expansionStep }, now);
  log(entries, 'cursor', `Resume people-search at page ${page}`, { page }, now);

  for (let i = 0; i < APOLLO_MAX_SEARCH_PAGES_PER_CYCLE; i += 1) {
    const remaining = quota - attached.length;
    if (remaining <= 0) break;

    const hits = await client.searchPeople(params, page, APOLLO_SEARCH_PER_PAGE);
    searches += 1;
    log(entries, 'search', `People search page ${page} returned ${hits.length}`, {
      page,
      count: hits.length,
    }, now);

    if (hits.length === 0) {
      log(entries, 'cursor', `Empty page ${page}; inventory thin`, { page }, now);
      inventoryExhausted = true;
      break;
    }

    const selected = selectIdsToEnrich({
      hits,
      knownApolloIds: knownIds,
      knownLinkedinUrls: knownLinkedin,
      quota: remaining,
    });
    skippedKnown += selected.skippedKnown;
    log(entries, 'skip', `Dropped ${selected.skippedKnown} stored Apollo/LinkedIn hits before enrich`, {
      page,
      count: selected.skippedKnown,
    }, now);

    if (selected.toEnrich.length > 0) {
      const batches = chunkIds(selected.toEnrich);
      for (const batch of batches) {
        if (attached.length >= quota) break;
        enrichAttempted += batch.length;
        log(entries, 'enrich', `Enrich ${batch.length} never-seen Apollo IDs`, {
          page,
          count: batch.length,
          ids: batch,
        }, now);
        const people = await client.enrichPeople(batch);
        for (const id of batch) knownIds.add(id);
        for (const person of people) {
          rememberPerson(person, knownIds, knownLinkedin);
          if (person.emailVerified && person.email) attached.push(person);
          else storedWithoutEmail.push(person);
        }
        const missing = batch.filter((id) =>
          !people.some((person) => person.apolloPersonId === id)
          && !attached.some((person) => person.apolloPersonId === id)
          && !storedWithoutEmail.some((person) => person.apolloPersonId === id),
        );
        for (const id of missing) {
          storedWithoutEmail.push({
            apolloPersonId: id,
            fullName: 'Unknown',
            emailVerified: false,
          });
        }
      }
    }

    if (attached.length >= quota) {
      if (!selected.pageExhausted) {
        log(entries, 'cursor', `Verified lead quota filled; stay on page ${page} for leftover new IDs`, { page }, now);
      }
      break;
    }

    if (hits.length < APOLLO_SEARCH_PER_PAGE && selected.pageExhausted) {
      log(entries, 'cursor', 'Last search page reached', { page }, now);
      inventoryExhausted = true;
      break;
    }

    const next = nextSearchPage(page, selected.pageExhausted);
    if (next !== page) {
      log(entries, 'cursor', `Page ${page} exhausted of new IDs; resume at ${next}`, { page: next }, now);
      page = next;
    }
  }

  const filled = attached.length >= quota;
  if (!filled && !inventoryExhausted) {
    log(entries, 'cursor', `Page budget reached at ${page}; verified ${attached.length} of ${quota}`, {
      page,
      count: attached.length,
    }, now);
  }

  return {
    pageEnd: page,
    attached,
    storedWithoutEmail,
    filled,
    inventoryExhausted,
    stats: {
      page_start: Math.max(1, input.page || 1),
      page_end: page,
      searches,
      enrich_attempted: enrichAttempted,
      enrich_verified: attached.length,
      skipped_known: skippedKnown,
      leads_attached: attached.length,
      expansion_step: input.expansionStep,
      log: entries,
    },
  };
}
