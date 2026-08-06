import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export const SESSION_COOKIE = 'outreach_session';
const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 days

export type SessionPayload = {
  userId: string;
  email: string;
};

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  return secret;
}

function b64url(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecode(str: string): string {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? padded : padded + '='.repeat(4 - (padded.length % 4));
  return atob(pad);
}

async function hmacSha256(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return b64url(new Uint8Array(sig));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signSession(payload: SessionPayload): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(
    JSON.stringify({
      userId: payload.userId,
      email: payload.email,
      iat: now,
      exp: now + SESSION_MAX_AGE_SEC,
    }),
  );
  const sig = await hmacSha256(`${header}.${body}`, getSecret());
  return `${header}.${body}.${sig}`;
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = await hmacSha256(`${header}.${body}`, getSecret());
  if (!timingSafeEqual(sig, expected)) return null;

  try {
    const json = JSON.parse(b64urlDecode(body));
    if (typeof json.exp === 'number' && json.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof json.userId !== 'string' || typeof json.email !== 'string') return null;
    return { userId: json.userId, email: json.email };
  } catch {
    return null;
  }
}

export async function getSession(): Promise<SessionPayload | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

export function sessionCookieOptions(token: string) {
  const secure = process.env.NODE_ENV === 'production';
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_MAX_AGE_SEC,
  };
}

export function clearSessionCookie() {
  const secure = process.env.NODE_ENV === 'production';
  return {
    name: SESSION_COOKIE,
    value: '',
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 0,
  };
}

/** Attach a 401 JSON response when no valid session exists. */
export async function requireSession(): Promise<SessionPayload | NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return session;
}

/**
 * Login allowlist. Controlled by `ALLOWED_EMAIL_DOMAINS`:
 * - unset or `*` → any syntactically valid email
 * - comma-separated domains (e.g. `example.com,gmail.com`) → only those
 */
export function isAllowedLoginEmail(email: string): boolean {
  const trimmed = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return false;

  const raw = process.env.ALLOWED_EMAIL_DOMAINS?.trim();
  if (!raw || raw === '*') return true;

  const allowed = raw
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const domain = trimmed.split('@')[1]?.toLowerCase();
  return Boolean(domain && allowed.includes(domain));
}

/** @deprecated Use isAllowedLoginEmail — kept for older call sites/tests. */
export function isEmbarkEmail(email: string): boolean {
  return isAllowedLoginEmail(email);
}

export function loginEmailPolicyMessage(): string {
  const raw = process.env.ALLOWED_EMAIL_DOMAINS?.trim();
  if (!raw || raw === '*') return 'Enter a valid email address to continue.';
  const domains = raw
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  if (domains.length === 1) return `Only @${domains[0]} email addresses are allowed.`;
  return `Only these email domains are allowed: ${domains.map((d) => `@${d}`).join(', ')}.`;
}

export function displayNameFromEmail(email: string): string {
  const local = email.trim().split('@')[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}
