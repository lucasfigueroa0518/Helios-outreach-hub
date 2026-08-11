import { listAllUsers } from '@/lib/campaigns';
import { DraftingNotFoundError } from '@/lib/drafting/errors';

/** Resolve which user's send queue to read/mutate. Any signed-in teammate may view another. */
export async function resolveQueueOwnerId(
  sessionUserId: string,
  requestedUserId: string | null | undefined,
): Promise<string> {
  const trimmed = requestedUserId?.trim();
  if (!trimmed || trimmed === sessionUserId) return sessionUserId;

  const users = await listAllUsers();
  if (!users.some((user) => user.id === trimmed)) {
    throw new DraftingNotFoundError('User not found');
  }
  return trimmed;
}
