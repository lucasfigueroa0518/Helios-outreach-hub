import { generateUpdate } from '@/lib/dashboards/ai';
import { syncProject } from '@/lib/dashboards/github-sync';
import {
  latestUpdateGeneratedAt,
  listActiveProjectsForDaily,
  setProjectCronStatus,
} from '@/lib/dashboards/repository';
import { captureException, scrubError } from '@/lib/dashboards/scrub-logs';

export type DailyUpdateResult = {
  id: string;
  name: string;
  synced: number;
  skipped: number;
  generated: boolean;
  source?: 'ai' | 'fallback';
  syncError?: string;
  generateError?: string;
  generateSkipped?: string;
};

const MIN_HOURS_BETWEEN_UPDATES = 47;

/**
 * One daily pass: per ACTIVE project, sync from GitHub, then generate an AI
 * update ONLY when the sync brought in new events and auto-updates are enabled.
 */
export async function runDailyUpdate(): Promise<DailyUpdateResult[]> {
  const projects = await listActiveProjectsForDaily();

  console.log(`[cron] active projects to process: ${projects.length}`);

  const results: DailyUpdateResult[] = [];

  for (const p of projects) {
    const log = (msg: string) => console.log(`[cron] "${p.name}" (${p.id}): ${msg}`);

    const result: DailyUpdateResult = {
      id: p.id,
      name: p.name,
      synced: 0,
      skipped: 0,
      generated: false,
    };

    let synced = 0;
    try {
      const counts = await syncProject(p.id);
      synced = counts.synced;
      result.synced = counts.synced;
      result.skipped = counts.skipped;
      log(
        `sync ok: synced=${counts.synced} skipped=${counts.skipped} cronEnabled=${p.cronEnabled}`,
      );
    } catch (e: unknown) {
      result.syncError = scrubError(e);
      log(`sync FAILED: ${result.syncError}`);
      results.push(result);
      continue;
    }

    if (synced === 0) {
      log('skip generation: no new events this sync (synced=0)');
      results.push(result);
      continue;
    }
    if (!p.cronEnabled) {
      result.generateSkipped = 'auto-updates disabled (cronEnabled=false)';
      log(`skip generation: ${result.generateSkipped}`);
      results.push(result);
      continue;
    }

    const lastUpdateAt = await latestUpdateGeneratedAt(p.id);
    const hoursSinceLast = lastUpdateAt
      ? (Date.now() - lastUpdateAt.getTime()) / 3_600_000
      : Infinity;
    if (hoursSinceLast < MIN_HOURS_BETWEEN_UPDATES) {
      result.generateSkipped = `last update ${hoursSinceLast.toFixed(1)}h ago (<${MIN_HOURS_BETWEEN_UPDATES}h)`;
      log(`skip generation: ${result.generateSkipped}`);
      results.push(result);
      continue;
    }

    log(
      `generating: synced=${synced} hoursSinceLast=` +
        `${Number.isFinite(hoursSinceLast) ? hoursSinceLast.toFixed(1) : 'none (first update)'}`,
    );
    await setProjectCronStatus(p.id, 'RUNNING');
    try {
      const outcome = await generateUpdate(p.id, { generatedBy: 'WORKER' });
      if (outcome.status === 'generated') {
        result.generated = true;
        result.source = outcome.source;
        log(`generated (source=${outcome.source})`);
      } else {
        log(`generateUpdate returned status=${outcome.status} — nothing written`);
      }
    } catch (e: unknown) {
      captureException(e, { projectId: p.id });
      result.generateError = scrubError(e);
      log(`generation ERROR: ${result.generateError}`);
    } finally {
      await setProjectCronStatus(p.id, 'IDLE');
    }

    results.push(result);
  }

  return results;
}
