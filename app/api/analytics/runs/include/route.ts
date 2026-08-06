import { NextRequest, NextResponse } from 'next/server';

import { includeAnalyticsRuns } from '@/lib/analytics';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json() as { runIds?: unknown };
    const runIds = Array.isArray(body.runIds)
      ? body.runIds.filter((id): id is string => typeof id === 'string')
      : [];
    const result = await includeAnalyticsRuns({ runIds });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to include runs' },
      { status: 500 },
    );
  }
}
