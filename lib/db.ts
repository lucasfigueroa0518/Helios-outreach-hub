import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

const globalPool = globalThis as typeof globalThis & {
  __outreachHubPool?: Pool;
};

/**
 * Runtime connection selection for the reference hub.
 *
 * Prefer DIRECT_DATABASE_URL (Supabase session pooler :5432). Transaction
 * pooler (:6543) is often unreachable from Windows/local networks and breaks
 * node-pg prepared statements unless prepareThreshold is 0.
 *
 * Session mode has a hard pool_size (~15). Safety for hundreds of Enrich leads
 * comes from tiny PG_POOL_MAX + one worker lock + low orch concurrency — not
 * from opening dozens of clients. Set OUTREACH_DB_USE_TRANSACTION_POOLER=1 to
 * force DATABASE_URL (:6543) when that path is reachable.
 */
function connectionString(): string {
  const forceTransaction = process.env.OUTREACH_DB_USE_TRANSACTION_POOLER === '1';
  const url = forceTransaction
    ? (process.env.DATABASE_URL || process.env.DIRECT_DATABASE_URL)
    : (process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL);
  if (!url) throw new Error('DATABASE_URL or DIRECT_DATABASE_URL is not set');
  if (process.platform === 'win32') {
    return `${url}${url.includes('?') ? '&' : '?'}sslmode=disable`;
  }
  return url;
}

function poolMax(): number {
  // Next + worker each open a pool. Default 2 so both fit under Supabase
  // session pool_size (~15) with headroom for psql/scripts/HMR leftovers.
  const parsed = Number(process.env.PG_POOL_MAX ?? 2);
  if (!Number.isFinite(parsed)) return 2;
  return Math.max(1, Math.min(8, Math.floor(parsed)));
}

function isPoolExhaustedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /EMAXCONNSESSION|max clients reached|remaining connection slots/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPool(): Pool {
  if (!globalPool.__outreachHubPool) {
    globalPool.__outreachHubPool = new Pool({
      connectionString: connectionString(),
      ssl: process.platform === 'win32' ? false : { rejectUnauthorized: false },
      max: poolMax(),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
      allowExitOnIdle: true,
    });
  }
  return globalPool.__outreachHubPool;
}

export async function dbQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await getPool().query<T>(text, params);
    } catch (error) {
      lastError = error;
      if (!isPoolExhaustedError(error) || attempt === maxAttempts) throw error;
      // Brief backoff so idle clients can return to the Supabase session pool.
      await sleep(150 * attempt);
    }
  }
  throw lastError;
}

/** Run related writes atomically. Roll back automatically when the callback throws. */
export async function dbTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      lastError = error;
      if (!isPoolExhaustedError(error) || attempt === maxAttempts) throw error;
      await sleep(150 * attempt);
    }
  }
  throw lastError;
}

/** Drain the shared pool (tests / graceful worker shutdown). */
export async function closeDbPool(): Promise<void> {
  if (!globalPool.__outreachHubPool) return;
  const pool = globalPool.__outreachHubPool;
  globalPool.__outreachHubPool = undefined;
  await pool.end();
}

/** Low-cardinality pool pressure snapshot; never includes connection details. */
export function dbPoolSnapshot(): {
  configuredMax: number;
  total: number;
  idle: number;
  waiting: number;
} {
  const pool = globalPool.__outreachHubPool;
  return {
    configuredMax: poolMax(),
    total: pool?.totalCount ?? 0,
    idle: pool?.idleCount ?? 0,
    waiting: pool?.waitingCount ?? 0,
  };
}

/** Ops helper: which URL mode the pool will use (no secrets). */
export function describeDbTarget(): { mode: 'session' | 'transaction' | 'unknown'; hostPort: string } {
  const forceTransaction = process.env.OUTREACH_DB_USE_TRANSACTION_POOLER === '1';
  const url = forceTransaction
    ? (process.env.DATABASE_URL || process.env.DIRECT_DATABASE_URL)
    : (process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL);
  if (!url) return { mode: 'unknown', hostPort: '' };
  try {
    const parsed = new URL(url);
    const port = parsed.port || '5432';
    const mode = port === '6543' || forceTransaction ? 'transaction' : 'session';
    return { mode, hostPort: `${parsed.hostname}:${port}` };
  } catch {
    return { mode: 'unknown', hostPort: '' };
  }
}
