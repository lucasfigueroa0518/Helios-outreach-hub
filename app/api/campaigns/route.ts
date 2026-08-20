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

  let body: {
    name?: string;
    needs_enrichment?: boolean;
    kind?: 'manual' | 'auto';
    emails_per_day?: number;
    follow_up_enabled?: boolean;
    sender_identity_slug?: 'lucas' | 'tommy';
    lead_attributes?: {
      industry?: string;
      seniority?: string;
      geography?: string;
      business_size?: string;
    };
  } = {};
  try {
    body = await request.json();
  } catch {
    // The default name is valid for an empty body.
  }

  try {
    const campaign = await createCampaign(session.userId, {
      name: body.name,
      needsEnrichment: typeof body.needs_enrichment === 'boolean' ? body.needs_enrichment : false,
      kind: body.kind === 'auto' ? 'auto' : 'manual',
      emailsPerDay: body.emails_per_day,
      followUpEnabled: body.follow_up_enabled,
      senderIdentitySlug: body.sender_identity_slug,
      leadAttributes: body.lead_attributes
        ? {
          industry: body.lead_attributes.industry ?? '',
          seniority: body.lead_attributes.seniority ?? '',
          geography: body.lead_attributes.geography ?? '',
          business_size: body.lead_attributes.business_size ?? '',
        }
        : undefined,
    });
    if (campaign.kind === 'auto' && campaign.auto_status === 'live') {
      const { enqueueAutoCycleJob } = await import('@/lib/auto-campaigns/enqueue');
      await enqueueAutoCycleJob(
        campaign.id,
        session.userId,
        campaign.next_cycle_at ? new Date(campaign.next_cycle_at) : new Date(),
      ).catch(() => undefined);
    }
    return NextResponse.json({ campaign }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to create campaign' },
      { status: 400 },
    );
  }
}
