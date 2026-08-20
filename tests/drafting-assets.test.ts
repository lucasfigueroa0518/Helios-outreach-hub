import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearDraftingAssetsCache,
  loadDraftingAssets,
} from '@/lib/drafting/assets';
import { buildWriterSystemBlocks } from '@/lib/drafting/writer-prompt';
import { CANONICAL_CAPABILITY_IDS } from '@/lib/drafting/types';

test('drafting assets load with matching manifest hashes', async () => {
  clearDraftingAssetsCache();
  const assets = await loadDraftingAssets({ forceReload: true });

  assert.ok(assets.skill.content.includes('First-contact outreach'));
  assert.ok(assets.skill.content.includes('## Output contract'));
  assert.ok(assets.skill.content.includes('Greeting line'));
  assert.ok(assets.skill.content.includes('Exactly one service per email'));
  assert.equal(assets.skill.version, 'v8');
  assert.equal(assets.versions.skillVersion, 'v8');
  assert.ok(!assets.skill.content.includes('\r'), 'skill content must be LF-normalized');
  assert.ok(assets.subjectLine.content.includes('Helios topic lean'));
  assert.ok(assets.subjectLine.content.includes('Governing principle'));
  assert.ok(!assets.subjectLine.content.includes('\r'), 'subject-line content must be LF-normalized');
  assert.ok(assets.positioning.text.includes('forward-deployed AI engineers'));
  assert.ok(assets.positioning.text.includes('Builders, not advisors'));
  assert.equal(assets.positioning.pdfSha256?.length, 64);
  assert.ok(assets.manifest);

  const skillEntry = assets.manifest!.assets.find((entry) => entry.name === 'skill');
  const subjectEntry = assets.manifest!.assets.find((entry) => entry.name === 'subject-line');
  const positioningEntry = assets.manifest!.assets.find((entry) => entry.name === 'positioning');
  const capabilitiesEntry = assets.manifest!.assets.find((entry) => entry.name === 'capabilities');
  assert.equal(skillEntry?.sha256, assets.skill.sha256);
  assert.equal(subjectEntry?.sha256, assets.subjectLine.sha256);
  assert.equal(positioningEntry?.sha256, assets.positioning.textSha256);
  assert.equal(capabilitiesEntry?.sha256, assets.capabilities.sha256);
  assert.equal(assets.versions.subjectLineVersion, subjectEntry?.version);
  assert.equal(assets.versions.subjectLineSha256, assets.subjectLine.sha256);

  const catalogIds = new Set(assets.capabilities.catalog.map((entry) => entry.id));
  for (const id of CANONICAL_CAPABILITY_IDS) {
    assert.ok(catalogIds.has(id), `missing capability ${id}`);
  }
});

test('writer system blocks include subject-line doctrine after skill', async () => {
  clearDraftingAssetsCache();
  const assets = await loadDraftingAssets({ forceReload: true });
  const blocks = buildWriterSystemBlocks({
    skillContent: assets.skill.content,
    subjectLineContent: assets.subjectLine.content,
    positioningText: assets.positioning.text,
  });

  assert.equal(blocks.length, 4);
  assert.match(blocks[0].text, /^## First-contact skill \(verbatim\)/);
  assert.match(blocks[1].text, /^## Subject line \(verbatim\)/);
  assert.ok(blocks[1].text.includes('Helios topic lean'));
  assert.ok(blocks[2].text.includes('no stacked clauses'));
  assert.match(blocks[3].text, /^## Helios positioning/);
  assert.equal(blocks[3].cache_control?.type, 'ephemeral');
});
