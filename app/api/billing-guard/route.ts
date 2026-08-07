import { NextRequest } from 'next/server';

import {
  acknowledgeBillingGuard,
  clearBillingGuard,
  getBillingGuardState,
} from '@/lib/billing-guard';
import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET() {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  try {
    const state = await getBillingGuardState();
    return draftingJson({ guard: state });
  } catch (error) {
    return draftingErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  let body: { action?: 'acknowledge' | 'clear'; confirm?: boolean };
  try {
    body = await request.json();
  } catch {
    return draftingJson({ error: 'Invalid JSON body' }, 400);
  }

  try {
    if (body.action === 'acknowledge') {
      const guard = await acknowledgeBillingGuard();
      return draftingJson({ guard });
    }

    if (body.action === 'clear') {
      if (body.confirm !== true) {
        return draftingJson({ error: 'confirm: true is required to clear the billing guard' }, 400);
      }
      const clearSecret = process.env.BILLING_GUARD_CLEAR_SECRET?.trim();
      const provided = request.headers.get('x-billing-guard-clear')?.trim();
      if (!clearSecret || !provided || provided !== clearSecret) {
        return draftingJson(
          {
            error: 'Clearing the fail-closed guard requires BILLING_GUARD_CLEAR_SECRET header',
            code: 'clear_secret_required',
          },
          403,
        );
      }
      const guard = await clearBillingGuard({
        source: `manual_clear:${session.email}`,
        detail: 'Manually cleared after reviewing GCP billing. Worker may resume.',
      });
      return draftingJson({ guard });
    }

    return draftingJson({ error: 'action must be acknowledge or clear' }, 400);
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
