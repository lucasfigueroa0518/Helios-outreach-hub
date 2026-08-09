import { NextRequest } from 'next/server';

import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import {
  listConversations,
  type ConversationFilter,
} from '@/lib/drafting/conversations';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

const FILTERS = new Set<ConversationFilter>(['all', 'awaiting', 'sent', 'failed']);

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  const url = request.nextUrl;
  const campaignId = url.searchParams.get('campaign_id');
  const filterRaw = (url.searchParams.get('filter') ?? 'all') as ConversationFilter;
  const filter = FILTERS.has(filterRaw) ? filterRaw : 'all';

  try {
    const result = await listConversations({
      ownerId: session.userId,
      campaignId,
      filter,
    });
    return draftingJson(result);
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
