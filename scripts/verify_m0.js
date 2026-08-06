// M0 acceptance checks — Helios no longer requires Embark SF seed tables.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/\r$/, '');
  }
}

const url = process.env.DIRECT_DATABASE_URL;
if (!url) {
  console.error('DIRECT_DATABASE_URL missing');
  process.exit(1);
}
process.env.PGSSLMODE = process.platform === 'win32'
  ? 'disable'
  : (process.env.PGSSLMODE || 'require');

const connUrl = process.env.PGSSLMODE === 'disable'
  ? `${url}${url.includes('?') ? '&' : '?'}sslmode=disable`
  : url;

(async () => {
  const c = new Client({
    connectionString: connUrl,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  });
  await c.connect();

  const retired = [
    'accounts',
    'contacts',
    'opportunities',
    'call_participants',
    'pitchbook_firms',
    'pitchbook_sister_cos',
  ];
  const remaining = await c.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      ORDER BY table_name`,
    [retired],
  );
  if (remaining.rows.length > 0) {
    console.error(
      'Retired Embark SF tables still present:',
      remaining.rows.map((row) => row.table_name),
    );
    process.exit(1);
  }

  const allPeople = await c.query(
    `SELECT 1
       FROM information_schema.views
      WHERE table_schema = 'outreach' AND table_name = 'all_people'`,
  );
  if ((allPeople.rowCount ?? 0) > 0) {
    console.error('Retired view outreach.all_people still present');
    process.exit(1);
  }

  const draftingResolutions = await c.query(
    `SELECT 1
       FROM information_schema.tables
      WHERE table_schema = 'outreach' AND table_name = 'drafting_resolutions'`,
  );
  if ((draftingResolutions.rowCount ?? 0) > 0) {
    console.error('Retired table outreach.drafting_resolutions still present');
    process.exit(1);
  }

  const sim = await c.query(`SELECT similarity('TA Associates', 'ta associates llc') AS s`);

  const outreachTables = await c.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'outreach' ORDER BY table_name
  `);

  const fns = await c.query(`
    SELECT routine_name FROM information_schema.routines
    WHERE routine_schema = 'public'
      AND routine_name IN ('enqueue', 'claim_research_jobs', 'finish_research_job')
    ORDER BY routine_name
  `);

  console.log('Retired Embark SF tables: absent (ok)');
  console.log('similarity():', sim.rows[0].s);
  console.log('outreach tables:', outreachTables.rows.map((r) => r.table_name));
  console.log('RPC functions:', fns.rows.map((r) => r.routine_name));

  await c.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
