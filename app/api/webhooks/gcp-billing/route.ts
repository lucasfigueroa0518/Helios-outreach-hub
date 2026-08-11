import { NextRequest, NextResponse } from 'next/server';

import {
  parseGcpBudgetNotification,
  recordCloudWorkerSpend,
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
  if (!parsed.shouldRecord) {
    return NextResponse.json({ ok: true, recorded: false, ignored: true });
  }

  const state = await recordCloudWorkerSpend({
    source: 'gcp_budget_pubsub',
    alertTitle: parsed.alertTitle,
    detail: parsed.detail,
    costAmount: parsed.costAmount,
    currencyCode: parsed.currencyCode,
    rawPayload: parsed.raw,
  });

  console.info(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    component: 'cloud-worker-spend',
    message: 'cloud_worker_spend_recorded',
    costAmount: state.cost_amount,
    detail: state.detail,
  }));

  return NextResponse.json({
    ok: true,
    recorded: true,
    cost_amount: state.cost_amount,
    updated_at: state.updated_at,
  });
}
