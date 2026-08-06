import { NextRequest } from 'next/server';

import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import { rescueDraftingWorkspace } from '@/lib/drafting/rescue';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * User-initiated drafting rescue — reclaim stale leases, unstick orphaned
 * researching/writing rows, and requeue eligible work after sleep / worker death.
 */
export async function POST(_request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  const { id: campaignId } = await params;
  try {
    const result = await rescueDraftingWorkspace(campaignId, session.userId);
    return draftingJson(result);
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
