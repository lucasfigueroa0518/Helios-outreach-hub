import fs from 'node:fs';
import { dbQuery } from '@/lib/db';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

async function main() {
  const names = process.argv.slice(2);
  const { rows } = await dbQuery(
    `SELECT l.full_name, i.state, p.status AS packet_status,
            d.subject, d.prompt_version,
            i.human_attention_code, i.last_error_code
     FROM outreach.drafting_items i
     JOIN outreach.leads l ON l.id = i.lead_id
     LEFT JOIN outreach.draft_research_packets p ON p.drafting_item_id = i.id
     LEFT JOIN outreach.email_drafts d ON d.drafting_item_id = i.id
     WHERE lower(l.full_name) = ANY($1::text[])
     ORDER BY l.full_name`,
    [names.map((n) => n.toLowerCase())],
  );
  console.log(JSON.stringify(rows, null, 2));
}

main().catch(console.error);
