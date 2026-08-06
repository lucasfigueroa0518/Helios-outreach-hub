import { NextRequest, NextResponse } from 'next/server';
import { cancelEnrichmentRun, submitPriorEnrichmentDecision, type PriorEnrichmentDecision } from '@/lib/runs';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

function isPriorEnrichmentDecision(value: unknown): value is PriorEnrichmentDecision {
  return value === 'use_prior' || value === 're_enrich';
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const body = await request.json().catch(() => ({})) as {
    action?: string;
    decision?: string;
  };

  if (body.action === 'prior_enrichment_decision') {
    if (!isPriorEnrichmentDecision(body.decision)) {
      return NextResponse.json(
        { error: 'decision must be use_prior or re_enrich' },
        { status: 400 },
      );
    }
    try {
      const run = await submitPriorEnrichmentDecision(id, session.userId, body.decision);
      return NextResponse.json({ run });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to apply prior enrichment decision';
      const status = message.includes('not awaiting') ? 409 : 400;
      return NextResponse.json({ error: message }, { status });
    }
  }

  if (body.action !== 'cancel') {
    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  }

  try {
    const run = await cancelEnrichmentRun(id, session.userId);
    return NextResponse.json({ run: { id: run.id, status: 'cancelled' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to cancel run';
    const status = message === 'Run cannot be cancelled' ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
