const fs = require('fs');
const { Client } = require('pg');

const url = fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)
  .map((line) => line.match(/^DIRECT_DATABASE_URL=(.*)$/)?.[1])
  .find(Boolean);

(async () => {
  const client = new Client({ connectionString: url, ssl: false });
  await client.connect();
  await client.query('BEGIN');
  try {
    const user = await client.query(
      `INSERT INTO outreach.users (email, display_name)
       VALUES ($1, 'M6 Fixture') RETURNING id`,
      [`m6-fixture-${Date.now()}@embarkwithus.com`],
    );
    const campaign = await client.query(
      `INSERT INTO outreach.campaigns (owner_id, name)
       VALUES ($1, 'M6 Fixture') RETURNING id`,
      [user.rows[0].id],
    );
    const run = await client.query(
      `INSERT INTO outreach.runs (campaign_id, user_id, status)
       VALUES ($1, $2, 'enriching') RETURNING id`,
      [campaign.rows[0].id, user.rows[0].id],
    );
    const first = await client.query(
      `SELECT public.enqueue('fixture-company:fixture-context', $1::jsonb, $2) AS id`,
      [JSON.stringify({ company_name: 'Fixture Company', people: [] }), run.rows[0].id],
    );
    const second = await client.query(
      `SELECT public.enqueue('fixture-company:fixture-context', $1::jsonb, $2) AS id`,
      [JSON.stringify({ company_name: 'Fixture Company', people: [] }), run.rows[0].id],
    );
    if (first.rows[0].id !== second.rows[0].id) throw new Error('enqueue is not idempotent');

    const claimed = await client.query(
      `SELECT * FROM public.claim_research_job($1)`,
      [first.rows[0].id],
    );
    if (claimed.rows.length !== 1 || claimed.rows[0].status !== 'in_flight') {
      throw new Error('claim_research_job did not atomically claim the fixture');
    }
    const duplicateClaim = await client.query(
      `SELECT * FROM public.claim_research_job($1)`,
      [first.rows[0].id],
    );
    if (duplicateClaim.rows.length !== 0) throw new Error('job was double-claimed');

    const finished = await client.query(
      `SELECT public.finish_research_job($1, 'done', 'fixture.example', NULL) AS runs`,
      [first.rows[0].id],
    );
    if (!finished.rows[0].runs.includes(run.rows[0].id)) {
      throw new Error('finish_research_job did not identify the completed run');
    }
    console.log('M6 SQL fixture passed.');
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
