const fs = require('fs');
const { Client } = require('pg');

async function main() {
  const url = fs.readFileSync('.env.local', 'utf8')
    .split('\n')
    .map((line) => line.match(/^DIRECT_DATABASE_URL=(.*)$/)?.[1]?.replace(/\r$/, ''))
    .find(Boolean);
  const client = new Client({ connectionString: url, ssl: false });
  await client.connect();

  const campaigns = await client.query(
    `SELECT id, name FROM outreach.campaigns ORDER BY created_at DESC LIMIT 3`,
  );
  console.log('Campaigns:', campaigns.rows);

  for (const c of campaigns.rows) {
    const leads = await client.query(
      `SELECT count(*)::int AS n FROM outreach.campaign_leads WHERE campaign_id = $1`,
      [c.id],
    );
    const uploads = await client.query(
      `SELECT u.file_name, u.status, u.extraction_summary->>'people_found' as people_found, r.status as run_status
       FROM outreach.uploads u JOIN outreach.runs r ON r.id = u.run_id
       WHERE r.campaign_id = $1 ORDER BY u.created_at`,
      [c.id],
    );
    const runs = await client.query(
      `SELECT id, status, error, stats FROM outreach.runs WHERE campaign_id = $1 ORDER BY started_at DESC`,
      [c.id],
    );
    console.log(`\n=== ${c.name} (${c.id}) ===`);
    console.log('campaign_leads:', leads.rows[0].n);
    console.log('runs:', JSON.stringify(runs.rows, null, 2));
    console.log('uploads:', JSON.stringify(uploads.rows, null, 2));
    const sheet = await client.query(
      `SELECT l.full_name, l.email_primary, l.email_status FROM outreach.campaign_leads cl
       JOIN outreach.leads l ON l.id = cl.lead_id WHERE cl.campaign_id = $1 LIMIT 5`,
      [c.id],
    );
    console.log('sheet sample:', sheet.rows);
  }

  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
