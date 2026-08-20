import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APOLLO_SEARCH_PER_PAGE,
  assertPeopleSearchTool,
  nextSearchPage,
  organizationSearchAllowed,
  selectIdsToEnrich,
} from '@/lib/auto-campaigns/credit-pipeline';
import { applyExpansion, shouldAdvanceExpansion } from '@/lib/auto-campaigns/expansion';
import { mapAttributesHeuristic } from '@/lib/auto-campaigns/filter-map';
import { runPeopleSearchProspecting } from '@/lib/auto-campaigns/prospect';
import { computeAutoReservations } from '@/lib/auto-campaigns/reservations';
import {
  nextAutoCycleAfterCompletion,
  nextAutoCycleAt,
  shouldRunFirstCycleNow,
  staggerMinuteOfDay,
} from '@/lib/auto-campaigns/schedule';
import { searchOrganizationsRest, type ApolloPeopleClient } from '@/lib/auto-campaigns/apollo';
import type { EnrichedPerson, PeopleSearchHit, PeopleSearchParams } from '@/lib/auto-campaigns/types';
import { formatNyDate } from '@/lib/drafting/send-queue-schedule';
import { laneLimit } from '@/lib/orchestration/config';

function hit(id: string, linkedin?: string): PeopleSearchHit {
  return { apolloPersonId: id, linkedinUrl: linkedin ?? null, name: id };
}

function person(id: string, email?: string): EnrichedPerson {
  return {
    apolloPersonId: id,
    fullName: id,
    email: email ?? null,
    emailVerified: Boolean(email),
  };
}

function fakeClient(pages: Record<number, PeopleSearchHit[]>): ApolloPeopleClient & {
  enrichCalls: string[][];
} {
  const enrichCalls: string[][] = [];
  return {
    enrichCalls,
    async searchPeople(_params: PeopleSearchParams, page: number) {
      return pages[page] ?? [];
    },
    async enrichPeople(ids: string[]) {
      enrichCalls.push([...ids]);
      return ids.map((id) => person(id, `${id}@example.com`));
    },
  };
}

test('people-search is allowed; enrich and org search are refused unless explicitly enabled', () => {
  assert.doesNotThrow(() => assertPeopleSearchTool('search_people'));
  assert.throws(() => assertPeopleSearchTool('enrich_people'), /must not call Apollo enrich/);
  assert.throws(() => assertPeopleSearchTool('search_organizations'), /1 Apollo credit/);
  const prior = process.env.AUTO_APOLLO_ORG_SEARCH;
  process.env.AUTO_APOLLO_ORG_SEARCH = '1';
  try {
    assert.equal(organizationSearchAllowed(), true);
    assert.doesNotThrow(() => assertPeopleSearchTool('search_organizations'));
  } finally {
    if (prior === undefined) delete process.env.AUTO_APOLLO_ORG_SEARCH;
    else process.env.AUTO_APOLLO_ORG_SEARCH = prior;
  }
});

test('organization search REST is disabled by default', async () => {
  const prior = process.env.AUTO_APOLLO_ORG_SEARCH;
  delete process.env.AUTO_APOLLO_ORG_SEARCH;
  try {
    await assert.rejects(searchOrganizationsRest(), /1 Apollo credit/);
  } finally {
    if (prior === undefined) delete process.env.AUTO_APOLLO_ORG_SEARCH;
    else process.env.AUTO_APOLLO_ORG_SEARCH = prior;
  }
});

test('selectIdsToEnrich drops stored Apollo IDs and LinkedIn URLs before taking quota', () => {
  const selected = selectIdsToEnrich({
    hits: [
      hit('known-1'),
      hit('new-1', 'https://www.linkedin.com/in/already'),
      hit('new-2'),
      hit('new-3'),
      hit('new-4'),
    ],
    knownApolloIds: new Set(['known-1']),
    knownLinkedinUrls: new Set(['linkedin.com/in/already']),
    quota: 2,
  });
  assert.deepEqual(selected.toEnrich, ['new-2', 'new-3']);
  assert.equal(selected.skippedKnown, 2);
  assert.equal(selected.leftoverNew, 1);
  assert.equal(selected.pageExhausted, false);
  assert.equal(nextSearchPage(4, false), 4);
  assert.equal(nextSearchPage(4, true), 5);
});

test('prospecting never enriches stored IDs and stops once emails_per_day verified leads attach', async () => {
  const page1 = Array.from({ length: APOLLO_SEARCH_PER_PAGE }, (_, index) => hit(`p1-${index}`));
  const client = fakeClient({
    1: page1,
    2: [hit('p2-a'), hit('p2-b')],
  });
  const known = new Set(page1.slice(0, 90).map((row) => row.apolloPersonId));
  const result = await runPeopleSearchProspecting(client, {
    emailsPerDay: 3,
    page: 1,
    searchParams: { q_keywords: 'cre' },
    expansionStep: 0,
    knownApolloIds: known,
    knownLinkedinUrls: new Set(),
  });
  const enriched = client.enrichCalls.flat();
  assert.equal(result.attached.length, 3);
  assert.equal(result.filled, true);
  assert.equal(enriched.length, 3);
  assert.ok(enriched.every((id) => !known.has(id)));
  assert.equal(result.stats.enrich_attempted, 3);
  assert.equal(result.stats.skipped_known, 90);
  assert.equal(result.pageEnd, 1);
});

test('unverified enrich does not consume the daily lead quota; search continues until verified count is met', async () => {
  const client: ApolloPeopleClient & { enrichCalls: string[][] } = {
    enrichCalls: [],
    async searchPeople() {
      return [hit('a'), hit('b'), hit('c'), hit('d')];
    },
    async enrichPeople(ids) {
      client.enrichCalls.push([...ids]);
      return ids.map((id, index) => (
        id === 'c' || id === 'd' ? person(id, `${id}@x.com`) : person(id)
      ));
    },
  };
  const result = await runPeopleSearchProspecting(client, {
    emailsPerDay: 2,
    page: 7,
    searchParams: {},
    expansionStep: 0,
    knownApolloIds: new Set(),
    knownLinkedinUrls: new Set(),
  });
  assert.deepEqual(client.enrichCalls.flat(), ['a', 'b', 'c', 'd']);
  assert.equal(result.attached.length, 2);
  assert.equal(result.filled, true);
  assert.equal(result.storedWithoutEmail.length, 2);
  assert.equal(result.pageEnd, 7);
  assert.equal(result.stats.enrich_attempted, 4);
});

test('quota stays short across a page of unverified hits and keeps leftover IDs on the same page', async () => {
  const page1 = [hit('u1'), hit('u2'), hit('v1'), hit('v2'), hit('v3')];
  const client: ApolloPeopleClient & { enrichCalls: string[][] } = {
    enrichCalls: [],
    async searchPeople() {
      return page1;
    },
    async enrichPeople(ids) {
      client.enrichCalls.push([...ids]);
      return ids.map((id) => (id.startsWith('v') ? person(id, `${id}@x.com`) : person(id)));
    },
  };
  const result = await runPeopleSearchProspecting(client, {
    emailsPerDay: 2,
    page: 1,
    searchParams: {},
    expansionStep: 0,
    knownApolloIds: new Set(),
    knownLinkedinUrls: new Set(),
  });
  assert.equal(result.attached.length, 2);
  assert.deepEqual(result.attached.map((row) => row.apolloPersonId), ['v1', 'v2']);
  assert.ok(client.enrichCalls.flat().includes('u1'));
  assert.ok(client.enrichCalls.flat().includes('v2'));
  assert.equal(result.filled, true);
  assert.equal(result.pageEnd, 1);
  assert.equal(result.inventoryExhausted, false);
});

test('a last short page of unverified people exhausts inventory instead of stopping at the attempt count', async () => {
  const client: ApolloPeopleClient & { enrichCalls: string[][] } = {
    enrichCalls: [],
    async searchPeople() {
      return [hit('a'), hit('b'), hit('c')];
    },
    async enrichPeople(ids) {
      client.enrichCalls.push([...ids]);
      return ids.map((id) => person(id));
    },
  };
  const result = await runPeopleSearchProspecting(client, {
    emailsPerDay: 2,
    page: 4,
    searchParams: {},
    expansionStep: 0,
    knownApolloIds: new Set(),
    knownLinkedinUrls: new Set(),
  });
  assert.deepEqual(client.enrichCalls.flat(), ['a', 'b', 'c']);
  assert.equal(result.attached.length, 0);
  assert.equal(result.filled, false);
  assert.equal(result.inventoryExhausted, true);
  assert.equal(result.storedWithoutEmail.length, 3);
  assert.equal(result.pageEnd, 4);
});

test('a second cycle resumes the persisted page and does not restart at page 1', async () => {
  const pages: Record<number, PeopleSearchHit[]> = {
    3: [hit('keep-1'), hit('keep-2'), hit('keep-3')],
    1: [hit('page-1-should-not-run')],
  };
  const seenPages: number[] = [];
  const client: ApolloPeopleClient = {
    async searchPeople(_params, page) {
      seenPages.push(page);
      return pages[page] ?? [];
    },
    async enrichPeople(ids) {
      return ids.map((id) => person(id, `${id}@x.com`));
    },
  };
  const first = await runPeopleSearchProspecting(client, {
    emailsPerDay: 1,
    page: 3,
    searchParams: {},
    expansionStep: 0,
    knownApolloIds: new Set(),
    knownLinkedinUrls: new Set(),
  });
  const second = await runPeopleSearchProspecting(client, {
    emailsPerDay: 1,
    page: first.pageEnd,
    searchParams: {},
    expansionStep: 0,
    knownApolloIds: new Set(first.attached.map((row) => row.apolloPersonId)),
    knownLinkedinUrls: new Set(),
  });
  assert.ok(!seenPages.includes(1));
  assert.deepEqual(seenPages, [3, 3]);
  assert.equal(first.attached[0]?.apolloPersonId, 'keep-1');
  assert.equal(second.attached[0]?.apolloPersonId, 'keep-2');
  assert.equal(second.pageEnd, 3);
});

test('filter mapping is heuristic JSON only — no organization ids', () => {
  const mapped = mapAttributesHeuristic({
    industry: 'CRE brokerage',
    seniority: 'Managing Partner',
    geography: 'New York',
    business_size: '11-50',
  });
  assert.ok(!('organization_ids' in mapped));
  assert.deepEqual(mapped.person_locations, ['New York']);
  assert.ok(mapped.organization_num_employees_ranges?.includes('11,50'));
});

test('expansion ladder drops geo, then size, then industry, then widens seniority', () => {
  const exact: PeopleSearchParams = {
    person_locations: ['NYC'],
    organization_num_employees_ranges: ['11,50'],
    q_keywords: 'CRE',
    person_seniorities: ['partner'],
  };
  assert.deepEqual(applyExpansion(exact, 0).person_locations, ['NYC']);
  assert.equal(applyExpansion(exact, 1).person_locations, undefined);
  assert.equal(applyExpansion(exact, 2).organization_num_employees_ranges, undefined);
  assert.equal(applyExpansion(exact, 3).q_keywords, undefined);
  assert.ok(applyExpansion(exact, 4).person_seniorities?.includes('c_suite'));
  assert.deepEqual(shouldAdvanceExpansion({ attached: 10, emailsPerDay: 10, currentStep: 0 }), {
    nextStep: 0,
    resetCursor: false,
  });
  assert.deepEqual(shouldAdvanceExpansion({ attached: 2, emailsPerDay: 10, currentStep: 0 }), {
    nextStep: 1,
    resetCursor: true,
  });
});

test('queue reservations subtract already slotted sends and skip weekends', () => {
  const locks = computeAutoReservations({
    today: '2026-08-20',
    from: '2026-08-20',
    to: '2026-08-24',
    campaigns: [{
      campaignId: 'c1',
      campaignName: 'NYC CRE',
      emailsPerDay: 10,
      queueColor: 'chart-1',
      leadAttributes: {
        industry: 'CRE',
        seniority: 'Partner',
        geography: 'NYC',
        business_size: '11-50',
      },
      expansionStep: 0,
      queuedOrSentByDate: { '2026-08-20': 4 },
    }],
  });
  const byDate = Object.fromEntries(locks.map((lock) => [lock.schedule_date, lock.reserved]));
  assert.equal(byDate['2026-08-20'], 6);
  assert.equal(byDate['2026-08-21'], 10);
  assert.equal(byDate['2026-08-22'], undefined);
  assert.equal(byDate['2026-08-23'], undefined);
  assert.equal(byDate['2026-08-24'], 10);
});

test('weekday cycles stagger inside 2–6am ET and skip Saturday/Sunday', () => {
  const minute = staggerMinuteOfDay('campaign-fixture');
  assert.ok(minute >= 2 * 60);
  assert.ok(minute < 6 * 60);

  const saturday = new Date('2026-08-22T16:00:00.000Z');
  assert.equal(shouldRunFirstCycleNow(saturday), false);
  const next = nextAutoCycleAt('campaign-fixture', saturday);
  assert.equal(formatNyDate(next), '2026-08-24');

  const thursday = new Date('2026-08-20T18:00:00.000Z');
  assert.equal(shouldRunFirstCycleNow(thursday), true);
  const afterRun = nextAutoCycleAfterCompletion('campaign-fixture', thursday);
  assert.equal(formatNyDate(afterRun), '2026-08-21');
});

test('only one Auto cycle lane runs at a time', () => {
  assert.equal(laneLimit('auto_campaign'), 1);
});
