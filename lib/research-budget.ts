import type { ResearchPerson } from '@/lib/research-types';
import { peopleNeedHardProfileResearch } from '@/lib/enrichment-fields';

export const MAX_EMAIL_TARGETS_PER_JOB = 5;

export function countEmailTargets(people: readonly ResearchPerson[]) {
  return people.filter((person) =>
    !person.email || ['inferred', 'format_guess'].includes(person.email_status ?? '')).length;
}

/**
 * Five searches cover at most 2.5 people. Since people are discrete, one or
 * two targets receive five searches and three through five receive ten.
 */
export function emailResearchBudget(targetCount: number) {
  if (targetCount <= 0) return 0;
  return targetCount <= 2 ? 5 : 10;
}

export function searchBudgetForJob(
  people: readonly ResearchPerson[],
  pass: 'primary' | 'profile_rescue' | 'email_rescue' = 'primary',
) {
  // Thin hard-field rescue only — location never gets a dedicated rescue budget.
  if (pass === 'profile_rescue') return 1;
  const emailBudget = emailResearchBudget(countEmailTargets(people));
  const needsHardProfile = peopleNeedHardProfileResearch(people);
  return Math.max(emailBudget, needsHardProfile ? 5 : 0);
}

export function shardPeopleForEmailResearch<T extends ResearchPerson>(people: readonly T[]) {
  const shards: T[][] = [];
  for (let index = 0; index < people.length; index += MAX_EMAIL_TARGETS_PER_JOB) {
    shards.push(people.slice(index, index + MAX_EMAIL_TARGETS_PER_JOB));
  }
  return shards;
}
