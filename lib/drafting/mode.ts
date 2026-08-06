/** Drafting runtime mode — live provider calls require explicit DRAFTING_MODE=live. */

export function draftingMode(): 'stub' | 'live' {
  const mode = (process.env.DRAFTING_MODE ?? 'stub').trim().toLowerCase();
  return mode === 'live' ? 'live' : 'stub';
}

export function assertStubMode(context: string): void {
  if (draftingMode() === 'live') {
    throw new Error(`${context}: live drafting provider is not wired in this build`);
  }
}
