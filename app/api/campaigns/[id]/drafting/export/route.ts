import { NextRequest } from 'next/server';

import { draftingErrorResponse, draftingJson, fileDownloadResponse } from '@/lib/drafting/api';
import {
  exportCoworkMarkdown,
  exportMailCsv,
  exportUnverifiedLeadsCsv,
} from '@/lib/drafting/repository';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

type ExportType = 'mail' | 'unverified' | 'cowork';

function parseExportType(value: string | null): ExportType | null {
  if (value === 'mail' || value === 'unverified' || value === 'cowork') return value;
  return null;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return draftingJson({ error: 'Unauthorized' }, 401);

  const { id: campaignId } = await params;
  const exportType = parseExportType(request.nextUrl.searchParams.get('type'));
  if (!exportType) {
    return draftingJson(
      { error: 'Query param type is required (mail, unverified, or cowork)' },
      400,
    );
  }

  try {
    if (exportType === 'mail') {
      const result = await exportMailCsv(campaignId, session.userId);
      return fileDownloadResponse(result);
    }
    if (exportType === 'unverified') {
      const result = await exportUnverifiedLeadsCsv(campaignId, session.userId);
      return fileDownloadResponse(result);
    }
    const result = await exportCoworkMarkdown(campaignId, session.userId);
    return fileDownloadResponse(result);
  } catch (error) {
    return draftingErrorResponse(error);
  }
}
