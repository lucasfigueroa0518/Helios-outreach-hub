// Cancels queued/extracting runs without deleting their source uploads.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (match) process.env[match[1]] = match[2].replace(/\r$/, '');
}

(async () => {
  const url = `${process.env.DIRECT_DATABASE_URL}${process.env.DIRECT_DATABASE_URL.includes('?') ? '&' : '?'}sslmode=disable`;
  const client = new Client({ connectionString: url, ssl: false });
  await client.connect();
  const result = await client.query(
    `UPDATE outreach.runs
     SET status = 'cancelled',
         error = 'Cancelled by user',
         finished_at = now()
     WHERE status IN ('queued', 'extracting')
     RETURNING id, campaign_id, status`,
  );
  console.log(JSON.stringify({ cancelled: result.rows }, null, 2));
  await client.end();
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
