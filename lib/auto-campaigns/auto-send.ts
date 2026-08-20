import { dbQuery } from '@/lib/db';
import { sendCampaignApprovedDrafts } from '@/lib/drafting/repository';
import { DraftingValidationError } from '@/lib/drafting/errors';

export async function enqueueReadyAutoCampaignDrafts(
  campaignId: string,
  ownerId: string,
): Promise<{ queued: number } | null> {
  const campaign = await dbQuery<{ kind: string }>(
    `SELECT kind FROM outreach.campaigns WHERE id = $1 AND owner_id = $2`,
    [campaignId, ownerId],
  );
  if (campaign.rows[0]?.kind !== 'auto') return null;
  try {
    const result = await sendCampaignApprovedDrafts(campaignId, ownerId);
    return { queued: result.queued + result.sent };
  } catch (error) {
    if (error instanceof DraftingValidationError) return { queued: 0 };
    return { queued: 0 };
  }
}

export async function enqueueReadyAutoDraftsForAllOwners(): Promise<number> {
  const { rows } = await dbQuery<{ id: string; owner_id: string }>(
    `SELECT c.id, c.owner_id
       FROM outreach.campaigns c
      WHERE c.kind = 'auto' AND c.status = 'active' AND c.auto_status IN ('live', 'paused', 'error')`,
  );
  let total = 0;
  for (const row of rows) {
    const result = await enqueueReadyAutoCampaignDrafts(row.id, row.owner_id);
    total += result?.queued ?? 0;
  }
  return total;
}
