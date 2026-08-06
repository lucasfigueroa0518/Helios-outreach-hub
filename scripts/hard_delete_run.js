/**
 * Hard-cancel and hard-delete a stuck run: purge enrichment artifacts,
 * restage uploads, then remove the run row.
 */
const fs = require('fs');
const { Client } = require('pg');

const campaignId = process.argv[2];
const runId = process.argv[3];
if (!campaignId || !runId) {
  throw new Error('Usage: node scripts/hard_delete_run.js <campaign-id> <run-id>');
}

const url = fs.readFileSync('.env.local', 'utf8')
  .split(/\r?\n/)
  .map((line) => line.match(/^DIRECT_DATABASE_URL=(.*)$/)?.[1]?.replace(/\r$/, ''))
  .find(Boolean);

async function main() {
  const client = new Client({ connectionString: url, ssl: false });
  await client.connect();
  try {
    await client.query('BEGIN');

    const run = await client.query(
      `SELECT id, campaign_id, user_id, status
       FROM outreach.runs
       WHERE id = $1 AND campaign_id = $2
       FOR UPDATE`,
      [runId, campaignId],
    );
    if (!run.rows[0]) throw new Error(`Run not found: ${runId}`);

    await client.query(
      `UPDATE outreach.runs
       SET status = 'cancelled', error = 'Hard cancelled after worker crash', finished_at = now()
       WHERE id = $1`,
      [runId],
    );

    await client.query(
      `DELETE FROM outreach.company_research_jobs
       WHERE requested_by_runs @> ARRAY[$1::uuid]`,
      [runId],
    );

    const removedLeads = await client.query(
      `DELETE FROM outreach.campaign_leads
       WHERE campaign_id = $1 AND run_id = $2
       RETURNING lead_id`,
      [campaignId, runId],
    );
    const leadIds = [...new Set(removedLeads.rows.map((row) => row.lead_id))];
    if (leadIds.length) {
      await client.query(
        `DELETE FROM outreach.leads l
         WHERE l.id = ANY($1::uuid[])
           AND NOT EXISTS (SELECT 1 FROM outreach.campaign_leads cl WHERE cl.lead_id = l.id)`,
        [leadIds],
      );
    }

    const ownerId = run.rows[0].user_id;
    let staging = await client.query(
      `SELECT id FROM outreach.runs
       WHERE campaign_id = $1 AND user_id = $2 AND status = 'uploading'
       ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
      [campaignId, ownerId],
    );
    let stagingRunId = staging.rows[0]?.id;
    if (!stagingRunId) {
      const created = await client.query(
        `INSERT INTO outreach.runs (campaign_id, user_id, status)
         VALUES ($1, $2, 'uploading')
         RETURNING id`,
        [campaignId, ownerId],
      );
      stagingRunId = created.rows[0].id;
    }

    const movedUploads = await client.query(
      `UPDATE outreach.uploads u
       SET run_id = $2,
           status = 'uploaded',
           content_hash = NULL,
           extraction_summary = NULL
       WHERE u.run_id = $1
       RETURNING u.id`,
      [runId, stagingRunId],
    );

    await client.query(`DELETE FROM outreach.runs WHERE id = $1`, [runId]);

    await client.query('COMMIT');
    console.log(JSON.stringify({
      campaign_id: campaignId,
      deleted_run_id: runId,
      staging_run_id: stagingRunId,
      leads_deleted: leadIds.length,
      uploads_restaged: movedUploads.rows.length,
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
