/**
 * Smoke-test Analytics Hub SQL against the configured hub database.
 * Usage: npx tsx scripts/verify_analytics_hub.ts
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

async function main() {
  const { getAnalyticsSummary, listAnalyticsRuns } = await import('../lib/analytics');
  const summary = await getAnalyticsSummary({ period: 'week' });
  const runs = await listAnalyticsRuns();
  console.log(JSON.stringify({
    ok: true,
    window: summary.window,
    aggregate: summary.aggregate,
    userCount: summary.by_user.length,
    runCount: runs.length,
    excludedRuns: summary.excluded_run_ids.length,
  }, null, 2));
}

main().catch((error) => {
  console.error('[verify_analytics_hub]', error instanceof Error ? error.message : error);
  process.exit(1);
});
