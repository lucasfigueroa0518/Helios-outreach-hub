import { NextRequest } from 'next/server';

import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import { cancelDraftingRun } from '@/lib/drafting/repository';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

/** Hard reset: discard paused drafting workspace (pre–Go to Drafting state). */
export async function POST(_request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  const { id: campaignId } = await params;
  try {
    const result = await cancelDraftingRun(campaignId, session.userId);
    return draftingJson(result);
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
