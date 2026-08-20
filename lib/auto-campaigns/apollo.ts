import { organizationSearchAllowed } from '@/lib/auto-campaigns/credit-pipeline';
import type {
  EnrichedPerson,
  PeopleSearchHit,
  PeopleSearchParams,
} from '@/lib/auto-campaigns/types';

const APOLLO_REST = 'https://api.apollo.io/api/v1';

export class ApolloClientError extends Error {
  readonly status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = 'ApolloClientError';
    this.status = status;
  }
}

export type ApolloPeopleClient = {
  searchPeople: (params: PeopleSearchParams, page: number, perPage: number) => Promise<PeopleSearchHit[]>;
  enrichPeople: (apolloIds: string[]) => Promise<EnrichedPerson[]>;
};

function apiKey(): string {
  const key = process.env.APOLLO_API_KEY?.trim();
  if (!key) throw new ApolloClientError('APOLLO_API_KEY is not configured', 503);
  return key;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function idFromPerson(row: Record<string, unknown>): string | null {
  return stringField(row.id) || stringField(row.person_id);
}

function hitFromPerson(row: unknown): PeopleSearchHit | null {
  const rec = asRecord(row);
  if (!rec) return null;
  const id = idFromPerson(rec);
  if (!id) return null;
  const org = asRecord(rec.organization);
  return {
    apolloPersonId: id,
    linkedinUrl: stringField(rec.linkedin_url) || stringField(rec.linkedin_url_cached),
    name: stringField(rec.name) || [stringField(rec.first_name), stringField(rec.last_name)].filter(Boolean).join(' ') || null,
    title: stringField(rec.title),
    organizationName: stringField(org?.name) || stringField(rec.organization_name),
  };
}

function verifiedEmail(row: Record<string, unknown>): { email: string | null; verified: boolean } {
  const email = stringField(row.email);
  const status = stringField(row.email_status)?.toLowerCase();
  return { email, verified: Boolean(email) && status === 'verified' };
}

function enrichedFromPerson(row: unknown): EnrichedPerson | null {
  const rec = asRecord(row);
  if (!rec) return null;
  const person = asRecord(rec.person) ?? rec;
  const id = idFromPerson(person);
  const name = stringField(person.name)
    || [stringField(person.first_name), stringField(person.last_name)].filter(Boolean).join(' ');
  if (!id || !name) return null;
  const org = asRecord(person.organization);
  const { email, verified } = verifiedEmail(person);
  return {
    apolloPersonId: id,
    fullName: name,
    title: stringField(person.title),
    company: stringField(org?.name) || stringField(person.organization_name),
    location: stringField(person.city)
      || [stringField(person.city), stringField(person.state), stringField(person.country)].filter(Boolean).join(', ')
      || stringField(person.present_raw_address),
    email,
    linkedinUrl: stringField(person.linkedin_url),
    emailVerified: Boolean(email) && verified,
  };
}

function searchBody(params: PeopleSearchParams, page: number, perPage: number): Record<string, unknown> {
  const body: Record<string, unknown> = {
    page,
    per_page: perPage,
  };
  if (params.person_titles?.length) body.person_titles = params.person_titles;
  if (params.person_seniorities?.length) body.person_seniorities = params.person_seniorities;
  if (params.person_locations?.length) body.person_locations = params.person_locations;
  if (params.q_keywords?.trim()) body.q_keywords = params.q_keywords.trim();
  if (params.organization_num_employees_ranges?.length) {
    body.organization_num_employees_ranges = params.organization_num_employees_ranges;
  }
  return body;
}

async function apolloPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${APOLLO_REST}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey(),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) as unknown : null;
  } catch {
    parsed = { raw: text.slice(0, 400) };
  }
  if (!response.ok) {
    const rec = asRecord(parsed);
    const message = stringField(rec?.error)
      || stringField(rec?.message)
      || `Apollo ${path} failed (${response.status})`;
    throw new ApolloClientError(message, response.status);
  }
  return parsed;
}

export async function searchPeopleRest(
  params: PeopleSearchParams,
  page: number,
  perPage: number,
): Promise<PeopleSearchHit[]> {
  const parsed = await apolloPost('/mixed_people/api_search', searchBody(params, page, perPage));
  const rec = asRecord(parsed);
  const people = Array.isArray(rec?.people) ? rec.people : Array.isArray(rec?.contacts) ? rec.contacts : [];
  return people.flatMap((row) => {
    const hit = hitFromPerson(row);
    return hit ? [hit] : [];
  });
}

export async function enrichPeopleRest(apolloIds: string[]): Promise<EnrichedPerson[]> {
  if (apolloIds.length === 0) return [];
  const parsed = await apolloPost('/people/bulk_match', {
    details: apolloIds.map((id) => ({ id })),
    reveal_personal_emails: false,
    reveal_phone_number: false,
  });
  const rec = asRecord(parsed);
  const matches = Array.isArray(rec?.matches)
    ? rec.matches
    : Array.isArray(rec?.people)
      ? rec.people
      : [];
  return matches.flatMap((row) => {
    const person = enrichedFromPerson(row);
    return person ? [person] : [];
  });
}

export async function searchOrganizationsRest(): Promise<never> {
  if (!organizationSearchAllowed()) {
    throw new ApolloClientError(
      'Organization search spends 1 Apollo credit per page and is disabled.',
      403,
    );
  }
  throw new ApolloClientError('Organization search is not used by Auto campaigns.', 400);
}

export function createApolloRestClient(): ApolloPeopleClient {
  return {
    searchPeople: searchPeopleRest,
    enrichPeople: enrichPeopleRest,
  };
}
