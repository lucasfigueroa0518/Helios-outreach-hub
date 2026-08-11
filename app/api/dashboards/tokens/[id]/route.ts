import { NextResponse } from 'next/server';

import { deleteGithubToken } from '@/lib/dashboards/repository';
import { requireSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'Missing token id' }, { status: 400 });
  }

  const deleted = await deleteGithubToken(id);
  if (!deleted) {
    return NextResponse.json({ error: 'Token not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
