import { NextResponse } from 'next/server';
import { dbQuery } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET() {
  try {
    await dbQuery('SELECT 1');
    return NextResponse.json({ ok: true, error: null });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
