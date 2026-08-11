/**
 * One-time copy: donor Helios Dashboards DB → Outreach Hub dashboards.* schema.
 *
 * Env:
 *   DIRECT_DATABASE_URL              — Outreach Hub target (required)
 *   DASHBOARDS_DONOR_DATABASE_URL    — donor Postgres (or load from donor .env.local)
 *
 * Never logs connection strings, passwords, or tokens.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const root = path.join(__dirname, '..');
const donorEnvPath = path.join(root, '..', 'helios-dashboards', '.env.local');

function loadEnvFile(filePath, into = process.env) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && into[match[1]] === undefined) into[match[1]] = match[2];
  }
}

loadEnvFile(path.join(root, '.env.local'));
loadEnvFile(donorEnvPath);

const targetUrl = process.env.DIRECT_DATABASE_URL;
const donorUrl =
  process.env.DASHBOARDS_DONOR_DATABASE_URL
  || process.env.DONOR_DIRECT_URL
  || process.env.DIRECT_URL;

if (!targetUrl) {
  console.error('DIRECT_DATABASE_URL is not set (Outreach Hub DB).');
  process.exit(1);
}
if (!donorUrl) {
  console.error(
    'Donor DB URL missing. Set DASHBOARDS_DONOR_DATABASE_URL or ensure '
    + 'helios-dashboards/.env.local has DIRECT_URL.',
  );
  process.exit(1);
}

function sslFor(url) {
  if (/localhost|127\.0\.0\.1/.test(url)) return undefined;
  return { rejectUnauthorized: false };
}

async function count(client, sql) {
  const { rows } = await client.query(sql);
  return Number(rows[0].n);
}

async function main() {
  const donor = new Client({ connectionString: donorUrl, ssl: sslFor(donorUrl) });
  const target = new Client({ connectionString: targetUrl, ssl: sslFor(targetUrl) });
  await donor.connect();
  await target.connect();

  try {
    const donorCounts = {
      clients: await count(donor, 'SELECT count(*)::int AS n FROM "Client"'),
      projects: await count(donor, 'SELECT count(*)::int AS n FROM "Project"'),
      events: await count(donor, 'SELECT count(*)::int AS n FROM "RepoEvent"'),
      updates: await count(donor, 'SELECT count(*)::int AS n FROM "ContextUpdate"'),
    };
    console.log('Donor row counts:', donorCounts);

    await target.query('BEGIN');

    // Idempotent re-run: replace dashboards product data (not github_tokens).
    await target.query('DELETE FROM dashboards.context_updates');
    await target.query('DELETE FROM dashboards.repo_events');
    await target.query('DELETE FROM dashboards.projects');
    await target.query('DELETE FROM dashboards.clients');

    const { rows: clients } = await donor.query(
      `SELECT id, name, "contactEmail" AS contact_email, "createdAt" AS created_at FROM "Client"`,
    );
    for (const row of clients) {
      await target.query(
        `INSERT INTO dashboards.clients (id, name, contact_email, created_at)
         VALUES ($1, $2, $3, $4)`,
        [row.id, row.name, row.contact_email, row.created_at],
      );
    }

    const { rows: projects } = await donor.query(`
      SELECT
        id,
        "clientId" AS client_id,
        name,
        status::text AS status,
        "startDate" AS start_date,
        "targetEndDate" AS target_end_date,
        "completedAt" AS completed_at,
        "accessToken" AS access_token,
        "githubRepo" AS github_repo,
        "githubBranch" AS github_branch,
        "githubLastSyncAt" AS github_last_sync_at,
        "lastSyncError" AS last_sync_error,
        "readmeMarkdown" AS readme_markdown,
        "readmeFetchedAt" AS readme_fetched_at,
        "deckPdfUrl" AS deck_pdf_url,
        "cronEnabled" AS cron_enabled,
        "cronStatus" AS cron_status,
        "mvpDelivered" AS mvp_delivered,
        "createdAt" AS created_at,
        "updatedAt" AS updated_at
      FROM "Project"
    `);
    for (const row of projects) {
      await target.query(
        `INSERT INTO dashboards.projects (
           id, client_id, name, status, start_date, target_end_date, completed_at,
           access_token, github_repo, github_branch, github_last_sync_at, last_sync_error,
           readme_markdown, readme_fetched_at, deck_pdf_url, deck_storage_path,
           cron_enabled, cron_status, mvp_delivered, created_at, updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,
           $8,$9,$10,$11,$12,
           $13,$14,$15,NULL,
           $16,$17,$18,$19,$20
         )`,
        [
          row.id,
          row.client_id,
          row.name,
          row.status,
          row.start_date,
          row.target_end_date,
          row.completed_at,
          row.access_token,
          row.github_repo ?? '',
          row.github_branch ?? 'main',
          row.github_last_sync_at,
          row.last_sync_error,
          row.readme_markdown,
          row.readme_fetched_at,
          row.deck_pdf_url,
          row.cron_enabled ?? true,
          row.cron_status ?? 'IDLE',
          row.mvp_delivered ?? false,
          row.created_at,
          row.updated_at,
        ],
      );
    }

    const { rows: events } = await donor.query(`
      SELECT
        id,
        "projectId" AS project_id,
        type::text AS type,
        "externalId" AS external_id,
        title,
        body,
        "authorName" AS author_name,
        "authorLogin" AS author_login,
        "authorAvatarUrl" AS author_avatar_url,
        url,
        "occurredAt" AS occurred_at,
        meta,
        "fetchedAt" AS fetched_at
      FROM "RepoEvent"
    `);
    for (const row of events) {
      await target.query(
        `INSERT INTO dashboards.repo_events (
           id, project_id, type, external_id, title, body,
           author_name, author_login, author_avatar_url, url,
           occurred_at, meta, fetched_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          row.id,
          row.project_id,
          row.type,
          row.external_id,
          row.title,
          row.body,
          row.author_name,
          row.author_login,
          row.author_avatar_url,
          row.url,
          row.occurred_at,
          row.meta,
          row.fetched_at,
        ],
      );
    }

    const { rows: updates } = await donor.query(`
      SELECT
        id,
        "projectId" AS project_id,
        bullets,
        "windowStart" AS window_start,
        "windowEnd" AS window_end,
        "generatedAt" AS generated_at,
        "generatedBy"::text AS generated_by
      FROM "ContextUpdate"
    `);
    for (const row of updates) {
      await target.query(
        `INSERT INTO dashboards.context_updates (
           id, project_id, bullets, window_start, window_end, generated_at, generated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          row.id,
          row.project_id,
          row.bullets,
          row.window_start,
          row.window_end,
          row.generated_at,
          row.generated_by === 'CRON' || row.generated_by === 'MANUAL'
            ? row.generated_by
            : 'CRON',
        ],
      );
    }

    await target.query('COMMIT');

    const targetCounts = {
      clients: await count(target, 'SELECT count(*)::int AS n FROM dashboards.clients'),
      projects: await count(target, 'SELECT count(*)::int AS n FROM dashboards.projects'),
      events: await count(target, 'SELECT count(*)::int AS n FROM dashboards.repo_events'),
      updates: await count(target, 'SELECT count(*)::int AS n FROM dashboards.context_updates'),
    };
    console.log('Target row counts:', targetCounts);

    const ok =
      targetCounts.clients === donorCounts.clients
      && targetCounts.projects === donorCounts.projects
      && targetCounts.events === donorCounts.events
      && targetCounts.updates === donorCounts.updates;
    if (!ok) {
      console.error('Row count mismatch after import.');
      process.exit(1);
    }
    console.log('Dashboards data migration complete.');
  } catch (err) {
    try { await target.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('Migration failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    await donor.end().catch(() => {});
    await target.end().catch(() => {});
  }
}

main();
