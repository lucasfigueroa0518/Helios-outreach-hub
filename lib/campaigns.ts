import { type PoolClient } from 'pg';
import { dbQuery, dbTransaction } from '@/lib/db';

export type TagWithColor = {
  tag: string;
  color: string | null;
};

export type Campaign = {
  id: string;
  name: string;
  status: 'active' | 'archived';
  merged_into_id: string | null;
  needs_enrichment: boolean;
  created_at: string;
  updated_at: string;
  lead_count: number;
  last_run_at: string | null;
  tags: string[];
  tag_details: TagWithColor[];
};

const campaignSelect = `
  SELECT
    c.id, c.name, c.status, c.merged_into_id, c.needs_enrichment,
    c.created_at, c.updated_at,
    count(DISTINCT cl.lead_id)::int AS lead_count,
    max(r.started_at) AS last_run_at,
    COALESCE(
      (SELECT array_agg(ct.tag ORDER BY ct.tag)
       FROM outreach.campaign_tags ct
       WHERE ct.campaign_id = c.id),
      '{}'::text[]
    ) AS tags,
    COALESCE(
      (SELECT json_agg(json_build_object('tag', ct.tag, 'color', ct.color) ORDER BY ct.tag)
       FROM outreach.campaign_tags ct
       WHERE ct.campaign_id = c.id),
      '[]'::json
    ) AS tag_details
  FROM outreach.campaigns c
  LEFT JOIN outreach.campaign_leads cl ON cl.campaign_id = c.id
  LEFT JOIN outreach.runs r ON r.campaign_id = c.id
  WHERE c.owner_id = $1`;

export async function listCampaigns(ownerId: string): Promise<Campaign[]> {
  const { rows } = await dbQuery<Campaign>(
    `${campaignSelect} GROUP BY c.id ORDER BY (c.status = 'active') DESC, c.updated_at DESC`,
    [ownerId],
  );
  return rows;
}

export async function getCampaign(ownerId: string, campaignId: string): Promise<Campaign | null> {
  const { rows } = await dbQuery<Campaign>(
    `${campaignSelect} AND c.id = $2 GROUP BY c.id`,
    [ownerId, campaignId],
  );
  return rows[0] ?? null;
}

export async function createCampaign(
  ownerId: string,
  input?: { name?: string; needsEnrichment?: boolean },
): Promise<Campaign> {
  return dbTransaction(async (client) => {
    const count = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM outreach.campaigns WHERE owner_id = $1`,
      [ownerId],
    );
    const defaultName = `Campaign #${count.rows[0].count + 1}`;
    const name = input?.name?.trim() || defaultName;
    // UI default is Needs Enrichment? = No (already enriched). Callers must pass true for the classic path.
    const needsEnrichment = input?.needsEnrichment ?? false;
    const created = await client.query<Campaign>(
      `INSERT INTO outreach.campaigns (owner_id, name, needs_enrichment)
       VALUES ($1, $2, $3)
       RETURNING id, name, status, merged_into_id, needs_enrichment, created_at, updated_at,
         0::int AS lead_count, NULL::timestamptz AS last_run_at, '{}'::text[] AS tags, '[]'::json AS tag_details`,
      [ownerId, name, needsEnrichment],
    );
    return created.rows[0];
  });
}

export async function updateCampaign(
  ownerId: string,
  campaignId: string,
  values: { name?: string; status?: 'active' | 'archived' },
): Promise<Campaign | null> {
  const name = values.name?.trim();
  if (values.name !== undefined && !name) throw new Error('Campaign name cannot be empty');
  if (values.status && !['active', 'archived'].includes(values.status)) {
    throw new Error('Invalid campaign status');
  }

  const { rows } = await dbQuery<Campaign>(
    `UPDATE outreach.campaigns
     SET name = COALESCE($3, name),
         status = COALESCE($4, status),
         updated_at = now()
     WHERE id = $1 AND owner_id = $2
     RETURNING id, name, status, merged_into_id, needs_enrichment, created_at, updated_at,
       0::int AS lead_count, NULL::timestamptz AS last_run_at,
       COALESCE(
         (SELECT array_agg(ct.tag ORDER BY ct.tag)
          FROM outreach.campaign_tags ct
          WHERE ct.campaign_id = outreach.campaigns.id),
         '{}'::text[]
       ) AS tags,
       COALESCE(
         (SELECT json_agg(json_build_object('tag', ct.tag, 'color', ct.color) ORDER BY ct.tag)
          FROM outreach.campaign_tags ct
          WHERE ct.campaign_id = outreach.campaigns.id),
         '[]'::json
       ) AS tag_details`,
    [campaignId, ownerId, name ?? null, values.status ?? null],
  );
  return rows[0] ?? null;
}

function mergeDuplicateSourceLeads(client: PoolClient, sourceId: string, targetId: string) {
  return client.query(
    `WITH pairs AS (
       SELECT source.lead_id AS source_lead_id, target.lead_id AS target_lead_id
       FROM outreach.campaign_leads source
       JOIN outreach.leads sl ON sl.id = source.lead_id
       JOIN outreach.campaign_leads target ON target.campaign_id = $2
       JOIN outreach.leads tl ON tl.id = target.lead_id
       WHERE source.campaign_id = $1
         AND (
           (CASE WHEN similarity(lower(sl.full_name), lower(tl.full_name)) >= 0.55 THEN 1 ELSE 0 END) +
           (CASE WHEN COALESCE(sl.company_name, '') <> ''
                       AND similarity(lower(sl.company_name), lower(tl.company_name)) >= 0.55 THEN 1 ELSE 0 END) +
           (CASE WHEN COALESCE(sl.title, '') <> ''
                       AND similarity(lower(sl.title), lower(tl.title)) >= 0.55 THEN 1 ELSE 0 END) +
           (CASE WHEN ARRAY[lower(sl.email_primary), lower(sl.email_alt_1), lower(sl.email_alt_2)]
                       && ARRAY[lower(tl.email_primary), lower(tl.email_alt_1), lower(tl.email_alt_2)]
                 THEN 1 ELSE 0 END)
         ) >= 3
     )
     DELETE FROM outreach.campaign_leads cl
     USING pairs
     WHERE cl.campaign_id = $1 AND cl.lead_id = pairs.source_lead_id`,
    [sourceId, targetId],
  );
}

/** Stack source into target, then archive source. Target keeps its name. */
export async function mergeCampaigns(
  ownerId: string,
  targetId: string,
  sourceId: string,
): Promise<void> {
  if (targetId === sourceId) throw new Error('Choose a different campaign to merge');

  await dbTransaction(async (client) => {
    const campaigns = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM outreach.campaigns
       WHERE owner_id = $1 AND id = ANY($2::uuid[])
       FOR UPDATE`,
      [ownerId, [targetId, sourceId]],
    );
    if (campaigns.rows.length !== 2) throw new Error('Campaign not found');
    if (campaigns.rows.some((campaign) => campaign.status !== 'active')) {
      throw new Error('Only active campaigns can be merged');
    }

    await mergeDuplicateSourceLeads(client, sourceId, targetId);
    await client.query(
      `INSERT INTO outreach.campaign_leads (campaign_id, lead_id, run_id, relationship_snapshot)
       SELECT $2, lead_id, run_id, relationship_snapshot
       FROM outreach.campaign_leads
       WHERE campaign_id = $1
       ON CONFLICT (campaign_id, lead_id) DO NOTHING`,
      [sourceId, targetId],
    );
    await client.query(
      `UPDATE outreach.campaigns
       SET status = 'archived', merged_into_id = $2, updated_at = now()
       WHERE id = $1`,
      [sourceId, targetId],
    );
    await client.query(`UPDATE outreach.campaigns SET updated_at = now() WHERE id = $1`, [targetId]);
  });
}

export async function getAllTags(): Promise<TagWithColor[]> {
  const { rows } = await dbQuery<TagWithColor>(
    `SELECT DISTINCT ON (lower(tag)) tag, color FROM outreach.campaign_tags ORDER BY lower(tag) ASC, created_at DESC`,
  );
  return rows;
}

export async function getCampaignTags(campaignId: string): Promise<TagWithColor[]> {
  const { rows } = await dbQuery<TagWithColor>(
    `SELECT tag, color FROM outreach.campaign_tags WHERE campaign_id = $1 ORDER BY tag ASC`,
    [campaignId],
  );
  return rows;
}

export async function addCampaignTag(campaignId: string, tag: string, color?: string | null): Promise<TagWithColor[]> {
  const cleanTag = tag.trim().toLowerCase();
  if (!cleanTag) throw new Error('Tag cannot be empty');
  if (cleanTag.length > 50) throw new Error('Tag must be 50 characters or fewer');
  const cleanColor = color?.trim() || null;
  await dbQuery(
    `INSERT INTO outreach.campaign_tags (campaign_id, tag, color)
     VALUES ($1, $2, $3)
     ON CONFLICT (campaign_id, tag) DO UPDATE SET color = COALESCE(EXCLUDED.color, outreach.campaign_tags.color)`,
    [campaignId, cleanTag, cleanColor],
  );
  return getCampaignTags(campaignId);
}

export async function removeCampaignTag(campaignId: string, tag: string): Promise<TagWithColor[]> {
  const cleanTag = tag.trim().toLowerCase();
  await dbQuery(
    `DELETE FROM outreach.campaign_tags WHERE campaign_id = $1 AND lower(tag) = $2`,
    [campaignId, cleanTag],
  );
  return getCampaignTags(campaignId);
}

export type UserOption = {
  id: string;
  email: string;
  display_name: string;
};

export async function listAllUsers(): Promise<UserOption[]> {
  const { rows } = await dbQuery<UserOption>(
    `SELECT id, email, display_name FROM outreach.users ORDER BY display_name ASC, email ASC`,
  );
  return rows;
}
