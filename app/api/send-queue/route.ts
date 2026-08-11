import { NextRequest } from 'next/server';

import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import { resolveQueueOwnerId } from '@/lib/drafting/queue-owner';
import {
  cancelSendQueueItems,
  formatNyDate,
  listSendQueue,
  moveSendQueueItems,
} from '@/lib/drafting/send-queue';
import { addCalendarDays } from '@/lib/drafting/send-queue-schedule';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  const url = request.nextUrl;
  const today = formatNyDate();
  const from = url.searchParams.get('from') ?? today;
  const to = url.searchParams.get('to') ?? addCalendarDays(today, 14);
  const campaignId = url.searchParams.get('campaign_id');

  try {
    const ownerId = await resolveQueueOwnerId(session.userId, url.searchParams.get('user_id'));
    const result = await listSendQueue({
      ownerId,
      from,
      to,
      campaignId,
    });
    return draftingJson({
      ...result,
      owner_id: ownerId,
      viewing_other: ownerId !== session.userId,
    });
  } catch (error) {
    return draftingErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  let body: { ids?: string[]; target_date?: string; user_id?: string };
  try {
    body = await request.json();
  } catch {
    return draftingJson({ error: 'Invalid JSON body' }, 400);
  }

  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return draftingJson({ error: 'ids are required' }, 400);
  }
  if (typeof body.target_date !== 'string') {
    return draftingJson({ error: 'target_date is required' }, 400);
  }

  try {
    const ownerId = await resolveQueueOwnerId(session.userId, body.user_id);
    const result = await moveSendQueueItems({
      ownerId,
      ids: body.ids,
      targetDate: body.target_date,
    });
    return draftingJson(result);
  } catch (error) {
    return draftingErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
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
    const result = await cancelSendQueueItems({
      ownerId,
      ids: body.ids,
    });
    return draftingJson(result);
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
