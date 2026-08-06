export const EMPTY_RESEARCH_BRIEF_ERROR_CODE = 'empty_research_brief';
export const EMPTY_BRIEF_MAX_AUTOMATIC_EXECUTIONS = 2;
export const EMPTY_BRIEF_RETRY_DELAY_MS = 5_000;
export const EMPTY_BRIEF_TERMINAL_MESSAGE =
  'Research found no usable personalization after 2 attempts. Review lead inputs, then retry.';

export type EmptyBriefRetrySurface = 'automatic' | 'manual';

export type EmptyBriefPolicyState = {
  attempts: number;
  inputFingerprint: string | null;
  lastErrorCode?: string | null;
};

export type EmptyBriefExecutionDecision = {
  allowed: boolean;
  executionNumber: number;
  forceFreshResearch: boolean;
};

export type EmptyBriefCompletionDecision = {
  attempts: number;
  inputFingerprint: string;
  action: 'retry' | 'quarantine';
  retryExecutionNumber: 2 | null;
};

function normalizedAttempts(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function attemptsForFingerprint(
  state: EmptyBriefPolicyState,
  inputFingerprint: string,
): number {
  return state.inputFingerprint === inputFingerprint
    ? normalizedAttempts(state.attempts)
    : 0;
}

export function decideEmptyBriefExecution(
  state: EmptyBriefPolicyState,
  inputFingerprint: string,
  surface: EmptyBriefRetrySurface,
): EmptyBriefExecutionDecision {
  const priorAttempts = attemptsForFingerprint(state, inputFingerprint);
  return {
    allowed: surface === 'manual'
      || priorAttempts < EMPTY_BRIEF_MAX_AUTOMATIC_EXECUTIONS,
    executionNumber: priorAttempts + 1,
    forceFreshResearch: priorAttempts > 0,
  };
}

export function recordEmptyBriefCompletion(
  state: EmptyBriefPolicyState,
  inputFingerprint: string,
  surface: EmptyBriefRetrySurface,
  completedExecutionNumber?: number,
): EmptyBriefCompletionDecision {
  const priorAttempts = attemptsForFingerprint(state, inputFingerprint);
  const attempts = completedExecutionNumber === undefined
    ? priorAttempts + 1
    : Math.max(priorAttempts, completedExecutionNumber);
  const shouldRetry = surface === 'automatic'
    && attempts < EMPTY_BRIEF_MAX_AUTOMATIC_EXECUTIONS;
  return {
    attempts,
    inputFingerprint,
    action: shouldRetry ? 'retry' : 'quarantine',
    retryExecutionNumber: shouldRetry ? 2 : null,
  };
}

export function isEmptyBriefQuarantined(
  state: EmptyBriefPolicyState,
  inputFingerprint: string,
): boolean {
  return state.lastErrorCode === EMPTY_RESEARCH_BRIEF_ERROR_CODE
    && state.inputFingerprint === inputFingerprint
    && normalizedAttempts(state.attempts) >= EMPTY_BRIEF_MAX_AUTOMATIC_EXECUTIONS;
}
