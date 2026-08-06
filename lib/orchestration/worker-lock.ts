import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const LOCK_PATH = path.join(process.cwd(), '.orchestration-worker.lock');
const execFileAsync = promisify(execFile);

export type OrchestrationWorkerLock = {
  pid: number;
  startedAt: string;
  token: string;
  replacedPid: number | null;
};

type StoredLock = Omit<OrchestrationWorkerLock, 'replacedPid'>;
type ParsedLock = {
  pid: number;
  startedAt: string | null;
  token: string | null;
  raw: string;
};

type LockOptions = {
  lockPath?: string;
  replace?: boolean;
  gracefulWaitMs?: number;
  ownerPid?: number;
};

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readOrchestrationWorkerLock(lockPath = LOCK_PATH): StoredLock | null {
  const parsed = readStoredLock(lockPath);
  if (!parsed || !parsed.startedAt || !parsed.token) return null;
  return {
    pid: parsed.pid,
    startedAt: parsed.startedAt,
    token: parsed.token,
  };
}

function readStoredLock(lockPath: string): ParsedLock | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const legacyPid = Number(raw.trim());
    if (Number.isInteger(legacyPid) && legacyPid > 0) {
      return { pid: legacyPid, startedAt: null, token: null, raw };
    }
    const parsed = JSON.parse(raw) as Partial<StoredLock>;
    if (
      !Number.isFinite(parsed.pid)
      || Number(parsed.pid) <= 0
      || typeof parsed.startedAt !== 'string'
      || typeof parsed.token !== 'string'
      || parsed.token.length < 8
    ) {
      return null;
    }
    return {
      pid: Number(parsed.pid),
      startedAt: parsed.startedAt,
      token: parsed.token,
      raw,
    };
  } catch {
    return null;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid) && Date.now() < deadline) {
    await wait(50);
  }
  return !pidAlive(pid);
}

async function terminateProcessTree(pid: number, gracefulWaitMs: number): Promise<boolean> {
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/pid', String(pid), '/T'], {
      windowsHide: true,
    }).catch(() => undefined);
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // It may already be gone.
    }
  }
  if (await waitForDeath(pid, gracefulWaitMs)) return true;

  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
    }).catch(() => undefined);
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // It may already be gone.
    }
  }
  return waitForDeath(pid, Math.min(gracefulWaitMs, 2_000));
}

function unlinkIfOwned(lockPath: string, token: string): boolean {
  const current = readOrchestrationWorkerLock(lockPath);
  if (!current || current.token !== token) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function unlinkLegacyIfUnchanged(lockPath: string, expectedRaw: string): boolean {
  try {
    if (fs.readFileSync(lockPath, 'utf8') !== expectedRaw) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure only one orchestration worker owns this checkout.
 * The lock is local checkout ownership only; production fleet ownership stays
 * in Postgres. Stale locks are removed only after the PID is confirmed dead,
 * and a prior owner can never unlink a successor's token.
 */
export async function acquireOrchestrationWorkerLock(
  options: LockOptions = {},
): Promise<OrchestrationWorkerLock> {
  const lockPath = options.lockPath ?? LOCK_PATH;
  const replace = options.replace
    ?? ((process.env.ORCHESTRATION_WORKER_REPLACE ?? '1') !== '0');
  const gracefulWaitMs = options.gracefulWaitMs ?? 5_000;
  const configuredOwnerPid = Number(
    options.ownerPid ?? process.env.ORCHESTRATION_WORKER_OWNER_PID ?? process.pid,
  );
  const ownerPid = Number.isFinite(configuredOwnerPid) && configuredOwnerPid > 0
    ? Math.floor(configuredOwnerPid)
    : process.pid;
  let replacedPid: number | null = null;

  for (;;) {
    const handle: OrchestrationWorkerLock = {
      // Under `npm run dev`, this is the wrapper PID so replacement terminates
      // the old worker watcher and its web sibling as one complete tree.
      pid: ownerPid,
      startedAt: new Date().toISOString(),
      token: randomUUID(),
      replacedPid,
    };
    try {
      fs.writeFileSync(
        lockPath,
        `${JSON.stringify({
          pid: handle.pid,
          startedAt: handle.startedAt,
          token: handle.token,
        })}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );
      return handle;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const existing = readStoredLock(lockPath);
    if (!existing) {
      throw new Error(
        `Invalid orchestration worker lock at ${lockPath}; refusing unsafe removal.`,
      );
    }

    if (pidAlive(existing.pid)) {
      if (existing.pid === ownerPid) {
        if (!replace) {
          throw new Error('This process already has an orchestration worker lock.');
        }
        // `tsx watch` restarts only the worker child while the npm/dev wrapper
        // (the recorded tree owner) stays alive. Rotate the token in place:
        // the dead child cannot unlink its successor, and killing ownerPid
        // here would take down the healthy web sibling and watcher.
        if (existing.token) unlinkIfOwned(lockPath, existing.token);
        else unlinkLegacyIfUnchanged(lockPath, existing.raw);
        continue;
      }
      if (!replace) {
        throw new Error(
          `Another orchestration worker is already running (pid ${existing.pid}). `
          + 'Stop it first, or set ORCHESTRATION_WORKER_REPLACE=1.',
        );
      }
      const died = await terminateProcessTree(existing.pid, gracefulWaitMs);
      if (!died) {
        throw new Error(
          `Could not stop orchestration worker process tree (pid ${existing.pid}); lock preserved.`,
        );
      }
      replacedPid = existing.pid;
    }

    // Re-read and compare the token: the dying owner may have released and a
    // successor may already own the path.
    if (existing.token) unlinkIfOwned(lockPath, existing.token);
    else unlinkLegacyIfUnchanged(lockPath, existing.raw);
  }
}

export function releaseOrchestrationWorkerLock(
  handle: Pick<OrchestrationWorkerLock, 'token'>,
  lockPath = LOCK_PATH,
): boolean {
  return unlinkIfOwned(lockPath, handle.token);
}
