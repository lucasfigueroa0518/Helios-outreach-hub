import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  acquireOrchestrationWorkerLock,
  readOrchestrationWorkerLock,
  releaseOrchestrationWorkerLock,
} from '@/lib/orchestration/worker-lock';

const temporaryDirectories: string[] = [];

function temporaryLockPath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'outreach-worker-lock-'));
  temporaryDirectories.push(directory);
  return path.join(directory, '.orchestration-worker.lock');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('local orchestration worker lock ownership', () => {
  it('stores pid/start/token and only the matching token can release', async () => {
    const lockPath = temporaryLockPath();
    const lock = await acquireOrchestrationWorkerLock({ lockPath, replace: false });
    const stored = readOrchestrationWorkerLock(lockPath);

    assert.equal(stored?.pid, process.pid);
    assert.equal(stored?.startedAt, lock.startedAt);
    assert.equal(stored?.token, lock.token);
    assert.equal(
      releaseOrchestrationWorkerLock({ token: 'foreign-token' }, lockPath),
      false,
    );
    assert.ok(fs.existsSync(lockPath));
    assert.equal(releaseOrchestrationWorkerLock(lock, lockPath), true);
    assert.equal(fs.existsSync(lockPath), false);
  });

  it('refuses a second live owner when replacement is disabled', async () => {
    const lockPath = temporaryLockPath();
    const lock = await acquireOrchestrationWorkerLock({ lockPath, replace: false });

    await assert.rejects(
      acquireOrchestrationWorkerLock({ lockPath, replace: false }),
      /already has an orchestration worker lock|already running/i,
    );
    assert.equal(readOrchestrationWorkerLock(lockPath)?.token, lock.token);
    releaseOrchestrationWorkerLock(lock, lockPath);
  });

  it('rotates the token for a watch reload under the same wrapper owner', async () => {
    const lockPath = temporaryLockPath();
    const first = await acquireOrchestrationWorkerLock({ lockPath, replace: false });
    const second = await acquireOrchestrationWorkerLock({
      lockPath,
      replace: true,
      ownerPid: process.pid,
    });

    assert.notEqual(second.token, first.token);
    assert.equal(releaseOrchestrationWorkerLock(first, lockPath), false);
    assert.equal(readOrchestrationWorkerLock(lockPath)?.token, second.token);
    assert.equal(releaseOrchestrationWorkerLock(second, lockPath), true);
  });

  it('safely migrates a stale PID-only legacy lock', async () => {
    const lockPath = temporaryLockPath();
    fs.writeFileSync(lockPath, '999999\n', 'utf8');

    const lock = await acquireOrchestrationWorkerLock({ lockPath, replace: false });
    const stored = readOrchestrationWorkerLock(lockPath);
    assert.equal(stored?.pid, process.pid);
    assert.equal(stored?.token, lock.token);
    assert.equal(releaseOrchestrationWorkerLock(lock, lockPath), true);
  });
});
