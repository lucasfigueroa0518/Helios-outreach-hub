const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) process.env[match[1]] = match[2];
  }
}

const budget = process.env.DRAFTING_DEFAULT_BATCH_BUDGET_USD ?? '30.0000';
const concurrency = process.env.ORG_DRAFT_RESEARCH_CONCURRENCY ?? '4';
const mode = process.env.DRAFTING_MODE ?? 'stub';

async function main() {
  const { Pool } = require('pg');
  const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('DIRECT_DATABASE_URL is not set');
  const pool = new Pool({
    connectionString: url,
    ssl: process.platform === 'win32' ? false : { rejectUnauthorized: false },
  });
  let schemaInstalled = false;
  let workerHealthy = false;
  try {
    const schema = await pool.query(
      `SELECT to_regclass('outreach.orchestration_jobs') IS NOT NULL AS installed`,
    );
    schemaInstalled = Boolean(schema.rows[0]?.installed);
    if (schemaInstalled) {
      const worker = await pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM outreach.orchestration_workers
            WHERE heartbeat_at > now() - interval '45 seconds'
         ) AS healthy`,
      );
      workerHealthy = Boolean(worker.rows[0]?.healthy);
    }
  } finally {
    await pool.end();
  }

  const report = {
    orchestrator: process.env.ORCHESTRATOR ?? 'postgres',
    drafting_mode: mode,
    batch_budget_usd: budget,
    draft_research_concurrency: Number(concurrency),
    schema_installed: schemaInstalled,
    worker_healthy: workerHealthy,
    production_ok: mode === 'live' && schemaInstalled && workerHealthy,
    next_step: !schemaInstalled
      ? 'Run npm run db:orchestration.'
      : !workerHealthy
        ? 'Start a durable worker with npm run worker.'
        : 'Postgres orchestration is ready.',
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.production_ok ? 0 : 2);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
