// Cross-platform DB setup: loads .env.local, runs bootstrap + outreach_schema via psql.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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
  console.error('DIRECT_DATABASE_URL is not set (check .env.local)');
  process.exit(1);
}

function resolvePsql() {
  if (process.env.PSQL_BIN) return process.env.PSQL_BIN;
  const winDefault = 'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe';
  if (process.platform === 'win32' && fs.existsSync(winDefault)) return winDefault;
  return 'psql';
}

const psqlBin = resolvePsql();

// Windows + Supabase pooler: local OpenSSL TLS to the pooler needs disable.
process.env.PGSSLMODE = process.platform === 'win32'
  ? 'disable'
  : (process.env.PGSSLMODE || 'require');

const files = [
  'db/bootstrap.sql',
  'db/outreach_schema.sql',
  'db/drafting_schema.sql',
  'db/migrate_duration_aware_timeliness_v2.sql',
  'db/migrate_draft_generation_mode.sql',
  'db/cost_ledger_schema.sql',
  'db/orchestration_schema.sql',
  'db/analytics_schema.sql',
];
for (const file of files) {
  console.log(`\n── ${file} ──`);
  const r = spawnSync(psqlBin, ['-d', url, '-v', 'ON_ERROR_STOP=1', '-f', path.join(root, file)], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    shell: false,
  });
  if (r.status !== 0) {
    console.error(`Failed: ${file} (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

console.log('\nDB setup complete.');
