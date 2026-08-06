const fs = require('fs');
const { Client } = require('pg');

async function main() {
  const campaignId = process.argv[2] || '70da0ac3-578d-4ce2-9ff1-a0c4fc0b0ae2';
  const url = fs.readFileSync('.env.local', 'utf8')
    .split('\n')
    .map((line) => line.match(/^DIRECT_DATABASE_URL=(.*)$/)?.[1]?.replace(/\r$/, ''))
    .find(Boolean);
  const client = new Client({ connectionString: url, ssl: false });
  await client.connect();

  const byStatus = await client.query(
    `SELECT l.email_status, count(*)::int AS n
     FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     WHERE cl.campaign_id = $1
     GROUP BY l.email_status ORDER BY n DESC`,
    [campaignId],
  );
  const withEmail = await client.query(
    `SELECT l.full_name, l.email_primary, l.email_alt_1, l.email_alt_2, l.email_status, l.email_source_note, l.sf_contact_id
     FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     WHERE cl.campaign_id = $1
     ORDER BY l.email_status, l.full_name LIMIT 50`,
    [campaignId],
  );
  const newlyFound = await client.query(
    `SELECT count(*)::int AS n FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     WHERE cl.campaign_id = $1 AND l.email_status IN ('from_embark_db', 'inferred') AND l.email_primary IS NOT NULL`,
    [campaignId],
  );
  const fromUpload = await client.query(
    `SELECT count(*)::int AS n FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     WHERE cl.campaign_id = $1 AND l.email_status = 'direct'`,
    [campaignId],
  );
  const notFound = await client.query(
    `SELECT count(*)::int AS n FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     WHERE cl.campaign_id = $1 AND (l.email_primary IS NULL OR l.email_status = 'not_found')`,
    [campaignId],
  );
  const withAlts = await client.query(
    `SELECT count(*)::int AS n FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
     WHERE cl.campaign_id = $1 AND (l.email_alt_1 IS NOT NULL OR l.email_alt_2 IS NOT NULL)`,
    [campaignId],
  );

  console.log(JSON.stringify({
    campaignId,
    byStatus: byStatus.rows,
    fromUploadDirect: fromUpload.rows[0].n,
    newlyDiscoveredBySystem: newlyFound.rows[0].n,
    missingEmail: notFound.rows[0].n,
    withAltEmails: withAlts.rows[0].n,
    sample: withEmail.rows.slice(0, 8),
  }, null, 2));

  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
