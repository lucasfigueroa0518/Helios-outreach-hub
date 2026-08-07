import { NextResponse } from 'next/server';
import NextAuth from 'next-auth';

import { authConfig } from '@/auth.config';

const { auth } = NextAuth(authConfig);

function isPublicPath(pathname: string): boolean {
  if (pathname === '/') return true;
  if (pathname.startsWith('/api/auth')) return true;
  if (pathname === '/api/health') return true;
  if (pathname === '/api/webhooks/resend') return true;
  if (pathname === '/api/webhooks/gcp-billing') return true;
  return false;
}

function isProtectedPage(pathname: string): boolean {
  return pathname === '/hub'
    || pathname.startsWith('/hub/')
    || pathname.startsWith('/campaigns/');
}

export default auth((req) => {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Edge config has no session callback — email presence means a valid Auth.js JWT.
  const signedIn = Boolean(req.auth?.user?.email);

  if (pathname.startsWith('/api/')) {
    if (!signedIn) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.next();
  }

  if (isProtectedPage(pathname) && !signedIn) {
    const login = new URL('/', req.nextUrl.origin);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    '/',
    '/hub/:path*',
    '/campaigns/:path*',
    '/api/:path*',
  ],
};
