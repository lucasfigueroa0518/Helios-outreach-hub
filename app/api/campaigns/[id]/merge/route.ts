import { NextRequest, NextResponse } from 'next/server';
import { mergeCampaigns } from '@/lib/campaigns';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { source_campaign_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.source_campaign_id) {
    return NextResponse.json({ error: 'source_campaign_id is required' }, { status: 400 });
  }

  const { id: targetId } = await params;
  try {
    await mergeCampaigns(session.userId, targetId, body.source_campaign_id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to merge campaigns' },
      { status: 400 },
    );
  }
}
