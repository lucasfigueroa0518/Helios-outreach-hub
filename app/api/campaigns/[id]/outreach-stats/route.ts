import { NextResponse } from 'next/server';
import { loadOutreachSuccess } from '@/lib/auto-campaigns/repository';
import { getCampaign } from '@/lib/campaigns';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_: Request, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const campaign = await getCampaign(session.userId, id);
  if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  const stats = await loadOutreachSuccess(id);
  return NextResponse.json({
    ...stats,
    emails_per_day: campaign.emails_per_day ?? 0,
    next_cycle_at: campaign.next_cycle_at,
    auto_status: campaign.auto_status,
    auto_error: campaign.auto_error,
    expansion_step: campaign.expansion_step,
    success_rate: stats.pulled > 0 ? stats.sent / stats.pulled : 0,
  });
}
