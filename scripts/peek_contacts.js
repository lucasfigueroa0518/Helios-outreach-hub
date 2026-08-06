const fs = require('fs');
const { Client } = require('pg');

for (const l of fs.readFileSync(require('path').join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await c.connect();
    const exists = await c.query("select to_regclass('public.contacts') as t");
    if (!exists.rows[0].t) {
      console.log(JSON.stringify({ status: 'NO_TABLE' }));
      return;
    }
    const cnt = await c.query('select count(*)::int as n from contacts');
    console.log(JSON.stringify({ status: 'OK', rows: cnt.rows[0].n }));
  } catch (e) {
    console.log(JSON.stringify({ status: 'ERR', error: e.message }));
  } finally {
    await c.end();
  }
})();
