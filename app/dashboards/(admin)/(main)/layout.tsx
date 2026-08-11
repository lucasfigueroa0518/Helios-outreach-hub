import Link from 'next/link';
import { redirect } from 'next/navigation';

import { countTokensForUser } from '@/lib/dashboards/repository';
import { getSession } from '@/lib/session';

/**
 * Soft-block admin project pages until the signed-in user has added at least
 * one GitHub PAT. Tokens page stays outside this group.
 */
export default async function DashboardsPatGateLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect('/');

  const tokenCount = await countTokensForUser(session.userId);
  if (tokenCount === 0) {
    return (
      <div className="dashboards-pat-gate">
        <h1>Connect GitHub</h1>
        <p>
          Before managing dashboards, add a GitHub personal access token. Sync
          uses your encrypted PAT for repos you own — the token is never shown
          again after you save it.
        </p>
        <Link href="/dashboards/tokens">Add GitHub PAT</Link>
      </div>
    );
  }

  return children;
}
