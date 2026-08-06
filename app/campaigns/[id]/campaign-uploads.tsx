'use client';

import { ChangeEvent, DragEvent, ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Upload as UploadIcon } from 'lucide-react';
import { acceptedTypeLabel, isSheetUploadKind, sniffUpload, type SupportedUploadKind } from '@/lib/upload-types';
import { isNonCriticalExtractionWarning } from '@/lib/extraction-warnings';
import { CampaignTabs } from '@/app/campaigns/[id]/campaign-tabs';
import {
  clearDraftingLaunch,
  DraftingLaunchOverlay,
  markDraftingLaunch,
} from '@/app/campaigns/[id]/draft/drafting-launch-overlay';
import { SenderSetupModal } from '@/app/campaigns/[id]/draft/sender-setup-modal';
import type { SenderProfile } from '@/app/campaigns/[id]/draft/types';

function preEnrichedIdempotencyKey(campaignId: string) {
  const storageKey = `pre-enriched-idempotency-${campaignId}`;
  let key = sessionStorage.getItem(storageKey);
  if (!key) {
    key = crypto.randomUUID();
    sessionStorage.setItem(storageKey, key);
  }
  return key;
}

type Upload = {
  id: string;
  run_id: string;
  run_status: string;
  file_name: string;
  mime_type: string | null;
  byte_size: number | null;
  content_hash: string | null;
  status: string;
  extraction_summary: {
    people_found?: number;
    warnings?: string[];
    progress?: { stage?: string; percent?: number; message?: string };
  } | null;
  created_at: string;
};

type UploadIntent = {
  upload: Upload & { storage_path: string };
  uploadUrl: string;
  token: string;
};

type ActiveRun = {
  id: string;
  status: string;
  stats?: {
    enrichment?: {
      companies_total?: number;
      companies_remaining?: number;
      rate_limit_events?: unknown[];
    };
    prior_enrichment?: {
      people_total?: number;
      people_scanned?: number;
      awaiting_count?: number;
      scan_complete?: boolean;
      decision?: string;
    };
  };
};

type CostEstimate = {
  lead_count: number;
  method?: 'path_bucket' | 'flat_fallback';
  enrichment: { avg_usd: string; sample_size: number; source: string };
  drafting: { avg_usd: string; sample_size: number; source: string };
  per_lead_usd: string;
  campaign_total_usd: string;
  note: string;
  buckets?: Array<{
    path: string;
    phase: string;
    count: number;
    unit_usd: string;
    total_usd: string;
  }>;
};

function formatBytes(bytes: number | null) {
  if (!bytes) return '—';
  if (bytes < 1_048_576) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function dedupeUploads(uploads: Upload[]) {
  const byId = new Map<string, Upload>();
  for (const upload of uploads) byId.set(upload.id, upload);
  return [...byId.values()];
}

export function CampaignUploads({
  campaignId,
  needsEnrichment = true,
  reviewEnabledInitial,
  draftEnabledInitial = false,
  defaultDisplayName,
  defaultWorkEmail,
}: {
  campaignId: string;
  needsEnrichment?: boolean;
  reviewEnabledInitial: boolean;
  draftEnabledInitial?: boolean;
  defaultDisplayName: string;
  defaultWorkEmail: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const resumeAfterSender = useRef(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [canEnrich, setCanEnrich] = useState(false);
  const [stagedCount, setStagedCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [goingToDraft, setGoingToDraft] = useState(false);
  const [senderModalOpen, setSenderModalOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [researchConcurrency, setResearchConcurrency] = useState(8);
  const [costEstimate, setCostEstimate] = useState<CostEstimate | null>(null);
  const [priorDecisionBusy, setPriorDecisionBusy] = useState(false);
  const [hasMadePriorDecision, setHasMadePriorDecision] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'notice' | 'success' } | null>(null);
  const preEnriched = !needsEnrichment;
  const activeRunStatus = activeRun?.status
    ?? uploads.find((upload) => upload.run_id === activeRunId)?.run_status;
  const priorEnrichment = activeRun?.stats?.prior_enrichment;
  const priorAwaitingCount = priorEnrichment?.awaiting_count ?? 0;
  const priorScanComplete = priorEnrichment?.scan_complete === true;
  const showPriorEnrichmentGate = priorAwaitingCount > 0
    && !hasMadePriorDecision
    && (activeRunStatus === 'awaiting_prior_enrichment'
      || activeRunStatus === 'extracting'
      || (priorEnrichment?.people_scanned ?? 0) > 0);
  const enrichmentComplete = !activeRunId
    && uploads.some((upload) => upload.status === 'extracted');
  const showGoToReview = !preEnriched && enrichmentComplete && !canEnrich;
  const hasPendingUploads = uploads.some((upload) => upload.status === 'pending_upload');
  const readySheetCount = uploads.filter((upload) =>
    upload.status === 'uploaded' || upload.status === 'extracted',
  ).length;
  const canGoToDraft = preEnriched && readySheetCount > 0 && !hasPendingUploads && !busy;

  async function loadUploads() {
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/uploads`);
      const data = await response.json();
      if (!response.ok) {
        setMessage({ text: data.error ?? 'Unable to load uploads', tone: 'error' });
        return;
      }
      setUploads(dedupeUploads(data.uploads ?? []));
      setActiveRunId(data.active_run_id ?? null);
      setActiveRun(data.active_run ?? null);
      setCanEnrich(Boolean(data.can_enrich));
      setStagedCount(data.staged_count ?? 0);
      setCostEstimate(data.cost_estimate ?? null);
      if (typeof data.research_concurrency === 'number') {
        setResearchConcurrency(data.research_concurrency);
      }
      const hasExtracted = (data.uploads ?? []).some((upload: Upload) => upload.status === 'extracted');
      if (!data.active_run_id) {
        setHasMadePriorDecision(false);
        setMessage((current) => {
          if (!current) return null;
          if (
            current.text === 'Extraction started. Progress will appear here as each file completes.' ||
            current.text.includes('resuming run') ||
            current.text.includes('resuming')
          ) {
            if (hasExtracted) {
              return { text: 'Enrichment complete — open Review to check your leads.', tone: 'success' };
            }
            return null;
          }
          return current;
        });
      }
    } catch {
      setMessage({ text: 'Connection failed — the dev server may have stopped. Refresh in a moment.', tone: 'error' });
    }
  }

  useEffect(() => {
    void loadUploads();
  }, [campaignId]);

  useEffect(() => {
    if (!activeRunId) return;
    const timer = window.setInterval(() => void loadUploads(), 1_500);
    return () => window.clearInterval(timer);
  }, [activeRunId, campaignId]);

  async function uploadFiles(files: FileList | File[]) {
    const fileList = Array.from(files);
    if (!fileList.length) return;
    setBusy(true);
    setMessage(null);

    for (const file of fileList) {
      const header = new Uint8Array(await file.slice(0, 32).arrayBuffer());
      const sniffed = sniffUpload(file.name, header);
      if (!sniffed) {
        setMessage({
          text: preEnriched
            ? `“${file.name}” wasn’t added. Pre-enriched campaigns accept CSV, TSV, or Excel only.`
            : `“${file.name}” wasn’t added. Accepted: images, PDF, CSV, Excel, Word, PowerPoint, or text.`,
          tone: 'error',
        });
        continue;
      }
      if (preEnriched && !isSheetUploadKind(sniffed.kind)) {
        setMessage({
          text: `“${file.name}” wasn’t added. Pre-enriched campaigns accept CSV, TSV, or Excel only.`,
          tone: 'error',
        });
        continue;
      }

      try {
        const intentResponse = await fetch(`/api/campaigns/${campaignId}/uploads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file_name: file.name,
            mime_type: sniffed.mimeType,
            byte_size: file.size,
          }),
        });
        const intent = await intentResponse.json() as UploadIntent & { error?: string };
        if (!intentResponse.ok) throw new Error(intent.error ?? 'Unable to prepare upload');

        setUploads((current) => dedupeUploads([...current, intent.upload]));
        const uploadResponse = await fetch(intent.uploadUrl, {
          method: 'PUT',
          headers: {
            'content-type': sniffed.mimeType,
            'x-upsert': 'false',
          },
          body: file,
        });
        const success = uploadResponse.ok;
        const resultResponse = await fetch(`/api/campaigns/${campaignId}/uploads`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ upload_id: intent.upload.id, success }),
        });
        const result = await resultResponse.json() as { upload?: Upload };
        if (!success || !resultResponse.ok || !result.upload) {
          throw new Error(`Upload failed${uploadResponse.status ? ` (${uploadResponse.status})` : ''}`);
        }
        setUploads((current) => current.map((upload) => upload.id === result.upload?.id ? result.upload : upload));
      } catch (error) {
        setMessage({ text: error instanceof Error ? error.message : `Could not upload “${file.name}”`, tone: 'error' });
        await loadUploads();
      }
    }

    await loadUploads();
    setBusy(false);
  }

  async function removeUpload(uploadId: string) {
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/uploads?upload_id=${encodeURIComponent(uploadId)}`, {
        method: 'DELETE',
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Unable to remove upload');
      setUploads((current) => current.filter((upload) => upload.id !== uploadId));
      await loadUploads();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Unable to remove upload', tone: 'error' });
    }
  }

  async function startEnrichment() {
    setEnriching(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/runs`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Unable to start extraction');
      setMessage({ text: 'Extraction started. Progress will appear here as each file completes.', tone: 'success' });
      window.setTimeout(() => void loadUploads(), 400);
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Unable to start extraction', tone: 'error' });
    } finally {
      setEnriching(false);
    }
  }

  const cancelGoToDraft = useCallback(() => {
    clearDraftingLaunch(campaignId);
    setGoingToDraft(false);
  }, [campaignId]);

  const runPreEnrichedIngest = useCallback(async () => {
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/pre-enriched/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotency_key: preEnrichedIdempotencyKey(campaignId) }),
      });
      const data = await response.json();

      if (response.status === 422 && data.field_errors?.sender_profile) {
        cancelGoToDraft();
        resumeAfterSender.current = true;
        setSenderModalOpen(true);
        return;
      }
      if (response.status === 409 && data.code === 'idempotency_collision') {
        window.location.href = `/campaigns/${campaignId}/draft`;
        return;
      }
      if (!response.ok) {
        cancelGoToDraft();
        setMessage({ text: data.error ?? 'Could not stage leads for drafting', tone: 'error' });
        return;
      }
      window.location.href = data.href ?? `/campaigns/${campaignId}/draft`;
    } catch {
      cancelGoToDraft();
      setMessage({ text: 'Connection failed — try again.', tone: 'error' });
    }
  }, [campaignId, cancelGoToDraft]);

  async function goToDraft() {
    if (!canGoToDraft || goingToDraft) return;
    setGoingToDraft(true);
    setMessage({ text: 'Staging leads for drafting…', tone: 'notice' });
    markDraftingLaunch(campaignId);

    try {
      const profileResponse = await fetch('/api/sender-profiles');
      const profileData = await profileResponse.json();
      if (!profileResponse.ok) {
        cancelGoToDraft();
        setMessage({ text: profileData.error ?? 'Could not load sender profile', tone: 'error' });
        return;
      }
      if (!profileData.profiles?.length) {
        cancelGoToDraft();
        resumeAfterSender.current = true;
        setSenderModalOpen(true);
        return;
      }
    } catch {
      cancelGoToDraft();
      setMessage({ text: 'Connection failed — try again.', tone: 'error' });
      return;
    }

    await runPreEnrichedIngest();
  }

  function onSenderSaved(_profile: SenderProfile) {
    setSenderModalOpen(false);
    if (resumeAfterSender.current) {
      resumeAfterSender.current = false;
      setGoingToDraft(true);
      setMessage({ text: 'Staging leads for drafting…', tone: 'notice' });
      markDraftingLaunch(campaignId);
      void runPreEnrichedIngest();
    }
  }

  async function submitPriorEnrichmentDecision(decision: 'use_prior' | 're_enrich') {
    if (!activeRunId) return;
    setPriorDecisionBusy(true);
    setHasMadePriorDecision(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/runs/${activeRunId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'prior_enrichment_decision', decision }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Unable to apply decision');
      setMessage({
        text: decision === 'use_prior'
          ? 'Using prior enrichment — resuming run…'
          : 'Re-enriching leads — resuming run…',
        tone: 'success',
      });
      await loadUploads();
    } catch (error) {
      setMessage({
        text: error instanceof Error ? error.message : 'Unable to apply prior enrichment decision',
        tone: 'error',
      });
    } finally {
      setPriorDecisionBusy(false);
    }
  }

  async function cancelRun() {
    if (!activeRunId || !window.confirm('Cancel this enrichment run? Incomplete files will return to staging so you can restart.')) return;
    setCancelling(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/runs/${activeRunId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Unable to cancel run');
      setMessage({ text: 'Enrichment run cancelled. Staged files are ready — click Enrich to restart.', tone: 'notice' });
      await loadUploads();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Unable to cancel run', tone: 'error' });
    } finally {
      setCancelling(false);
    }
  }

  function onInput(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) void uploadFiles(event.target.files);
    event.target.value = '';
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void uploadFiles(event.dataTransfer.files);
  }

  return (
    <section className="upload-section">
      {goingToDraft ? <DraftingLaunchOverlay /> : null}
      <div className="campaign-tabs-row">
        <CampaignTabs
          campaignId={campaignId}
          active="upload"
          showReview={!preEnriched}
          reviewEnabled={
            preEnriched
              ? false
              : reviewEnabledInitial || uploads.some((upload) => upload.status === 'extracted')
          }
          draftEnabled={
            preEnriched
              ? draftEnabledInitial
              : reviewEnabledInitial || uploads.some((upload) => upload.status === 'extracted')
          }
        />
        {!preEnriched && costEstimate && costEstimate.lead_count > 0 && uploads.length > 0 && (
          <div
            className="campaign-cost-summary-compact"
            aria-live="polite"
            title={costEstimate.note}
          >
            <span className="campaign-cost-estimate__badge">
              {costEstimate.method === 'path_bucket' ? 'Path Estimate' : 'Campaign Estimate'}
            </span>
            <span className="cost-total"><strong>${Number(costEstimate.campaign_total_usd).toFixed(2)}</strong> total</span>
            <span className="cost-divider">·</span>
            <span className="cost-leads">{costEstimate.lead_count} leads</span>
            <span className="cost-divider">·</span>
            <span className="cost-rate">${Number(costEstimate.per_lead_usd).toFixed(2)}/lead</span>
          </div>
        )}
      </div>

      <div className="review-guide upload-guide">
        <div className="review-guide__intro">
          <span className="upload-guide__eyebrow">
            {preEnriched ? 'Upload enriched leads' : 'Upload your leads'}
          </span>
          <strong>
            {preEnriched
              ? 'Load an already-enriched sheet and go straight to Draft'
              : 'Turn your lead list into an enriched CSV'}
          </strong>
          <p>
            {preEnriched
              ? 'Upload a CSV or Excel lead list that already has validated emails. We skip enrichment and mailbox verification, stage the rows for drafting, then take you to Draft.'
              : 'Upload your leads in the file format you already have. We\'ll enrich them with email addresses, companies, job titles, and locations, and identify any previous relationship they have with Embark.'}
          </p>
        </div>
        <div className="upload-guide__value">
          <strong>What you get</strong>
          <ul>
            {preEnriched ? (
              <>
                <li>Leads staged in drafting-ready format</li>
                <li>Emails trusted as already validated</li>
                <li>Direct path to personalized draft emails</li>
              </>
            ) : (
              <>
                <li>Enriched contact and company details</li>
                <li>Previous Embark relationship context</li>
                <li>A downloadable CSV ready for outreach</li>
              </>
            )}
          </ul>
        </div>
      </div>
      <div className="upload-actions">
        <span className="text-muted">
          {preEnriched ? 'Upload your enriched sheet, then click Go to Draft.' : 'Upload more lead sources at any time.'}
        </span>
      </div>
      <div
        className={`dropzone${dragging ? ' dropzone--active' : ''}`}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => event.key === 'Enter' && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          multiple={!preEnriched}
          accept={preEnriched ? '.csv,.tsv,.xlsx,.xls,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel' : undefined}
          onChange={onInput}
        />
        <span className="dropzone__icon"><UploadIcon size={18} /></span>
        <strong>{busy ? 'Uploading files…' : 'Drop files here or browse'}</strong>
        <span>
          {preEnriched
            ? 'CSV, TSV, or Excel spreadsheets'
            : 'Screenshots & photos, PDF, CSV, Excel, PowerPoint, Word, and text'}
        </span>
        <span className="text-muted">
          {preEnriched
            ? 'Already-enriched lead lists only · 50 MB per file'
            : 'PNG, JPEG, WebP, and GIF images are supported · 50 MB per file'}
        </span>
      </div>

      {message && (
        <p className={
          message.tone === 'error'
            ? 'field__error'
            : message.tone === 'success'
            ? 'field__success'
            : 'field__notice'
        }>
          {message.text}
        </p>
      )}

      {uploads.length > 0 && (
        <div className="upload-list">
          <div className="upload-list__header">
            <strong>
              {preEnriched
                ? 'Staged sheets'
                : activeRunId ? 'Enrichment run' : 'Staged uploads'}
            </strong>
            <span>{uploads.length} file{uploads.length === 1 ? '' : 's'}</span>
          </div>
          {!preEnriched && activeRunId && (
            (showPriorEnrichmentGate && !priorDecisionBusy) ? (
              <div className="prior-decision-container" aria-live="polite">
                <div className="prior-decision-info">
                  <div className="prior-decision-title">
                    {!priorScanComplete && <span className="loading-spinner" aria-hidden="true" style={{ width: '14px', height: '14px', marginRight: 'var(--space-1)' }} />}
                    <span>
                      {priorScanComplete
                        ? 'Waiting for your prior enrichment decision'
                        : 'Checking leads for prior enrichment…'}
                    </span>
                  </div>
                  <div className="prior-decision-desc">
                    <strong>{priorAwaitingCount} lead{priorAwaitingCount === 1 ? '' : 's'}</strong> have prior enrichment.{' '}
                    <span className="text-muted">
                      {priorScanComplete
                        ? 'Choose once for every lead in this cohort.'
                        : `Checking remaining leads (${priorEnrichment?.people_scanned ?? 0}/${priorEnrichment?.people_total ?? '…'})…`}
                    </span>
                  </div>
                </div>
                <div className="prior-decision-actions">
                  {priorScanComplete && activeRunStatus === 'awaiting_prior_enrichment' && (
                    <span className="prior-decision-alert" aria-hidden="true">
                      <span className="prior-decision-alert__dot" />
                      Decision Required
                    </span>
                  )}
                  <button
                    className="btn btn--secondary"
                    disabled={!priorScanComplete || priorDecisionBusy || activeRunStatus !== 'awaiting_prior_enrichment'}
                    onClick={() => void submitPriorEnrichmentDecision('re_enrich')}
                  >
                    Enrich
                  </button>
                  <button
                    className="btn btn--primary"
                    disabled={!priorScanComplete || priorDecisionBusy || activeRunStatus !== 'awaiting_prior_enrichment'}
                    onClick={() => void submitPriorEnrichmentDecision('use_prior')}
                  >
                    Use Prior
                  </button>
                  <button
                    className="btn btn--quiet"
                    onClick={() => void cancelRun()}
                    disabled={cancelling}
                  >
                    {cancelling ? 'Cancelling…' : 'Cancel run'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="run-progress">
                <span className="loading-spinner" aria-hidden="true" />
                <span>
                  {priorDecisionBusy || activeRunStatus === 'awaiting_prior_enrichment'
                    ? 'Applying prior enrichment decision and resuming run…'
                    : activeRunStatus === 'enriching'
                    ? `Researching missing emails and profile details on the web${
                      activeRun?.stats?.enrichment?.companies_total
                        ? ` · ${researchConcurrency} parallel workers · ${Math.max(
                          (activeRun.stats.enrichment.companies_total ?? 0)
                            - (activeRun.stats.enrichment.companies_remaining ?? 0),
                          0,
                        )}/${activeRun.stats.enrichment.companies_total} research tasks`
                        : ''
                    }`
                    : `Extracting ${uploads.filter((upload) => upload.run_id === activeRunId && ['extracted', 'failed', 'failed_quality'].includes(upload.status)).length} of ${uploads.filter((upload) => upload.run_id === activeRunId).length} files`}
                </span>
                <button className="btn btn--secondary" onClick={() => void cancelRun()} disabled={cancelling}>
                  {cancelling ? 'Cancelling…' : 'Cancel run'}
                </button>
              </div>
            )
          )}
          {!preEnriched && (activeRun?.stats?.enrichment?.rate_limit_events?.length ?? 0) > 0 && (
            <p className="field__notice">
              Enrichment briefly slowed by API limits — resuming automatically
              ({activeRun?.stats?.enrichment?.companies_remaining ?? 0} research tasks remaining).
            </p>
          )}
          {uploads.map((upload) => (
            <div
              className={[
                'upload-row',
                !preEnriched && isUploadEnriched(upload, activeRunId) ? 'upload-row--enriched' : '',
              ].filter(Boolean).join(' ')}
              key={upload.id}
            >
              <div>
                <strong>{upload.file_name}</strong>
                <span>{upload.mime_type ? acceptedTypeLabel(kindForMime(upload.mime_type)) : 'File'} · {formatBytes(upload.byte_size)}</span>
                {!preEnriched && <UploadProgress upload={upload} activeRunId={activeRunId} />}
                {!preEnriched && <UploadWarnings upload={upload} />}
              </div>
              <div className="upload-row__right">
                <span className={`status-chip status-chip--${statusClass(upload, activeRunId)}`}>
                  {statusLabel(upload, activeRunId)}
                </span>
                {upload.run_status === 'uploading' && <button className="btn btn--quiet" onClick={() => void removeUpload(upload.id)} disabled={busy || goingToDraft}>Remove</button>}
              </div>
            </div>
          ))}
          {preEnriched ? (
            <button
              className={`btn btn--primary${goingToDraft ? ' btn--pending' : ''}`}
              onClick={() => void goToDraft()}
              disabled={!canGoToDraft || goingToDraft}
              aria-busy={goingToDraft}
            >
              {goingToDraft
                ? 'Staging leads…'
                : readySheetCount > 0
                  ? `Go to Draft${readySheetCount > 1 ? ` (${readySheetCount} files)` : ''}`
                  : 'Go to Draft'}
            </button>
          ) : showGoToReview ? (
            <Link className="btn btn--primary" href={`/campaigns/${campaignId}/review`}>
              Go to Review
            </Link>
          ) : (
            <button
              className="btn btn--primary"
              onClick={() => void startEnrichment()}
              disabled={busy || enriching || cancelling || Boolean(activeRunId) || !canEnrich}
            >
              {enriching ? 'Starting…' : activeRunId ? 'Enrichment running' : stagedCount > 0 ? `Enrich ${stagedCount} file${stagedCount === 1 ? '' : 's'}` : 'Enrich'}
            </button>
          )}
        </div>
      )}

      <SenderSetupModal
        defaultDisplayName={defaultDisplayName}
        defaultWorkEmail={defaultWorkEmail}
        open={senderModalOpen}
        onClose={() => {
          resumeAfterSender.current = false;
          setSenderModalOpen(false);
        }}
        onSaved={onSenderSaved}
      />
    </section>
  );
}

function statusLabel(upload: Upload, activeRunId: string | null): ReactNode {
  if (isUploadInProgress(upload, activeRunId)) return 'In Progress';
  if (upload.run_status === 'cancelled') return 'Cancelled';
  if (upload.run_status === 'failed') return 'Failed';
  if (upload.status === 'extracted') {
    return (upload.extraction_summary?.people_found ?? 0) > 0
      ? <><CheckCircle2 size={12} aria-hidden="true" /> Enriched</>
      : <><AlertTriangle size={12} aria-hidden="true" /> No leads found</>;
  }
  if (upload.status === 'processing') return 'Enriching';
  if (upload.status === 'uploaded' && activeRunId && upload.run_id === activeRunId) return 'Queued';
  if (upload.status === 'uploaded') return 'Staged';
  return upload.status.replaceAll('_', ' ');
}

function statusClass(upload: Upload, activeRunId: string | null) {
  if (['cancelled', 'failed'].includes(upload.run_status)) return 'failed';
  if (isUploadInProgress(upload, activeRunId)) return 'processing';
  if (upload.status === 'extracted' && (upload.extraction_summary?.people_found ?? 0) === 0) return 'failed_quality';
  return upload.status;
}

function isUploadEnriched(upload: Upload, activeRunId: string | null) {
  return !activeRunId && upload.status === 'extracted' && (upload.extraction_summary?.people_found ?? 0) > 0;
}

function isUploadInProgress(upload: Upload, activeRunId: string | null) {
  return upload.run_id === activeRunId
    && ['queued', 'extracting', 'enriching', 'awaiting_prior_enrichment'].includes(upload.run_status);
}

function UploadProgress({ upload, activeRunId }: { upload: Upload; activeRunId: string | null }) {
  const inActiveRun = Boolean(activeRunId && upload.run_id === activeRunId);
  const isQueued = inActiveRun && upload.status === 'uploaded';
  const isProcessing = upload.status === 'processing';
  if (!isQueued && !isProcessing) return null;

  const progress = upload.extraction_summary?.progress;
  const percent = isProcessing ? (progress?.percent ?? 5) : 5;
  const label = isProcessing ? (progress?.message ?? 'Enriching file') : 'Waiting in queue';
  return (
    <div className="file-progress" aria-label={label}>
      <div className="file-progress__track"><span style={{ width: `${percent}%` }} /></div>
      <span>{label} · {percent}%</span>
    </div>
  );
}

function UploadWarnings({ upload }: { upload: Upload }) {
  const warnings = upload.extraction_summary?.warnings ?? [];
  const peopleFound = upload.extraction_summary?.people_found ?? 0;
  if (upload.status !== 'extracted' && upload.status !== 'failed_quality') return null;
  if (!warnings.length && peopleFound > 0) return null;
  return (
    <ul className="upload-warnings">
      {peopleFound === 0 && upload.status === 'extracted' && (
        <li className="upload-warnings__item upload-warnings__item--warning">No leads were found in this file.</li>
      )}
      {warnings.slice(0, 3).map((warning, index) => (
        <li
          key={index}
          className={`upload-warnings__item${
            isNonCriticalExtractionWarning(warning)
              ? ' upload-warnings__item--signal'
              : ' upload-warnings__item--warning'
          }`}
        >
          {warning}
        </li>
      ))}
    </ul>
  );
}

function kindForMime(mime: string): SupportedUploadKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('text/csv') || mime === 'text/tab-separated-values') return 'csv';
  if (mime.includes('spreadsheet') || mime === 'application/vnd.ms-excel') return 'xlsx';
  if (mime.includes('wordprocessing')) return 'docx';
  if (mime.includes('presentation')) return 'pptx';
  return 'text';
}
