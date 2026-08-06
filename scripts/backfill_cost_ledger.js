const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) process.env[match[1]] = match[2];
  }
}

async function run() {
  const { Pool } = require('pg');
  const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('DIRECT_DATABASE_URL is not set');
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: url,
    ssl: process.platform === 'win32' || process.env.PGSSLMODE === 'disable'
      ? false
      : { rejectUnauthorized: false },
    connectionTimeoutMillis: 20_000,
  });

  const { rows } = await pool.query(`
    SELECT DISTINCT j.drafting_item_id AS item_id
    FROM outreach.drafting_jobs j
    WHERE j.actual_cost_usd > 0
      AND j.status IN ('done', 'failed', 'superseded')
  `);

  let written = 0;
  for (const row of rows) {
    const existing = await pool.query(
      `SELECT id FROM outreach.lead_cost_events
       WHERE phase = 'drafting' AND source_kind = 'drafting_item' AND source_id = $1
       LIMIT 1`,
      [row.item_id],
    );
    if (existing.rows[0]) continue;

    const agg = await pool.query(
      `SELECT i.lead_id, w.campaign_id,
              coalesce(sum(j.actual_cost_usd), 0)::text AS cost_usd
       FROM outreach.drafting_items i
       JOIN outreach.drafting_workspaces w ON w.id = i.workspace_id
       LEFT JOIN outreach.drafting_jobs j
         ON j.drafting_item_id = i.id
        AND j.status IN ('done', 'failed', 'superseded')
       WHERE i.id = $1
       GROUP BY i.lead_id, w.campaign_id`,
      [row.item_id],
    );
    const target = agg.rows[0];
    if (!target || Number(target.cost_usd) <= 0) continue;

    await pool.query(
      `INSERT INTO outreach.lead_cost_events (
         lead_id, campaign_id, phase, actual_cost_usd, usage, source_kind, source_id
       ) VALUES ($1, $2, 'drafting', $3::numeric, $4::jsonb, 'drafting_item', $5)
       ON CONFLICT (phase, source_kind, source_id, lead_id) DO NOTHING`,
      [
        target.lead_id,
        target.campaign_id,
        target.cost_usd,
        JSON.stringify({ aggregatedFromJobs: true, backfill: true }),
        row.item_id,
      ],
    );
    written += 1;
  }

  await pool.end();
  console.log(`backfilled ${written} drafting lead cost event(s) from ${rows.length} item(s)`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
