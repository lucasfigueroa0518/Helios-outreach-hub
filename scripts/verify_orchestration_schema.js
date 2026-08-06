const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');

if (fs.existsSync('.env.local')) {
  for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) process.env[match[1]] = match[2];
  }
}

const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error('DIRECT_DATABASE_URL is not set');
const pool = new Pool({
  connectionString: url,
  ssl: process.platform === 'win32' ? false : { rejectUnauthorized: false },
  max: 5,
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function insertJob({ lane, dedupe, scope }) {
  return pool.query(
    `INSERT INTO outreach.orchestration_jobs (
       kind, lane, payload, dedupe_key, scope_key, max_attempts
     ) VALUES ('system.reconcile', $1, '{}'::jsonb, $2, $3, 3)
     ON CONFLICT (kind, dedupe_key) DO NOTHING
     RETURNING id`,
    [lane, dedupe, scope],
  );
}

async function claim(lane, worker, limit) {
  await pool.query(
    `INSERT INTO outreach.orchestration_workers (worker_id, heartbeat_at, metadata)
     VALUES ($1, now(), '{}'::jsonb)
     ON CONFLICT (worker_id) DO UPDATE SET heartbeat_at = now()`,
    [worker],
  );
  const result = await pool.query(
    `SELECT * FROM public.claim_orchestration_job($1, $2, $3, 60)`,
    [lane, worker, limit],
  );
  return result.rows[0] ?? null;
}

async function main() {
  const token = `verify-${crypto.randomUUID()}`;
  const laneOne = `${token}-limit`;
  const laneFair = `${token}-fair`;
  try {
    await insertJob({ lane: laneOne, dedupe: `${token}-one-a`, scope: 'scope-a' });
    await insertJob({ lane: laneOne, dedupe: `${token}-one-b`, scope: 'scope-b' });
    await insertJob({ lane: laneOne, dedupe: `${token}-one-a`, scope: 'scope-a' });
    const deduped = await pool.query(
      `SELECT count(*)::int AS count
         FROM outreach.orchestration_jobs
        WHERE dedupe_key LIKE $1`,
      [`${token}-one-%`],
    );
    assert(deduped.rows[0].count === 2, 'duplicate enqueue was not idempotent');

    const simultaneous = await Promise.all([
      claim(laneOne, `${token}-worker-a`, 1),
      claim(laneOne, `${token}-worker-b`, 1),
    ]);
    assert(
      simultaneous.filter(Boolean).length === 1,
      'global lane limit allowed more than one concurrent claim',
    );
    const owned = simultaneous.find(Boolean);
    const wrongHeartbeat = await pool.query(
      `SELECT public.heartbeat_orchestration_job($1, $2, 60) AS ok`,
      [owned.id, `${token}-wrong-worker`],
    );
    assert(wrongHeartbeat.rows[0].ok === false, 'non-owner refreshed a job lease');
    const ownerHeartbeat = await pool.query(
      `SELECT public.heartbeat_orchestration_job($1, $2, 60) AS ok`,
      [owned.id, owned.lease_owner],
    );
    assert(ownerHeartbeat.rows[0].ok === true, 'lease owner could not refresh lease');

    await pool.query(
      `DELETE FROM outreach.orchestration_workers WHERE worker_id = $1`,
      [owned.lease_owner],
    );
    const reclaimed = await claim(laneOne, `${token}-worker-c`, 1);
    assert(reclaimed?.id === owned.id, 'dead-owner lease was not reclaimed');
    assert(reclaimed.attempt_count === 2, 'lease reclaim did not increment attempt count');

    await insertJob({ lane: laneFair, dedupe: `${token}-fair-a1`, scope: 'campaign-a' });
    await insertJob({ lane: laneFair, dedupe: `${token}-fair-a2`, scope: 'campaign-a' });
    await insertJob({ lane: laneFair, dedupe: `${token}-fair-b1`, scope: 'campaign-b' });
    const first = await claim(laneFair, `${token}-fair-worker-1`, 3);
    const second = await claim(laneFair, `${token}-fair-worker-2`, 3);
    assert(first && second, 'fairness test could not claim two jobs');
    assert(first.scope_key !== second.scope_key, 'one campaign monopolized initial lane claims');

    console.log(JSON.stringify({
      ok: true,
      idempotency: true,
      global_lane_limit: true,
      lease_ownership: true,
      lease_recovery: true,
      initial_scope_fairness: true,
    }, null, 2));
  } finally {
    await pool.query(
      `DELETE FROM outreach.orchestration_jobs WHERE dedupe_key LIKE $1`,
      [`${token}%`],
    );
    await pool.query(
      `DELETE FROM outreach.orchestration_workers WHERE worker_id LIKE $1`,
      [`${token}%`],
    );
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
