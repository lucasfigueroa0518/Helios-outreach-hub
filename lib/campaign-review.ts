import { dbQuery } from '@/lib/db';

export async function campaignHasDraftingWorkspace(campaignId: string) {
  const { rows } = await dbQuery<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM outreach.drafting_workspaces WHERE campaign_id = $1
     ) AS ok`,
    [campaignId],
  );
  return rows[0]?.ok ?? false;
}

export async function campaignHasReviewableData(campaignId: string) {
  const { rows } = await dbQuery<{ ok: boolean }>(
    `SELECT (
       EXISTS (SELECT 1 FROM outreach.campaign_leads WHERE campaign_id = $1)
       OR EXISTS (
         SELECT 1 FROM outreach.uploads u
         JOIN outreach.runs r ON r.id = u.run_id
         WHERE r.campaign_id = $1 AND u.status = 'extracted'
           AND coalesce((u.extraction_summary->>'people_found')::int, 0) > 0
       )
     ) AS ok`,
    [campaignId],
  );
  return rows[0]?.ok ?? false;
}
