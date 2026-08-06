/**
 * Reconstruct the exact Anthropic messages.create payload used for Rachel Barron's write.
 * Writes JSON + a readable markdown dump under fixtures/drafting-debug/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dbQuery } from '@/lib/db';
import { loadDraftingAssets } from '@/lib/drafting/assets';
import { buildWriterResearchBrief } from '@/lib/drafting/writer-research-brief';
import {
  DRAFTING_WRITER_PROMPT_VERSION,
  buildWriterSystemBlocks,
  buildWriterUserPrompt,
  reportDraftOutputTool,
} from '@/lib/drafting/writer-prompt';
import { DRAFTING_WRITER_MODEL } from '@/lib/models';
import type { DraftingResearchPacket, InputSnapshot } from '@/lib/drafting/types';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

async function main() {
  const { rows } = await dbQuery<{
    item_id: string;
    full_name: string;
    input_snapshot: InputSnapshot;
    research_revision: number;
    draft_revision: number;
    packet: DraftingResearchPacket;
    packet_sha256: string;
    packet_status: string;
    model_id: string | null;
    prompt_version: string | null;
    draft_subject: string | null;
    draft_model_id: string | null;
    draft_prompt_version: string | null;
    draft_usage: Record<string, unknown> | null;
  }>(
    `SELECT i.id AS item_id, l.full_name, i.input_snapshot, i.research_revision, i.draft_revision,
            p.packet, p.packet_sha256, p.status AS packet_status,
            p.model_id, p.prompt_version,
            d.subject AS draft_subject, d.model_id AS draft_model_id,
            d.prompt_version AS draft_prompt_version, d.usage AS draft_usage
     FROM outreach.drafting_items i
     JOIN outreach.leads l ON l.id = i.lead_id
     JOIN outreach.draft_research_packets p ON p.drafting_item_id = i.id
     LEFT JOIN outreach.email_drafts d ON d.drafting_item_id = i.id
     WHERE lower(l.full_name) LIKE '%rachel barron%'
     LIMIT 1`,
  );
  const row = rows[0];
  if (!row) throw new Error('Rachel Barron not found');

  const assets = await loadDraftingAssets({ forceReload: true });
  const system = buildWriterSystemBlocks({
    skillContent: assets.skill.content,
    subjectLineContent: assets.subjectLine.content,
    positioningText: assets.positioning.text,
  });
  const userPrompt = buildWriterUserPrompt({
    inputSnapshot: row.input_snapshot,
    packet: row.packet,
    // First write: no previous draft / feedback / repair
    previousSubject: null,
    previousBodyText: null,
    feedback: null,
    isRewrite: false,
    isRepair: false,
  });

  const apiPayload = {
    model: DRAFTING_WRITER_MODEL,
    max_tokens: 2_000,
    system,
    messages: [{ role: 'user' as const, content: userPrompt }],
    tools: [reportDraftOutputTool],
    tool_choice: { type: 'tool' as const, name: 'report_draft_output' },
  };

  const outDir = path.join(process.cwd(), 'fixtures', 'drafting-debug');
  fs.mkdirSync(outDir, { recursive: true });

  const meta = {
    lead: row.full_name,
    item_id: row.item_id,
    note:
      'This reconstructs the writer messages.create() call from the stored packet + input_snapshot '
      + '+ current drafting assets (same code path as lib/drafting/writer-provider.ts writeLive). '
      + 'Packet includes the test-only low→medium trust bump applied before write.',
    writer_model: DRAFTING_WRITER_MODEL,
    writer_prompt_version: DRAFTING_WRITER_PROMPT_VERSION,
    draft_prompt_version_saved: row.draft_prompt_version,
    draft_model_id_saved: row.draft_model_id,
    draft_usage: row.draft_usage,
    draft_subject: row.draft_subject,
    packet_sha256: row.packet_sha256,
    packet_status: row.packet_status,
    research_revision: row.research_revision,
    draft_revision: row.draft_revision,
    asset_versions: assets.versions,
    sizes: {
      system_block_chars: system.map((b) => b.text.length),
      user_prompt_chars: userPrompt.length,
      skill_chars: assets.skill.content.length,
      positioning_chars: assets.positioning.text.length,
      input_snapshot_chars: JSON.stringify(row.input_snapshot).length,
      full_packet_chars: JSON.stringify(row.packet).length,
      writer_brief_chars: JSON.stringify(buildWriterResearchBrief(row.packet)).length,
    },
  };

  fs.writeFileSync(
    path.join(outDir, 'rachel-barron-writer-api-payload.json'),
    JSON.stringify({ meta, apiPayload }, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.join(outDir, 'rachel-barron-writer-user-prompt.txt'),
    userPrompt,
    'utf8',
  );
  fs.writeFileSync(
    path.join(outDir, 'rachel-barron-writer-system-1-skill.txt'),
    system[0].text,
    'utf8',
  );
  fs.writeFileSync(
    path.join(outDir, 'rachel-barron-writer-system-2-positioning.txt'),
    system[1].text,
    'utf8',
  );
  fs.writeFileSync(
    path.join(outDir, 'rachel-barron-input-snapshot.json'),
    JSON.stringify(row.input_snapshot, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.join(outDir, 'rachel-barron-research-brief.json'),
    JSON.stringify(buildWriterResearchBrief(row.packet), null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.join(outDir, 'rachel-barron-research-packet.json'),
    JSON.stringify(row.packet, null, 2),
    'utf8',
  );

  console.log(JSON.stringify({
    written_to: outDir,
    meta,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
