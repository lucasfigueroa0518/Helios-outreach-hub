import { NextRequest } from 'next/server';

import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import { resolveQueueOwnerId } from '@/lib/drafting/queue-owner';
import { listSendQueueShareTargets } from '@/lib/drafting/send-queue';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  try {
    const ownerId = await resolveQueueOwnerId(
      session.userId,
      request.nextUrl.searchParams.get('user_id'),
    );
    const users = await listSendQueueShareTargets(ownerId);
    return draftingJson({ users });
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
