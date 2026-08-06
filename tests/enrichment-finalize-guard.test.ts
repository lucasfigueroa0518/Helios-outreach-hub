import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canFinalizeEnrichingRun,
  OPEN_ENRICHMENT_ORCH_KINDS,
} from '@/lib/orchestration/enrichment-finalize-guard';

describe('enrichment finalize guard (Campaign #9 scar)', () => {
  it('blocks finalize while research jobs are open', () => {
    assert.equal(canFinalizeEnrichingRun({ researchJobs: 1, orchJobs: 0 }), false);
  });

  it('blocks finalize while run.enrich / research orch is open', () => {
    assert.equal(canFinalizeEnrichingRun({ researchJobs: 0, orchJobs: 1 }), false);
  });

  it('allows finalize only when both research and prep orch are clear', () => {
    assert.equal(canFinalizeEnrichingRun({ researchJobs: 0, orchJobs: 0 }), true);
  });

  it('treats run.enrich as open enrichment work (re_enrich race)', () => {
    assert.ok(OPEN_ENRICHMENT_ORCH_KINDS.includes('run.enrich'));
    assert.ok(OPEN_ENRICHMENT_ORCH_KINDS.includes('research.company'));
    assert.ok(!(OPEN_ENRICHMENT_ORCH_KINDS as readonly string[]).includes('run.finalize'));
    assert.ok(!(OPEN_ENRICHMENT_ORCH_KINDS as readonly string[]).includes('mailbox.run'));
  });
});
