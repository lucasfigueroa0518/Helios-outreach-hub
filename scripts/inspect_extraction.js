const fs = require('fs');
const { Client } = require('pg');

async function main() {
  const url = fs.readFileSync('.env.local', 'utf8')
    .split('\n')
    .map((line) => line.match(/^DIRECT_DATABASE_URL=(.*)$/)?.[1]?.replace(/\r$/, ''))
    .find(Boolean);
  const client = new Client({ connectionString: url, ssl: false });
  await client.connect();
  const r = await client.query(
    `SELECT u.file_name, u.extraction_summary
     FROM outreach.uploads u
     JOIN outreach.runs r ON r.id = u.run_id
     WHERE r.campaign_id = 'c7637c6d-41c7-4542-a658-611bba095189'`,
  );
  const summary = r.rows[0]?.extraction_summary;
  console.log('keys:', Object.keys(summary || {}));
  console.log('people_found:', summary?.people_found);
  console.log('result.people length:', summary?.result?.people?.length);
  console.log('first person:', summary?.result?.people?.[0]);
  const leads = await client.query('SELECT count(*)::int AS n FROM outreach.leads');
  console.log('leads in db:', leads.rows[0].n);
  await client.end();
}

main();
