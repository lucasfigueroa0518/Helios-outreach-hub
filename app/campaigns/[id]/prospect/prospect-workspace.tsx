'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { CampaignTabs } from '@/app/campaigns/[id]/campaign-tabs';
import { ReviewTable } from '@/app/campaigns/[id]/review/review-table';
import { SenderSetupModal } from '@/app/campaigns/[id]/draft/sender-setup-modal';
import { LivePulse } from '@/app/components/live-pulse';
import { EXPANSION_LABELS } from '@/lib/auto-campaigns/types';
import { requestJson } from '@/lib/client-request';
import type { Campaign } from '@/lib/campaigns';
import type { CampaignSheetViewRow } from '@/lib/campaign-sheet';

type ProspectLogEntry = {
  at: string;
  kind: string;
  message: string;
  page?: number;
  count?: number;
};

type ProspectPayload = {
  campaign: Campaign;
  days: string[];
  selected_day: string | null;
  leads: CampaignSheetViewRow[];
  pulled_count: number;
  sent_count: number;
  cycle_job: 'pending' | 'in_flight' | null;
  active_run: {
    id: string;
    status: string;
    stats: { prospect?: { log?: ProspectLogEntry[] } };
    error: string | null;
    started_at: string;
  } | null;
};

function prospectActivity(payload: ProspectPayload | null): { busy: boolean; message: string } {
  if (!payload) {
    return { busy: true, message: 'Opening prospecting…' };
  }
  const health = payload.campaign.auto_status ?? 'pending_sender';
  const log = payload.active_run?.stats?.prospect?.log ?? [];
  const latest = log[log.length - 1]?.message;
  if (health === 'pending_sender') {
    return { busy: false, message: 'Sender setup is required before Apollo can run.' };
  }
  if (health === 'paused') {
    return { busy: false, message: 'Paused. Edit targeting, then resume.' };
  }
  if (health === 'error') {
    return { busy: false, message: payload.campaign.auto_error || 'The last cycle hit an error.' };
  }
  if (health === 'exhausted') {
    return { busy: false, message: 'Exact and similar profiles are exhausted.' };
  }
  const running = payload.cycle_job === 'pending'
    || payload.cycle_job === 'in_flight'
    || payload.active_run?.status === 'prospecting';
  if (running) {
    return {
      busy: true,
      message: latest ?? (
        payload.cycle_job === 'pending'
          ? 'First cycle is queued. Apollo people search starts next.'
          : 'Running Apollo people search…'
      ),
    };
  }
  if (!payload.campaign.last_cycle_at) {
    return { busy: true, message: 'First cycle is queued. Apollo people search starts next.' };
  }
  if (latest) return { busy: false, message: latest };
  return { busy: false, message: 'Waiting for the next weekday cycle.' };
}

export function ProspectWorkspace({
  campaignId,
  defaultDisplayName,
  defaultWorkEmail,
}: {
  campaignId: string;
  defaultDisplayName: string;
  defaultWorkEmail: string;
}) {
  const [data, setData] = useState<ProspectPayload | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showSender, setShowSender] = useState(false);
  const [editPaused, setEditPaused] = useState(false);
  const [industry, setIndustry] = useState('');
  const [seniority, setSeniority] = useState('');
  const [geography, setGeography] = useState('');
  const [businessSize, setBusinessSize] = useState('');
  const [emailsPerDay, setEmailsPerDay] = useState('10');

  const load = useCallback(async (selected?: string | null) => {
    const params = selected ? `?day=${encodeURIComponent(selected)}` : '';
    const payload = await requestJson<ProspectPayload>(`/api/campaigns/${campaignId}/prospect${params}`);
    setData(payload);
    setDay(payload.selected_day);
    setIndustry(payload.campaign.lead_attributes.industry);
    setSeniority(payload.campaign.lead_attributes.seniority);
    setGeography(payload.campaign.lead_attributes.geography);
    setBusinessSize(payload.campaign.lead_attributes.business_size);
    setEmailsPerDay(String(payload.campaign.emails_per_day ?? 10));
  }, [campaignId]);

  useEffect(() => {
    void load(day).catch((err) => setError(err instanceof Error ? err.message : 'Unable to load prospecting'));
  }, [load, day]);

  useEffect(() => {
    const live = data?.campaign.auto_status === 'live';
    const running = data?.active_run?.status === 'prospecting'
      || data?.cycle_job === 'pending'
      || data?.cycle_job === 'in_flight';
    if (data && !live && !running) return undefined;
    const busy = !data || !data.campaign.last_cycle_at || running;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void load(day).catch(() => undefined);
    }, busy ? 1000 : 2500);
    return () => window.clearInterval(timer);
  }, [
    data,
    data?.campaign.auto_status,
    data?.campaign.last_cycle_at,
    data?.active_run?.status,
    data?.cycle_job,
    load,
    day,
  ]);

  const campaign = data?.campaign;
  const days = data?.days ?? [];
  const dayIndex = day ? days.indexOf(day) : 0;
  const live = campaign?.auto_status === 'live';
  const health = campaign?.auto_status ?? 'pending_sender';
  const activity = prospectActivity(data);

  async function patch(body: Record<string, unknown>) {
    setSaving(true);
    try {
      await requestJson(`/api/campaigns/${campaignId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await load(day);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update campaign');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <CampaignTabs
        campaignId={campaignId}
        active="prospect"
        mode="auto"
        showReview={false}
        reviewEnabled={false}
        draftEnabled
      />

      {error ? <p className="field__error">{error}</p> : null}

      <div className={`auto-health${live ? ' auto-health--live' : ''}`}>
        <LivePulse live={live} />
        {live ? null : <span className="auto-health__status">{health.replace(/_/g, ' ')}</span>}
        {campaign?.auto_error ? <span className="auto-health__error">{campaign.auto_error}</span> : null}
        <div className="auto-health__actions">
          {health === 'pending_sender' ? (
            <button type="button" className="btn btn--primary" onClick={() => setShowSender(true)}>
              Complete sender setup
            </button>
          ) : null}
          {live ? (
            <button type="button" className="btn btn--secondary" disabled={saving} onClick={() => void patch({ auto_status: 'paused' })}>
              Pause
            </button>
          ) : null}
          {health === 'paused' || health === 'error' || health === 'exhausted' ? (
            <button type="button" className="btn btn--primary" disabled={saving} onClick={() => void patch({ auto_status: 'live' })}>
              Resume
            </button>
          ) : null}
        </div>
      </div>

      <div className="stat-tile-row auto-stat-row">
        <div className="stat-tile">
          <span className="stat-tile__label">Total leads</span>
          <span className="stat-tile__value">{data?.pulled_count ?? 0}</span>
        </div>
        <div className="stat-tile">
          <span className="stat-tile__label">Leads this day</span>
          <span className="stat-tile__value">{data?.leads.length ?? 0}</span>
        </div>
        <div className="stat-tile">
          <span className="stat-tile__label">Emails / day</span>
          <span className="stat-tile__value">{campaign?.emails_per_day ?? '—'}</span>
        </div>
        <div className="stat-tile">
          <span className="stat-tile__label">Profile match</span>
          <span className="stat-tile__value">
            {EXPANSION_LABELS[campaign?.expansion_step ?? 0]}
          </span>
        </div>
      </div>

      <p className="auto-attributes">
        {campaign?.lead_attributes.seniority} · {campaign?.lead_attributes.industry} · {campaign?.lead_attributes.geography} · {campaign?.lead_attributes.business_size}
      </p>

      {health === 'paused' ? (
        <details className="auto-edit" open={editPaused} onToggle={(event) => setEditPaused(event.currentTarget.open)}>
          <summary>Edit targeting</summary>
          <form
            className="login-form"
            onSubmit={(event) => {
              event.preventDefault();
              void patch({
                emails_per_day: Number.parseInt(emailsPerDay.replace(/[^\d]/g, ''), 10),
                lead_attributes: {
                  industry,
                  seniority,
                  geography,
                  business_size: businessSize,
                },
              });
            }}
          >
            <label className="field"><span className="field__label">Industry</span><input className="field__input" value={industry} onChange={(e) => setIndustry(e.target.value)} required /></label>
            <label className="field"><span className="field__label">Seniority</span><input className="field__input" value={seniority} onChange={(e) => setSeniority(e.target.value)} required /></label>
            <label className="field"><span className="field__label">Geography</span><input className="field__input" value={geography} onChange={(e) => setGeography(e.target.value)} required /></label>
            <label className="field"><span className="field__label">Business size</span><input className="field__input" value={businessSize} onChange={(e) => setBusinessSize(e.target.value)} required /></label>
            <label className="field"><span className="field__label">Emails per day</span><input className="field__input" value={emailsPerDay} onChange={(e) => setEmailsPerDay(e.target.value)} required /></label>
            <button className="btn btn--primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save targeting'}</button>
          </form>
        </details>
      ) : null}

      <div className="auto-activity" role="status" aria-live="polite">
        {activity.busy ? <span className="loading-spinner" aria-hidden="true" /> : null}
        <span>{activity.message}</span>
      </div>

      <div className="auto-day-pager">
        <button
          type="button"
          className="btn btn--quiet"
          disabled={dayIndex <= 0}
          onClick={() => dayIndex > 0 && setDay(days[dayIndex - 1] ?? null)}
          aria-label="Previous day"
        >
          <ChevronLeft size={16} />
        </button>
        <strong>{day ?? 'No leads yet'}</strong>
        <button
          type="button"
          className="btn btn--quiet"
          disabled={dayIndex < 0 || dayIndex >= days.length - 1}
          onClick={() => dayIndex >= 0 && setDay(days[dayIndex + 1] ?? null)}
          aria-label="Next day"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      {data?.leads.length ? (
        <ReviewTable campaignId={campaignId} initialRows={data.leads} compact />
      ) : null}

      {showSender ? (
        <SenderSetupModal
          open={showSender}
          defaultDisplayName={defaultDisplayName}
          defaultWorkEmail={defaultWorkEmail}
          onClose={() => setShowSender(false)}
          onSaved={() => {
            setShowSender(false);
            void patch({ auto_status: 'live' });
          }}
        />
      ) : null}
    </>
  );
}
