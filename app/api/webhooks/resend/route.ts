import { NextResponse } from 'next/server';
import { Resend } from 'resend';

import {
  applyResendWebhookEvent,
  type ResendWebhookPayload,
} from '@/lib/drafting/resend-engagement';

export const runtime = 'nodejs';

function headerValue(headers: Headers, name: string): string | null {
  return headers.get(name) ?? headers.get(name.toLowerCase());
}

export async function POST(request: Request) {
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) {
    return NextResponse.json(
      { ok: false, error: 'RESEND_WEBHOOK_SECRET is not configured' },
      { status: 503 },
    );
  }

  const payload = await request.text();
  const svixId = headerValue(request.headers, 'svix-id');
  const svixTimestamp = headerValue(request.headers, 'svix-timestamp');
  const svixSignature = headerValue(request.headers, 'svix-signature');

  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ ok: false, error: 'Missing Svix signature headers' }, { status: 400 });
  }

  let verified: ResendWebhookPayload;
  try {
    const resend = new Resend(process.env.RESEND_API_KEY?.trim() || 're_webhook_verify');
    verified = resend.webhooks.verify({
      payload,
      headers: {
        id: svixId,
        timestamp: svixTimestamp,
        signature: svixSignature,
      },
      webhookSecret,
    }) as unknown as ResendWebhookPayload;
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Webhook signature verification failed',
      },
      { status: 401 },
    );
  }

  try {
    const result = await applyResendWebhookEvent(verified, svixId);
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
