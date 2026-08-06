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
const schema = path.join(root, 'db', 'outreach_schema.sql');
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

const verificationSql = `
SELECT
  (SELECT count(*) = 2
     FROM information_schema.columns
    WHERE table_schema = 'outreach'
      AND table_name = 'company_research_jobs'
      AND column_name IN ('search_budget', 'searches_used'))
  AND position(
    'v_target_count' IN pg_get_functiondef(
      'public.enqueue(text,jsonb,uuid,text)'::regprocedure
    )
  ) > 0 AS research_budget_schema_ok;
`;
const verification = spawnSync(psql, [
  '-d', url, '-v', 'ON_ERROR_STOP=1', '-tAc', verificationSql,
], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    PGSSLMODE: process.platform === 'win32' ? 'disable' : (process.env.PGSSLMODE || 'require'),
  },
  shell: false,
});
process.exit(verification.status ?? 1);
