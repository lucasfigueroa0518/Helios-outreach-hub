/**
 * Local dev: Next.js + Postgres orchestration worker in one command.
 * Production still runs the worker as a separate always-on service (see Dockerfile.worker).
 *
 * The worker's tokenized checkout lock owns replacement. This wrapper only
 * owns the two child process trees it started.
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

function loadEnvLocal() {
  const envPath = path.join(root, '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

function spawnLogged(label, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
    // Windows .cmd shims (npm/npx) require shell mode on recent Node.
    shell: isWindows,
  });
  child.on('exit', (code, signal) => {
    if (shutdownPromise) return;
    const detail = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    console.error(`[dev] ${label} exited (${detail})`);
    void shutdown(typeof code === 'number' ? code : 1);
  });
  return child;
}

loadEnvLocal();

function runDraftingSchemaAudit(label) {
  const result = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'scripts/verify_drafting_schema.ts'],
    {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
      shell: false,
    },
  );
  if (result.status === 0) {
    console.log(`[dev] Drafting schema audit passed (${label})`);
    return true;
  }
  return false;
}

console.log('[dev] Verifying drafting schema…');
if (!runDraftingSchemaAudit('initial')) {
  console.warn('[dev] Drafting schema drift detected — applying db/drafting_schema.sql…');
  const apply = spawnSync(process.execPath, [path.join(__dirname, 'apply_drafting_schema.js')], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    shell: false,
  });
  if (apply.status !== 0) {
    console.error('[dev] Failed to apply drafting schema. Fix with: npm run db:drafting');
    process.exit(apply.status ?? 1);
  }
  if (!runDraftingSchemaAudit('post-apply')) {
    console.error('[dev] Drafting schema still drifted after apply. Run: npm run verify:drafting');
    process.exit(1);
  }
}

console.log('[dev] Applying Next.js SWC fallback patch…');
const patch = spawnSync(process.execPath, [path.join(root, 'scripts', 'patch_next_swc_fallback.js')], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
if (patch.status !== 0) process.exit(patch.status ?? 1);

const children = [];
let shutdownPromise = null;

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child, timeoutMs) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(childExited(child));
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function stopChildTree(child) {
  if (!child.pid || childExited(child)) return;
  if (isWindows) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    child.kill('SIGTERM');
  }
  if (await waitForChildExit(child, 5_000)) return;

  if (isWindows) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    child.kill('SIGKILL');
  }
  if (!(await waitForChildExit(child, 2_000))) {
    console.error(`[dev] child process tree ${child.pid} did not exit`);
  }
}

function shutdown(exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    await Promise.allSettled(children.map((child) => stopChildTree(child)));
    process.exit(exitCode);
  })();
  return shutdownPromise;
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

console.log('[dev] Starting orchestration worker + Next.js (Ctrl+C stops both)…');
children.push(spawnLogged('worker', npmCmd, ['run', 'worker:dev'], {
  ORCHESTRATION_WORKER_REPLACE: '1',
  ORCHESTRATION_WORKER_OWNER_PID: String(process.pid),
}));
children.push(spawnLogged('web', npmCmd, ['run', 'dev:web']));
