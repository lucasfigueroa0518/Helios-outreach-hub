import { formatNyDate } from '@/lib/drafting/send-queue-schedule';
import { enqueueWork } from '@/lib/orchestration/repository';

export async function enqueueAutoCycleJob(
  campaignId: string,
  ownerId: string,
  availableAt: Date = new Date(),
): Promise<string> {
  const day = formatNyDate(availableAt);
  return enqueueWork({
    kind: 'auto.cycle',
    payload: { campaignId, ownerId },
    dedupeKey: `auto.cycle:${campaignId}:${day}`,
    scopeKey: `auto:${campaignId}`,
    availableAt,
    maxAttempts: 2,
    priority: 15,
    reviveTerminal: true,
  });
}
