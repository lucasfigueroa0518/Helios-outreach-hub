import fs from 'node:fs';
import { dbQuery } from '@/lib/db';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

type LeadRow = {
  full_name: string;
  email_primary: string | null;
  email_alt_1: string | null;
  email_alt_2: string | null;
  email_status: string;
  email_verification: string | null;
};

function isFoundStatus(status: string) {
  return status === 'direct' || status === 'from_embark_db';
}

function isInferredStatus(status: string) {
  return status === 'inferred' || status === 'format_guess';
}

function isValid(verification: string | null) {
  return verification === 'valid';
}

function isInvalid(verification: string | null) {
  return !verification || verification !== 'valid';
}

function allEmails(lead: LeadRow) {
  return [lead.email_primary, lead.email_alt_1, lead.email_alt_2]
    .map((email) => email?.trim() ?? '')
    .filter(Boolean);
}

function primaryEmail(lead: LeadRow) {
  return lead.email_primary?.trim() ?? '';
}

async function main() {
  const latestRun = await dbQuery<{
    id: string;
    campaign_id: string;
    campaign_name: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    stats: Record<string, unknown>;
  }>(
    `SELECT r.id, r.campaign_id, c.name AS campaign_name, r.status,
            r.started_at, r.finished_at, r.stats
     FROM outreach.runs r
     JOIN outreach.campaigns c ON c.id = r.campaign_id
     WHERE EXISTS (
       SELECT 1 FROM outreach.campaign_leads cl WHERE cl.run_id = r.id
     )
     ORDER BY r.started_at DESC
     LIMIT 1`,
  );
  const run = latestRun.rows[0];
  if (!run) {
    console.log(JSON.stringify({ error: 'No completed run with leads found' }, null, 2));
    return;
  }

  const leads = await dbQuery<LeadRow>(
    `SELECT l.full_name, l.email_primary, l.email_alt_1, l.email_alt_2,
            l.email_status, l.email_verification
     FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     WHERE cl.run_id = $1
     ORDER BY l.full_name`,
    [run.id],
  );

  const rows = leads.rows;
  const totalContacts = rows.length;
  const withAnyEmail = rows.filter((lead) => allEmails(lead).length > 0);
  const withPrimaryEmail = rows.filter((lead) => primaryEmail(lead));
  const foundLeads = rows.filter((lead) => isFoundStatus(lead.email_status) && primaryEmail(lead));
  const inferredLeads = rows.filter((lead) => isInferredStatus(lead.email_status) && primaryEmail(lead));
  const notFoundLeads = rows.filter((lead) => lead.email_status === 'not_found' || !primaryEmail(lead));

  const allAddressSlots = rows.flatMap((lead) =>
    allEmails(lead).map((email) => ({
      email,
      email_status: lead.email_status,
      email_verification: lead.email_verification,
      kind: isFoundStatus(lead.email_status) ? 'found' : isInferredStatus(lead.email_status) ? 'inferred' : 'other',
    })),
  );

  const verifiedAddresses = allAddressSlots.filter((slot) => slot.email_verification != null);
  const validAddresses = allAddressSlots.filter((slot) => isValid(slot.email_verification));
  const invalidAddresses = allAddressSlots.filter((slot) => isInvalid(slot.email_verification));

  const validContacts = rows.filter((lead) => primaryEmail(lead) && isValid(lead.email_verification));

  const foundValid = foundLeads.filter((lead) => isValid(lead.email_verification));
  const foundInvalid = foundLeads.filter((lead) => isInvalid(lead.email_verification));
  const inferredValid = inferredLeads.filter((lead) => isValid(lead.email_verification));
  const inferredInvalid = inferredLeads.filter((lead) => isInvalid(lead.email_verification));

  const bounced = rows.filter((lead) => lead.email_verification === 'invalid');

  const enrichment = (run.stats?.enrichment ?? {}) as Record<string, number>;

  console.log(JSON.stringify({
    run: {
      id: run.id,
      campaign: run.campaign_name,
      status: run.status,
      started_at: run.started_at,
      finished_at: run.finished_at,
    },
    contacts_reached: {
      valid_contacts: validContacts.length,
      total_contacts: totalContacts,
      rate: totalContacts ? validContacts.length / totalContacts : 0,
    },
    overall_address_validity: {
      valid_addresses: validAddresses.length,
      total_addresses_with_email: allAddressSlots.length,
      rate: allAddressSlots.length ? validAddresses.length / allAddressSlots.length : 0,
      note: 'unknown/pending/null verification counts as invalid',
    },
    overall_bounce_rate: {
      bounced_contacts: bounced.length,
      verified_or_probed_contacts: rows.filter((lead) =>
        primaryEmail(lead) && shouldScheduleMailboxVerification(lead.email_status),
      ).length,
      invalid_verification_contacts: bounced.length,
      rate_by_contacts_with_email: withPrimaryEmail.length
        ? bounced.length / withPrimaryEmail.length
        : 0,
      rate_by_verified_only: verifiedAddresses.length
        ? invalidAddresses.length / verifiedAddresses.length
        : null,
      run_stats_mailbox_invalid: enrichment.mailbox_invalid ?? null,
      run_stats_mailbox_valid: enrichment.mailbox_valid ?? null,
    },
    found_email_validity: {
      found_contacts_with_email: foundLeads.length,
      valid: foundValid.length,
      invalid: foundInvalid.length,
      rate: foundLeads.length ? foundValid.length / foundLeads.length : null,
    },
    inferred_email_validity: {
      inferred_contacts_with_email: inferredLeads.length,
      valid: inferredValid.length,
      invalid: inferredInvalid.length,
      rate: inferredLeads.length ? inferredValid.length / inferredLeads.length : null,
    },
    breakdown: {
      email_status: countBy(rows, (lead) => lead.email_status),
      email_verification: countBy(rows, (lead) => lead.email_verification ?? 'null'),
      not_found: notFoundLeads.length,
    },
  }, null, 2));
}

function shouldScheduleMailboxVerification(emailStatus: string | null | undefined) {
  return emailStatus === 'direct' || emailStatus === 'inferred' || emailStatus === 'format_guess';
}

function countBy<T>(items: T[], keyFn: (item: T) => string) {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
