import { dbQuery } from '@/lib/db';
import { normalizeName } from '@/lib/name-standard';
import { formatNyDate } from '@/lib/drafting/send-queue-schedule';
import type { EnrichedPerson } from '@/lib/auto-campaigns/types';

async function upsertLeadFromApollo(person: EnrichedPerson, runId: string): Promise<string | null> {
  const normalized = normalizeName(person.fullName || 'Unknown');
  const email = person.emailVerified ? person.email?.trim().toLowerCase() ?? null : null;
  const existing = await dbQuery<{ id: string }>(
    `SELECT id FROM outreach.leads WHERE apollo_person_id = $1 LIMIT 1`,
    [person.apolloPersonId],
  );
  if (existing.rows[0]) {
    const leadId = existing.rows[0].id;
    await dbQuery(
      `UPDATE outreach.leads
          SET full_name = COALESCE($2, full_name),
              first_name = COALESCE($3, first_name),
              last_name = COALESCE($4, last_name),
              title = COALESCE($5, title),
              company_name = COALESCE($6, company_name),
              location = COALESCE($7, location),
              email_primary = COALESCE($8, email_primary),
              email_status = CASE WHEN $8 IS NOT NULL THEN 'direct' ELSE email_status END,
              email_source_note = CASE
                WHEN $8 IS NOT NULL THEN 'Apollo verified (auto campaign)'
                ELSE email_source_note
              END,
              email_verification = CASE WHEN $8 IS NOT NULL THEN 'valid' ELSE email_verification END,
              linkedin_url = COALESCE($9, linkedin_url),
              updated_at = now()
        WHERE id = $1`,
      [
        leadId,
        normalized.fullName,
        normalized.firstName || null,
        normalized.lastName || null,
        person.title ?? null,
        person.company ?? null,
        person.location ?? null,
        email,
        person.linkedinUrl ?? null,
      ],
    );
    return leadId;
  }

  const inserted = await dbQuery<{ id: string }>(
    `INSERT INTO outreach.leads (
       full_name, first_name, last_name, title, company_name, location,
       email_primary, email_status, email_source_note, email_verification,
       linkedin_url, apollo_person_id, source_run_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      normalized.fullName,
      normalized.firstName || null,
      normalized.lastName || null,
      person.title ?? null,
      person.company ?? null,
      person.location ?? null,
      email,
      email ? 'direct' : 'not_found',
      email ? 'Apollo verified (auto campaign)' : 'Apollo enrich returned no verified email',
      email ? 'valid' : null,
      person.linkedinUrl ?? null,
      person.apolloPersonId,
      runId,
    ],
  );
  return inserted.rows[0]?.id ?? null;
}

export async function persistEnrichedApolloPeople(input: {
  campaignId: string;
  runId: string;
  expansionStep: number;
  sourcedOn?: string;
  people: EnrichedPerson[];
  attachVerified: boolean;
}): Promise<{ attached: number; stored: number }> {
  const sourcedOn = input.sourcedOn ?? formatNyDate();
  let attached = 0;
  let stored = 0;
  for (const person of input.people) {
    const leadId = await upsertLeadFromApollo(person, input.runId);
    if (!leadId) continue;
    stored += 1;
    const email = person.emailVerified ? person.email?.trim() : null;
    if (!input.attachVerified || !email) continue;
    const result = await dbQuery(
      `INSERT INTO outreach.campaign_leads (
         campaign_id, lead_id, run_id, sourced_on, expansion_step
       ) VALUES ($1,$2,$3,$4::date,$5)
       ON CONFLICT (campaign_id, lead_id) DO NOTHING`,
      [input.campaignId, leadId, input.runId, sourcedOn, input.expansionStep],
    );
    if ((result.rowCount ?? 0) > 0) attached += 1;
  }
  return { attached, stored };
}
