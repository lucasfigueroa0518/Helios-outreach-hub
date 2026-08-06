const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) process.env[match[1]] = match[2];
  }
}

const url = process.env.DIRECT_DATABASE_URL;
if (!url) {
  console.error('DIRECT_DATABASE_URL is not set (check .env.local)');
  process.exit(1);
}

const windowsPsql = 'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe';
const psql = process.env.PSQL_BIN
  || (process.platform === 'win32' && fs.existsSync(windowsPsql) ? windowsPsql : 'psql');
const schema = path.join(root, 'db', 'orchestration_schema.sql');
const result = spawnSync(psql, ['-d', url, '-v', 'ON_ERROR_STOP=1', '-f', schema], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    PGSSLMODE: process.platform === 'win32' ? 'disable' : (process.env.PGSSLMODE || 'require'),
  },
  shell: false,
});
if (result.status !== 0) process.exit(result.status ?? 1);

console.log('orchestration schema applied');
