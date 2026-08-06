import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { Pool, type PoolClient } from 'pg';

const root = process.cwd();

function loadLocalEnv(): void {
  const envPath = join(root, '.env.local');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function resolvePsql(): string {
  if (process.env.PSQL_BIN) return process.env.PSQL_BIN;
  const windowsDefault = 'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe';
  return process.platform === 'win32' && existsSync(windowsDefault) ? windowsDefault : 'psql';
}

function installProductionCostSql(connectionString: string, dataSchema: string, functionSchema: string): void {
  const result = spawnSync(resolvePsql(), [
    '-d', connectionString,
    '-v', 'ON_ERROR_STOP=1',
    '-v', `drafting_data_schema=${dataSchema}`,
    '-v', `drafting_function_schema=${functionSchema}`,
    '-f', join(root, 'db', 'drafting_cost_persistence.sql'),
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PGSSLMODE: process.platform === 'win32' ? 'disable' : (process.env.PGSSLMODE || 'require'),
    },
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`Production cost SQL install failed:\n${result.stdout}\n${result.stderr}`);
  }
}

async function scalar(client: PoolClient, sql: string, params: unknown[] = []): Promise<string> {
  const result = await client.query<{ value: string }>(sql, params);
  assert.ok(result.rows[0]);
  return String(result.rows[0].value);
}

async function main(): Promise<void> {
loadLocalEnv();
const connectionString = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error('DIRECT_DATABASE_URL or DATABASE_URL is not set in .env.local');

const suffix = randomUUID().replaceAll('-', '');
const dataSchema = `draft_cost_it_${suffix}`;
const functionSchema = `draft_cost_fn_it_${suffix}`;
const data = quoteIdent(dataSchema);
const fn = quoteIdent(functionSchema);
const pool = new Pool({
  connectionString: process.platform === 'win32'
    ? `${connectionString}${connectionString.includes('?') ? '&' : '?'}sslmode=disable`
    : connectionString,
  ssl: process.platform === 'win32' ? false : { rejectUnauthorized: false },
  max: 1,
});

let client: PoolClient | null = null;
let campaignCountBefore: string | null = null;
let testError: unknown;
try {
  client = await pool.connect();
  campaignCountBefore = await scalar(
    client,
    `SELECT count(*)::text AS value FROM outreach.campaigns`,
  );

  await client.query(`CREATE SCHEMA ${data}`);
  await client.query(`CREATE SCHEMA ${fn}`);
  console.log(`created disposable schemas: ${dataSchema}, ${functionSchema}`);

  await client.query(`
    CREATE TABLE ${data}.campaigns (id uuid PRIMARY KEY);
    CREATE TABLE ${data}.drafting_workspaces (
      id uuid PRIMARY KEY,
      campaign_id uuid NOT NULL REFERENCES ${data}.campaigns(id)
    );
    CREATE TABLE ${data}.drafting_runs (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL REFERENCES ${data}.drafting_workspaces(id),
      actual_cost_usd numeric(10, 4) NOT NULL DEFAULT 0,
      started_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE ${data}.drafting_items (id uuid PRIMARY KEY);
    CREATE TABLE ${data}.drafting_jobs (
      id uuid PRIMARY KEY,
      drafting_run_id uuid NOT NULL REFERENCES ${data}.drafting_runs(id),
      drafting_item_id uuid NOT NULL REFERENCES ${data}.drafting_items(id),
      execution_epoch int NOT NULL DEFAULT 0,
      attempt_count int NOT NULL DEFAULT 0,
      actual_cost_usd numeric(10, 4) NOT NULL DEFAULT 0,
      provider_request_id text,
      usage jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz
    );
  `);

  const legacyCampaignId = randomUUID();
  const legacyWorkspaceId = randomUUID();
  const legacyRunId = randomUUID();
  const legacyItemId = randomUUID();
  const legacyJobId = randomUUID();
  await client.query(`INSERT INTO ${data}.campaigns VALUES ($1)`, [legacyCampaignId]);
  await client.query(`INSERT INTO ${data}.drafting_workspaces VALUES ($1, $2)`, [
    legacyWorkspaceId,
    legacyCampaignId,
  ]);
  await client.query(
    `INSERT INTO ${data}.drafting_runs (id, workspace_id, actual_cost_usd) VALUES ($1, $2, 1.5000)`,
    [legacyRunId, legacyWorkspaceId],
  );
  await client.query(`INSERT INTO ${data}.drafting_items VALUES ($1)`, [legacyItemId]);
  await client.query(`
    INSERT INTO ${data}.drafting_jobs (
      id, drafting_run_id, drafting_item_id, execution_epoch, attempt_count,
      actual_cost_usd, provider_request_id, usage, finished_at
    ) VALUES ($1, $2, $3, 2, 3, 0.4000, 'legacy-provider', '{"legacy":true}', now())
  `, [legacyJobId, legacyRunId, legacyItemId]);

  installProductionCostSql(connectionString, dataSchema, functionSchema);
  assert.equal(await scalar(client, `
    SELECT actual_cost_usd::text AS value
      FROM ${data}.drafting_run_cost_opening_balances
     WHERE drafting_run_id = $1
  `, [legacyRunId]), '1.1000');
  assert.equal(await scalar(client, `
    SELECT evidence->>'attribution' AS value
      FROM ${data}.drafting_run_cost_opening_balances
     WHERE drafting_run_id = $1
  `, [legacyRunId]), 'unavailable');
  assert.equal(await scalar(client, `
    SELECT count(*)::text AS value
      FROM ${data}.drafting_job_cost_events
     WHERE drafting_run_id = $1
  `, [legacyRunId]), '1');

  installProductionCostSql(connectionString, dataSchema, functionSchema);
  assert.equal(await scalar(client, `
    SELECT count(*)::text AS value
      FROM ${data}.drafting_run_cost_opening_balances
     WHERE drafting_run_id = $1
  `, [legacyRunId]), '1');
  assert.equal(await scalar(client, `
    SELECT actual_cost_usd::text AS value
      FROM ${data}.drafting_run_cost_opening_balances
     WHERE drafting_run_id = $1
  `, [legacyRunId]), '1.1000');

  const campaignId = randomUUID();
  const workspaceId = randomUUID();
  const runId = randomUUID();
  const itemId = randomUUID();
  const jobId = randomUUID();
  await client.query(`INSERT INTO ${data}.campaigns VALUES ($1)`, [campaignId]);
  await client.query(`INSERT INTO ${data}.drafting_workspaces VALUES ($1, $2)`, [
    workspaceId,
    campaignId,
  ]);
  await client.query(`INSERT INTO ${data}.drafting_runs (id, workspace_id) VALUES ($1, $2)`, [
    runId,
    workspaceId,
  ]);
  await client.query(`INSERT INTO ${data}.drafting_items VALUES ($1)`, [itemId]);
  await client.query(`
    INSERT INTO ${data}.drafting_jobs (
      id, drafting_run_id, drafting_item_id, execution_epoch, attempt_count
    ) VALUES ($1, $2, $3, 1, 1)
  `, [jobId, runId, itemId]);

  const callCostFunction = async (
    cost: string,
    providerRequestId: string,
    eventKey: string,
  ): Promise<boolean> => {
    const result = await client!.query<{ inserted: boolean }>(
      `SELECT ${fn}.record_drafting_job_cost_event($1, $2, $3, $4, $5) AS inserted`,
      [jobId, cost, { stage: eventKey }, providerRequestId, eventKey],
    );
    return result.rows[0]?.inserted === true;
  };
  const totals = async (): Promise<[string, string, string]> => {
    const result = await client!.query<{ job_total: string; run_total: string; event_count: string }>(`
      SELECT job.actual_cost_usd::text AS job_total,
             run.actual_cost_usd::text AS run_total,
             count(event.id)::text AS event_count
        FROM ${data}.drafting_jobs job
        JOIN ${data}.drafting_runs run ON run.id = job.drafting_run_id
        LEFT JOIN ${data}.drafting_job_cost_events event ON event.drafting_job_id = job.id
       WHERE job.id = $1
       GROUP BY job.actual_cost_usd, run.actual_cost_usd
    `, [jobId]);
    const row = result.rows[0];
    assert.ok(row);
    return [row.job_total, row.run_total, row.event_count];
  };

  assert.equal(await callCostFunction('0.2500', 'provider-write-1', 'write:provider-write-1'), true);
  assert.deepEqual(await totals(), ['0.2500', '0.2500', '1']);
  assert.equal(await callCostFunction('0.2500', 'provider-write-1', 'write:provider-write-1'), false);
  assert.deepEqual(await totals(), ['0.2500', '0.2500', '1']);
  assert.equal(await callCostFunction('0.1000', 'provider-write-2', 'write:provider-write-2'), true);
  assert.deepEqual(await totals(), ['0.3500', '0.3500', '2']);

  assert.equal(await callCostFunction('0.0750', 'provider-write-before-repair', 'write:before-repair'), true);
  await client.query('BEGIN');
  try {
    await client.query(`UPDATE ${data}.drafting_items SET id = id WHERE id = $1`, [itemId]);
    await client.query('SELECT 1 / 0');
    assert.fail('simulated downstream repair transaction should fail');
  } catch {
    await client.query('ROLLBACK');
  }
  assert.equal(await scalar(client, `
    SELECT count(*)::text AS value
      FROM ${data}.drafting_job_cost_events
     WHERE drafting_job_id = $1 AND event_key = 'write:before-repair'
  `, [jobId]), '1');
  assert.deepEqual(await totals(), ['0.4250', '0.4250', '3']);

  await client.query('BEGIN');
  try {
    assert.equal(await callCostFunction('0.0500', 'provider-rolled-back', 'write:rolled-back'), true);
    await client.query('SELECT 1 / 0');
    assert.fail('cost transaction should fail');
  } catch {
    await client.query('ROLLBACK');
  }
  assert.equal(await scalar(client, `
    SELECT count(*)::text AS value
      FROM ${data}.drafting_job_cost_events
     WHERE drafting_job_id = $1 AND event_key = 'write:rolled-back'
  `, [jobId]), '0');
  assert.deepEqual(await totals(), ['0.4250', '0.4250', '3']);

  assert.equal(
    await scalar(client, `SELECT count(*)::text AS value FROM outreach.campaigns`),
    campaignCountBefore,
  );
  console.log('verified real outreach.campaigns count unchanged');
} catch (error) {
  testError = error;
} finally {
  if (client) {
    try {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${fn} CASCADE`);
      await client.query(`DROP SCHEMA IF EXISTS ${data} CASCADE`);
      const residue = await client.query<{ data_exists: boolean; function_exists: boolean }>(
        `SELECT to_regnamespace($1) IS NOT NULL AS data_exists,
                to_regnamespace($2) IS NOT NULL AS function_exists`,
        [dataSchema, functionSchema],
      );
      assert.deepEqual(residue.rows[0], { data_exists: false, function_exists: false });
      console.log(`dropped disposable schemas: ${dataSchema}, ${functionSchema}; residue=false`);
    } catch (cleanupError) {
      testError = testError
        ? new AggregateError([testError, cleanupError], 'Integration assertion and cleanup both failed')
        : cleanupError;
    } finally {
      client.release();
    }
  }
  await pool.end();
}

if (testError) throw testError;
console.log('drafting cost PostgreSQL persistence integration passed');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
