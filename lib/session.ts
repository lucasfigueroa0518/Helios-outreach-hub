import { NextResponse } from 'next/server';

import { auth } from '@/auth';
import {
  displayNameFromEmail,
  isAllowedLoginEmail,
  isEmbarkEmail,
  loginEmailPolicyMessage,
} from '@/lib/login-policy';

export type SessionPayload = {
  userId: string;
  email: string;
};

export {
  displayNameFromEmail,
  isAllowedLoginEmail,
  isEmbarkEmail,
  loginEmailPolicyMessage,
};

/** Current Helios user from Auth.js (outreach.users.id + email). */
export async function getSession(): Promise<SessionPayload | null> {
  const session = await auth();
  const userId = session?.user?.id?.trim();
  const email = session?.user?.email?.trim().toLowerCase();
  if (!userId || !email) return null;
  if (!isAllowedLoginEmail(email)) return null;
  return { userId, email };
}

/** Attach a 401 JSON response when no valid session exists. */
export async function requireSession(): Promise<SessionPayload | NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return session;
}
