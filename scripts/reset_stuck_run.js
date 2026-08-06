const fs = require('fs');
const { Client } = require('pg');

async function main() {
  const url = fs.readFileSync('.env.local', 'utf8')
    .split('\n')
    .map((line) => line.match(/^DIRECT_DATABASE_URL=(.*)$/)?.[1]?.replace(/\r$/, ''))
    .find(Boolean);
  const client = new Client({ connectionString: url, ssl: false });
  await client.connect();

  const active = await client.query(
    `SELECT r.id, r.status, count(u.id)::int AS uploads,
            count(*) FILTER (WHERE u.status = 'processing')::int AS processing
     FROM outreach.runs r
     LEFT JOIN outreach.uploads u ON u.run_id = r.id
     WHERE r.status IN ('queued', 'extracting')
     GROUP BY r.id, r.status`,
  );
  console.log('Active runs:', JSON.stringify(active.rows, null, 2));

  for (const run of active.rows) {
    await client.query(
      `UPDATE outreach.runs
       SET status = 'cancelled', error = 'Reset after worker crash', finished_at = now()
       WHERE id = $1`,
      [run.id],
    );
    await client.query(
      `UPDATE outreach.uploads
       SET status = 'uploaded', extraction_summary = NULL
       WHERE run_id = $1 AND status = 'processing'`,
      [run.id],
    );
    console.log(`Reset run ${run.id}`);
  }

  await client.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
