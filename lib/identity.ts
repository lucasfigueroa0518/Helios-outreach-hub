import { dbQuery } from '@/lib/db';
import type { ExtractedPerson } from '@/lib/extraction';
import { canonicalCompany, normalizeName } from '@/lib/name-standard';
import {
  completePriorEnrichmentScan,
  initPriorEnrichmentScanStats,
  updatePriorEnrichmentScanProgress,
} from '@/lib/prior-enrichment';

type Candidate = {
  source: 'lead';
  id: string;
  name: string;
  email: string | null;
  title: string | null;
  company: string | null;
  company_id: string | null;
  location: string | null;
  email_status: string | null;
  source_run_id: string | null;
};

export function isPriorLeadReuse(
  match: Pick<Candidate, 'source' | 'source_run_id'> | undefined,
  currentRunId: string,
) {
  return match?.source === 'lead' && match.source_run_id !== currentRunId;
}

/** Prior hub-assembled enrichment on outreach.leads. */
export function isPriorHubEnrichmentReuse(
  match: Pick<Candidate, 'source' | 'source_run_id' | 'email' | 'title' | 'company' | 'location' | 'email_status'> | undefined,
  currentRunId: string,
): boolean {
  if (!isPriorLeadReuse(match, currentRunId)) return false;
  const hasEnrichment = Boolean(
    match?.email
    || match?.title
    || match?.company
    || match?.location
    || (match?.email_status && match.email_status !== 'not_found'),
  );
  return hasEnrichment;
}

export function priorLeadGuessUntrusted(emailStatus: string | null | undefined) {
  return emailStatus === 'format_guess';
}

function same(value: string | undefined, candidate: string | null) {
  return Boolean(value && candidate && canonicalCompany(value) === canonicalCompany(candidate));
}

async function candidatesFor(person: ExtractedPerson): Promise<Candidate[]> {
  const email = person.email?.toLowerCase() ?? null;
  // Helios identity is leads-only — Embark Salesforce contacts are retired.
  const leads = await dbQuery<Candidate>(
    `SELECT 'lead'::text AS source, id::text AS id, full_name AS name, email_primary AS email,
            title, company_name AS company, company_id, location, email_status, source_run_id
     FROM outreach.leads
     WHERE ($2::text IS NOT NULL AND lower(email_primary) = $2)
        OR similarity(lower(full_name), lower($1)) >= 0.4
     ORDER BY CASE WHEN $2::text IS NOT NULL AND lower(email_primary) = $2 THEN 1 ELSE 0 END DESC,
              similarity(lower(full_name), lower($1)) DESC LIMIT 10`,
    [person.full_name, email],
  );
  return leads.rows;
}

function strongNameMatch(personName: string, candidateName: string) {
  const person = normalizeName(personName).fullName.toLowerCase();
  const candidate = normalizeName(candidateName).fullName.toLowerCase();
  return person.length > 0 && person === candidate;
}

export function corroboratingSignals(
  person: Pick<ExtractedPerson, 'full_name' | 'company' | 'title' | 'location' | 'email' | 'linkedin_url'>,
  candidate: Pick<Candidate, 'name' | 'company' | 'title' | 'location' | 'email'>,
) {
  return [
    person.email && candidate.email?.toLowerCase() === person.email.toLowerCase(),
    same(person.company, candidate.company),
    Boolean(person.title && candidate.title && person.title.toLowerCase() === candidate.title.toLowerCase()),
    Boolean(person.location && candidate.location && person.location.toLowerCase() === candidate.location.toLowerCase()),
    strongNameMatch(person.full_name, candidate.name),
  ].filter(Boolean).length;
}

function confirmed(person: ExtractedPerson, candidate: Candidate) {
  if (person.email && candidate.email?.toLowerCase() === person.email.toLowerCase()) return true;
  return corroboratingSignals(person, candidate) >= 2;
}

async function existingCampaignLead(person: ExtractedPerson, campaignId: string): Promise<Candidate | null> {
  const { rows } = await dbQuery<Candidate>(
    `SELECT 'lead'::text AS source, l.id::text AS id, l.full_name AS name, l.email_primary AS email,
            l.title, l.company_name AS company, l.company_id, l.location, l.email_status, l.source_run_id
     FROM outreach.leads l
     JOIN outreach.campaign_leads cl ON cl.lead_id = l.id
     WHERE cl.campaign_id = $1
       AND lower(l.full_name) = lower($2)
     ORDER BY l.created_at ASC`,
    [campaignId, person.full_name],
  );
  return rows.find((candidate) =>
    confirmed(person, candidate)
    || (strongNameMatch(person.full_name, candidate.name)
      && (!person.company || same(person.company, candidate.company))),
  ) ?? null;
}

/**
 * Previously resolved company names against Embark Salesforce `accounts`.
 * That dump is retired — Helios no longer attaches SF account ids.
 */
export async function resolveCompanyAccountId(
  _companyName: string | null | undefined,
): Promise<string | null> {
  return null;
}

/** Pure helper — pre-enriched path trusts present emails as already validated. */
export function trustedLeadEmailFields(personEmail: string | null | undefined): {
  email: string | null;
  email_status: 'direct' | 'not_found';
  email_verification: 'valid' | null;
  email_source_note: string;
} {
  const email = personEmail?.trim() || null;
  if (email) {
    return {
      email,
      email_status: 'direct',
      email_verification: 'valid',
      email_source_note: 'present in upload (pre-enriched, trusted)',
    };
  }
  return {
    email: null,
    email_status: 'not_found',
    email_verification: null,
    email_source_note: 'no direct email found',
  };
}

export type ResolveExtractedPersonOptions = {
  /** Skip mailbox verify + prior-enrichment gate; trust sheet emails as valid. */
  trustEmailAsValidated?: boolean;
};

async function insertStubLead(
  person: ExtractedPerson,
  runId: string,
  match: Candidate | null | undefined,
  companyName: string | null,
  options?: ResolveExtractedPersonOptions,
) {
  const normalized = normalizeName(person.full_name);
  const companyId = match?.company_id ?? (await resolveCompanyAccountId(companyName));

  let email: string | null;
  let status: string;
  let sourceNote: string;
  let verification: string | null;

  if (options?.trustEmailAsValidated) {
    const trusted = trustedLeadEmailFields(person.email);
    email = trusted.email;
    status = trusted.email_status;
    sourceNote = trusted.email_source_note;
    verification = trusted.email_verification;
  } else {
    email = person.email ?? match?.email ?? null;
    status = person.email ? 'direct' : match?.email ? 'direct' : 'not_found';
    sourceNote = person.email
      ? 'present in upload'
      : match?.email
        ? 'reused from prior Helios lead'
        : 'no direct email found';
    const needsMailbox = status === 'direct';
    verification = needsMailbox ? 'pending' : null;
  }

  const { rows } = await dbQuery<{ id: string }>(
    `INSERT INTO outreach.leads (
      sf_contact_id, first_name, last_name, full_name, credentials, title,
      company_name, company_id, location, email_primary, email_alt_1, email_alt_2,
      email_status, email_source_note, email_verification, linkedin_url, source_run_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    RETURNING id`,
    [
      null,
      normalized.firstName, normalized.lastName, normalized.fullName, normalized.credentials,
      person.title ?? (options?.trustEmailAsValidated ? null : match?.title), companyName, companyId,
      person.location ?? (options?.trustEmailAsValidated ? null : match?.location),
      email, person.email_alt_1 ?? null, person.email_alt_2 ?? null,
      status, sourceNote, verification, person.linkedin_url ?? null, runId,
    ],
  );
  return rows[0].id;
}

async function applyTrustedEmailToLead(leadId: string, person: ExtractedPerson) {
  const trusted = trustedLeadEmailFields(person.email);
  await dbQuery(
    `UPDATE outreach.leads
     SET email_primary = COALESCE($2, email_primary),
         email_alt_1 = COALESCE($3, email_alt_1),
         email_alt_2 = COALESCE($4, email_alt_2),
         email_status = $5,
         email_source_note = $6,
         email_verification = $7,
         title = COALESCE($8, title),
         company_name = COALESCE($9, company_name),
         location = COALESCE($10, location),
         linkedin_url = COALESCE($11, linkedin_url),
         updated_at = now()
     WHERE id = $1`,
    [
      leadId,
      trusted.email,
      person.email_alt_1 ?? null,
      person.email_alt_2 ?? null,
      trusted.email_status,
      trusted.email_source_note,
      trusted.email_verification,
      person.title ?? null,
      person.company ?? null,
      person.location ?? null,
      person.linkedin_url ?? null,
    ],
  );
}

export async function resolveExtractedPerson(
  person: ExtractedPerson,
  runId: string,
  campaignId: string,
  options?: ResolveExtractedPersonOptions,
) {
  const trust = Boolean(options?.trustEmailAsValidated);
  const campaignExisting = await existingCampaignLead(person, campaignId);
  const candidates = trust ? [] : await candidatesFor(person);
  let match = campaignExisting ?? candidates.find((candidate) => confirmed(person, candidate));
  const companyName = person.company ?? match?.company ?? null;
  const pendingPriorEnrichment = trust ? false : isPriorHubEnrichmentReuse(match, runId);
  const priorEnrichmentLeadId = pendingPriorEnrichment && match?.source === 'lead' ? match.id : null;

  let leadId: string;
  if (pendingPriorEnrichment && match?.source === 'lead') {
    leadId = await insertStubLead(person, runId, null, companyName, options);
  } else if (match?.source === 'lead') {
    leadId = match.id;
    if (trust) {
      await applyTrustedEmailToLead(leadId, person);
    } else if (priorLeadGuessUntrusted(match.email_status)) {
      await dbQuery(
        `UPDATE outreach.leads
         SET email_primary = NULL,
             email_alt_1 = NULL,
             email_alt_2 = NULL,
             email_source_note = 'prior format guess discarded — re-researching',
             updated_at = now()
         WHERE id = $1`,
        [leadId],
      );
      match = { ...match, email: null };
    }
    if (!match.company_id) {
      const accountId = await resolveCompanyAccountId(companyName);
      if (accountId) {
        await dbQuery(`UPDATE outreach.leads SET company_id = $2 WHERE id = $1`, [leadId, accountId]);
      }
    }
  } else {
    leadId = await insertStubLead(person, runId, trust ? null : match, companyName, options);
  }

  const reusedFromPriorLead = !pendingPriorEnrichment && isPriorLeadReuse(match, runId);
  const extraFields = person.extra && Object.keys(person.extra).length ? person.extra : {};
  await dbQuery(
    `INSERT INTO outreach.campaign_leads (
       campaign_id, lead_id, run_id, reused_from_prior_lead,
       prior_enrichment_pending, prior_enrichment_lead_id, extra_fields
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT (campaign_id, lead_id) DO UPDATE SET
       run_id = EXCLUDED.run_id,
       reused_from_prior_lead =
         outreach.campaign_leads.reused_from_prior_lead
         OR EXCLUDED.reused_from_prior_lead,
       prior_enrichment_pending = EXCLUDED.prior_enrichment_pending,
       prior_enrichment_lead_id = EXCLUDED.prior_enrichment_lead_id,
       extra_fields = outreach.campaign_leads.extra_fields || EXCLUDED.extra_fields`,
    [
      campaignId, leadId, runId, reusedFromPriorLead,
      pendingPriorEnrichment, priorEnrichmentLeadId, JSON.stringify(extraFields),
    ],
  );
  const emailOrigin = pendingPriorEnrichment
    ? (person.email ? 'upload_direct' : 'none')
    : person.email
      ? 'upload_direct'
      : match?.email_status === 'direct' || match?.email_status === 'from_embark_db'
        ? 'prior_direct'
        : match?.email_status === 'inferred'
          ? 'prior_inferred'
          : match?.email_status === 'format_guess'
            ? 'prior_format_guess'
            : 'none';
  // Upload emails must enter mailbox verify (or fail-open if the run is
  // already AgentMail rate-limited). Pre-enriched trusts sheet emails.
  const scheduleEmail = person.email?.trim() || null;
  if (!trust && scheduleEmail && emailOrigin === 'upload_direct') {
    const { scheduleLeadMailboxVerification } = await import('@/lib/mailbox-verify-schedule');
    void scheduleLeadMailboxVerification({
      leadId,
      runId,
      emailStatus: 'direct',
    }).catch((error) => console.error('Failed to schedule mailbox verification for upload email:', error));
  }

  return {
    leadId,
    matched: Boolean(match),
    emailOrigin,
    priorEnrichmentPending: pendingPriorEnrichment,
  };
}

export async function resolveRunPeople(runId: string) {
  const { rows } = await dbQuery<{ campaign_id: string }>(
    `SELECT campaign_id FROM outreach.runs WHERE id = $1`, [runId],
  );
  const campaignId = rows[0]?.campaign_id;
  if (!campaignId) return;
  const uploads = await dbQuery<{ extraction_summary: { result?: { people?: ExtractedPerson[] } } }>(
    `SELECT extraction_summary FROM outreach.uploads WHERE run_id = $1 AND status = 'extracted'`, [runId],
  );
  let totalPeople = 0;
  for (const upload of uploads.rows) {
    totalPeople += upload.extraction_summary?.result?.people?.length ?? 0;
  }
  await initPriorEnrichmentScanStats(runId, totalPeople);

  let available = 0;
  let actualDirect = 0;
  let inferredReuse = 0;
  let matched = 0;
  let peopleScanned = 0;
  let awaitingCount = 0;
  for (const upload of uploads.rows) {
    for (const person of upload.extraction_summary?.result?.people ?? []) {
      const result = await resolveExtractedPerson(person, runId, campaignId);
      peopleScanned += 1;
      if (result.priorEnrichmentPending) awaitingCount += 1;
      await updatePriorEnrichmentScanProgress(runId, peopleScanned, awaitingCount);
      if (!['none', 'prior_format_guess'].includes(result.emailOrigin)) available++;
      if (['upload_direct', 'prior_direct'].includes(result.emailOrigin)) actualDirect++;
      if (result.emailOrigin === 'prior_inferred') inferredReuse++;
      if (result.matched) matched++;
    }
  }
  await completePriorEnrichmentScan(runId, awaitingCount);
  await dbQuery(
    `UPDATE outreach.runs SET stats = stats || jsonb_build_object(
      'matched_existing', $2::int,
      'emails_available_after_identity', $3::int,
      'emails_direct_after_identity', $4::int,
      'emails_inferred_reused', $5::int,
      'people_resolved', true
    ) WHERE id = $1`,
    [runId, matched, available, actualDirect, inferredReuse],
  );
}
