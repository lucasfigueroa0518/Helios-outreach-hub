import { NextRequest } from 'next/server';

import { downloadDeckObject } from '@/lib/dashboards/deck-storage';
import { findProjectByAccessToken } from '@/lib/dashboards/repository';

export const runtime = 'nodejs';

async function fetchLegacyBlob(url: string): Promise<Buffer | null> {
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  const headers: Record<string, string> = {};
  if (blobToken) headers.authorization = `Bearer ${blobToken}`;
  try {
    const res = await fetch(url, { headers, cache: 'no-store' });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const project = await findProjectByAccessToken(token);

  if (!project || project.status === 'ARCHIVED') {
    return new Response('Not found', { status: 404 });
  }

  try {
    let bytes: Buffer | null = null;
    if (project.deckStoragePath) {
      bytes = await downloadDeckObject(project.deckStoragePath);
    } else if (project.deckPdfUrl?.startsWith('http')) {
      // Migrated donor rows may still point at Vercel Blob until re-uploaded.
      bytes = await fetchLegacyBlob(project.deckPdfUrl);
    }

    if (!bytes) {
      return new Response('Not found', { status: 404 });
    }

    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch {
    return new Response('Deck unavailable', { status: 502 });
  }
}
