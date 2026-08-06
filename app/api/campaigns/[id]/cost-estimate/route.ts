import { NextRequest, NextResponse } from 'next/server';

import { getCampaignCostEstimate } from '@/lib/cost-ledger';
import { dbQuery } from '@/lib/db';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

async function campaignLeadCount(campaignId: string, ownerId: string): Promise<number> {
  const { rows: owned } = await dbQuery<{ id: string }>(
    `SELECT id FROM outreach.campaigns WHERE id = $1 AND owner_id = $2`,
    [campaignId, ownerId],
  );
  if (!owned[0]) throw new Error('Campaign not found');

  const { rows: fromUploads } = await dbQuery<{ lead_count: string }>(
    `SELECT coalesce(sum(coalesce((u.extraction_summary->>'people_found')::int, 0)), 0)::text AS lead_count
     FROM outreach.uploads u
     JOIN outreach.runs r ON r.id = u.run_id
     WHERE r.campaign_id = $1`,
    [campaignId],
  );
  const uploadCount = Number(fromUploads[0]?.lead_count ?? 0);
  if (uploadCount > 0) return uploadCount;

  const { rows: fromCampaign } = await dbQuery<{ lead_count: string }>(
    `SELECT count(*)::text AS lead_count
     FROM outreach.campaign_leads
     WHERE campaign_id = $1`,
    [campaignId],
  );
  return Number(fromCampaign[0]?.lead_count ?? 0);
}

export async function GET(_: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  try {
    const leadCount = await campaignLeadCount(id, session.userId);
    const estimate = await getCampaignCostEstimate({
      campaignId: id,
      fallbackLeadCount: leadCount,
    });
    return NextResponse.json(estimate);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to estimate campaign cost' },
      { status: 400 },
    );
  }
}
