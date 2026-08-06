export type DraftingCostStage = 'research' | 'adversarial' | 'write' | 'repair' | 'rewrite';

export type DraftingCostEvent = {
  eventKey: string;
  costUsd: string;
};

export type PersistedDraftingProviderResult = {
  providerRequestId: string;
  usage: {
    costUsd: string;
  } & Record<string, unknown>;
};

export type DraftingCostEventPersistenceInput = {
  jobId: string;
  stage: DraftingCostStage;
  providerRequestId: string;
  costUsd: string;
  usage: Record<string, unknown>;
};

function normalizeProviderRequestIds(ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id?.trim())).map((id) => id.trim()))]
    .sort();
}

/**
 * Provider result identity is the idempotency boundary for spend. Replaying a
 * persisted result produces the same key; a genuinely new provider response
 * produces a new key even when the drafting job row was revived.
 */
export function draftingCostEventKey(input: {
  stage: DraftingCostStage;
  providerRequestIds: Array<string | null | undefined>;
}): string {
  const ids = normalizeProviderRequestIds(input.providerRequestIds);
  if (ids.length === 0) {
    throw new Error(`Cannot persist ${input.stage} spend without provider request identity`);
  }
  return `${input.stage}:${ids.join('|')}`;
}

/**
 * The provider-return boundary: a successful billable result is durable before
 * linting, repair scheduling, or any other later stage is allowed to throw.
 */
export async function runProviderCallWithCostPersistence<T extends PersistedDraftingProviderResult>(
  input: {
    stage: DraftingCostStage;
    call: () => Promise<T>;
    persist: (event: Omit<DraftingCostEventPersistenceInput, 'jobId'>) => Promise<void>;
  },
): Promise<T> {
  const result = await input.call();
  await input.persist({
    stage: input.stage,
    providerRequestId: result.providerRequestId,
    costUsd: result.usage.costUsd,
    usage: result.usage,
  });
  return result;
}

/** Pure mirror of the database's append-once event accounting. */
export function sumUniqueDraftingCostEvents(events: DraftingCostEvent[]): string {
  const seen = new Set<string>();
  let totalTenThousandths = 0;
  for (const event of events) {
    if (seen.has(event.eventKey)) continue;
    seen.add(event.eventKey);
    totalTenThousandths += Math.round(Number(event.costUsd) * 10_000);
  }
  return (totalTenThousandths / 10_000).toFixed(4);
}
