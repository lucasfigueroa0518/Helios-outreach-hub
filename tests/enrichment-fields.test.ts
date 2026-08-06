import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRequestedProfileFields,
  hardRequestedFields,
  normalizePersonProfileFields,
  peopleNeedHardProfileResearch,
  peopleStillNeedEmailResearch,
} from '@/lib/enrichment-fields';
import { unresolvedProfileFields } from '@/lib/enrichment';
import { searchBudgetForJob } from '@/lib/research-budget';
import { buildDisambiguation, isHighConfidenceProfileFinding } from '@/lib/research-types';
import type { ResearchPerson } from '@/lib/research-types';

test('peopleStillNeedEmailResearch is true until every lead has an email', () => {
  assert.equal(
    peopleStillNeedEmailResearch([
      { email: null, email_status: 'not_found' },
      { email: 'a@acme.com', email_status: 'inferred' },
    ]),
    true,
  );
  assert.equal(
    peopleStillNeedEmailResearch([
      { email: 'a@acme.com', email_status: 'inferred' },
      { email: 'b@acme.com', email_status: 'direct' },
    ]),
    false,
  );
  assert.equal(
    peopleStillNeedEmailResearch([{ email: '  ', email_status: 'not_found' }]),
    true,
  );
});

test('buildRequestedProfileFields keeps location opportunistic and title hard', () => {
  assert.deepEqual(
    buildRequestedProfileFields({
      company_name: 'Acme',
      title: null,
      location: null,
    }),
    { requested_fields: ['title'], opportunistic_fields: ['location'] },
  );
  assert.deepEqual(
    buildRequestedProfileFields({
      company_name: 'Acme',
      title: 'CFO',
      location: null,
    }),
    { requested_fields: [], opportunistic_fields: ['location'] },
  );
  assert.deepEqual(
    buildRequestedProfileFields({
      company_name: 'Acme',
      title: 'CFO',
      location: 'Dallas, TX',
    }),
    { requested_fields: [], opportunistic_fields: [] },
  );
  assert.deepEqual(
    buildRequestedProfileFields({
      company_name: null,
      title: null,
      location: null,
    }),
    { requested_fields: ['company_name'], opportunistic_fields: ['location'] },
  );
});

test('normalizePersonProfileFields moves legacy location out of requested_fields', () => {
  const normalized = normalizePersonProfileFields({
    lead_id: '1',
    full_name: 'Jane Doe',
    first_name: 'Jane',
    last_name: 'Doe',
    title: 'CFO',
    location: null,
    requested_fields: ['title', 'location'],
  } satisfies ResearchPerson);
  assert.deepEqual(normalized.requested_fields, ['title']);
  assert.deepEqual(normalized.opportunistic_fields, ['location']);
});

test('searchBudgetForJob ignores location-only soft gaps', () => {
  const locationOnly: ResearchPerson[] = [{
    lead_id: '1',
    full_name: 'Jane Doe',
    first_name: 'Jane',
    last_name: 'Doe',
    title: 'CFO',
    location: null,
    email: 'jane@acme.com',
    email_status: 'direct',
    requested_fields: [],
    opportunistic_fields: ['location'],
  }];
  assert.equal(peopleNeedHardProfileResearch(locationOnly), false);
  assert.equal(searchBudgetForJob(locationOnly, 'primary'), 0);

  const legacyLocationRequested: ResearchPerson[] = [{
    ...locationOnly[0],
    requested_fields: ['location'],
    opportunistic_fields: [],
  }];
  // Legacy payloads still look soft once hardRequestedFields filters them.
  assert.deepEqual(hardRequestedFields(legacyLocationRequested[0].requested_fields), []);
  assert.equal(searchBudgetForJob(legacyLocationRequested, 'primary'), 0);

  const titleMissing: ResearchPerson[] = [{
    ...locationOnly[0],
    title: null,
    requested_fields: ['title'],
    opportunistic_fields: ['location'],
  }];
  assert.equal(searchBudgetForJob(titleMissing, 'primary'), 5);
  assert.equal(searchBudgetForJob(titleMissing, 'profile_rescue'), 1);
});

test('buildDisambiguation normalizes location into opportunistic_fields', () => {
  const disambiguation = buildDisambiguation('Acme', [{
    lead_id: '1',
    full_name: 'Jane Doe',
    first_name: 'Jane',
    last_name: 'Doe',
    title: 'CFO',
    location: null,
    requested_fields: ['location'],
  }]);
  assert.deepEqual(disambiguation.people[0].requested_fields, []);
  assert.deepEqual(disambiguation.people[0].opportunistic_fields, ['location']);
});

test('opportunistic location findings still pass the write gate', () => {
  const person: ResearchPerson = {
    lead_id: '1',
    full_name: 'Jane Smith',
    first_name: 'Jane',
    last_name: 'Smith',
    title: 'CFO',
    location: null,
    email: 'jane@acme.com',
    requested_fields: [],
    opportunistic_fields: ['location'],
  };
  const finding = {
    person_name: 'Jane Smith',
    field: 'location' as const,
    value: 'Dallas, TX',
    confidence: 'high' as const,
    reasoning: 'Two independent sources explicitly place Jane in Dallas.',
    location_scope: 'person_work_location' as const,
    evidence: [
      {
        url: 'https://acme.com/team/jane-smith',
        source_type: 'first_party' as const,
        quote: 'Jane Smith is based in Dallas, TX.',
        value: 'Dallas, TX',
        person_specific: true,
        location_scope: 'person_work_location' as const,
      },
      {
        url: 'https://conference.org/speakers/jane-smith',
        source_type: 'conference_bio' as const,
        quote: 'Jane Smith works from Dallas, TX.',
        value: 'Dallas, TX',
        person_specific: true,
        location_scope: 'person_work_location' as const,
      },
    ],
  };
  assert.equal(isHighConfidenceProfileFinding(finding, person), true);
  assert.equal(isHighConfidenceProfileFinding(finding, {
    ...person,
    opportunistic_fields: [],
  }), false);
});

test('hardRequestedFields strips location from rescue candidates', () => {
  assert.deepEqual(
    hardRequestedFields(['company_name', 'title', 'location']),
    ['company_name', 'title'],
  );
  assert.deepEqual(hardRequestedFields(['location']), []);
});

test('location-only unresolved gaps do not survive the hard rescue filter', () => {
  const lead = {
    company_name: 'Acme',
    title: 'CFO',
    location: null as string | null,
  };
  assert.deepEqual(
    hardRequestedFields(unresolvedProfileFields(['location'], lead)),
    [],
  );
  assert.deepEqual(
    hardRequestedFields(unresolvedProfileFields(['title', 'location'], {
      ...lead,
      title: null,
    })),
    ['title'],
  );
});
