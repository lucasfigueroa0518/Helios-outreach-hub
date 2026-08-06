import { NextRequest } from 'next/server';

import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import {
  approveDraft,
  requestDraftRewrite,
  saveDraft,
  sendApprovedDraft,
} from '@/lib/drafting/repository';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ draftId: string }> };

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  const { draftId } = await params;
  let body: {
    expected_content_revision?: number;
    expectedContentRevision?: number;
    expected_input_fingerprint?: string;
    expectedInputFingerprint?: string;
    subject?: string;
    body_text?: string;
    bodyText?: string;
  };

  try {
    body = await request.json();
  } catch {
    return draftingJson({ error: 'Invalid JSON body' }, 400);
  }

  const expectedContentRevision = body.expectedContentRevision ?? body.expected_content_revision;
  if (typeof expectedContentRevision !== 'number') {
    return draftingJson({ error: 'expected_content_revision is required' }, 400);
  }

  try {
    const result = await saveDraft(draftId, session.userId, {
      expectedContentRevision,
      expectedInputFingerprint: body.expectedInputFingerprint ?? body.expected_input_fingerprint,
      subject: body.subject,
      bodyText: body.bodyText ?? body.body_text,
    });
    return draftingJson(result);
  } catch (error) {
    return draftingErrorResponse(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  const { draftId } = await params;
  let body: {
    action?: 'approve' | 'rewrite' | 'send';
    expected_content_revision?: number;
    expectedContentRevision?: number;
    expected_input_fingerprint?: string;
    expectedInputFingerprint?: string;
    expected_packet_sha256?: string;
    expectedPacketSha256?: string;
    idempotency_key?: string;
    idempotencyKey?: string;
    feedback?: string;
  };

  try {
    body = await request.json();
  } catch {
    return draftingJson({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.action) {
    return draftingJson({ error: 'action is required (approve or rewrite)' }, 400);
  }

  const expectedContentRevision = body.expectedContentRevision ?? body.expected_content_revision;

  try {
    if (body.action === 'send') {
      const result = await sendApprovedDraft(draftId, session.userId);
      return draftingJson(result);
    }

    if (typeof expectedContentRevision !== 'number') {
      return draftingJson({ error: 'expected_content_revision is required' }, 400);
    }

    if (body.action === 'approve') {
      const fingerprint = body.expectedInputFingerprint ?? body.expected_input_fingerprint;
      if (!fingerprint) {
        return draftingJson({ error: 'expected_input_fingerprint is required' }, 400);
      }
      const result = await approveDraft(draftId, session.userId, {
        expectedContentRevision,
        expectedInputFingerprint: fingerprint,
        expectedPacketSha256: body.expectedPacketSha256 ?? body.expected_packet_sha256,
      });
      return draftingJson(result);
    }

    if (body.action === 'rewrite') {
      const result = await requestDraftRewrite(draftId, session.userId, {
        expectedContentRevision,
        idempotencyKey: body.idempotencyKey ?? body.idempotency_key,
        feedback: body.feedback,
      });
      return draftingJson(result, 202);
    }

    return draftingJson({ error: 'Unsupported action' }, 400);
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
