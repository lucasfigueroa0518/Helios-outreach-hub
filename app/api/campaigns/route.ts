import { NextRequest, NextResponse } from 'next/server';
import { createCampaign, listCampaigns } from '@/lib/campaigns';
import { DraftingNotFoundError } from '@/lib/drafting/errors';
import { resolveQueueOwnerId } from '@/lib/drafting/queue-owner';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const ownerId = await resolveQueueOwnerId(
      session.userId,
      request.nextUrl.searchParams.get('user_id'),
    );
    return NextResponse.json({ campaigns: await listCampaigns(ownerId) });
  } catch (error) {
    if (error instanceof DraftingNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to load campaigns' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { name?: string; needs_enrichment?: boolean } = {};
  try {
    body = await request.json();
  } catch {
    // The default name is valid for an empty body.
  }

  try {
    const campaign = await createCampaign(session.userId, {
      name: body.name,
      needsEnrichment: typeof body.needs_enrichment === 'boolean' ? body.needs_enrichment : false,
    });
    return NextResponse.json({ campaign }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to create campaign' },
      { status: 400 },
    );
  }
}
