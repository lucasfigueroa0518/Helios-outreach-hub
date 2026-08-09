import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { ConversationsHub } from '@/app/hub/conversations-hub';
import { HubLoadingSpinner } from '@/app/hub/hub-loading';
import { getSession } from '@/lib/session';

export default async function HubConversationsPage() {
  const session = await getSession();
  if (!session) redirect('/');
  return (
    <Suspense fallback={<HubLoadingSpinner label="Loading conversations" />}>
      <ConversationsHub />
    </Suspense>
  );
}
