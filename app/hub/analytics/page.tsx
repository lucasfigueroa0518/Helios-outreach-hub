import { redirect } from 'next/navigation';
import { AnalyticsHub } from '@/app/hub/analytics-hub';
import { getSession } from '@/lib/session';

export default async function HubAnalyticsPage() {
  const session = await getSession();
  if (!session) redirect('/');
  return <AnalyticsHub />;
}
