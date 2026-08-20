import { MAX_EXPANSION_STEP, type PeopleSearchParams } from '@/lib/auto-campaigns/types';

const WIDE_SENIORITY = [
  'owner',
  'founder',
  'c_suite',
  'partner',
  'vp',
  'head',
  'director',
];

export function applyExpansion(params: PeopleSearchParams, step: number): PeopleSearchParams {
  const clamped = Math.max(0, Math.min(MAX_EXPANSION_STEP, Math.floor(step) || 0));
  let next: PeopleSearchParams = {
    person_titles: params.person_titles?.length ? [...params.person_titles] : undefined,
    person_seniorities: params.person_seniorities?.length ? [...params.person_seniorities] : undefined,
    person_locations: params.person_locations?.length ? [...params.person_locations] : undefined,
    q_keywords: params.q_keywords?.trim() || undefined,
    organization_num_employees_ranges: params.organization_num_employees_ranges?.length
      ? [...params.organization_num_employees_ranges]
      : undefined,
  };
  if (clamped >= 1) next = { ...next, person_locations: undefined };
  if (clamped >= 2) next = { ...next, organization_num_employees_ranges: undefined };
  if (clamped >= 3) next = { ...next, q_keywords: undefined };
  if (clamped >= 4) {
    const merged = new Set([
      ...(next.person_seniorities ?? []),
      ...WIDE_SENIORITY,
    ]);
    next = { ...next, person_seniorities: [...merged] };
  }
  return next;
}

export function shouldAdvanceExpansion(input: {
  attached: number;
  emailsPerDay: number;
  currentStep: number;
}): { nextStep: number; resetCursor: boolean } {
  if (input.attached >= input.emailsPerDay) {
    return { nextStep: input.currentStep, resetCursor: false };
  }
  if (input.currentStep >= MAX_EXPANSION_STEP) {
    return { nextStep: MAX_EXPANSION_STEP, resetCursor: false };
  }
  return { nextStep: input.currentStep + 1, resetCursor: true };
}
