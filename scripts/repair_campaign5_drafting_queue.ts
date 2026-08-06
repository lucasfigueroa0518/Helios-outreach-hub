/**
 * Repair Campaign #5: queue every idle eligible drafting item.
 */
import fs from 'node:fs';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const m = t.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (!m || process.env[m[1]]) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  process.env[m[1]] = v;
}

async function main() {
  const { dbQuery } = await import('../lib/db');
  const { reconcileDraftingWorkspaceQueue } = await import('../lib/drafting/repository');

  const campaignId = process.env.CAMPAIGN_ID ?? '2b27a197-3b22-4fba-baa4-d8f190ef99f7';
  const ws = await dbQuery<{ id: string; created_by: string }>(
    `SELECT id, created_by::text AS created_by
       FROM outreach.drafting_workspaces
      WHERE campaign_id = $1`,
    [campaignId],
  );
  if (!ws.rows[0]) {
    console.error('No drafting workspace for campaign', campaignId);
    process.exitCode = 1;
    return;
  }

  const result = await reconcileDraftingWorkspaceQueue({
    workspaceId: ws.rows[0].id,
    ownerId: ws.rows[0].created_by,
    trigger: 'retry',
    idempotencyKey: `manual-repair:${ws.rows[0].id}:${Date.now()}`,
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
