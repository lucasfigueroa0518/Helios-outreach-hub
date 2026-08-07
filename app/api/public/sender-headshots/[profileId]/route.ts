import { NextRequest, NextResponse } from 'next/server';

import { getSenderProfileHeadshotPath } from '@/lib/drafting/repository';
import { isLucasSenderEmail } from '@/lib/drafting/email-signature';
import { dbQuery } from '@/lib/db';
import { downloadStoredObject } from '@/lib/storage';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const runtime = 'nodejs';

/**
 * Public headshot URL for HTML email signatures.
 * Profile UUIDs are unguessable; Lucas uses the static public asset instead.
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ profileId: string }> },
) {
  const { profileId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(profileId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const { rows } = await dbQuery<{ work_email: string; headshot_storage_path: string | null }>(
      `SELECT work_email, headshot_storage_path
         FROM outreach.sender_profiles
        WHERE id = $1`,
      [profileId],
    );
    const row = rows[0];
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    if (isLucasSenderEmail(row.work_email)) {
      const filePath = path.join(process.cwd(), 'public', 'signatures', 'lucas-figueroa.jpg');
      const bytes = await readFile(filePath);
      return new NextResponse(new Uint8Array(bytes), {
        status: 200,
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    const storagePath = row.headshot_storage_path ?? await getSenderProfileHeadshotPath(profileId);
    if (!storagePath) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const bytes = await downloadStoredObject(storagePath);
    const contentType = storagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}
