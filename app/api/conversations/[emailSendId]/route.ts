import { NextRequest } from 'next/server';

import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import { getConversationThread } from '@/lib/drafting/conversations';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ emailSendId: string }> };

export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  const { emailSendId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(emailSendId)) {
    return draftingJson({ error: 'Invalid email send id' }, 400);
  }

  try {
    const thread = await getConversationThread({
      ownerId: session.userId,
      emailSendId,
    });
    if (!thread) return draftingJson({ error: 'Conversation not found' }, 404);
    return draftingJson({ thread });
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
