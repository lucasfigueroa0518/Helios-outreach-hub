import { NextRequest, NextResponse } from 'next/server';

import { excludeAnalyticsRuns } from '@/lib/analytics';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json() as { runIds?: unknown; reason?: unknown };
    const runIds = Array.isArray(body.runIds)
      ? body.runIds.filter((id): id is string => typeof id === 'string')
      : [];
    const reason = typeof body.reason === 'string' ? body.reason : null;
    const result = await excludeAnalyticsRuns({
      runIds,
      userId: session.userId,
      reason,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to exclude runs';
    const status = /reason/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
