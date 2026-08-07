import { NextRequest, NextResponse } from 'next/server';
import {
  createUploadIntent,
  createUploadIntents,
  listCampaignUploads,
  markUploadComplete,
  markUploadsComplete,
  removeUpload,
  seedLeadCountsForStagedUploads,
  UPLOAD_INTENT_BATCH_LIMIT,
} from '@/lib/uploads';
import {
  buildCampaignCostGate,
  costCapBlockMessage,
  type CampaignCostGate,
} from '@/lib/campaign-cost-cap';
import { dbQuery } from '@/lib/db';
import { getCampaign } from '@/lib/campaigns';
import { getCampaignRunState } from '@/lib/runs';
import { campaignHasReviewableData } from '@/lib/campaign-review';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

function leadCountFromUploads(uploads: Array<{ extraction_summary: { people_found?: number } | null }>) {
  return uploads.reduce(
    (sum, upload) => sum + Math.max(0, Number(upload.extraction_summary?.people_found ?? 0)),
    0,
  );
}

async function campaignLeadCount(campaignId: string) {
  const { rows } = await dbQuery<{ count: string }>(
    `SELECT count(*)::text AS count FROM outreach.campaign_leads WHERE campaign_id = $1`,
    [campaignId],
  );
  return Number(rows[0]?.count ?? 0);
}

async function stagingCostSnapshot(campaignId: string, ownerId: string): Promise<{
  uploads: Awaited<ReturnType<typeof listCampaignUploads>>;
  cost_gate: CampaignCostGate;
  cost_estimate: CampaignCostGate['estimate'];
}> {
  const uploads = await listCampaignUploads(campaignId, ownerId);
  const fromUploads = leadCountFromUploads(uploads);
  const leadCount = fromUploads > 0 ? fromUploads : await campaignLeadCount(campaignId);
  const campaign = await getCampaign(ownerId, campaignId);
  const cost_gate = await buildCampaignCostGate({
    campaignId,
    needsEnrichment: campaign?.needs_enrichment ?? true,
    fallbackLeadCount: leadCount,
  });
  return {
    uploads,
    cost_gate,
    cost_estimate: cost_gate.estimate,
  };
}

/** Count leads on newly staged files, then return uploads + cost gate together. */
async function finalizeStagingCost(input: {
  campaignId: string;
  ownerId: string;
  uploadIds?: string[];
  maxFiles?: number;
}) {
  await seedLeadCountsForStagedUploads(input);
  return stagingCostSnapshot(input.campaignId, input.ownerId);
}

export async function GET(_: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  try {
    const runState = await getCampaignRunState(id, session.userId, true);
    let uploads = await listCampaignUploads(id, session.userId);
    // Backfill any staged files that never got a staging-time count.
    const needsPeopleCount = uploads.some(
      (u) =>
        (u.status === 'uploaded' || u.status === 'extracted')
        && u.extraction_summary?.people_counted !== true,
    );
    if (needsPeopleCount) {
      await seedLeadCountsForStagedUploads({
        campaignId: id,
        ownerId: session.userId,
        maxFiles: 20,
      });
      uploads = await listCampaignUploads(id, session.userId);
    }
    const review_enabled = await campaignHasReviewableData(id);
    const cost = await stagingCostSnapshot(id, session.userId);
    return NextResponse.json({
      uploads: cost.uploads,
      ...runState,
      review_enabled,
      research_concurrency: Math.max(1, Number(process.env.ORG_RESEARCH_CONCURRENCY ?? 2)),
      cost_estimate: cost.cost_estimate,
      cost_gate: cost.cost_gate,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to load uploads' },
      { status: 400 },
    );
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  let body: {
    file_name?: string;
    mime_type?: string;
    byte_size?: number;
    files?: Array<{ file_name?: string; mime_type?: string; byte_size?: number }>;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const campaign = await getCampaign(session.userId, id);
    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
    }
    const cost = await stagingCostSnapshot(id, session.userId);
    if (cost.cost_gate.at_or_over_cap) {
      return NextResponse.json(
        {
          error: costCapBlockMessage(cost.cost_gate) || 'Campaign is at the $50 cost cap — remove leads before uploading more files.',
          code: 'campaign_cost_cap',
          cost_gate: cost.cost_gate,
        },
        { status: 402 },
      );
    }

    if (Array.isArray(body.files)) {
      if (!body.files.length) {
        return NextResponse.json({ error: 'files must not be empty' }, { status: 400 });
      }
      if (body.files.length > UPLOAD_INTENT_BATCH_LIMIT) {
        return NextResponse.json(
          { error: `At most ${UPLOAD_INTENT_BATCH_LIMIT} files per batch` },
          { status: 400 },
        );
      }
      for (const file of body.files) {
        if (!file.file_name || !file.mime_type || file.byte_size === undefined) {
          return NextResponse.json(
            { error: 'Each file requires file_name, mime_type, and byte_size' },
            { status: 400 },
          );
        }
      }
      const intents = await createUploadIntents(
        id,
        session.userId,
        body.files.map((file) => ({
          fileName: file.file_name!,
          mimeType: file.mime_type!,
          byteSize: file.byte_size!,
        })),
      );
      return NextResponse.json({ intents }, { status: 201 });
    }

    if (!body.file_name || !body.mime_type || body.byte_size === undefined) {
      return NextResponse.json({ error: 'file_name, mime_type, and byte_size are required' }, { status: 400 });
    }

    const intent = await createUploadIntent(id, session.userId, {
      fileName: body.file_name,
      mimeType: body.mime_type,
      byteSize: body.byte_size,
    });
    return NextResponse.json(intent, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to prepare upload' },
      { status: 400 },
    );
  }
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  let body: {
    upload_id?: string;
    success?: boolean;
    completions?: Array<{ upload_id?: string; success?: boolean }>;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    if (Array.isArray(body.completions)) {
      if (!body.completions.length) {
        return NextResponse.json({ error: 'completions must not be empty' }, { status: 400 });
      }
      for (const item of body.completions) {
        if (!item.upload_id || typeof item.success !== 'boolean') {
          return NextResponse.json(
            { error: 'Each completion requires upload_id and success' },
            { status: 400 },
          );
        }
      }
      await markUploadsComplete(
        session.userId,
        body.completions.map((item) => ({
          uploadId: item.upload_id!,
          success: item.success!,
        })),
      );
      const successIds = body.completions
        .filter((item) => item.success)
        .map((item) => item.upload_id!)
        .filter(Boolean);
      const cost = await finalizeStagingCost({
        campaignId: id,
        ownerId: session.userId,
        uploadIds: successIds.length ? successIds : undefined,
        maxFiles: Math.min(Math.max(successIds.length, 1), 50),
      });
      return NextResponse.json(cost);
    }

    if (!body.upload_id || typeof body.success !== 'boolean') {
      return NextResponse.json({ error: 'upload_id and success are required' }, { status: 400 });
    }

    await markUploadComplete(body.upload_id, session.userId, body.success);
    const cost = body.success
      ? await finalizeStagingCost({
          campaignId: id,
          ownerId: session.userId,
          uploadIds: [body.upload_id],
          maxFiles: 1,
        })
      : await stagingCostSnapshot(id, session.userId);
    const refreshed = cost.uploads.find((row) => row.id === body.upload_id);
    return NextResponse.json({
      upload: refreshed,
      ...cost,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to update upload' },
      { status: 400 },
    );
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const uploadId = request.nextUrl.searchParams.get('upload_id');
  if (!uploadId) return NextResponse.json({ error: 'upload_id is required' }, { status: 400 });

  try {
    await removeUpload(uploadId, id, session.userId);
    const cost = await stagingCostSnapshot(id, session.userId);
    return NextResponse.json({ ok: true, ...cost });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to remove upload' },
      { status: 400 },
    );
  }
}
