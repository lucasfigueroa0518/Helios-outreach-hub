import { redirect } from 'next/navigation';
import { SendQueueHub } from '@/app/hub/send-queue-hub';
import { getSession } from '@/lib/session';

export default async function HubQueuePage() {
  const session = await getSession();
  if (!session) redirect('/');
  return <SendQueueHub sessionUserId={session.userId} sessionEmail={session.email} />;
}
