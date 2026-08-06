import { NextRequest, NextResponse } from 'next/server';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { dbTransaction } from '@/lib/db';
import { isLinkedinRelationshipHeader, LINKEDIN_RELATIONSHIP_LABEL } from '@/lib/models';
import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };
type SheetInput = Record<string, unknown>;

const string = (row: SheetInput, name: string) => String(row[name] ?? '').trim() || null;

/** Canonical headers consumed into lead columns; everything else is a custom column. */
const KNOWN_HEADERS = new Set([
  'id', 'first name', 'last name', 'name', 'credentials',
  'email', 'email alt 1', 'email alt 2', 'email status', 'email source',
  'job title', 'title', 'company', 'location', 'linkedin', 'linkedin url',
  'prior relationship activity',
]);

/** Non-canonical columns (incl. added ones) → drafting input, keyed by display header. */
function collectExtraFields(row: SheetInput): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const header of Object.keys(row)) {
    const label = header.trim();
    if (!label || KNOWN_HEADERS.has(label.toLowerCase())) continue;
    const value = String(row[header] ?? '').trim();
    if (!value) continue;
    const key = isLinkedinRelationshipHeader(header) ? LINKEDIN_RELATIONSHIP_LABEL : label;
    extra[key] = value;
  }
  return extra;
}

function parseFile(file: File): Promise<SheetInput[]> {
  return file.arrayBuffer().then((bytes) => {
    if (file.name.toLowerCase().endsWith('.csv')) {
      const parsed = Papa.parse<SheetInput>(new TextDecoder().decode(bytes), { header: true, skipEmptyLines: true });
      if (parsed.errors.length) throw new Error(`Could not read CSV: ${parsed.errors[0].message}`);
      return parsed.data;
    }
    const workbook = XLSX.read(bytes, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw new Error('The workbook has no worksheet');
    return XLSX.utils.sheet_to_json<SheetInput>(sheet, { defval: '' });
  });
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id: campaignId } = await params;
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'Choose a CSV or XLSX file first.' }, { status: 400 });

  try {
    const rows = await parseFile(file);
    if (!rows.length || !Object.keys(rows[0]).includes('ID')) throw new Error('The file must include the ID column from an Outreach export.');
    const result = await dbTransaction(async (client) => {
      const owner = await client.query(`SELECT 1 FROM outreach.campaigns WHERE id = $1 AND owner_id = $2`, [campaignId, session.userId]);
      if (!owner.rowCount) throw new Error('Campaign not found');
      const ids = rows.map((row) => string(row, 'ID')).filter((id): id is string => Boolean(id));
      if (ids.length) {
        const known = await client.query<{ id: string }>(`SELECT id FROM outreach.leads WHERE id = ANY($1::uuid[])`, [ids]);
        const knownIds = new Set(known.rows.map((row) => row.id));
        const unknown = ids.find((id) => !knownIds.has(id));
        if (unknown) throw new Error(`Unknown outreach lead ID: ${unknown}`);
      }
      const keep: Array<{ leadId: string; extra: Record<string, string> }> = [];
      for (const row of rows) {
        const id = string(row, 'ID');
        const firstName = string(row, 'First Name');
        const lastName = string(row, 'Last Name');
        const fullName = [firstName, lastName].filter(Boolean).join(' ') || string(row, 'Name');
        if (!fullName) throw new Error('Every new row must have a First Name/Last Name or Name.');
        let leadId = id;
        if (leadId) {
          await client.query(
            `UPDATE outreach.leads SET first_name=$2, last_name=$3, full_name=$4,
             email_primary=$5, email_alt_1=$6, email_alt_2=$7,
             email_status=CASE WHEN $5 IS NULL THEN email_status ELSE 'direct' END,
             email_source_note=CASE WHEN $5 IS NULL THEN email_source_note ELSE 'provided in replacement sheet' END,
             title=$8, company_name=$9, location=$10, updated_at=now() WHERE id=$1`,
            [leadId, firstName, lastName, fullName, string(row, 'Email'), string(row, 'Email Alt 1'), string(row, 'Email Alt 2'), string(row, 'Job Title'), string(row, 'Company'), string(row, 'Location')],
          );
        } else {
          const created = await client.query<{ id: string }>(
            `INSERT INTO outreach.leads (
               first_name,last_name,full_name,email_primary,email_alt_1,email_alt_2,
               email_status,email_source_note,title,company_name,location
             ) VALUES (
               $1,$2,$3,$4,$5,$6,
               CASE WHEN $4 IS NULL THEN 'not_found' ELSE 'direct' END,
               CASE WHEN $4 IS NULL THEN NULL ELSE 'provided in replacement sheet' END,
               $7,$8,$9
             ) RETURNING id`,
            [firstName, lastName, fullName, string(row, 'Email'), string(row, 'Email Alt 1'), string(row, 'Email Alt 2'), string(row, 'Job Title'), string(row, 'Company'), string(row, 'Location')],
          );
          leadId = created.rows[0].id;
        }
        keep.push({ leadId, extra: collectExtraFields(row) });
      }
      const keepIds = keep.map((entry) => entry.leadId);
      await client.query(`DELETE FROM outreach.campaign_leads WHERE campaign_id=$1 AND NOT (lead_id = ANY($2::uuid[]))`, [campaignId, keepIds]);
      const lastRun = await client.query<{ id: string }>(`SELECT id FROM outreach.runs WHERE campaign_id=$1 ORDER BY started_at DESC LIMIT 1`, [campaignId]);
      if (!lastRun.rows[0]) throw new Error('This campaign needs an enrichment run before replacing its sheet.');
      for (const { leadId, extra } of keep) await client.query(
        `INSERT INTO outreach.campaign_leads (campaign_id, lead_id, run_id, extra_fields) VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT (campaign_id,lead_id) DO UPDATE SET
           extra_fields = outreach.campaign_leads.extra_fields || EXCLUDED.extra_fields`,
        [campaignId, leadId, lastRun.rows[0].id, JSON.stringify(extra)],
      );
      return { rows: keepIds.length };
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to replace the sheet' }, { status: 400 });
  }
}
