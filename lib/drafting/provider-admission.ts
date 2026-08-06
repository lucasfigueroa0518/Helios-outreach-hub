/**
 * Provider admission control — caps lane concurrency and cold-start ramp so
 * Go to Drafting cannot spike Anthropic with N parallel research pipelines.
 *
 * Lane env vars are ceilings; effective limits are derived from
 * DRAFTING_ANTHROPIC_MAX_INFLIGHT and peak calls per pipeline stage.
 */

/** Research Sonnet call + adversarial pass (sequential, but overlap across jobs). */
export const PEAK_ANTHROPIC_CALLS_PER_RESEARCH_PIPELINE = 2;

/** Initial write call (repair/rewrite add more, but admission stays conservative). */
export const PEAK_ANTHROPIC_CALLS_PER_WRITE_PIPELINE = 1;

function positiveInt(name: string, fallback: number, maximum = 100): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(parsed)));
}

export function resolveAnthropicMaxInflight(): number {
  return positiveInt('DRAFTING_ANTHROPIC_MAX_INFLIGHT', 24, 32);
}

export function draftingResearchConcurrencyCeiling(): number {
  return positiveInt('ORG_DRAFT_RESEARCH_CONCURRENCY', 8, 24);
}

export function draftingWriteConcurrencyCeiling(): number {
  return positiveInt('ORG_DRAFT_WRITE_CONCURRENCY', 8, 24);
}

/** Milliseconds between successive pipeline starts within one reconcile/go-to-drafting batch. */
export function campaignRampIntervalMs(): number {
  return positiveInt('DRAFTING_CAMPAIGN_RAMP_MS', 3_000, 60_000);
}

/** Stagger index 0 = immediate; 1 = one interval later, etc. */
export function campaignRampDelayMs(startIndex: number): number {
  if (startIndex <= 0) return 0;
  return startIndex * campaignRampIntervalMs();
}

export function scheduledProviderStartAt(startIndex: number, now = new Date()): Date {
  return new Date(now.getTime() + campaignRampDelayMs(startIndex));
}

/** Effective research lane slots — never exceed provider budget / peak calls. */
export function effectiveDraftingResearchLaneLimit(): number {
  const ceiling = draftingResearchConcurrencyCeiling();
  const byBudget = Math.floor(
    resolveAnthropicMaxInflight() / PEAK_ANTHROPIC_CALLS_PER_RESEARCH_PIPELINE,
  );
  return Math.max(1, Math.min(ceiling, byBudget));
}

/**
 * Write lane gets the remainder of the provider budget after reserving research
 * headroom so research+write waves cannot double-punch the API.
 */
export function effectiveDraftingWriteLaneLimit(): number {
  const ceiling = draftingWriteConcurrencyCeiling();
  const budget = resolveAnthropicMaxInflight();
  const researchReserve = effectiveDraftingResearchLaneLimit()
    * PEAK_ANTHROPIC_CALLS_PER_RESEARCH_PIPELINE;
  const writeBudget = Math.max(PEAK_ANTHROPIC_CALLS_PER_WRITE_PIPELINE, budget - researchReserve);
  const byBudget = Math.floor(writeBudget / PEAK_ANTHROPIC_CALLS_PER_WRITE_PIPELINE);
  return Math.max(1, Math.min(ceiling, byBudget));
}

/** Cap worker process slots so we do not claim far more jobs than provider budget. */
export function effectiveWorkerMaxConcurrency(): number {
  const configured = positiveInt('ORCHESTRATION_WORKER_MAX_CONCURRENCY', 16, 24);
  const derived = effectiveDraftingResearchLaneLimit()
    + effectiveDraftingWriteLaneLimit()
    + 2; // mailbox verify + maintenance headroom
  return Math.max(2, Math.min(configured, derived));
}

export function isProviderPressureError(message: string): boolean {
  return /\b429\b/.test(message)
    || /\b529\b/.test(message)
    || /rate.?limit/i.test(message)
    || /overloaded/i.test(message);
}
