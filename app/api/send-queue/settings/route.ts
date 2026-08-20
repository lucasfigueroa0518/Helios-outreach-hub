import { NextRequest } from 'next/server';

import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import { getDailyInboxCap, setDailyInboxCap } from '@/lib/drafting/sender-identities';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET() {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);
  try {
    const cap = await getDailyInboxCap();
    return draftingJson({ daily_inbox_cap: cap });
  } catch (error) {
    return draftingErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);
  let body: { daily_inbox_cap?: number };
  try {
    body = await request.json();
  } catch {
    return draftingJson({ error: 'Invalid JSON body' }, 400);
  }
  try {
    const cap = await setDailyInboxCap(Number(body.daily_inbox_cap));
    return draftingJson({ daily_inbox_cap: cap });
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
