import { NextRequest, NextResponse } from 'next/server';

import { formatEmailStatus, loadCampaignSheetRows } from '@/lib/campaign-sheet';

import { dbQuery } from '@/lib/db';

import { syncCampaignSheet } from '@/lib/sheet-sync';

import { getSession } from '@/lib/session';



export const runtime = 'nodejs';



type RouteContext = { params: Promise<{ id: string }> };



function priorRelationshipActivityLabel(tier: string) {

  if (tier === 'active') return 'Within 6 months';

  if (tier === 'dormant') return 'Older than 6 months';

  return '';

}



function csvCell(value: unknown) {

  const text = value == null ? '' : String(value);

  const safe = /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;

  return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;

}



export async function GET(request: NextRequest, { params }: RouteContext) {

  const session = await getSession();

  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: campaignId } = await params;

  const owned = await dbQuery<{ id: string }>(

    `SELECT id FROM outreach.campaigns WHERE id = $1 AND owner_id = $2`,

    [campaignId, session.userId],

  );

  if (!owned.rows[0]) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });



  const skipSync = request.nextUrl.searchParams.get('sync') === '0';

  if (!skipSync) {

    await syncCampaignSheet(campaignId);

  }



  const format = request.nextUrl.searchParams.get('format');
  const rows = await loadCampaignSheetRows(campaignId, session.userId);

  if (!format) {
    return NextResponse.json({ rows });
  }

  // Union of non-canonical column headers across the sheet, so a download → edit →
  // Upload & Replace round-trip already contains every custom column.
  const extraKeys = Array.from(
    new Set(rows.flatMap((row) => Object.keys(row.extra_fields ?? {}))),
  );



  if (format === 'xlsx') {

    const ExcelJS = await import('exceljs');

    const workbook = new ExcelJS.Workbook();

    const sheet = workbook.addWorksheet('Outreach sheet');

    sheet.columns = [

      { header: 'ID', key: 'id', width: 38 },

      { header: 'First Name', key: 'first_name', width: 18 }, { header: 'Last Name', key: 'last_name', width: 18 },

      { header: 'Email', key: 'email_primary', width: 30 },

      { header: 'Email Alt 1', key: 'email_alt_1', width: 30 },

      { header: 'Email Alt 2', key: 'email_alt_2', width: 30 }, { header: 'Email Status', key: 'email_status', width: 18 },

      { header: 'Email Source', key: 'email_source_note', width: 36 },

      { header: 'Job Title', key: 'title', width: 26 }, { header: 'Company', key: 'company_name', width: 28 },

      { header: 'Location', key: 'location', width: 24 },

      { header: 'Prior Relationship Activity', key: 'prior_relationship_activity', width: 24 },

      ...extraKeys.map((key) => ({ header: key, key: `extra:${key}`, width: 24 })),

    ];

    for (const row of rows) {

      const tier = String(row.relationship_snapshot?.relationship_tier ?? 'cold');

      const added = sheet.addRow({

        ...row,

        email_status: formatEmailStatus(row.email_status),

        prior_relationship_activity: priorRelationshipActivityLabel(tier),

        ...Object.fromEntries(extraKeys.map((key) => [`extra:${key}`, row.extra_fields?.[key] ?? ''])),

      });

      if (tier === 'active') added.getCell('prior_relationship_activity').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };

      if (tier === 'dormant') added.getCell('prior_relationship_activity').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } };

      const enrichedFill = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFE9F1FD' } };

      if (row.profile_enrichment?.title) added.getCell('title').fill = enrichedFill;

      if (row.profile_enrichment?.company_name) added.getCell('company_name').fill = enrichedFill;

      if (row.profile_enrichment?.location) added.getCell('location').fill = enrichedFill;

    }

    sheet.getRow(1).font = { bold: true };

    const bytes = await workbook.xlsx.writeBuffer();

    return new NextResponse(bytes, { headers: {

      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',

      'content-disposition': 'attachment; filename="outreach-sheet.xlsx"',

    } });

  }



  const headers = ['ID', 'First Name', 'Last Name', 'Credentials', 'Email', 'Email Alt 1', 'Email Alt 2', 'Email Status', 'Email Source', 'Job Title', 'Company', 'Location', 'LinkedIn', 'Prior Relationship Activity', ...extraKeys];

  const body = [

    headers.join(','),

    ...rows.map((row) => [

      row.id,

      row.first_name, row.last_name, row.credentials,

      row.email_primary, row.email_alt_1, row.email_alt_2,

      formatEmailStatus(row.email_status), row.email_source_note,

      row.title, row.company_name, row.location,

      row.linkedin_url, priorRelationshipActivityLabel(row.relationship_snapshot?.relationship_tier ?? 'cold'),

      ...extraKeys.map((key) => row.extra_fields?.[key] ?? ''),

    ].map(csvCell).join(',')),

  ].join('\n');

  return new NextResponse(body, {

    headers: {

      'content-type': 'text/csv; charset=utf-8',

      'content-disposition': 'attachment; filename="outreach-sheet.csv"',

    },

  });

}

