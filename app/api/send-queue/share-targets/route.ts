import { NextRequest } from 'next/server';

import type { SenderIdentitySlug } from '@/lib/agentmail-inboxes';
import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import { listSendQueueShareTargets } from '@/lib/drafting/send-queue';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  try {
    const identity = request.nextUrl.searchParams.get('identity');
    const fromSlug: SenderIdentitySlug = identity === 'tommy' ? 'tommy' : 'lucas';
    const users = await listSendQueueShareTargets(fromSlug);
    return draftingJson({
      users: users.map((row) => ({
        id: row.slug,
        email: row.slug,
        display_name: row.display_name,
        backlog_count: row.backlog_count,
        day_occupancy: row.day_occupancy,
      })),
    });
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
