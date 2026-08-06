import { NextRequest } from 'next/server';

import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import { pauseDraftingWorkspace } from '@/lib/drafting/repository';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

/** Pause drafting — cancel in-flight jobs, preserve item positions. */
export async function POST(_request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  const { id: campaignId } = await params;
  try {
    const result = await pauseDraftingWorkspace(campaignId, session.userId);
    return draftingJson(result);
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
