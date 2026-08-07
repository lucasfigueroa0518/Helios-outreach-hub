/**
 * Drafting runtime mode.
 * - Explicit `DRAFTING_MODE=live|stub` always wins.
 * - Unset in production (NODE_ENV/VERCEL_ENV) defaults to **live**.
 * - Unset elsewhere defaults to **stub** so local/agent work stays offline.
 */

export function defaultDraftingMode(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  vercelEnv: string | undefined = process.env.VERCEL_ENV,
): 'stub' | 'live' {
  return nodeEnv === 'production' || vercelEnv === 'production' ? 'live' : 'stub';
}

export function draftingMode(): 'stub' | 'live' {
  const raw = process.env.DRAFTING_MODE?.trim().toLowerCase();
  if (raw === 'live' || raw === 'stub') return raw;
  return defaultDraftingMode();
}

export function assertStubMode(context: string): void {
  if (draftingMode() === 'live') {
    throw new Error(`${context}: live drafting provider is not wired in this build`);
  }
}
