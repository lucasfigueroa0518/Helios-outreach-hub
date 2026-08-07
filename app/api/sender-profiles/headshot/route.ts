import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

import { draftingErrorResponse, draftingJson } from '@/lib/drafting/api';
import {
  listSenderProfiles,
  setSenderProfileHeadshot,
  upsertSenderProfile,
} from '@/lib/drafting/repository';
import { getSession } from '@/lib/session';
import { removeStoredObject, uploadStoredObject } from '@/lib/storage';

export const runtime = 'nodejs';

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/jpg']);
const MAX_BYTES = 5 * 1024 * 1024;

function extensionFor(mime: string): string {
  if (mime === 'image/png') return 'png';
  return 'jpg';
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return draftingJson({ error: 'Expected multipart form data' }, 400);
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return draftingJson({ error: 'file is required (png or jpeg)' }, 400);
  }

  const mime = (file.type || '').toLowerCase();
  if (!ALLOWED.has(mime)) {
    return draftingJson({ error: 'Headshot must be a PNG or JPEG image' }, 400);
  }
  if (file.size <= 0 || file.size > MAX_BYTES) {
    return draftingJson({ error: 'Headshot must be between 1 byte and 5 MB' }, 400);
  }

  const profileIdRaw = form.get('profile_id') ?? form.get('profileId');
  let profileId = typeof profileIdRaw === 'string' ? profileIdRaw.trim() : '';

  try {
    const profiles = await listSenderProfiles(session.userId);
    let profile = profileId
      ? profiles.find((row) => row.id === profileId)
      : profiles.find((row) => row.is_default) ?? profiles[0];

    if (!profile) {
      // Create a minimal profile so first-time setup can attach a headshot before full save.
      const displayName = String(form.get('display_name') ?? form.get('displayName') ?? '').trim()
        || session.email.split('@')[0]
        || 'Sender';
      const workEmail = String(form.get('work_email') ?? form.get('workEmail') ?? '').trim()
        || session.email;
      const title = String(form.get('title') ?? '').trim() || 'Team member';
      profile = await upsertSenderProfile(session.userId, {
        display_name: displayName,
        work_email: workEmail,
        title,
        company_name: String(form.get('company_name') ?? form.get('companyName') ?? 'Helios Group').trim() || 'Helios Group',
        is_default: true,
      });
    }

    profileId = profile.id;
    const bytes = Buffer.from(await file.arrayBuffer());
    const storagePath = `sender-headshots/${session.userId}/${profileId}-${randomUUID()}.${extensionFor(mime)}`;

    await uploadStoredObject(storagePath, bytes, mime === 'image/png' ? 'image/png' : 'image/jpeg');

    const previous = profile.headshot_storage_path;
    const updated = await setSenderProfileHeadshot(session.userId, profileId, storagePath);
    if (previous && previous !== storagePath) {
      try {
        await removeStoredObject(previous);
      } catch {
        // Best-effort cleanup of the previous object.
      }
    }

    return draftingJson({ profile: updated, storage_path: storagePath });
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
