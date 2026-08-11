import { NextRequest } from 'next/server';

import {
  clearBillingGuard,
  getCloudWorkerSpendState,
} from '@/lib/billing-guard';
import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET() {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  try {
    const spend = await getCloudWorkerSpendState();
    return draftingJson({
      spend,
      // Legacy shape for any older clients.
      guard: spend,
    });
  } catch (error) {
    return draftingErrorResponse(error);
  }
}

/** Optional admin clear of any leftover fail-closed flag from the old $0 guard. */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  let body: { action?: 'clear'; confirm?: boolean };
  try {
    body = await request.json();
  } catch {
    return draftingJson({ error: 'Invalid JSON body' }, 400);
  }

  try {
    if (body.action === 'clear') {
      if (body.confirm !== true) {
        return draftingJson({ error: 'confirm: true is required to clear' }, 400);
      }
      const clearSecret = process.env.BILLING_GUARD_CLEAR_SECRET?.trim();
      const provided = request.headers.get('x-billing-guard-clear')?.trim();
      if (!clearSecret || !provided || provided !== clearSecret) {
        return draftingJson(
          {
            error: 'Clearing requires BILLING_GUARD_CLEAR_SECRET header',
            code: 'clear_secret_required',
          },
          403,
        );
      }
      const spend = await clearBillingGuard({
        source: `manual_clear:${session.email}`,
        detail: 'Manually cleared leftover fail-closed flag. Worker spend is tracked only.',
      });
      return draftingJson({ spend, guard: spend });
    }

    return draftingJson({ error: 'action must be clear' }, 400);
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
