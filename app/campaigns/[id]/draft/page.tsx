import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { CampaignTabs } from '@/app/campaigns/[id]/campaign-tabs';
import { DraftWorkspace } from '@/app/campaigns/[id]/draft/draft-workspace';
import { campaignHasDraftingWorkspace, campaignHasReviewableData } from '@/lib/campaign-review';
import { getCampaign } from '@/lib/campaigns';
import { getSession } from '@/lib/session';

export default async function DraftPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect('/');

  const { id } = await params;
  const campaign = await getCampaign(session.userId, id);
  if (!campaign) notFound();

  const showReview = campaign.needs_enrichment;
  const [reviewEnabled, workspaceStarted] = await Promise.all([
    showReview ? campaignHasReviewableData(id) : Promise.resolve(false),
    campaignHasDraftingWorkspace(id),
  ]);

  return (
    <main className="app-shell">
      <section className="card">
        <div className="card__header">
          <div>
            <Link href="/hub" className="back-link"><ArrowLeft size={14} /> Outreach Hub</Link>
            <div className="card__title">{campaign.name}</div>
            <div className="card__subtitle">
              {campaign.lead_count} leads
              {campaign.last_run_at ? ` · last run ${new Date(campaign.last_run_at).toLocaleDateString()}` : ''}
            </div>
          </div>
        </div>
        <div className="card__body">
          <CampaignTabs
            campaignId={id}
            active="draft"
            showReview={showReview}
            reviewEnabled={reviewEnabled}
            draftEnabled={showReview ? (reviewEnabled || workspaceStarted) : workspaceStarted}
          />
          <DraftWorkspace campaignId={id} />
        </div>
      </section>
    </main>
  );
}
