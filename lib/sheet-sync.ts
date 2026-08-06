import { dbQuery } from '@/lib/db';
import type { ExtractedPerson } from '@/lib/extraction';
import { resolveExtractedPerson } from '@/lib/identity';

async function needsSheetSync(campaignId: string) {
  const { rows } = await dbQuery<{ needs: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM outreach.runs r
       JOIN outreach.uploads u ON u.run_id = r.id
       WHERE r.campaign_id = $1
         AND r.status <> 'cancelled'
         AND u.status = 'extracted'
         AND coalesce((u.extraction_summary->>'people_found')::int, 0) > 0
         AND NOT coalesce((r.stats->>'people_resolved')::boolean, false)
     ) AS needs`,
    [campaignId],
  );
  return rows[0]?.needs ?? false;
}

async function markRunsPeopleResolved(runIds: Iterable<string>) {
  const ids = [...new Set(runIds)];
  if (!ids.length) return;
  await dbQuery(
    `UPDATE outreach.runs
     SET stats = stats || jsonb_build_object('people_resolved', true)
     WHERE id = ANY($1::uuid[])`,
    [ids],
  );
}

async function resolvePeopleWithConcurrency(
  people: Array<{ person: ExtractedPerson; runId: string }>,
  campaignId: string,
) {
  const concurrency = Math.max(1, Number(process.env.ORG_IDENTITY_RESOLVE_CONCURRENCY ?? 4));
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, people.length) }, async () => {
    while (index < people.length) {
      const current = people[index++];
      await resolveExtractedPerson(current.person, current.runId, campaignId);
    }
  }));
}

export async function syncCampaignSheet(campaignId: string) {
  if (!(await needsSheetSync(campaignId))) return { synced: false, leads: 0 };

  const { rows: uploads } = await dbQuery<{
    run_id: string;
    extraction_summary: { result?: { people?: ExtractedPerson[] } };
  }>(
    `SELECT u.run_id, u.extraction_summary
     FROM outreach.uploads u
     JOIN outreach.runs r ON r.id = u.run_id
     WHERE r.campaign_id = $1
       AND r.status <> 'cancelled'
       AND u.status = 'extracted'
       AND NOT coalesce((r.stats->>'people_resolved')::boolean, false)
     ORDER BY u.created_at`,
    [campaignId],
  );

  const people: Array<{ person: ExtractedPerson; runId: string }> = [];
  const runIds = new Set<string>();
  for (const upload of uploads) {
    runIds.add(upload.run_id);
    for (const person of upload.extraction_summary?.result?.people ?? []) {
      people.push({ person, runId: upload.run_id });
    }
  }

  await resolvePeopleWithConcurrency(people, campaignId);
  await markRunsPeopleResolved(runIds);

  const { rows } = await dbQuery<{ count: number }>(
    `SELECT count(*)::int AS count FROM outreach.campaign_leads WHERE campaign_id = $1`,
    [campaignId],
  );
  return { synced: true, leads: rows[0]?.count ?? 0 };
}
