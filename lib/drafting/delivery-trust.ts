/**
 * Resolve mailbox verification for drafting eligibility.
 * Upload / Embark-DB / inferred emails all require AgentMail (or rate-limit
 * fail-open) before they count as draftable. Do not invent "valid".
 */
export function resolveDeliveryVerificationStatus(
  verification: string | null | undefined,
  _emailStatus: string | null | undefined,
): string {
  const status = verification ?? null;
  if (!status || status === 'missing') {
    return 'pending';
  }
  return status;
}
