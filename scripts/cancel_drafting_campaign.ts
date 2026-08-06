/**
 * Cancel all active drafting work for a campaign (operator / dev use).
 *
 * Usage:
 *   npx tsx scripts/cancel_drafting_campaign.ts 15
 *   npx tsx scripts/cancel_drafting_campaign.ts 79582f7d-dbfa-40f9-ad3f-dad0f2490987
 */
import fs from 'node:fs';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}
if (process.platform === 'win32') process.env.PGSSLMODE = 'disable';

async function resolveCampaignId(arg: string): Promise<string> {
  const { dbQuery } = await import('@/lib/db');
  if (/^[0-9a-f-]{36}$/i.test(arg)) return arg;
  if (/^\d+$/.test(arg)) {
    const byNumber = await dbQuery<{ id: string }>(
      `SELECT id FROM outreach.campaigns
       WHERE name ~* ('(^|\\D)#' || $1 || '(\\D|$)') OR name ~* ('campaign\\s*' || $1)
       ORDER BY created_at DESC LIMIT 1`,
      [arg],
    );
    if (byNumber.rows[0]) return byNumber.rows[0].id;
  }
  const byName = await dbQuery<{ id: string }>(
    `SELECT id FROM outreach.campaigns WHERE name = $1 OR lower(name) = lower($1) LIMIT 1`,
    [arg],
  );
  if (byName.rows[0]) return byName.rows[0].id;
  throw new Error(`Campaign not found: ${arg}`);
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) throw new Error('Usage: npx tsx scripts/cancel_drafting_campaign.ts <campaign-id-or-number>');
  const campaignId = await resolveCampaignId(arg);
  const { cancelDraftingCampaign } = await import('@/lib/drafting/repository');
  const result = await cancelDraftingCampaign(campaignId);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
