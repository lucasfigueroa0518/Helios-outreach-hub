import { NextRequest, NextResponse } from 'next/server';
import {
  loadProspectDayLeads,
  loadProspectWorkspace,
} from '@/lib/auto-campaigns/repository';
import { getCampaign } from '@/lib/campaigns';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const campaign = await getCampaign(session.userId, id);
  if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  if (campaign.kind !== 'auto') {
    return NextResponse.json({ error: 'Not an Auto campaign' }, { status: 400 });
  }
  const sourcedOn = request.nextUrl.searchParams.get('day');
  const workspace = await loadProspectWorkspace(id, session.userId);
  const day = sourcedOn && workspace.days.includes(sourcedOn)
    ? sourcedOn
    : workspace.days[0] ?? null;
  const leads = day ? await loadProspectDayLeads(id, session.userId, day) : [];
  return NextResponse.json({
    campaign,
    ...workspace,
    selected_day: day,
    leads,
  });
}
