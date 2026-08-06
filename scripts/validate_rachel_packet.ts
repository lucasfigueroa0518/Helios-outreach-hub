import fs from 'node:fs';
import { dbQuery } from '@/lib/db';
import { validateResearchPacket } from '@/lib/drafting/research-validate';
import { CANONICAL_CAPABILITY_IDS } from '@/lib/drafting/types';
import type { DraftingResearchPacket } from '@/lib/drafting/types';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

async function main() {
  const { rows } = await dbQuery<{
    packet: DraftingResearchPacket;
    status: string;
    usage: Record<string, unknown>;
  }>(
    `SELECT p.packet, p.status, p.usage
     FROM outreach.draft_research_packets p
     JOIN outreach.drafting_items i ON i.id = p.drafting_item_id
     JOIN outreach.leads l ON l.id = i.lead_id
     WHERE lower(l.full_name) LIKE '%rachel barron%'`,
  );
  const row = rows[0];
  if (!row) throw new Error('no packet');
  const issues = validateResearchPacket(row.packet, {
    allowedCapabilityIds: CANONICAL_CAPABILITY_IDS,
  });
  console.log(JSON.stringify({
    packet_status: row.status,
    usage: row.usage,
    identity: row.packet.leadIdentity.classification,
    resolution: row.packet.resolution.level,
    validation_issue_count: issues.length,
    validation_issues: issues.slice(0, 20),
  }, null, 2));
}

main().catch(console.error);
