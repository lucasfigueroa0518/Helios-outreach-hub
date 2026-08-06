import type { ProfileField, ResearchPerson } from '@/lib/research-types';

/** Drive search budget, cache short-circuit, and profile_rescue. */
export const HARD_PROFILE_FIELDS = ['company_name', 'title'] as const satisfies readonly ProfileField[];

/** Opportunistic only — fill when easy; never chase with budget or rescue. */
export const SOFT_PROFILE_FIELDS = ['location'] as const satisfies readonly ProfileField[];

const HARD_SET = new Set<string>(HARD_PROFILE_FIELDS);
const SOFT_SET = new Set<string>(SOFT_PROFILE_FIELDS);

export function isHardProfileField(field: string): field is (typeof HARD_PROFILE_FIELDS)[number] {
  return HARD_SET.has(field);
}

export function isSoftProfileField(field: string): field is (typeof SOFT_PROFILE_FIELDS)[number] {
  return SOFT_SET.has(field);
}

export function hardRequestedFields(
  fields: readonly ProfileField[] | null | undefined,
): ProfileField[] {
  return [...new Set((fields ?? []).filter(isHardProfileField))];
}

export function softRequestedFields(
  fields: readonly ProfileField[] | null | undefined,
): ProfileField[] {
  return [...new Set((fields ?? []).filter(isSoftProfileField))];
}

export function personNeedsHardProfileResearch(person: ResearchPerson): boolean {
  return hardRequestedFields(person.requested_fields).length > 0;
}

export function peopleNeedHardProfileResearch(people: readonly ResearchPerson[]): boolean {
  return people.some(personNeedsHardProfileResearch);
}

/**
 * After a known-domain / format-cache attempt, research must still run when any
 * lead lacks an email. Skipping here is what makes Enrich look "done" in seconds
 * with a sheet full of Not Found.
 */
export function peopleStillNeedEmailResearch(
  people: ReadonlyArray<{ email?: string | null; email_status?: string | null }>,
): boolean {
  return people.some((person) => !person.email?.trim());
}


export type LeadProfileFieldSource = {
  company_name?: string | null;
  title?: string | null;
  location?: string | null;
};

/**
 * Split missing profile fields into budget/rescue hard fields vs opportunistic soft fields.
 * Company blank → research company_name only (same as today's primary path).
 */
export function buildRequestedProfileFields(lead: LeadProfileFieldSource): {
  requested_fields: ProfileField[];
  opportunistic_fields: ProfileField[];
} {
  if (!lead.company_name?.trim()) {
    return {
      requested_fields: ['company_name'],
      opportunistic_fields: lead.location?.trim() ? [] : ['location'],
    };
  }
  const requested_fields: ProfileField[] = [];
  if (!lead.title?.trim()) requested_fields.push('title');
  const opportunistic_fields: ProfileField[] = lead.location?.trim() ? [] : ['location'];
  return { requested_fields, opportunistic_fields };
}

/**
 * Move legacy location entries out of requested_fields into opportunistic_fields.
 * Hard fields stay on requested_fields.
 */
export function normalizePersonProfileFields<T extends ResearchPerson>(
  person: T,
): Omit<T, 'requested_fields' | 'opportunistic_fields'> & {
  requested_fields: ProfileField[];
  opportunistic_fields: ProfileField[];
} {
  const legacyRequested = person.requested_fields ?? [];
  const legacyOpportunistic = person.opportunistic_fields ?? [];
  const hard = hardRequestedFields(legacyRequested);
  const softFromRequested = softRequestedFields(legacyRequested);
  const softFromOpportunistic = softRequestedFields(legacyOpportunistic);
  const opportunistic = [...new Set([...softFromRequested, ...softFromOpportunistic])];
  return {
    ...person,
    requested_fields: hard,
    opportunistic_fields: opportunistic,
  };
}

export function normalizePeopleProfileFields<T extends ResearchPerson>(
  people: readonly T[],
): Array<Omit<T, 'requested_fields' | 'opportunistic_fields'> & {
  requested_fields: ProfileField[];
  opportunistic_fields: ProfileField[];
}> {
  return people.map((person) => normalizePersonProfileFields(person));
}
