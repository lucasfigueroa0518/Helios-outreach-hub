const PAT_RE = /(github_pat_|ghp_)[A-Za-z0-9_]+/g;

/** Redact PAT-like substrings before logging or surfacing errors. */
export function scrubSecrets(message: string): string {
  return message.replace(PAT_RE, '[REDACTED]');
}

export function scrubError(error: unknown): string {
  if (error instanceof Error) return scrubSecrets(error.message);
  return scrubSecrets(String(error));
}

export function captureException(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  console.error('[dashboards]', scrubError(error), context ?? {});
}
