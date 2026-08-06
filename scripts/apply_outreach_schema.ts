import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

const url = process.env.DIRECT_DATABASE_URL;
if (!url) {
  console.error('DIRECT_DATABASE_URL missing');
  process.exit(1);
}

process.env.PGSSLMODE = 'disable';
const psql = process.platform === 'win32' && fs.existsSync('C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe')
  ? 'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe'
  : 'psql';

const result = spawnSync(
  psql,
  ['-d', url, '-v', 'ON_ERROR_STOP=1', '-f', path.join(root, 'db', 'outreach_schema.sql')],
  { stdio: 'inherit', env: process.env },
);

if (result.status !== 0) process.exit(result.status ?? 1);
console.log('outreach_schema.sql applied');
