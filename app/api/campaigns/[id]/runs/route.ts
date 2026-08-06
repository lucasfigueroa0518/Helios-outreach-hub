import { NextRequest, NextResponse } from 'next/server';
import { queueEnrichmentRun } from '@/lib/runs';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id: campaignId } = await params;

  try {
    const result = await queueEnrichmentRun(campaignId, session.userId);
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not queue extraction';
    const status = message.includes('already in progress') ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
