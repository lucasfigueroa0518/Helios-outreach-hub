import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

/** Resend is no longer the outreach provider. Use /api/webhooks/agentmail. */
export async function POST() {
  return NextResponse.json(
    { ok: false, error: 'Resend webhooks are retired. Use /api/webhooks/agentmail.' },
    { status: 410 },
  );
}
