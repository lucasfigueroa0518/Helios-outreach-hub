import { NextRequest, NextResponse } from 'next/server';

import {
  parseGcpBudgetNotification,
  tripBillingGuard,
} from '@/lib/billing-guard';

export const runtime = 'nodejs';

function unauthorized() {
  return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
}

export async function POST(request: NextRequest) {
  const configured = process.env.GCP_BILLING_WEBHOOK_TOKEN?.trim();
  if (!configured) {
    return NextResponse.json(
      { ok: false, error: 'GCP_BILLING_WEBHOOK_TOKEN is not configured' },
      { status: 503 },
    );
  }

  const token = request.nextUrl.searchParams.get('token')
    ?? request.headers.get('x-helios-billing-token');
  if (!token || token !== configured) return unauthorized();

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const parsed = parseGcpBudgetNotification(body);
  if (!parsed.shouldTrip) {
    return NextResponse.json({ ok: true, tripped: false, ignored: true });
  }

  const state = await tripBillingGuard({
    source: 'gcp_budget_pubsub',
    alertTitle: parsed.alertTitle,
    detail: parsed.detail,
    costAmount: parsed.costAmount,
    currencyCode: parsed.currencyCode,
    rawPayload: parsed.raw,
  });

  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'error',
    component: 'billing-guard',
    message: 'billing_guard_tripped',
    costAmount: state.cost_amount,
    detail: state.detail,
  }));

  return NextResponse.json({
    ok: true,
    tripped: true,
    cost_amount: state.cost_amount,
    tripped_at: state.tripped_at,
  });
}
