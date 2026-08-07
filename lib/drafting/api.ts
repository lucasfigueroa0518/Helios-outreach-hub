import { NextResponse } from 'next/server';

import {
  DraftingAssetHashMismatchError,
  MissingDraftingAssetsError,
} from '@/lib/drafting/assets';
import {
  DraftingConflictError,
  DraftingExportBlockedError,
  DraftingNotFoundError,
  DraftingValidationError,
  EmailSendConfigurationError,
  EmailSendProviderError,
} from '@/lib/drafting/errors';

const PRIVATE_CACHE = { 'Cache-Control': 'private, no-store' };

export function draftingJson(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(body, { status, headers: { ...PRIVATE_CACHE, ...extraHeaders } });
}

export function draftingErrorResponse(error: unknown): NextResponse {
  if (error instanceof DraftingNotFoundError) {
    return draftingJson({ error: error.message }, 404);
  }
  if (error instanceof DraftingConflictError) {
    return draftingJson({ error: error.message, code: error.code }, 409);
  }
  if (error instanceof DraftingValidationError) {
    return draftingJson(
      { error: error.message, field_errors: error.fieldErrors },
      422,
    );
  }
  if (error instanceof DraftingExportBlockedError) {
    return draftingJson({ error: error.message, blockers: error.blockers }, 409);
  }
  if (error instanceof EmailSendConfigurationError) {
    return draftingJson({ error: error.message, code: 'send_not_configured' }, 503);
  }
  if (error instanceof EmailSendProviderError) {
    return draftingJson({ error: error.message, code: 'send_failed' }, 502);
  }
  if (error instanceof DraftingAssetHashMismatchError) {
    return draftingJson(
      {
        error: 'Drafting assets are out of sync. Ask an admin to run npm run drafting:sync-manifest.',
        code: error.code,
      },
      422,
    );
  }
  if (error instanceof MissingDraftingAssetsError) {
    return draftingJson(
      { error: 'Drafting assets are missing on the server.', code: 'assets_missing' },
      503,
    );
  }
  const message = error instanceof Error ? error.message : 'Unexpected error';
  return draftingJson({ error: message }, 500);
}

export function fileDownloadResponse(input: {
  bytes: Uint8Array;
  filename: string;
  mime: string;
}): NextResponse {
  return new NextResponse(Buffer.from(input.bytes), {
    status: 200,
    headers: {
      ...PRIVATE_CACHE,
      'Content-Type': input.mime,
      'Content-Disposition': `attachment; filename="${input.filename}"`,
    },
  });
}
