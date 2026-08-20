import { NextRequest, NextResponse } from 'next/server';
import { getCampaign, updateAutoCampaign, updateCampaign } from '@/lib/campaigns';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  try {
    const campaign = await getCampaign(session.userId, id);
    if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
    return NextResponse.json({ campaign });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to load campaign' },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  let body: {
    name?: string;
    status?: 'active' | 'archived';
    auto_status?: 'live' | 'paused';
    emails_per_day?: number;
    follow_up_enabled?: boolean;
    sender_identity_slug?: 'lucas' | 'tommy';
    lead_attributes?: {
      industry?: string;
      seniority?: string;
      geography?: string;
      business_size?: string;
    };
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const existing = await getCampaign(session.userId, id);
    if (!existing) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });

    if (
      existing.kind === 'auto'
      && (
        body.auto_status
        ||         body.emails_per_day != null
        || body.follow_up_enabled != null
        || body.sender_identity_slug
        || body.lead_attributes
      )
    ) {
      const campaign = await updateAutoCampaign(session.userId, id, {
        autoStatus: body.auto_status,
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
      if (campaign?.auto_status === 'live') {
        const { enqueueAutoCycleJob } = await import('@/lib/auto-campaigns/enqueue');
        await enqueueAutoCycleJob(
          campaign.id,
          session.userId,
          campaign.next_cycle_at ? new Date(campaign.next_cycle_at) : new Date(),
        ).catch(() => undefined);
      }
      if (body.name || body.status) {
        await updateCampaign(session.userId, id, { name: body.name, status: body.status });
      }
      return NextResponse.json({ campaign: await getCampaign(session.userId, id) });
    }

    const campaign = await updateCampaign(session.userId, id, body);
    if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
    return NextResponse.json({ campaign });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to update campaign' },
      { status: 400 },
    );
  }
}
