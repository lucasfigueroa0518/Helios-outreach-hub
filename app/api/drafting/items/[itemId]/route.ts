import { NextRequest } from 'next/server';

import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import {
  removeDraftingItem,
  updateDraftingItemInput,
} from '@/lib/drafting/repository';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ itemId: string }> };

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  const { itemId } = await params;
  let body: {
    expected_revision?: number;
    expectedRevision?: number;
    fields?: Record<string, unknown>;
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
  if (!body.fields || typeof body.fields !== 'object') {
    return draftingJson({ error: 'fields object is required' }, 400);
  }

  try {
    const result = await updateDraftingItemInput(itemId, session.userId, {
      expectedRevision,
      fields: body.fields,
    });
    return draftingJson(result);
  } catch (error) {
    return draftingErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  const { itemId } = await params;
  let body: {
    expected_revision?: number;
    expectedRevision?: number;
    confirm?: boolean;
  } = {};

  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return draftingJson({ error: 'Invalid JSON body' }, 400);
  }

  const expectedRevision = body.expectedRevision ?? body.expected_revision;
  if (typeof expectedRevision !== 'number') {
    return draftingJson({ error: 'expected_revision is required' }, 400);
  }

  try {
    const result = await removeDraftingItem(itemId, session.userId, {
      expectedRevision,
      confirm: body.confirm ?? true,
    });
    return draftingJson(result);
  } catch (error) {
    return draftingErrorResponse(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  const { itemId } = await params;
  let body: {
    action?: string;
    expected_revision?: number;
    expectedRevision?: number;
    confirm?: boolean;
  };

  try {
    body = await request.json();
  } catch {
    return draftingJson({ error: 'Invalid JSON body' }, 400);
  }

  if (body.action !== 'remove') {
    return draftingJson({ error: 'Unsupported action' }, 400);
  }

  const expectedRevision = body.expectedRevision ?? body.expected_revision;
  if (typeof expectedRevision !== 'number') {
    return draftingJson({ error: 'expected_revision is required' }, 400);
  }

  try {
    const result = await removeDraftingItem(itemId, session.userId, {
      expectedRevision,
      confirm: body.confirm ?? true,
    });
    return draftingJson(result);
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
