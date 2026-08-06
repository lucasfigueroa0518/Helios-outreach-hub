import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/session';

const PUBLIC_API = new Set([
  '/api/auth/login',
  '/api/auth/logout',
  '/api/health',
]);

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (!pathname.startsWith('/api/')) {
    return NextResponse.next();
  }
  if (PUBLIC_API.has(pathname)) {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const session = await verifySessionToken(token);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const headers = new Headers(req.headers);
  headers.set('x-user-id', session.userId);
  headers.set('x-user-email', session.email);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/api/:path*'],
};
