import { NextRequest } from 'next/server';

import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import {
  DraftingConflictError,
  DraftingNotFoundError,
  DraftingValidationError,
} from '@/lib/drafting/errors';
import { getDraftingRuntimeReadiness } from '@/lib/drafting/runtime-readiness';
import {
  acceptPreEnrichedIngest,
  getPreEnrichedLaunchProgress,
  PreEnrichedIngestError,
} from '@/lib/pre-enriched-ingest';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  const { id: campaignId } = await params;
  try {
    const progress = await getPreEnrichedLaunchProgress(campaignId, session.userId);
    return draftingJson({ progress });
  } catch (error) {
    return draftingErrorResponse(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  const { id: campaignId } = await params;
  let body: {
    senderProfileId?: string;
    sender_profile_id?: string;
    idempotencyKey?: string;
    idempotency_key?: string;
  } = {};

  try {
    body = await request.json();
  } catch {
    // Empty body is fine — defaults apply.
  }

  const readiness = await getDraftingRuntimeReadiness();
  if (!readiness.ready) {
    return draftingJson(
      {
        error: readiness.blockers[0] ?? 'Drafting runtime is not ready',
        blockers: readiness.blockers,
        readiness,
      },
      503,
    );
  }

  try {
    const result = await acceptPreEnrichedIngest(campaignId, session.userId, {
      senderProfileId: body.senderProfileId ?? body.sender_profile_id,
      idempotencyKey: body.idempotencyKey ?? body.idempotency_key,
    });
    return draftingJson(result, 202);
  } catch (error) {
    if (error instanceof PreEnrichedIngestError) {
      return draftingJson(
        {
          error: error.message,
          ...(error.code ? { code: error.code } : {}),
          ...(error.fieldErrors ? { field_errors: error.fieldErrors } : {}),
        },
        error.status,
      );
    }
    if (
      error instanceof DraftingValidationError
      || error instanceof DraftingConflictError
      || error instanceof DraftingNotFoundError
    ) {
      return draftingErrorResponse(error);
    }
    return draftingErrorResponse(error);
  }
}
