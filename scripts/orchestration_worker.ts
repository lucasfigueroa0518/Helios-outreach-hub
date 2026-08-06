import fs from 'node:fs';
import path from 'node:path';

function loadLocalEnvironment() {
  const envPath = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

loadLocalEnvironment();

async function main() {
  const { acquireOrchestrationWorkerLock, releaseOrchestrationWorkerLock } = await import(
    '@/lib/orchestration/worker-lock'
  );
  const { closeDbPool } = await import('@/lib/db');
  const lock = await acquireOrchestrationWorkerLock();
  if (lock.replacedPid != null) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'warn',
      component: 'orchestration-worker',
      message: 'replaced_stale_worker',
      replacedPid: lock.replacedPid,
    }));
  }

  const { OrchestrationWorker } = await import('@/lib/orchestration/worker');
  const worker = new OrchestrationWorker(process.env.ORCHESTRATION_WORKER_ID);

  let stopPromise: Promise<void> | null = null;
  const stop = (signal: string): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        component: 'orchestration-worker',
        message: 'shutdown_requested',
        signal,
      }));
      try {
        const activeRemaining = await worker.stop();
        if (activeRemaining > 0) {
          console.warn(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'warn',
            component: 'orchestration-worker',
            message: 'shutdown_drain_expired',
            activeRemaining,
          }));
        }
      } finally {
        try {
          releaseOrchestrationWorkerLock(lock);
        } finally {
          await closeDbPool().catch(() => undefined);
        }
      }
    })();
    return stopPromise;
  };

  process.on('SIGINT', () => void stop('SIGINT').finally(() => process.exit(0)));
  process.on('SIGTERM', () => void stop('SIGTERM').finally(() => process.exit(0)));
  process.on('exit', () => {
    releaseOrchestrationWorkerLock(lock);
  });
  process.on('unhandledRejection', (error) => {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      component: 'orchestration-worker',
      message: 'unhandled_rejection',
      error: error instanceof Error ? error.message : String(error),
    }));
  });

  try {
    await worker.start();
  } catch (error) {
    releaseOrchestrationWorkerLock(lock);
    await closeDbPool().catch(() => undefined);
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
