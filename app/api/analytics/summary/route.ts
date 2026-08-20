import { NextRequest, NextResponse } from 'next/server';

import { getAnalyticsSummary } from '@/lib/analytics';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { searchParams } = new URL(request.url);
    const campaignIdsRaw = searchParams.get('campaignIds');
    const tagsRaw = searchParams.get('tags');
    const userId = searchParams.get('userId');
    const identitySlug = searchParams.get('identitySlug');
    const fromEmail = searchParams.get('fromEmail');

    const campaignIds = campaignIdsRaw ? campaignIdsRaw.split(',').map((s) => s.trim()).filter(Boolean) : null;
    const tags = tagsRaw ? tagsRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;

    const summary = await getAnalyticsSummary({
      period: searchParams.get('period'),
      from: searchParams.get('from'),
      to: searchParams.get('to'),
      campaignIds,
      tags,
      userId,
      identitySlug,
      fromEmail,
    });
    return NextResponse.json(summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load analytics summary';
    const status = /custom range|Invalid from|from must/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
