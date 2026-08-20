import { NextRequest } from 'next/server';

import type { SenderIdentitySlug } from '@/lib/agentmail-inboxes';
import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import { shareSendQueueWithUser } from '@/lib/drafting/send-queue';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  let body: {
    target_user_id?: string;
    target_identity?: string;
    from_identity?: string;
    ids?: string[];
  };
  try {
    body = await request.json();
  } catch {
    return draftingJson({ error: 'Invalid JSON body' }, 400);
  }

  const target = (body.target_identity ?? body.target_user_id ?? '').trim();
  if (target !== 'lucas' && target !== 'tommy') {
    return draftingJson({ error: 'target_identity must be lucas or tommy' }, 400);
  }

  try {
    const result = await shareSendQueueWithUser({
      sharerId: session.userId,
      fromIdentity: body.from_identity === 'tommy' ? 'tommy' : 'lucas',
      targetIdentity: target as SenderIdentitySlug,
      ids: body.ids,
    });
    return draftingJson(result);
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
