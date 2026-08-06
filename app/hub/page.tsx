import { redirect } from 'next/navigation';
import { CampaignHub } from '@/app/hub/campaign-hub';
import { getSession } from '@/lib/session';

export default async function HubPage() {
  const session = await getSession();
  if (!session) redirect('/');

  return <CampaignHub email={session.email} />;
}
