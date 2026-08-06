import { NextRequest } from 'next/server';

import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import { sendCampaignApprovedDrafts } from '@/lib/drafting/repository';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  const { id: campaignId } = await params;

  try {
    const result = await sendCampaignApprovedDrafts(campaignId, session.userId);
    return draftingJson(result);
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
