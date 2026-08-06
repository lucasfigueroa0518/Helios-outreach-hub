/**
 * Hard-delete enrichment artifacts for one campaign so the next Enrich run is blind.
 * Keeps staged uploads + the active uploading run; removes leads, research jobs,
 * extraction summaries, content hashes, and terminal/cancelled run history.
 */
const fs = require('fs');
const { Client } = require('pg');

async function main() {
  const campaignId = process.argv[2];
  if (!campaignId) throw new Error('Usage: node scripts/purge_campaign_enrichment.js <campaign-id>');

  const env = Object.create(null);
  for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[m[1]] = v;
  }
  let url = env.DIRECT_DATABASE_URL || env.DATABASE_URL;
  if (!url) throw new Error('No DIRECT_DATABASE_URL / DATABASE_URL in .env.local');
  if (process.platform === 'win32' && !/[?&]sslmode=/.test(url)) {
    url = `${url}${url.includes('?') ? '&' : '?'}sslmode=disable`;
  }
  const client = new Client({ connectionString: url, ssl: false });
  await client.connect();

  try {
    await client.query('BEGIN');

    const runs = await client.query(
      `SELECT id, status FROM outreach.runs WHERE campaign_id = $1 ORDER BY started_at`,
      [campaignId],
    );
    const runIds = runs.rows.map((row) => row.id);
    const staging = runs.rows.find((row) => row.status === 'uploading');

    if (!runIds.length) {
      console.log('No runs found for campaign — nothing to purge.');
      await client.query('ROLLBACK');
      return;
    }

    const jobs = await client.query(
      `DELETE FROM outreach.company_research_jobs
       WHERE requested_by_runs && $1::uuid[]
       RETURNING id`,
      [runIds],
    );

    const campaignLeads = await client.query(
      `DELETE FROM outreach.campaign_leads WHERE campaign_id = $1 RETURNING lead_id`,
      [campaignId],
    );
    const leadIds = [...new Set(campaignLeads.rows.map((row) => row.lead_id))];

    let leadsDeleted = 0;
    if (leadIds.length) {
      const orphanLeads = await client.query(
        `DELETE FROM outreach.leads l
         WHERE l.id = ANY($1::uuid[])
           AND NOT EXISTS (
             SELECT 1 FROM outreach.campaign_leads cl WHERE cl.lead_id = l.id
           )
         RETURNING l.id`,
        [leadIds],
      );
      leadsDeleted = orphanLeads.rows.length;
    }

    const uploadsReset = await client.query(
      `UPDATE outreach.uploads u
       SET status = 'uploaded',
           content_hash = NULL,
           extraction_summary = NULL
       FROM outreach.runs r
       WHERE u.run_id = r.id
         AND r.campaign_id = $1
         AND u.status IN ('uploaded', 'processing', 'extracted', 'failed', 'failed_quality')
       RETURNING u.id`,
      [campaignId],
    );

    // Prefer an existing uploading run; otherwise keep the run that owns uploads.
    let keepRunId = staging?.id ?? null;
    if (!keepRunId) {
      const owner = await client.query(
        `SELECT u.run_id
           FROM outreach.uploads u
           JOIN outreach.runs r ON r.id = u.run_id
          WHERE r.campaign_id = $1
          ORDER BY u.created_at DESC NULLS LAST
          LIMIT 1`,
        [campaignId],
      );
      keepRunId = owner.rows[0]?.run_id ?? runIds[runIds.length - 1];
    }

    // Move uploads off terminal runs so FK delete can succeed.
    const moved = await client.query(
      `UPDATE outreach.uploads u
          SET run_id = $2
         FROM outreach.runs r
        WHERE u.run_id = r.id
          AND r.campaign_id = $1
          AND u.run_id <> $2
        RETURNING u.id`,
      [campaignId, keepRunId],
    );

    const terminalRuns = runIds.filter((id) => id !== keepRunId);
    let runsDeleted = 0;
    if (terminalRuns.length) {
      const deletedRuns = await client.query(
        `DELETE FROM outreach.runs
         WHERE id = ANY($1::uuid[])
         RETURNING id`,
        [terminalRuns],
      );
      runsDeleted = deletedRuns.rows.length;
    }

    await client.query(
      `UPDATE outreach.runs
       SET status = 'uploading', error = NULL, finished_at = NULL, stats = '{}'::jsonb
       WHERE id = $1`,
      [keepRunId],
    );

    await client.query('COMMIT');

    console.log(JSON.stringify({
      campaign_id: campaignId,
      research_jobs_deleted: jobs.rows.length,
      campaign_leads_deleted: campaignLeads.rows.length,
      leads_deleted: leadsDeleted,
      uploads_reset: uploadsReset.rows.length,
      uploads_moved_to_staging: moved.rows.length,
      runs_deleted: runsDeleted,
      staging_run_id: keepRunId,
    }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
