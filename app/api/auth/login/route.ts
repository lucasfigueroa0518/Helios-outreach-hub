import { NextRequest, NextResponse } from 'next/server';
import { upsertUserByEmail } from '@/lib/auth';
import {
  isAllowedLoginEmail,
  loginEmailPolicyMessage,
  sessionCookieOptions,
  signSession,
} from '@/lib/session';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const email = body.email?.trim();
  if (!email) {
    return NextResponse.json({ error: 'Email is required' }, { status: 400 });
  }
  if (!isAllowedLoginEmail(email)) {
    return NextResponse.json(
      { error: loginEmailPolicyMessage() },
      { status: 400 },
    );
  }

  try {
    const user = await upsertUserByEmail(email);
    const token = await signSession({ userId: user.id, email: user.email });
    const res = NextResponse.json({
      user: { id: user.id, email: user.email, display_name: user.display_name },
    });
    res.cookies.set(sessionCookieOptions(token));
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Login failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
