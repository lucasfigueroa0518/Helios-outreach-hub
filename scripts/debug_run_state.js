const fs = require('fs');
const { Client } = require('pg');

const url = fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)
  .map((line) => line.match(/^DIRECT_DATABASE_URL=(.*)$/)?.[1])
  .find(Boolean);

(async () => {
  const client = new Client({ connectionString: url, ssl: false });
  await client.connect();
  const campaigns = await client.query(
    'SELECT c.id, c.name FROM outreach.campaigns c ORDER BY c.updated_at DESC LIMIT 5',
  );
  for (const camp of campaigns.rows) {
    const runs = await client.query(
      `SELECT id, status, started_at, finished_at, error
       FROM outreach.runs WHERE campaign_id = $1 ORDER BY started_at DESC LIMIT 8`,
      [camp.id],
    );
    const uploads = await client.query(
      `SELECT u.id, u.file_name, u.status, r.status AS run_status, r.id AS run_id
       FROM outreach.uploads u
       JOIN outreach.runs r ON r.id = u.run_id
       WHERE r.campaign_id = $1
       ORDER BY u.created_at DESC LIMIT 10`,
      [camp.id],
    );
    const counts = await client.query(
      `SELECT
         (SELECT count(*)::int FROM outreach.uploads u
          JOIN outreach.runs r ON r.id = u.run_id
          WHERE r.campaign_id = $1 AND r.status = 'uploading' AND u.status = 'uploaded') AS staged,
         (SELECT count(*)::int FROM outreach.uploads u
          JOIN outreach.runs r ON r.id = u.run_id
          WHERE r.campaign_id = $1 AND r.status IN ('cancelled', 'failed')
            AND u.status IN ('uploaded', 'processing')) AS retryable,
         (SELECT count(*)::int FROM outreach.runs
          WHERE campaign_id = $1 AND status IN ('queued', 'extracting', 'enriching')) AS active_runs`,
      [camp.id],
    );
    console.log(JSON.stringify({ campaign: camp.name, counts: counts.rows[0], runs: runs.rows, uploads: uploads.rows }, null, 2));
  }
  await client.end();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
