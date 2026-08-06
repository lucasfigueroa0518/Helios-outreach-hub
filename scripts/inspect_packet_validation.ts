import fs from 'node:fs';
import { dbQuery } from '@/lib/db';
import { validateResearchPacket } from '@/lib/drafting/research-validate';
import { CANONICAL_CAPABILITY_IDS, type DraftingResearchPacket } from '@/lib/drafting/types';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

async function main() {
  const name = process.argv[2] ?? 'Eric Edwards';
  const { rows } = await dbQuery<{ full_name: string; packet: DraftingResearchPacket; state: string }>(
    `SELECT l.full_name, p.packet, i.state
     FROM outreach.drafting_items i
     JOIN outreach.leads l ON l.id = i.lead_id
     JOIN outreach.draft_research_packets p ON p.drafting_item_id = i.id
     WHERE lower(l.full_name) = lower($1)`,
    [name],
  );
  const row = rows[0];
  if (!row) {
    console.log(JSON.stringify({ error: 'no packet' }));
    return;
  }
  const issues = validateResearchPacket(row.packet, { allowedCapabilityIds: CANONICAL_CAPABILITY_IDS });
  console.log(JSON.stringify({
    lead: row.full_name,
    state: row.state,
    resolution: row.packet.resolution.level,
    selectedFactIds: row.packet.resolution.selectedFactIds,
    issues,
  }, null, 2));
}

main().catch(console.error);
