import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isTransitionAllowed } from '@/lib/drafting/state';
import { RUNNING_STATES } from '@/lib/drafting/eligibility';
import { DRAFTING_ITEM_STATES } from '@/lib/drafting/types';
import { resolveCompanyResearchKey } from '@/lib/drafting/company-research-key';
import { canSkipSiblingResearch } from '@/lib/drafting/research-company-reuse';
import type { InputSnapshot, ReusableCompanyResearchContext } from '@/lib/drafting/types';

describe('waiting_company_research state machine', () => {
  it('includes waiting_company_research in the state union', () => {
    assert.ok(DRAFTING_ITEM_STATES.includes('waiting_company_research'));
  });

  it('allows park and wake transitions', () => {
    assert.equal(isTransitionAllowed('queued_research', 'waiting_company_research'), true);
    assert.equal(isTransitionAllowed('researching', 'waiting_company_research'), true);
    assert.equal(isTransitionAllowed('waiting_company_research', 'queued_research'), true);
    assert.equal(isTransitionAllowed('waiting_company_research', 'researching'), true);
    assert.equal(isTransitionAllowed('waiting_company_research', 'failed_research'), true);
  });

  it('counts park as a running state for UI polling', () => {
    assert.ok((RUNNING_STATES as readonly string[]).includes('waiting_company_research'));
  });
});

describe('company research key + sibling skip', () => {
  it('resolves corporate domains and rejects generics', () => {
    assert.equal(resolveCompanyResearchKey('ada@acme.com'), 'acme.com');
    assert.equal(resolveCompanyResearchKey('ada@gmail.com'), null);
  });

  it('can skip when reusable company facts + complete identity exist', () => {
    const reusable: ReusableCompanyResearchContext = {
      sourceDraftingItemId: '00000000-0000-0000-0000-000000000001',
      company: 'Acme',
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      prospectWorld: { pressures: [] },
      companyFacts: [{
        id: 'f1',
        text: 'Acme raised a round',
        confidence: 'supported',
        weight: 'primary',
        sourceIds: ['s1'],
        asOf: new Date().toISOString(),
      }],
      roleSegmentFacts: [],
      sources: [{
        id: 's1',
        url: 'https://example.com',
        title: 'News',
        bindsPerson: false,
      }],
    };
    const snapshot = {
      lead: {
        fullName: 'Ada Lovelace',
        email: 'ada@acme.com',
        company: 'Acme',
        title: 'CTO',
        workLocation: '',
        connectingContext: '',
      },
    } as unknown as InputSnapshot;
    assert.equal(canSkipSiblingResearch(snapshot, reusable), true);
  });
});
