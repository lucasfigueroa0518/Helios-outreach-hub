import { NextRequest } from 'next/server';

import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import { shareSendQueueWithUser } from '@/lib/drafting/send-queue';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  let body: { target_user_id?: string };
  try {
    body = await request.json();
  } catch {
    return draftingJson({ error: 'Invalid JSON body' }, 400);
  }

  if (typeof body.target_user_id !== 'string' || !body.target_user_id.trim()) {
    return draftingJson({ error: 'target_user_id is required' }, 400);
  }

  try {
    const result = await shareSendQueueWithUser({
      sharerId: session.userId,
      targetUserId: body.target_user_id.trim(),
    });
    return draftingJson(result);
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
