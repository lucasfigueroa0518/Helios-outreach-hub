import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyCampaignCostPaths,
  estimateCampaignCostFlatFallback,
  estimateCampaignCostFromLeads,
} from '@/lib/path-cost-estimate';

test('classifyCampaignCostPaths amortizes enrichment by company and buckets drafting by domain', () => {
  const counts = classifyCampaignCostPaths([
    {
      id: '1',
      fullName: 'Ada Lovelace',
      email: 'ada@acme.com',
      companyName: 'Acme Corp',
      title: 'CTO',
    },
    {
      id: '2',
      fullName: 'Grace Hopper',
      email: 'grace@acme.com',
      companyName: 'Acme Inc',
      title: 'VP Engineering',
    },
    {
      id: '3',
      fullName: 'Alan Turing',
      email: 'alan@other.io',
      companyName: 'Other Co',
      title: null,
    },
    {
      id: '4',
      fullName: 'Personal User',
      email: 'person@gmail.com',
      companyName: 'Indie',
      title: 'Founder',
    },
  ]);

  // Acme Corp / Acme Inc normalize together; Other + Indie are separate → 3 company jobs.
  assert.equal(counts.enrichment_company_job, 3);
  // Alan missing title → hard rescue; Personal/Indie/Acme have company+title.
  assert.equal(counts.enrichment_hard_rescue, 1);
  // acme.com: first fresh, second sibling_skip (complete identity)
  // other.io: fresh; gmail.com: fresh (generic domain disables reuse)
  assert.equal(counts.draft_fresh, 3);
  assert.equal(counts.draft_sibling_skip, 1);
  assert.equal(counts.draft_company_reuse, 0);
});

test('classifyCampaignCostPaths uses company_reuse when sibling identity is incomplete', () => {
  const counts = classifyCampaignCostPaths([
    {
      id: 'a',
      fullName: 'First Lead',
      email: 'one@firm.com',
      companyName: 'Firm',
      title: 'CEO',
    },
    {
      id: 'b',
      fullName: 'Second Lead',
      email: 'two@firm.com',
      companyName: 'Firm',
      title: null,
    },
  ]);
  assert.equal(counts.draft_fresh, 1);
  assert.equal(counts.draft_company_reuse, 1);
  assert.equal(counts.draft_sibling_skip, 0);
});

test('classifyCampaignCostPaths skips enrichment for prior-resolved leads', () => {
  const counts = classifyCampaignCostPaths([
    {
      id: '1',
      fullName: 'Known',
      email: 'known@acme.com',
      companyName: 'Acme',
      title: 'CFO',
      skipEnrichment: true,
    },
    {
      id: '2',
      fullName: 'New',
      email: 'new@acme.com',
      companyName: 'Acme',
      title: 'Controller',
    },
  ]);
  assert.equal(counts.enrichment_skip, 1);
  assert.equal(counts.enrichment_company_job, 1);
});

test('estimateCampaignCostFromLeads prices shared companies cheaper than unique ones', () => {
  const shared = estimateCampaignCostFromLeads([
    {
      id: '1',
      fullName: 'A',
      email: 'a@same.com',
      companyName: 'Same Co',
      title: 'CEO',
    },
    {
      id: '2',
      fullName: 'B',
      email: 'b@same.com',
      companyName: 'Same Co',
      title: 'CFO',
    },
    {
      id: '3',
      fullName: 'C',
      email: 'c@same.com',
      companyName: 'Same Co',
      title: 'COO',
    },
  ]);
  const unique = estimateCampaignCostFromLeads([
    {
      id: '1',
      fullName: 'A',
      email: 'a@a.com',
      companyName: 'A Co',
      title: 'CEO',
    },
    {
      id: '2',
      fullName: 'B',
      email: 'b@b.com',
      companyName: 'B Co',
      title: 'CFO',
    },
    {
      id: '3',
      fullName: 'C',
      email: 'c@c.com',
      companyName: 'C Co',
      title: 'COO',
    },
  ]);

  assert.equal(shared.method, 'path_bucket');
  assert.ok(Number(shared.campaign_total_usd) < Number(unique.campaign_total_usd));
  assert.ok(shared.buckets.some((b) => b.path === 'enrichment_company_job' && b.count === 1));
  assert.ok(unique.buckets.some((b) => b.path === 'enrichment_company_job' && b.count === 3));
  assert.ok(shared.buckets.some((b) => b.path === 'draft_sibling_skip' && b.count === 2));
});

test('estimateCampaignCostFlatFallback uses model unit × lead count', () => {
  const estimate = estimateCampaignCostFlatFallback(10);
  assert.equal(estimate.method, 'flat_fallback');
  assert.equal(estimate.lead_count, 10);
  assert.equal(estimate.buckets[0]?.path, 'flat_fallback');
  assert.equal(estimate.buckets[0]?.count, 10);
  assert.ok(Number(estimate.campaign_total_usd) > 0);
});
