import { NextResponse } from 'next/server';

import { verifyAgentMailWebhookAuth } from '@/lib/agentmail-webhook';
import { applyAgentMailWebhookEvent } from '@/lib/drafting/agentmail-engagement';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const secret = process.env.AGENTMAIL_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: 'AGENTMAIL_WEBHOOK_SECRET is not configured' },
      { status: 503 },
    );
  }

  const rawBody = await request.text();
  const provided = request.headers.get('x-agentmail-secret')
    ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!verifyAgentMailWebhookAuth({
    secret,
    rawBody,
    svixId: request.headers.get('svix-id'),
    svixTimestamp: request.headers.get('svix-timestamp'),
    svixSignature: request.headers.get('svix-signature'),
    providedSecret: provided,
  })) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const result = await applyAgentMailWebhookEvent(
      payload && typeof payload === 'object' ? payload as Record<string, unknown> : {},
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Webhook processing failed',
      },
      { status: 500 },
    );
  }
}
