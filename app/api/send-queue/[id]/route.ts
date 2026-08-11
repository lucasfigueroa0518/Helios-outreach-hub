import { NextRequest } from 'next/server';

import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import { resolveQueueOwnerId } from '@/lib/drafting/queue-owner';
import { getSendQueueDetail } from '@/lib/drafting/send-queue';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  const { id } = await params;

  try {
    const ownerId = await resolveQueueOwnerId(
      session.userId,
      request.nextUrl.searchParams.get('user_id'),
    );
    const result = await getSendQueueDetail(ownerId, id);
    return draftingJson(result);
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
