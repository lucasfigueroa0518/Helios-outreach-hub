import { NextResponse } from 'next/server';
import NextAuth from 'next-auth';

import { authConfig } from '@/auth.config';

const { auth } = NextAuth(authConfig);

function isStaticAsset(pathname: string): boolean {
  // public/dashboards/* shares the /dashboards URL prefix with App Router pages.
  // Those files must not go through auth redirects (Image optimizer / <img> / fonts).
  return /\.(?:png|jpe?g|gif|webp|svg|ico|otf|ttf|woff2?|pdf|txt|map)$/i.test(pathname);
}

function isPublicPath(pathname: string): boolean {
  if (pathname === '/') return true;
  if (isStaticAsset(pathname)) return true;
  // Client dashboard links (token-gated in app code; no Auth.js session required).
  if (pathname.startsWith('/d/')) return true;
  if (pathname.startsWith('/dashboards/d/')) return true;
  // Deck PDFs are gated by project access_token, not Auth.js session.
  if (pathname.startsWith('/api/dashboards/deck/')) return true;
  if (pathname.startsWith('/api/auth')) return true;
  if (pathname === '/api/health') return true;
  if (pathname === '/api/webhooks/resend') return true;
  if (pathname === '/api/webhooks/gcp-billing') return true;
  if (pathname.startsWith('/api/public/sender-headshots/')) return true;
  return false;
}

function isProtectedPage(pathname: string): boolean {
  if (isStaticAsset(pathname)) return false;
  return pathname === '/hub'
    || pathname.startsWith('/hub/')
    || pathname.startsWith('/campaigns/')
    || pathname === '/dashboards'
    || (pathname.startsWith('/dashboards/') && !pathname.startsWith('/dashboards/d/'));
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
    '/dashboards',
    '/dashboards/:path*',
    '/d/:path*',
    '/api/:path*',
  ],
};
