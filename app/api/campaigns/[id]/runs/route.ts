import { NextRequest, NextResponse } from 'next/server';
import {
  assertCampaignUnderCostCap,
  CampaignCostCapError,
} from '@/lib/campaign-cost-cap';
import { getCampaign } from '@/lib/campaigns';
import { queueEnrichmentRun } from '@/lib/runs';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id: campaignId } = await params;

  try {
    const campaign = await getCampaign(session.userId, campaignId);
    if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
    await assertCampaignUnderCostCap({
      campaignId,
      needsEnrichment: campaign.needs_enrichment,
    });
    const result = await queueEnrichmentRun(campaignId, session.userId);
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    if (error instanceof CampaignCostCapError) {
      return NextResponse.json(
        { error: error.message, code: error.code, cost_gate: error.gate },
        { status: 402 },
      );
    }
    const message = error instanceof Error ? error.message : 'Could not queue extraction';
    const status = message.includes('already in progress') ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
