import { type PoolClient } from 'pg';
import { dbQuery, dbTransaction } from '@/lib/db';
import { GENERATED_STATES, RUNNING_STATES } from '@/lib/drafting/eligibility';
import type {
  AutoStatus,
  CampaignKind,
  LeadAttributes,
} from '@/lib/auto-campaigns/types';
import {
  listUsedQueueColors,
  ownerHasReadySender,
  parseLeadAttributes,
  pickQueueColor,
} from '@/lib/auto-campaigns/repository';
import { nextAutoCycleAt, shouldRunFirstCycleNow } from '@/lib/auto-campaigns/schedule';
import {
  campaignSenderIdentity,
  parseSenderIdentitySlug,
  type SenderIdentitySlug,
} from '@/lib/agentmail-inboxes';

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
  kind: CampaignKind;
  auto_status: AutoStatus | null;
  auto_error: string | null;
  emails_per_day: number | null;
  follow_up_enabled: boolean;
  sender_identity_slug: SenderIdentitySlug | null;
  lead_attributes: LeadAttributes;
  expansion_step: number;
  queue_color: string | null;
  next_cycle_at: string | null;
  last_cycle_at: string | null;
  sent_count: number;
  created_at: string;
  updated_at: string;
  lead_count: number;
  last_run_at: string | null;
  tags: string[];
  tag_details: TagWithColor[];
  drafting_active: boolean;
  drafting_generated: number;
  drafting_total: number;
};

export function sqlLiteralTextArray(values: readonly string[]): string {
  return `ARRAY[${values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', ')}]::text[]`;
}

export function mapCampaignDraftingActivity(activity: unknown): {
  drafting_active: boolean;
  drafting_generated: number;
  drafting_total: number;
} {
  let payload: unknown = activity;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload) as unknown;
    } catch {
      payload = null;
    }
  }
  const row = payload && typeof payload === 'object' ? payload as {
    active?: unknown;
    generated?: unknown;
    total?: unknown;
  } : null;
  return {
    drafting_active: row?.active === true,
    drafting_generated: Number(row?.generated ?? 0) || 0,
    drafting_total: Number(row?.total ?? 0) || 0,
  };
}

const campaignDraftingActivitySelect = `
    COALESCE((
      SELECT json_build_object(
        'active', COALESCE(bool_or(di.state = ANY(${sqlLiteralTextArray(RUNNING_STATES)})), false),
        'generated', count(*) FILTER (WHERE di.state = ANY(${sqlLiteralTextArray(GENERATED_STATES)}))::int,
        'total', count(*)::int
      )
      FROM outreach.drafting_workspaces dw
      JOIN outreach.drafting_items di ON di.workspace_id = dw.id
      WHERE dw.campaign_id = c.id
        AND dw.status = 'active'
        AND di.removed_at IS NULL
        AND di.state <> 'removed'
    ), '{"active":false,"generated":0,"total":0}'::json) AS drafting_activity`;

type CampaignQueryRow = Omit<
  Campaign,
  'drafting_active' | 'drafting_generated' | 'drafting_total' | 'lead_attributes'
> & {
  drafting_activity?: unknown;
  lead_attributes?: unknown;
};

function mapCampaignRow(row: CampaignQueryRow): Campaign {
  const { drafting_activity, lead_attributes, ...campaign } = row;
  return {
    ...campaign,
    kind: campaign.kind === 'auto' ? 'auto' : 'manual',
    auto_status: campaign.auto_status ?? null,
    auto_error: campaign.auto_error ?? null,
    emails_per_day: campaign.emails_per_day ?? null,
    follow_up_enabled: Boolean(campaign.follow_up_enabled),
    sender_identity_slug: campaign.kind === 'auto'
      ? campaignSenderIdentity(campaign.sender_identity_slug)
      : parseSenderIdentitySlug(campaign.sender_identity_slug),
    expansion_step: Number(campaign.expansion_step ?? 0) || 0,
    queue_color: campaign.queue_color ?? null,
    next_cycle_at: campaign.next_cycle_at ?? null,
    last_cycle_at: campaign.last_cycle_at ?? null,
    sent_count: Number(campaign.sent_count ?? 0) || 0,
    lead_attributes: parseLeadAttributes(lead_attributes),
    ...mapCampaignDraftingActivity(drafting_activity),
  };
}

const campaignSelect = `
  SELECT
    c.id, c.name, c.status, c.merged_into_id, c.needs_enrichment,
    COALESCE(c.kind, 'manual') AS kind,
    c.auto_status, c.auto_error, c.emails_per_day, c.follow_up_enabled,
    c.sender_identity_slug,
    c.lead_attributes, COALESCE(c.expansion_step, 0) AS expansion_step,
    c.queue_color, c.next_cycle_at, c.last_cycle_at,
    c.created_at, c.updated_at,
    count(DISTINCT cl.lead_id)::int AS lead_count,
    (
      SELECT count(*)::int FROM outreach.email_send_queue q
       WHERE q.campaign_id = c.id AND q.status = 'sent'
    ) AS sent_count,
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
    ) AS tag_details,
    ${campaignDraftingActivitySelect}
  FROM outreach.campaigns c
  LEFT JOIN outreach.campaign_leads cl ON cl.campaign_id = c.id
  LEFT JOIN outreach.runs r ON r.campaign_id = c.id
  WHERE c.owner_id = $1
     OR (COALESCE(c.kind, 'manual') = 'auto' AND c.status = 'active')`;

export async function listCampaigns(ownerId: string): Promise<Campaign[]> {
  const { rows } = await dbQuery<CampaignQueryRow>(
    `${campaignSelect}
     GROUP BY c.id
     ORDER BY
       (c.status = 'active' AND COALESCE(c.kind, 'manual') = 'auto' AND c.auto_status = 'live') DESC,
       (c.status = 'active') DESC,
       c.updated_at DESC`,
    [ownerId],
  );
  return rows.map(mapCampaignRow);
}

export async function getCampaign(ownerId: string, campaignId: string): Promise<Campaign | null> {
  const { rows } = await dbQuery<CampaignQueryRow>(
    `${campaignSelect} AND c.id = $2 GROUP BY c.id`,
    [ownerId, campaignId],
  );
  return rows[0] ? mapCampaignRow(rows[0]) : null;
}

export type CreateCampaignInput = {
  name?: string;
  needsEnrichment?: boolean;
  kind?: CampaignKind;
  emailsPerDay?: number;
  followUpEnabled?: boolean;
  senderIdentitySlug?: SenderIdentitySlug;
  leadAttributes?: LeadAttributes;
};

function normalizeLeadAttributes(input?: LeadAttributes): LeadAttributes {
  return {
    industry: input?.industry?.trim() ?? '',
    seniority: input?.seniority?.trim() ?? '',
    geography: input?.geography?.trim() ?? '',
    business_size: input?.business_size?.trim() ?? '',
  };
}

function assertAutoCreateInput(input: CreateCampaignInput): {
  attrs: LeadAttributes;
  senderIdentity: SenderIdentitySlug;
} {
  const attrs = normalizeLeadAttributes(input.leadAttributes);
  if (!attrs.industry || !attrs.seniority || !attrs.geography || !attrs.business_size) {
    throw new Error('Auto campaigns need industry, seniority, geography, and business size');
  }
  const perDay = Math.floor(Number(input.emailsPerDay));
  if (!Number.isFinite(perDay) || perDay < 1 || perDay > 200) {
    throw new Error('Emails per day must be between 1 and 200');
  }
  const senderIdentity = input.senderIdentitySlug
    ? parseSenderIdentitySlug(input.senderIdentitySlug)
    : campaignSenderIdentity(null);
  if (!senderIdentity) {
    throw new Error('Sender must be Lucas or Tommy');
  }
  return { attrs, senderIdentity };
}

export async function createCampaign(
  ownerId: string,
  input?: CreateCampaignInput,
): Promise<Campaign> {
  return dbTransaction(async (client) => {
    const count = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM outreach.campaigns WHERE owner_id = $1`,
      [ownerId],
    );
    const defaultName = `Campaign #${count.rows[0].count + 1}`;
    const name = input?.name?.trim() || defaultName;
    const kind: CampaignKind = input?.kind === 'auto' ? 'auto' : 'manual';
    const needsEnrichment = kind === 'auto' ? false : (input?.needsEnrichment ?? false);
    const autoCreate = kind === 'auto' ? assertAutoCreateInput(input ?? {}) : null;
    const attrs = autoCreate ? autoCreate.attrs : normalizeLeadAttributes();
    const senderIdentity = autoCreate?.senderIdentity ?? null;
    const emailsPerDay = kind === 'auto' ? Math.floor(Number(input?.emailsPerDay)) : null;
    const followUp = kind === 'auto' ? Boolean(input?.followUpEnabled) : false;
    const usedColors = await listUsedQueueColors(ownerId);
    const queueColor = kind === 'auto' ? pickQueueColor(usedColors) : null;
    const senderReady = kind === 'auto'
      ? await ownerHasReadySender(ownerId, senderIdentity)
      : false;
    const autoStatus = kind === 'auto' ? (senderReady ? 'live' : 'pending_sender') : null;
    const firstNow = kind === 'auto' && senderReady && shouldRunFirstCycleNow();
    const nextCycle = kind === 'auto' && autoStatus === 'live'
      ? (firstNow ? new Date() : nextAutoCycleAt(crypto.randomUUID()))
      : null;

    const created = await client.query<{ id: string }>(
      `INSERT INTO outreach.campaigns (
         owner_id, name, needs_enrichment, kind, auto_status, emails_per_day,
         follow_up_enabled, sender_identity_slug, lead_attributes, expansion_step, queue_color, next_cycle_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,0,$10,$11)
       RETURNING id`,
      [
        ownerId,
        name,
        needsEnrichment,
        kind,
        autoStatus,
        emailsPerDay,
        followUp,
        senderIdentity,
        JSON.stringify(attrs),
        queueColor,
        nextCycle?.toISOString() ?? null,
      ],
    );
    const id = created.rows[0]!.id;
    if (kind === 'auto' && autoStatus === 'live' && !firstNow) {
      await client.query(
        `UPDATE outreach.campaigns SET next_cycle_at = $2 WHERE id = $1`,
        [id, nextAutoCycleAt(id).toISOString()],
      );
    }
    return id;
  }).then((id) => getCampaign(ownerId, id).then((campaign) => {
    if (!campaign) throw new Error('Campaign not found after create');
    return campaign;
  }));
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

  const { rowCount } = await dbQuery(
    `UPDATE outreach.campaigns
        SET name = COALESCE($3, name),
            status = COALESCE($4, status),
            auto_status = CASE
              WHEN $4 = 'archived' AND kind = 'auto' THEN 'paused'
              ELSE auto_status
            END,
            next_cycle_at = CASE
              WHEN $4 = 'archived' THEN NULL
              ELSE next_cycle_at
            END,
            updated_at = now()
      WHERE id = $1
        AND (owner_id = $2 OR COALESCE(kind, 'manual') = 'auto')`,
    [campaignId, ownerId, name ?? null, values.status ?? null],
  );
  if (!rowCount) return null;
  return getCampaign(ownerId, campaignId);
}

export async function updateAutoCampaign(
  ownerId: string,
  campaignId: string,
  values: {
    autoStatus?: AutoStatus;
    emailsPerDay?: number;
    followUpEnabled?: boolean;
    senderIdentitySlug?: SenderIdentitySlug;
    leadAttributes?: LeadAttributes;
  },
): Promise<Campaign | null> {
  const existing = await getCampaign(ownerId, campaignId);
  if (!existing) return null;
  if (existing.kind !== 'auto') throw new Error('Not an Auto campaign');

  if (values.leadAttributes || values.emailsPerDay != null || values.senderIdentitySlug) {
    if (existing.auto_status === 'live') {
      throw new Error('Pause the campaign before changing targeting, sender, or emails per day');
    }
  }

  let emailsPerDay = existing.emails_per_day;
  if (values.emailsPerDay != null) {
    const perDay = Math.floor(Number(values.emailsPerDay));
    if (!Number.isFinite(perDay) || perDay < 1 || perDay > 200) {
      throw new Error('Emails per day must be between 1 and 200');
    }
    emailsPerDay = perDay;
  }

  const attrs = values.leadAttributes
    ? assertAutoCreateInput({
      kind: 'auto',
      emailsPerDay: emailsPerDay ?? 1,
      senderIdentitySlug: values.senderIdentitySlug
        ?? existing.sender_identity_slug
        ?? undefined,
      leadAttributes: values.leadAttributes,
    }).attrs
    : existing.lead_attributes;

  let senderIdentity = existing.sender_identity_slug ?? campaignSenderIdentity(null);
  if (values.senderIdentitySlug) {
    const parsed = parseSenderIdentitySlug(values.senderIdentitySlug);
    if (!parsed) throw new Error('Sender must be Lucas or Tommy');
    senderIdentity = parsed;
  }

  const filtersChanged = Boolean(values.leadAttributes);
  let autoStatus = values.autoStatus ?? existing.auto_status;
  if (autoStatus === 'live') {
    const ready = await ownerHasReadySender(ownerId, senderIdentity);
    if (!ready) autoStatus = 'pending_sender';
  }
  if (existing.status === 'archived') throw new Error('Archived campaigns cannot go live');

  const nextCycle = autoStatus === 'live'
    ? (shouldRunFirstCycleNow() ? new Date() : nextAutoCycleAt(campaignId))
    : null;

  await dbQuery(
    `UPDATE outreach.campaigns
        SET emails_per_day = $3,
            follow_up_enabled = COALESCE($4, follow_up_enabled),
            sender_identity_slug = $5,
            lead_attributes = $6::jsonb,
            auto_status = $7,
            auto_error = CASE WHEN $7 = 'live' THEN NULL ELSE auto_error END,
            apollo_search_page = CASE WHEN $8 THEN 1 ELSE apollo_search_page END,
            apollo_search_params = CASE WHEN $8 THEN NULL ELSE apollo_search_params END,
            expansion_step = CASE WHEN $8 THEN 0 ELSE expansion_step END,
            thin_days = CASE WHEN $8 THEN 0 ELSE thin_days END,
            next_cycle_at = $9,
            updated_at = now()
      WHERE id = $1
        AND (owner_id = $2 OR COALESCE(kind, 'manual') = 'auto')`,
    [
      campaignId,
      ownerId,
      emailsPerDay,
      values.followUpEnabled ?? null,
      senderIdentity,
      JSON.stringify(attrs),
      autoStatus,
      filtersChanged,
      nextCycle?.toISOString() ?? null,
    ],
  );
  return getCampaign(ownerId, campaignId);
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
    const campaigns = await client.query<{ id: string; status: string; kind: string }>(
      `SELECT id, status, kind FROM outreach.campaigns
       WHERE owner_id = $1 AND id = ANY($2::uuid[])
       FOR UPDATE`,
      [ownerId, [targetId, sourceId]],
    );
    if (campaigns.rows.length !== 2) throw new Error('Campaign not found');
    if (campaigns.rows.some((campaign) => campaign.status !== 'active')) {
      throw new Error('Only active campaigns can be merged');
    }
    if (campaigns.rows.some((campaign) => campaign.kind === 'auto')) {
      throw new Error('Auto campaigns cannot be merged');
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
