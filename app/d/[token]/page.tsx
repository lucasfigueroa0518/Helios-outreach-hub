import { permanentRedirect } from 'next/navigation';

/**
 * Preserve donor public client links (`/d/[token]`).
 * Canonical app path after merge: `/dashboards/d/[token]`.
 */
export default async function LegacyClientDashboardRedirect({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  permanentRedirect(`/dashboards/d/${encodeURIComponent(token)}`);
}
