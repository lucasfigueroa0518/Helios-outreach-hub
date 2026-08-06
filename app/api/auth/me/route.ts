import { NextResponse } from 'next/server';
import { dbQuery } from '@/lib/db';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { rows } = await dbQuery<{ id: string; email: string; display_name: string }>(
      `SELECT id, email, display_name FROM outreach.users WHERE id = $1`,
      [session.userId],
    );
    if (!rows[0]) {
      return NextResponse.json({ error: 'User not found' }, { status: 401 });
    }
    return NextResponse.json({ user: rows[0] });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load user';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
