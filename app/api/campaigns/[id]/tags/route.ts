import { NextRequest, NextResponse } from 'next/server';
import { addCampaignTag, getCampaignTags, removeCampaignTag } from '@/lib/campaigns';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  try {
    const tags = await getCampaignTags(id);
    return NextResponse.json({ tags });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to fetch campaign tags' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  let body: { tag?: string; color?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.tag || typeof body.tag !== 'string') {
    return NextResponse.json({ error: 'Tag parameter is required' }, { status: 400 });
  }

  try {
    const tags = await addCampaignTag(id, body.tag, body.color);
    return NextResponse.json({ tags }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to add tag' },
      { status: 400 },
    );
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  let tagToDelete = searchParams.get('tag');

  if (!tagToDelete) {
    try {
      const body = await request.json();
      if (typeof body.tag === 'string') tagToDelete = body.tag;
    } catch {
      // Ignored if query param wasn't provided either
    }
  }

  if (!tagToDelete) {
    return NextResponse.json({ error: 'Tag parameter is required' }, { status: 400 });
  }

  try {
    const tags = await removeCampaignTag(id, tagToDelete);
    return NextResponse.json({ tags });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to remove tag' },
      { status: 400 },
    );
  }
}
