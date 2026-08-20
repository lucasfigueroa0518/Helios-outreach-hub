import { NextRequest } from 'next/server';

import type { SenderIdentitySlug } from '@/lib/agentmail-inboxes';
import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import {
  cancelSendQueueItems,
  formatNyDate,
  listSendQueue,
  moveSendQueueItems,
} from '@/lib/drafting/send-queue';
import { sendQueueBoardWindow } from '@/lib/drafting/send-queue-schedule';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  const url = request.nextUrl;
  const today = formatNyDate();
  const boardWindow = sendQueueBoardWindow(today);
  const from = url.searchParams.get('from') ?? boardWindow.from;
  const to = url.searchParams.get('to') ?? boardWindow.to;
  const campaignId = url.searchParams.get('campaign_id');
  const identitySlug = url.searchParams.get('identity') as SenderIdentitySlug | null;
  const inboxEmail = url.searchParams.get('inbox');

  try {
    const result = await listSendQueue({
      ownerId: session.userId,
      from,
      to,
      campaignId,
      identitySlug: identitySlug === 'lucas' || identitySlug === 'tommy' ? identitySlug : null,
      inboxEmail,
    });
    return draftingJson({
      ...result,
      owner_id: session.userId,
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
    const result = await moveSendQueueItems({
      ownerId: session.userId,
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
    const result = await cancelSendQueueItems({
      ownerId: session.userId,
      ids: body.ids,
    });
    return draftingJson(result);
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
