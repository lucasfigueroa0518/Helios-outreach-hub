import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import { getSendQueueDetail } from '@/lib/drafting/send-queue';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  const { id } = await params;

  try {
    const result = await getSendQueueDetail(session.userId, id);
    return draftingJson(result);
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
