import { NextRequest, NextResponse } from 'next/server';
import {
  createUploadIntent,
  listCampaignUploads,
  markUploadComplete,
  removeUpload,
} from '@/lib/uploads';
import { getCampaignCostEstimate } from '@/lib/cost-ledger';
import { dbQuery } from '@/lib/db';
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

export async function GET(_: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  try {
    const runState = await getCampaignRunState(id, session.userId, true);
    const uploads = await listCampaignUploads(id, session.userId);
    const review_enabled = await campaignHasReviewableData(id);
    const fromUploads = leadCountFromUploads(uploads);
    const leadCount = fromUploads > 0 ? fromUploads : await campaignLeadCount(id);
    const cost_estimate = await getCampaignCostEstimate({
      campaignId: id,
      fallbackLeadCount: leadCount,
    });
    return NextResponse.json({
      uploads,
      ...runState,
      review_enabled,
      research_concurrency: Math.max(1, Number(process.env.ORG_RESEARCH_CONCURRENCY ?? 2)),
      cost_estimate,
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

  let body: { file_name?: string; mime_type?: string; byte_size?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.file_name || !body.mime_type || body.byte_size === undefined) {
    return NextResponse.json({ error: 'file_name, mime_type, and byte_size are required' }, { status: 400 });
  }

  try {
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
  await params;

  let body: { upload_id?: string; success?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.upload_id || typeof body.success !== 'boolean') {
    return NextResponse.json({ error: 'upload_id and success are required' }, { status: 400 });
  }

  try {
    return NextResponse.json({ upload: await markUploadComplete(body.upload_id, session.userId, body.success) });
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
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to remove upload' },
      { status: 400 },
    );
  }
}
