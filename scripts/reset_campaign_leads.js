const fs = require('fs');
const { Client } = require('pg');

async function main() {
  const campaignId = '70da0ac3-578d-4ce2-9ff1-a0c4fc0b0ae2';
  const url = fs.readFileSync('.env.local', 'utf8')
    .split('\n')
    .map((line) => line.match(/^DIRECT_DATABASE_URL=(.*)$/)?.[1]?.replace(/\r$/, ''))
    .find(Boolean);
  const client = new Client({ connectionString: url, ssl: false });
  await client.connect();
  await client.query('DELETE FROM outreach.campaign_leads WHERE campaign_id = $1', [campaignId]);
  await client.query(
    `DELETE FROM outreach.leads
     WHERE source_run_id IN (SELECT id FROM outreach.runs WHERE campaign_id = $1)`,
    [campaignId],
  );
  const count = await client.query('SELECT count(*)::int AS n FROM outreach.campaign_leads WHERE campaign_id = $1', [campaignId]);
  console.log('campaign_leads after reset:', count.rows[0].n);
  await client.end();
}

main();
