import { NextRequest, NextResponse } from 'next/server';
import { getMetricDrilldown } from '@/lib/analytics-drilldown';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { searchParams } = new URL(request.url);
    const metricKey = searchParams.get('metricKey');
    if (!metricKey) {
      return NextResponse.json({ error: 'metricKey parameter is required' }, { status: 400 });
    }

    const campaignIdsRaw = searchParams.get('campaignIds');
    const tagsRaw = searchParams.get('tags');
    const userId = searchParams.get('userId');

    const campaignIds = campaignIdsRaw ? campaignIdsRaw.split(',').map((s) => s.trim()).filter(Boolean) : null;
    const tags = tagsRaw ? tagsRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;

    const data = await getMetricDrilldown({
      metricKey,
      period: searchParams.get('period'),
      from: searchParams.get('from'),
      to: searchParams.get('to'),
      campaignIds,
      tags,
      userId,
    });

    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load drill-down details';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
