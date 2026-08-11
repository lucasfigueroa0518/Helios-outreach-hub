import { NextRequest } from 'next/server';

import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import { resolveQueueOwnerId } from '@/lib/drafting/queue-owner';
import { retryFailedQueueItems } from '@/lib/drafting/send-queue';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  let body: { ids?: string[]; user_id?: string };
  try {
    body = await request.json();
  } catch {
    return draftingJson({ error: 'Invalid JSON body' }, 400);
  }

  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return draftingJson({ error: 'ids are required' }, 400);
  }

  try {
    const ownerId = await resolveQueueOwnerId(session.userId, body.user_id);
    const result = await retryFailedQueueItems({
      ownerId,
      ids: body.ids,
    });
    return draftingJson(result);
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
