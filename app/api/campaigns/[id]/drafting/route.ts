import { NextRequest } from 'next/server';

import {
  assertCampaignUnderCostCap,
  CampaignCostCapError,
} from '@/lib/campaign-cost-cap';
import { getCampaign } from '@/lib/campaigns';
import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import { getWorkspaceSnapshot, startDraftingWorkspace } from '@/lib/drafting/repository';
import { getDraftingRuntimeReadiness } from '@/lib/drafting/runtime-readiness';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  const { id: campaignId } = await params;
  const search = request.nextUrl.searchParams;
  if (search.get('readiness') === '1') {
    return draftingJson(await getDraftingRuntimeReadiness());
  }
  const itemId = search.get('item_id') ?? undefined;
  const filter = search.get('filter') as
    | 'to_review'
    | 'approved'
    | 'all_generated'
    | 'needs_attention'
    | null;
  const limitRaw = search.get('limit');
  const offsetRaw = search.get('offset');
  const limit = limitRaw == null ? undefined : Number(limitRaw);
  const offset = offsetRaw == null ? undefined : Number(offsetRaw);

  try {
    const snapshot = await getWorkspaceSnapshot(campaignId, session.userId, {
      itemId,
      filter: filter ?? undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
    });
    return draftingJson(snapshot);
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
    budgetCapUsd?: string;
    budget_cap_usd?: string;
    idempotencyKey?: string;
    idempotency_key?: string;
  } = {};

  try {
    body = await request.json();
  } catch {
    return draftingJson({ error: 'Invalid JSON body' }, 400);
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
    const campaign = await getCampaign(session.userId, campaignId);
    if (!campaign) return draftingJson({ error: 'Campaign not found' }, 404);
    await assertCampaignUnderCostCap({
      campaignId,
      needsEnrichment: campaign.needs_enrichment,
    });
    const result = await startDraftingWorkspace(campaignId, session.userId, {
      senderProfileId: body.senderProfileId ?? body.sender_profile_id,
      budgetCapUsd: body.budgetCapUsd ?? body.budget_cap_usd,
      idempotencyKey: body.idempotencyKey ?? body.idempotency_key,
    });
    return draftingJson(result, 202);
  } catch (error) {
    if (error instanceof CampaignCostCapError) {
      return draftingJson(
        { error: error.message, code: error.code, cost_gate: error.gate },
        402,
      );
    }
    return draftingErrorResponse(error);
  }
}
