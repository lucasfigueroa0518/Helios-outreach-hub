import { NextResponse } from 'next/server';

import { listAnalyticsRuns } from '@/lib/analytics';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const runs = await listAnalyticsRuns();
    return NextResponse.json({ runs });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to list analytics runs' },
      { status: 500 },
    );
  }
}
