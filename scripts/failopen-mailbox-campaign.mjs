import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) process.env[match[1]] = match[2];
  }
}

const campaignId = process.argv[2] || '2e600d5a-3998-4174-9814-00039a7de9d7';
const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error('No DATABASE_URL');

const pool = new pg.Pool({
  connectionString: process.platform === 'win32'
    ? `${url}${url.includes('?') ? '&' : '?'}sslmode=disable`
    : url,
  max: 1,
});

async function main() {
  const runs = await pool.query(
    `SELECT DISTINCT cl.run_id::text AS run_id
       FROM outreach.campaign_leads cl
      WHERE cl.campaign_id = $1 AND cl.run_id IS NOT NULL`,
    [campaignId],
  );
  console.log(JSON.stringify({ campaignId, runs: runs.rows }, null, 2));

  for (const row of runs.rows) {
    const hit = await pool.query(
      `SELECT EXISTS (
         SELECT 1
           FROM outreach.campaign_leads cl
           JOIN outreach.leads l ON l.id = cl.lead_id
          WHERE cl.run_id = $1
            AND l.email_verification = 'rate_limited'
       ) AS hit`,
      [row.run_id],
    );
    const already = Boolean(hit.rows[0]?.hit);
    console.log('run', row.run_id, 'alreadyRateLimited', already);
    if (!already) continue;

    await pool.query(
      `UPDATE outreach.orchestration_jobs
          SET status = 'cancelled',
              lease_owner = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              finished_at = now(),
              updated_at = now()
        WHERE scope_key = $1
          AND kind IN ('mailbox.lead', 'mailbox.run')
          AND status = 'pending'`,
      [row.run_id],
    );

    const updated = await pool.query(
      `UPDATE outreach.leads l
          SET email_verification = 'rate_limited',
              email_verified_at = now(),
              updated_at = now()
         FROM outreach.campaign_leads cl
        WHERE cl.lead_id = l.id
          AND cl.run_id = $1
          AND l.email_primary IS NOT NULL
          AND (
            l.email_verification IS NULL
            OR l.email_verification IN ('pending', 'unknown')
          )
        RETURNING l.id`,
      [row.run_id],
    );
    console.log('failOpened', updated.rowCount);
  }

  const summary = await pool.query(
    `SELECT l.email_verification, l.email_status, count(*)::int AS n
       FROM outreach.campaign_leads cl
       JOIN outreach.leads l ON l.id = cl.lead_id
      WHERE cl.campaign_id = $1
      GROUP BY 1, 2
      ORDER BY 1 NULLS FIRST, 2`,
    [campaignId],
  );
  console.log('summary', summary.rows);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
