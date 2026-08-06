import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { notFound, redirect } from 'next/navigation';

import { CampaignTabs } from '@/app/campaigns/[id]/campaign-tabs';

import { ReviewTable } from '@/app/campaigns/[id]/review/review-table';

import { ReplaceSheet } from '@/app/campaigns/[id]/review/replace-sheet';

import { countActiveEnrichmentRuns, loadCampaignSheetRows } from '@/lib/campaign-sheet';

import { campaignHasDraftingWorkspace, campaignHasReviewableData } from '@/lib/campaign-review';

import { getCampaign } from '@/lib/campaigns';

import { GoToDraftingButton } from '@/app/campaigns/[id]/review/go-to-drafting-button';
import { getSession, displayNameFromEmail } from '@/lib/session';

import { syncCampaignSheet } from '@/lib/sheet-sync';



export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {

  const session = await getSession();

  if (!session) redirect('/');

  const { id } = await params;

  const campaign = await getCampaign(session.userId, id);

  if (!campaign) notFound();

  if (!campaign.needs_enrichment) {
    const hasDraft = await campaignHasDraftingWorkspace(id);
    redirect(hasDraft ? `/campaigns/${id}/draft` : `/campaigns/${id}`);
  }

  await syncCampaignSheet(id);



  const [reviewEnabled, activeRuns, initialRows] = await Promise.all([

    campaignHasReviewableData(id),

    countActiveEnrichmentRuns(id),

    loadCampaignSheetRows(id, session.userId),

  ]);



  return (

    <main className="app-shell">

      <section className="card">

        <div className="card__header">

          <div>

            <Link href="/hub" className="back-link"><ArrowLeft size={14} /> Outreach Hub</Link>

            <div className="card__title">{campaign.name}</div>

            <div className="card__subtitle">{campaign.lead_count} leads on sheet{campaign.last_run_at ? ` · last run ${new Date(campaign.last_run_at).toLocaleDateString()}` : ''}</div>

          </div>

        </div>

        <div className="card__body">

          <CampaignTabs
            campaignId={id}
            active="review"
            reviewEnabled={reviewEnabled}
            draftEnabled={reviewEnabled}
          />

          <div className="review-toolbar">
            <div className="review-toolbar__left">
              <a className="btn btn--secondary" href={`/api/campaigns/${id}/sheet?format=csv`}>Export CSV</a>
              <a className="btn btn--primary" href={`/api/campaigns/${id}/sheet?format=xlsx`}>Export XLSX</a>
              <ReplaceSheet campaignId={id} />
            </div>
            {reviewEnabled ? (
              <div className="review-toolbar__right">
                <GoToDraftingButton
                  campaignId={id}
                  campaignName={campaign.name}
                  defaultDisplayName={displayNameFromEmail(session.email)}
                  defaultWorkEmail={session.email}
                />
              </div>
            ) : null}
          </div>

          {activeRuns > 0 && (

            <div className="run-progress">

              <span className="loading-spinner" />

              {activeRuns} run{activeRuns === 1 ? '' : 's'} still enriching — this table updates as files finish.

            </div>

          )}

          <ReviewTable
            campaignId={id}
            initialRows={initialRows}
            pollWhileEnriching={activeRuns > 0}
            pollWhileVerifying={initialRows.some((row) =>
              Boolean(row.email_primary)
              && ['direct', 'inferred', 'format_guess'].includes(row.email_status)
              && (!row.email_verification || row.email_verification === 'pending'))}
          />

        </div>

      </section>

    </main>

  );

}

