import { NextRequest } from 'next/server';

import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import { listSenderProfiles, upsertSenderProfile } from '@/lib/drafting/repository';
import { getSession } from '@/lib/session';
import type { SenderSignatureMode } from '@/lib/drafting/types';

export const runtime = 'nodejs';

export async function GET() {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  try {
    const profiles = await listSenderProfiles(session.userId);
    return draftingJson({ profiles });
  } catch (error) {
    return draftingErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  let body: {
    id?: string;
    display_name?: string;
    displayName?: string;
    work_email?: string;
    workEmail?: string;
    title?: string;
    company_name?: string;
    companyName?: string;
    headshot_storage_path?: string | null;
    headshotStoragePath?: string | null;
    signature_mode?: SenderSignatureMode;
    signatureMode?: SenderSignatureMode;
    timezone?: string | null;
    voice_notes?: string | null;
    voiceNotes?: string | null;
    professional_context?: Record<string, unknown>;
    professionalContext?: Record<string, unknown>;
    is_default?: boolean;
    isDefault?: boolean;
    preferred_ask_forms?: unknown;
  };

  try {
    body = await request.json();
  } catch {
    return draftingJson({ error: 'Invalid JSON body' }, 400);
  }

  if ('preferred_ask_forms' in body || 'preferredAskForms' in body) {
    return draftingJson({ error: 'preferred_ask_forms is not supported' }, 400);
  }

  const displayName = body.displayName ?? body.display_name;
  const workEmail = body.workEmail ?? body.work_email;
  const title = body.title;
  if (!displayName || !workEmail || !title) {
    return draftingJson({ error: 'display_name, work_email, and title are required' }, 400);
  }

  try {
    const profile = await upsertSenderProfile(session.userId, {
      id: body.id,
      display_name: displayName,
      work_email: workEmail,
      title,
      company_name: body.companyName ?? body.company_name,
      headshot_storage_path: body.headshotStoragePath ?? body.headshot_storage_path,
      signature_mode: body.signatureMode ?? body.signature_mode,
      timezone: body.timezone,
      voice_notes: body.voiceNotes ?? body.voice_notes,
      professional_context: body.professionalContext ?? body.professional_context,
      is_default: body.isDefault ?? body.is_default,
    });
    return draftingJson({ profile }, body.id ? 200 : 201);
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
