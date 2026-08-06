import { NextResponse } from 'next/server';
import { listAllUsers } from '@/lib/campaigns';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const users = await listAllUsers();
    return NextResponse.json({ users });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to fetch users' },
      { status: 500 },
    );
  }
}
