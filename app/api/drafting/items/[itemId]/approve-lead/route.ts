import { NextRequest } from 'next/server';

import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import { approveDraftingLead } from '@/lib/drafting/repository';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ itemId: string }> };

export async function POST(request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  const { itemId } = await params;
  let body: {
    expected_revision?: number;
    expectedRevision?: number;
    idempotency_key?: string;
    idempotencyKey?: string;
  };

  try {
    body = await request.json();
  } catch {
    return draftingJson({ error: 'Invalid JSON body' }, 400);
  }

  const expectedRevision = body.expectedRevision ?? body.expected_revision;
  if (typeof expectedRevision !== 'number') {
    return draftingJson({ error: 'expected_revision is required' }, 400);
  }

  try {
    const result = await approveDraftingLead(itemId, session.userId, {
      expectedRevision,
      idempotencyKey: body.idempotencyKey ?? body.idempotency_key,
    });
    return draftingJson(result, 202);
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
