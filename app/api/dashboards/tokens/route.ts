import { NextRequest, NextResponse } from 'next/server';

import { encryptToken, tokenSuffix } from '@/lib/dashboards/crypto';
import {
  insertGithubToken,
  listGithubTokenMeta,
} from '@/lib/dashboards/repository';
import { scrubError } from '@/lib/dashboards/scrub-logs';
import { PAT_FORMAT_RE } from '@/lib/dashboards/tokens';
import { requireSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET() {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  const tokens = await listGithubTokenMeta();
  return NextResponse.json({
    tokens: tokens.map((t) => ({
      id: t.id,
      githubHandle: t.githubHandle,
      tokenSuffix: t.tokenSuffix,
      addedByEmail: t.addedByEmail,
      lastUsedAt: t.lastUsedAt,
      expiresAt: t.expiresAt,
      createdAt: t.createdAt,
    })),
  });
}

export async function POST(req: NextRequest) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  let body: {
    githubHandle?: string;
    token?: string;
    expiresAt?: string | null;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const githubHandle = body.githubHandle?.trim() ?? '';
  const token = body.token?.trim() ?? '';
  if (!githubHandle) {
    return NextResponse.json({ error: 'GitHub handle is required.' }, { status: 400 });
  }
  if (!PAT_FORMAT_RE.test(token)) {
    return NextResponse.json(
      { error: 'Token must start with github_pat_ or ghp_.' },
      { status: 400 },
    );
  }

  let login: string;
  try {
    const ghRes = await fetch('https://api.github.com/user', {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'helios-outreach-hub',
      },
      cache: 'no-store',
    });
    if (!ghRes.ok) {
      return NextResponse.json(
        { error: 'GitHub rejected this token. Check that it is valid and not expired.' },
        { status: 400 },
      );
    }
    const user = (await ghRes.json()) as { login?: string };
    login = (user.login ?? '').trim();
    if (!login) {
      return NextResponse.json(
        { error: 'Could not resolve GitHub login for this token.' },
        { status: 400 },
      );
    }
  } catch (e: unknown) {
    return NextResponse.json(
      { error: `GitHub verification failed: ${scrubError(e)}` },
      { status: 400 },
    );
  }

  if (login.toLowerCase() !== githubHandle.toLowerCase()) {
    return NextResponse.json(
      {
        error: `Token belongs to @${login}, not @${githubHandle}. Use the matching handle.`,
      },
      { status: 400 },
    );
  }

  let encrypted: ReturnType<typeof encryptToken>;
  try {
    encrypted = encryptToken(token);
  } catch (e: unknown) {
    return NextResponse.json(
      { error: scrubError(e) },
      { status: 500 },
    );
  }

  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  if (expiresAt && isNaN(expiresAt.getTime())) {
    return NextResponse.json({ error: 'Invalid expiresAt date.' }, { status: 400 });
  }

  const saved = await insertGithubToken({
    githubHandle: login,
    encryptedToken: encrypted.encryptedToken,
    iv: encrypted.iv,
    authTag: encrypted.authTag,
    tokenSuffix: tokenSuffix(token),
    addedByUserId: session.userId,
    addedByEmail: session.email,
    expiresAt,
  });

  // Never return plaintext or ciphertext.
  return NextResponse.json({
    id: saved.id,
    githubHandle: saved.githubHandle,
    tokenSuffix: saved.tokenSuffix,
    expiresAt: saved.expiresAt,
  });
}
