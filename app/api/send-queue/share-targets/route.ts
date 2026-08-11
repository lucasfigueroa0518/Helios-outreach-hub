import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import { listSendQueueShareTargets } from '@/lib/drafting/send-queue';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET() {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  try {
    const users = await listSendQueueShareTargets(session.userId);
    return draftingJson({ users });
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
