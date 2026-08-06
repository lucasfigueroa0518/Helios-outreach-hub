import fs from 'node:fs';
import { dbQuery } from '@/lib/db';
import { rescueDraftingWorkspace } from '@/lib/drafting/rescue';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

const campaignId = process.argv[2] ?? '2b27a197-3b22-4fba-baa4-d8f190ef99f7';

async function main() {
  const owner = await dbQuery<{ owner_id: string }>(
    `SELECT owner_id::text AS owner_id FROM outreach.campaigns WHERE id = $1`,
    [campaignId],
  );
  const ownerId = owner.rows[0]?.owner_id;
  if (!ownerId) throw new Error(`Campaign not found: ${campaignId}`);
  const result = await rescueDraftingWorkspace(campaignId, ownerId);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
