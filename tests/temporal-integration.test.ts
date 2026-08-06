import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  assertDraftGenerationMode,
  DraftingTimelinessError,
  resolvePersistedDraftGrounding,
} from '@/lib/drafting/repository';

test('current-time reload preserves full persisted draft grounding', () => {
  const grounding = resolvePersistedDraftGrounding({
    draft_grounding: {
      usedFactIds: ['persisted-fact'],
      claimLedger: [{
        exactText: 'Acme is currently executing its rollout.',
        factIds: ['persisted-fact'],
        claimType: 'prospect_fact',
        temporalFraming: 'active',
      }],
      prospectTerms: ['Acme', 'Acme Holdings'],
    },
    used_fact_ids: ['legacy-fact'],
    claim_ledger: { entries: [] },
  });

  assert.deepEqual(grounding.usedFactIds, ['persisted-fact']);
  assert.equal(grounding.claimLedger[0]?.temporalFraming, 'active');
  assert.deepEqual(grounding.prospectTerms, ['Acme', 'Acme Holdings']);
});

test('db setup applies duration migration immediately after drafting schema', () => {
  const root = process.cwd();
  const setup = fs.readFileSync(path.join(root, 'scripts', 'db_setup.js'), 'utf8');
  const draftingIndex = setup.indexOf("'db/drafting_schema.sql'");
  const migrationIndex = setup.indexOf("'db/migrate_duration_aware_timeliness_v2.sql'");
  const costLedgerIndex = setup.indexOf("'db/cost_ledger_schema.sql'");

  assert.ok(draftingIndex >= 0);
  assert.ok(migrationIndex > draftingIndex);
  assert.ok(costLedgerIndex > migrationIndex);

  const migration = fs.readFileSync(
    path.join(root, 'db', 'migrate_duration_aware_timeliness_v2.sql'),
    'utf8',
  );
  assert.match(migration, /ADD COLUMN IF NOT EXISTS temporal_status/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS temporal_audit/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS draft_grounding/);
  assert.match(migration, /WHERE schema_version IS DISTINCT FROM '2'/);
});

test('stub review is allowed but all non-live delivery is blocked', () => {
  assert.doesNotThrow(() => assertDraftGenerationMode('stub', { allowStubReview: true }));
  for (const mode of ['stub', 'legacy'] as const) {
    assert.throws(
      () => assertDraftGenerationMode(mode),
      (error: unknown) => error instanceof DraftingTimelinessError
        && error.codes.length === 1
        && error.codes[0] === 'NON_LIVE_DRAFT_DELIVERY_BLOCKED',
      `${mode} delivery must fail with the structured non-live code`,
    );
  }
});

test('live v2 delivery mode remains eligible', () => {
  assert.doesNotThrow(() => assertDraftGenerationMode('live'));
});

test('db setup durably migrates generation mode after drafting schema', () => {
  const root = process.cwd();
  const setup = fs.readFileSync(path.join(root, 'scripts', 'db_setup.js'), 'utf8');
  const draftingIndex = setup.indexOf("'db/drafting_schema.sql'");
  const temporalIndex = setup.indexOf("'db/migrate_duration_aware_timeliness_v2.sql'");
  const generationIndex = setup.indexOf("'db/migrate_draft_generation_mode.sql'");
  const costLedgerIndex = setup.indexOf("'db/cost_ledger_schema.sql'");

  assert.ok(draftingIndex >= 0);
  assert.ok(temporalIndex > draftingIndex);
  assert.ok(generationIndex > temporalIndex);
  assert.ok(costLedgerIndex > generationIndex);

  const schema = fs.readFileSync(path.join(root, 'db', 'drafting_schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'db', 'migrate_draft_generation_mode.sql'),
    'utf8',
  );
  assert.match(schema, /generation_mode\s+text NOT NULL DEFAULT 'legacy'/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS generation_mode text/);
  assert.match(migration, /SET generation_mode = 'legacy'/);
  assert.match(migration, /generation_mode IN \('live', 'stub', 'legacy'\)/);
});

test('repository persists, reloads, and preserves truthful generation provenance', () => {
  const repository = fs.readFileSync(
    path.join(process.cwd(), 'lib', 'drafting', 'repository.ts'),
    'utf8',
  );
  assert.match(repository, /temporal_audit, generation_mode\s+FROM outreach\.email_drafts/);
  assert.match(repository, /generation_mode, temporal_status, temporal_audit, draft_grounding/);
  assert.match(repository, /generation_mode = EXCLUDED\.generation_mode/);
  assert.match(repository, /input\.generationMode/);
  assert.match(
    repository,
    /generation_mode, grounding_status, manually_edited, edited_by, edited_at[\s\S]*?'legacy', 'manual_override'/,
  );
  assert.doesNotMatch(
    repository,
    /ON CONFLICT \(drafting_item_id\) DO UPDATE[\s\S]{0,1200}generation_mode = 'legacy'/,
  );
});
