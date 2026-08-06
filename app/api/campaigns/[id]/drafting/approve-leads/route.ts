import { NextRequest } from 'next/server';

import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import { approveDraftingLeadsBulk } from '@/lib/drafting/repository';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Bulk-approve every eligible idle lead (or a provided item id list) into
 * verify/research. Same eligibility as single Approve for drafting.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  const { id: campaignId } = await params;
  let body: {
    item_ids?: string[];
    itemIds?: string[];
    idempotency_key?: string;
    idempotencyKey?: string;
  } = {};

  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const itemIds = body.itemIds ?? body.item_ids;
  try {
    const result = await approveDraftingLeadsBulk(campaignId, session.userId, {
      itemIds: Array.isArray(itemIds) ? itemIds.filter((id) => typeof id === 'string') : undefined,
      idempotencyKey: body.idempotencyKey ?? body.idempotency_key,
    });
    return draftingJson(result, 202);
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
