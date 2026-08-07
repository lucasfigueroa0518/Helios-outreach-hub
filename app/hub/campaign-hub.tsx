'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { HubPlaneFlight } from '@/app/components/plane-flight';
import { BillingGuardAlert } from '@/app/hub/billing-guard-alert';
import { LeadListTutorial } from '@/app/hub/lead-list-tutorial';

import { requestJson } from '@/lib/client-request';
import { TagBadge } from '@/app/components/tag-badge';
import { TagInputPopover } from '@/app/components/tag-input-popover';
import { TagWithColor } from '@/lib/campaigns';

type Campaign = {
  id: string;
  name: string;
  status: 'active' | 'archived';
  merged_into_id: string | null;
  needs_enrichment?: boolean;
  created_at: string;
  updated_at: string;
  lead_count: number;
  last_run_at: string | null;
  tags?: string[];
  tag_details?: TagWithColor[];
};

function formatDate(value: string | null) {
  if (!value) return 'No runs yet';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(
    new Date(value),
  );
}

export function CampaignHub({ email }: { email: string }) {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'create' | 'rename' | 'merge' | null>(null);
  const [selected, setSelected] = useState<Campaign | null>(null);
  const [name, setName] = useState('');
  const [needsEnrichment, setNeedsEnrichment] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const [saving, setSaving] = useState(false);

  const active = useMemo(() => campaigns.filter((campaign) => campaign.status === 'active'), [campaigns]);
  const archived = useMemo(() => campaigns.filter((campaign) => campaign.status === 'archived'), [campaigns]);

  async function loadCampaigns() {
    setLoading(true);
    try {
      const data = await requestJson<{ campaigns: Campaign[] }>('/api/campaigns');
      setCampaigns(data.campaigns);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load campaigns');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCampaigns();
  }, []);

  function openCreate() {
    setName(`Campaign #${campaigns.length + 1}`);
    setNeedsEnrichment(false);
    setSelected(null);
    setDialog('create');
  }

  function openRename(campaign: Campaign) {
    setSelected(campaign);
    setName(campaign.name);
    setDialog('rename');
  }

  function openMerge(target: Campaign) {
    setSelected(target);
    setSourceId(active.find((campaign) => campaign.id !== target.id)?.id ?? '');
    setDialog('merge');
  }

  async function createCampaign(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const data = await requestJson<{ campaign: { id: string } }>('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, needs_enrichment: needsEnrichment }),
      });
      setDialog(null);
      router.push(`/campaigns/${data.campaign.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create campaign');
    } finally {
      setSaving(false);
    }
  }

  async function renameCampaign(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    try {
      await requestJson(`/api/campaigns/${selected.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      setDialog(null);
      await loadCampaigns();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to rename campaign');
    } finally {
      setSaving(false);
    }
  }

  async function archiveCampaign(campaign: Campaign) {
    if (!window.confirm(`Archive “${campaign.name}”? You can restore it later.`)) return;
    try {
      await requestJson(`/api/campaigns/${campaign.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'archived' }),
      });
      await loadCampaigns();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to archive campaign');
    }
  }

  async function mergeCampaign(event: FormEvent) {
    event.preventDefault();
    if (!selected || !sourceId) return;
    setSaving(true);
    try {
      await requestJson(`/api/campaigns/${selected.id}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_campaign_id: sourceId }),
      });
      setDialog(null);
      await loadCampaigns();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to merge campaigns');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="app-shell">
      <BillingGuardAlert />
      <section className="card">
        <div className="card__header">
          <div>
            <div className="card__title">Outreach Hub</div>
            <div className="card__subtitle">Campaigns for {email}</div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => void signOut({ callbackUrl: '/' })}
            >
              Sign out
            </button>
          </div>
        </div>
        <div className="card__body">
          {error && <p className="field__error">{error}</p>}
          <section className="hub-overview" aria-labelledby="hub-overview-title">
            <HubPlaneFlight />
            <div className="hub-overview__pitch">
              <h2 id="hub-overview-title">
                <span>Upload your Leads.</span>
                <span>Personalized Outreach.</span>
              </h2>
              <p>
                Upload an image, csv, doc, pdf, and more. eVA enriches your leads, researches them,
                situates them in Embark&apos;s prior work, and drafts personalized emails for each one.
              </p>
            </div>
            <LeadListTutorial />
          </section>
          {loading ? (
            <p className="text-muted">Loading campaigns…</p>
          ) : active.length === 0 ? (
            <div className="empty-state">
              <strong>Create your first campaign</strong>
              <span>Keep each outreach list organized in its own workspace, then add your lead sources.</span>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="btn btn--primary" onClick={openCreate}>+ New Campaign</button>
                <Link href="/hub/queue" className="btn btn--secondary">
                  Queue
                </Link>
                <Link href="/hub/analytics" className="btn btn--secondary">
                  Analytics Hub
                </Link>
              </div>
            </div>
          ) : (
            <div className="hub-campaigns">
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="btn btn--primary hub-campaigns__create" type="button" onClick={openCreate}>
                  + New Campaign
                </button>
                <Link href="/hub/queue" className="btn btn--secondary">
                  Queue
                </Link>
                <Link href="/hub/analytics" className="btn btn--secondary">
                  Analytics Hub
                </Link>
              </div>
              <div className="hub-campaigns__header">
                <strong>Your campaigns</strong>
                <span>{active.length} active</span>
              </div>
              <div className="campaign-list">
                {active.map((campaign) => (
                  <CampaignRow
                    key={campaign.id}
                    campaign={campaign}
                    canMerge={active.length > 1}
                    onRename={() => openRename(campaign)}
                    onMerge={() => openMerge(campaign)}
                    onArchive={() => void archiveCampaign(campaign)}
                    onReload={() => void loadCampaigns()}
                  />
                ))}
              </div>
            </div>
          )}

          {archived.length > 0 && (
            <details className="archived-campaigns">
              <summary>Archived campaigns ({archived.length})</summary>
              <div className="campaign-list">
                {archived.map((campaign) => (
                  <CampaignRow
                    key={campaign.id}
                    campaign={campaign}
                    canMerge={false}
                    onRename={() => openRename(campaign)}
                    onMerge={() => undefined}
                    onArchive={() => undefined}
                    onReload={() => void loadCampaigns()}
                  />
                ))}
              </div>
            </details>
          )}
        </div>
      </section>

      {dialog && (
        <div className="dialog-overlay" role="presentation" onMouseDown={() => !saving && setDialog(null)}>
          <section className="card dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className="card__header">
              <div className="card__title">
                {dialog === 'create' && 'New Campaign'}
                {dialog === 'rename' && 'Rename Campaign'}
                {dialog === 'merge' && `Merge into “${selected?.name}”`}
              </div>
              <button className="dialog__close" onClick={() => setDialog(null)} aria-label="Close dialog"><X size={18} /></button>
            </div>
            <div className="card__body">
              {dialog === 'create' && (
                <CampaignNameForm
                  name={name}
                  setName={setName}
                  saving={saving}
                  submitLabel="Create Campaign"
                  onSubmit={createCampaign}
                  needsEnrichment={needsEnrichment}
                  setNeedsEnrichment={setNeedsEnrichment}
                />
              )}
              {dialog === 'rename' && (
                <CampaignNameForm name={name} setName={setName} saving={saving} submitLabel="Save Name" onSubmit={renameCampaign} />
              )}
              {dialog === 'merge' && selected && (
                <form className="login-form" onSubmit={mergeCampaign}>
                  <p className="text-muted">The selected campaign will keep its name. Leads from the campaign below will be added and high-confidence duplicates collapsed.</p>
                  <label className="field">
                    <span className="field__label">Campaign to bring in</span>
                    <select className="field__input" value={sourceId} onChange={(event) => setSourceId(event.target.value)} required>
                      {active.filter((campaign) => campaign.id !== selected.id).map((campaign) => (
                        <option key={campaign.id} value={campaign.id}>{campaign.name}</option>
                      ))}
                    </select>
                  </label>
                  <button className="btn btn--primary" type="submit" disabled={saving || !sourceId}>
                    {saving ? 'Merging…' : 'Merge Campaigns'}
                  </button>
                </form>
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function CampaignNameForm({
  name, setName, saving, submitLabel, onSubmit,
  needsEnrichment, setNeedsEnrichment,
}: {
  name: string;
  setName: (name: string) => void;
  saving: boolean;
  submitLabel: string;
  onSubmit: (event: FormEvent) => Promise<void>;
  needsEnrichment?: boolean;
  setNeedsEnrichment?: (value: boolean) => void;
}) {
  const showEnrichmentToggle = typeof needsEnrichment === 'boolean' && setNeedsEnrichment;
  return (
    <form className="login-form" onSubmit={(event) => void onSubmit(event)}>
      <label className="field">
        <span className="field__label">Campaign name</span>
        <input
          className="field__input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Q3 Fintech VP Outreach"
          autoFocus
          required
        />
      </label>
      {showEnrichmentToggle && (
        <div className="field" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 'var(--space-2)' }}>
          <span className="field__label" id="needs-enrichment-label">Needs Enrichment?</span>
          <div className="segmented" style={{ width: 'fit-content' }}>
            <button
              type="button"
              className={`segmented__item${!needsEnrichment ? ' segmented__item--active' : ''}`}
              onClick={() => setNeedsEnrichment(false)}
            >
              No
            </button>
            <button
              type="button"
              className={`segmented__item${needsEnrichment ? ' segmented__item--active' : ''}`}
              onClick={() => setNeedsEnrichment(true)}
            >
              Yes
            </button>
          </div>
          <p className="field__hint" style={{ margin: 0, marginTop: 'var(--space-1)' }}>
            {needsEnrichment
              ? 'Upload → Enrich → Review → Draft. Use for lists that still need email and profile research.'
              : 'Upload → Draft. Use for lists that are already enriched with validated emails.'}
          </p>
        </div>
      )}
      <button className="btn btn--primary" type="submit" disabled={saving || !name.trim()}>
        {saving ? 'Saving…' : submitLabel}
      </button>
    </form>
  );
}

function CampaignRow({
  campaign, canMerge, onRename, onMerge, onArchive, onReload,
}: {
  campaign: Campaign;
  canMerge: boolean;
  onRename: () => void;
  onMerge: () => void;
  onArchive: () => void;
  onReload: () => void;
}) {
  const [editingTag, setEditingTag] = useState(false);

  async function handleAddTag(tagName: string, colorId: string) {
    try {
      await requestJson(`/api/campaigns/${campaign.id}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: tagName, color: colorId }),
      });
      setEditingTag(false);
      onReload();
    } catch {
      // Ignore
    }
  }

  async function handleRemoveTag(tag: string) {
    try {
      await requestJson(`/api/campaigns/${campaign.id}/tags?tag=${encodeURIComponent(tag)}`, {
        method: 'DELETE',
      });
      onReload();
    } catch {
      // Ignore
    }
  }

  const tagItems: { tag: string; color?: string | null }[] = campaign.tag_details?.length
    ? campaign.tag_details
    : (campaign.tags ?? []).map((t) => ({ tag: t, color: null }));

  return (
    <div className="campaign-row">
      <Link className="campaign-row__main" href={`/campaigns/${campaign.id}`}>
        <span className="campaign-row__name">{campaign.name}</span>
        <span className="campaign-row__meta">{campaign.lead_count} {campaign.lead_count === 1 ? 'lead' : 'leads'} · {formatDate(campaign.last_run_at)}</span>
      </Link>

      <div className="campaign-row__actions" style={{ gap: '6px' }}>
        {/* Right-aligned tags section */}
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px', marginRight: '6px' }}>
          {tagItems.map((item) => (
            <TagBadge
              key={item.tag}
              tag={item.tag}
              color={item.color}
              onRemove={() => void handleRemoveTag(item.tag)}
              size="sm"
            />
          ))}

          {editingTag ? (
            <TagInputPopover
              onAddTag={handleAddTag}
              onCancel={() => setEditingTag(false)}
              excludeTags={tagItems.map((item) => item.tag)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingTag(true)}
              style={{
                border: '1px dashed var(--color-border)',
                background: 'transparent',
                borderRadius: 'var(--radius-pill)',
                padding: '2px 8px',
                fontSize: '11px',
                color: 'var(--color-text-subtle)',
                cursor: 'pointer',
                fontWeight: '500',
              }}
            >
              + Tag
            </button>
          )}
        </div>

        {campaign.status === 'active' && canMerge && <button className="btn btn--quiet" onClick={onMerge}>Merge in</button>}
        <button className="btn btn--quiet" onClick={onRename}>Rename</button>
        {campaign.status === 'active' && <button className="btn btn--quiet" onClick={onArchive}>Archive</button>}
      </div>
    </div>
  );
}
