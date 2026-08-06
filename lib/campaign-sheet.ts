import { dbQuery } from '@/lib/db';

export type CampaignSheetRow = {
  id: string;
  sf_contact_id: string | null;
  first_name: string | null;
  last_name: string | null;
  credentials: string | null;
  email_primary: string | null;
  email_alt_1: string | null;
  email_alt_2: string | null;
  email_status: string;
  email_verification: string | null;
  email_mx_status: string | null;
  email_source_note: string | null;
  title: string | null;
  company_name: string | null;
  company_id: string | null;
  location: string | null;
  linkedin_url: string | null;
  profile_enrichment: Partial<Record<'title' | 'company_name' | 'location', { value?: string }>>;
  reused_from_prior_lead: boolean;
  relationship_snapshot: {
    past_work?: string;
    prior_relationship_date?: string | null;
    last_contacted?: string | null;
    last_contacted_by?: string | null;
    relationship_tier?: string;
  } | null;
  /** Non-canonical sheet columns (LinkedIn relationship + user-added columns), keyed by header. */
  extra_fields: Record<string, string>;
};

export type CampaignSheetViewRow = CampaignSheetRow & {
  display_id: string;
  email_status_label: string;
  email_verification_label: string;
};

export function formatEmailStatus(status: string) {
  if (status === 'direct' || status === 'from_embark_db') return 'Found';
  if (status === 'inferred') return 'Inferred';
  if (status === 'format_guess') return 'Guess';
  if (status === 'not_found') return 'Not Found';
  return status;
}

export function formatEmailVerification(status: string | null | undefined) {
  if (!status || status === 'pending') return 'Pending';
  if (status === 'valid') return 'Valid';
  if (status === 'invalid') return 'Invalid';
  if (status === 'accept_all') return 'Accept-all';
  if (status === 'risky') return 'Risky';
  if (status === 'unknown') return 'Unknown';
  if (status === 'rate_limited') return 'Verification rate limited';
  return status;
}

export function toCampaignSheetViewRows(rows: CampaignSheetRow[]): CampaignSheetViewRow[] {
  return rows.map((row) => ({
    ...row,
    display_id: row.sf_contact_id ?? `OR-${row.id.slice(0, 8)}`,
    email_status_label: formatEmailStatus(row.email_status),
    email_verification_label: row.email_primary
      && ['direct', 'inferred', 'format_guess'].includes(row.email_status)
      ? formatEmailVerification(row.email_verification ?? 'pending')
      : '',
  }));
}

export async function loadCampaignSheetRows(campaignId: string, ownerId: string) {
  const { rows } = await dbQuery<CampaignSheetRow>(
    `SELECT l.id, l.sf_contact_id, l.first_name, l.last_name, l.credentials,
            l.email_primary, l.email_alt_1, l.email_alt_2, l.email_status,
            l.email_verification, l.email_mx_status,
            l.email_source_note, l.title, l.company_name,
            l.company_id, l.location, l.linkedin_url, l.profile_enrichment,
            cl.relationship_snapshot, cl.reused_from_prior_lead,
            cl.extra_fields
     FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     JOIN outreach.campaigns c ON c.id = cl.campaign_id
     WHERE cl.campaign_id = $1 AND c.owner_id = $2
     ORDER BY l.last_name NULLS LAST, l.first_name NULLS LAST`,
    [campaignId, ownerId],
  );
  return toCampaignSheetViewRows(rows);
}

export async function countActiveEnrichmentRuns(campaignId: string) {
  const { rows } = await dbQuery<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM outreach.runs r
     WHERE r.campaign_id = $1
       AND r.status IN ('queued', 'extracting', 'enriching', 'awaiting_prior_enrichment')`,
    [campaignId],
  );
  return rows[0]?.count ?? 0;
}
