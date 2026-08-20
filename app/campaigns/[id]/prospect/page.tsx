import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { CampaignTagsHeader } from '@/app/campaigns/[id]/campaign-tags-header';
import { CampaignTitle } from '@/app/campaigns/[id]/campaign-title';
import { ProspectWorkspace } from '@/app/campaigns/[id]/prospect/prospect-workspace';
import { getCampaign } from '@/lib/campaigns';
import { displayNameFromEmail, getSession } from '@/lib/session';

export default async function ProspectPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect('/');

  const { id } = await params;
  const campaign = await getCampaign(session.userId, id);
  if (!campaign) notFound();
  if (campaign.kind !== 'auto') redirect(`/campaigns/${id}`);

  return (
    <main className="app-shell">
      <section className="card">
        <div className="card__header">
          <div>
            <Link href="/hub" className="back-link"><ArrowLeft size={14} /> Outreach Hub</Link>
            <CampaignTitle
              name={campaign.name}
              senderIdentitySlug={campaign.sender_identity_slug}
            />
            <div className="card__subtitle">{campaign.lead_count} leads · Auto</div>
            <CampaignTagsHeader campaignId={campaign.id} initialTags={campaign.tags} initialTagDetails={campaign.tag_details} />
          </div>
        </div>
        <div className="card__body">
          <ProspectWorkspace
            campaignId={id}
            defaultDisplayName={displayNameFromEmail(session.email)}
            defaultWorkEmail={session.email}
          />
        </div>
      </section>
    </main>
  );
}
