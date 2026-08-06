const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

for (const l of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/\r$/, '');
}
const OUT = path.join(__dirname, 'conn_probe.out');
const write = (o) => fs.writeFileSync(OUT, JSON.stringify(o));

const hardTimer = setTimeout(() => { write({ status: 'HANG_TIMEOUT' }); process.exit(0); }, 15000);

(async () => {
  const c = new Client({
    connectionString: process.env.DIRECT_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 12000,
    statement_timeout: 8000,
  });
  try {
    await c.connect();
    const r = await c.query("select current_database() db, count(*)::int n from information_schema.tables where table_schema='public'");
    write({ status: 'OK', db: r.rows[0].db, public_tables: r.rows[0].n });
  } catch (e) {
    write({ status: 'ERR', error: e.message });
  } finally {
    clearTimeout(hardTimer);
    try { await c.end(); } catch {}
    process.exit(0);
  }
})();
