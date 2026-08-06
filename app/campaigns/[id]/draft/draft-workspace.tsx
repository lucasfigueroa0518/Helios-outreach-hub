'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { DraftingActivityPanel } from '@/app/campaigns/[id]/draft/drafting-activity-panel';
import { DraftingStatusStrip } from '@/app/campaigns/[id]/draft/drafting-status-strip';
import {
  clearDraftingLaunch,
  readDraftingLaunch,
} from '@/app/campaigns/[id]/draft/drafting-launch-overlay';
import { EmailReview } from '@/app/campaigns/[id]/draft/email-review';
import { ExportPanel, type ExportPulse } from '@/app/campaigns/[id]/draft/export-panel';
import { LeadsTable } from '@/app/campaigns/[id]/draft/leads-table';
import type { DraftingSnapshot, SenderProfile } from '@/app/campaigns/[id]/draft/types';

type WorkspaceMode = 'email' | 'leads';

function pickCurrentItemId(snapshot: DraftingSnapshot, previousId: string | null) {
  if (previousId) {
    const previous = snapshot.email_rows.find((row) => row.id === previousId);
    // Keep the open card only while it still has draft content to show.
    if (previous?.draft) return previousId;
  }
  const ready = snapshot.email_rows.find((row) => row.state === 'ready_for_review' && row.draft);
  if (ready) return ready.id;
  const generated = snapshot.email_rows.find((row) => row.draft);
  return generated?.id ?? null;
}

export function DraftWorkspace({ campaignId }: { campaignId: string }) {
  const [snapshot, setSnapshot] = useState<DraftingSnapshot | null>(null);
  const [launching, setLaunching] = useState(() => readDraftingLaunch(campaignId));
  const [mode, setMode] = useState<WorkspaceMode>('email');
  const [currentItemId, setCurrentItemId] = useState<string | null>(null);
  const [sender, setSender] = useState<SenderProfile | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [decisionsMade, setDecisionsMade] = useState(0);
  const [exportPulse, setExportPulse] = useState<ExportPulse>(null);
  const [rescueBusy, setRescueBusy] = useState(false);
  const [rescueNotice, setRescueNotice] = useState<string | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [cancelRunBusy, setCancelRunBusy] = useState(false);
  const [pauseNotice, setPauseNotice] = useState<string | null>(null);
  const pollFailures = useRef(0);
  const requestSequence = useRef(0);
  const defaultedMode = useRef(false);
  const exportPulseId = useRef(0);

  const applyOptimisticApprove = useCallback((itemId: string, recipientLabel: string) => {
    exportPulseId.current += 1;
    setExportPulse({
      id: exportPulseId.current,
      recipientLabel,
      approvedCount: 0,
    });
    setSnapshot((previous) => {
      if (!previous) return previous;
      const row = previous.email_rows.find((item) => item.id === itemId);
      if (!row || row.state === 'approved' || row.review_status === 'approved') {
        return previous;
      }
      const approved = previous.counts.approved + 1;
      return {
        ...previous,
        counts: {
          ...previous.counts,
          approved,
        },
        progress: {
          ...previous.progress,
          reviewed: previous.progress.reviewed + 1,
        },
        email_rows: previous.email_rows.map((item) => (
          item.id === itemId
            ? { ...item, state: 'approved', review_status: 'approved' }
            : item
        )),
        exports: (() => {
          const stubBlocked = previous.exports.blocking_reasons.some((reason) =>
            reason.includes('Stub/legacy') || reason.includes('DRAFTING_MODE=live'),
          );
          if (approved === 0) {
            return {
              available: false,
              blocking_reasons: ['Download at least one draft to export'],
            };
          }
          if (stubBlocked) {
            return {
              available: false,
              blocking_reasons: [
                'Stub/legacy drafts cannot be exported — regenerate with DRAFTING_MODE=live',
              ],
            };
          }
          return { available: true, blocking_reasons: [] as string[] };
        })(),
      };
    });
  }, []);

  const rewriteRollbackRef = useRef<Map<string, DraftingSnapshot['email_rows'][number]>>(new Map());
  const rewriteWatchesRef = useRef<Record<string, number>>({});
  const [rewriteWatches, setRewriteWatches] = useState<Record<string, number>>({});

  useEffect(() => {
    rewriteWatchesRef.current = rewriteWatches;
  }, [rewriteWatches]);

  const endRewriteWatch = useCallback((itemId: string) => {
    setRewriteWatches((previous) => {
      if (!(itemId in previous)) return previous;
      const next = { ...previous };
      delete next[itemId];
      rewriteWatchesRef.current = next;
      return next;
    });
  }, []);

  function mergeRewriteWatchRows(data: DraftingSnapshot): DraftingSnapshot {
    const watches = rewriteWatchesRef.current;
    const watchedIds = Object.keys(watches);
    if (watchedIds.length === 0) return data;

    let pendingWatchCount = 0;
    const emailRows = data.email_rows.map((row) => {
      const baselineRevision = watches[row.id];
      if (baselineRevision === undefined || !row.draft) return row;
      if (row.draft.content_revision > baselineRevision) return row;
      pendingWatchCount += 1;
      return {
        ...row,
        state: row.state === 'queued_rewrite' || row.state === 'rewriting' ? row.state : 'rewriting',
        review_status: 'unreviewed' as const,
      };
    });

    return {
      ...data,
      email_rows: emailRows,
      counts: {
        ...data.counts,
        running: Math.max(data.counts.running, pendingWatchCount),
      },
    };
  }

  function clearCompletedRewriteWatches(data: DraftingSnapshot) {
    setRewriteWatches((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const [itemId, baselineRevision] of Object.entries(previous)) {
        const row = data.email_rows.find((item) => item.id === itemId);
        if (!row?.draft) continue;
        const landed = row.draft.content_revision > baselineRevision
          && ['ready_for_review', 'failed_write', 'failed_rewrite'].includes(row.state);
        if (landed) {
          delete next[itemId];
          changed = true;
        }
      }
      if (changed) {
        rewriteWatchesRef.current = next;
        return next;
      }
      return previous;
    });
  }

  const loadSnapshot = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/drafting`);
      const data = await response.json();
      if (sequence !== requestSequence.current) return;
      if (!response.ok) {
        pollFailures.current += 1;
        setPollError(data.error ?? 'Updates paused — retrying');
        return;
      }
      pollFailures.current = 0;
      setPollError(null);
      clearCompletedRewriteWatches(data);
      setSnapshot(mergeRewriteWatchRows(data));
      setCurrentItemId((prev) => pickCurrentItemId(data, prev));
      if (data.workspace?.id) {
        clearDraftingLaunch(campaignId);
        setLaunching(false);
      } else if (readDraftingLaunch(campaignId)) {
        // Stale launch marker from an aborted click — release the shell.
        clearDraftingLaunch(campaignId);
        setLaunching(false);
      }
    } catch {
      if (sequence !== requestSequence.current) return;
      pollFailures.current += 1;
      setPollError('Updates paused — retrying');
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [campaignId]);

  const rescueRun = useCallback(async () => {
    setRescueBusy(true);
    setRescueNotice(null);
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/drafting/rescue`, {
        method: 'POST',
      });
      const data = await response.json();
      if (!response.ok) {
        setRescueNotice(data.error ?? 'Rescue failed — try again');
        return;
      }
      const queued = Number(data.reconciled_queued ?? 0);
      const reset = Number(data.stranded_reset ?? 0);
      const leases = Number(data.recovered_leases ?? 0) + Number(data.revived_drafting_jobs ?? 0);
      setRescueNotice(
        data.assessment?.message
        || `Resumed: ${reset} stranded · ${leases} leases · ${queued} queued`,
      );
      await loadSnapshot();
    } finally {
      setRescueBusy(false);
    }
  }, [campaignId, loadSnapshot]);

  const pauseRun = useCallback(async () => {
    setPauseBusy(true);
    setPauseNotice(null);
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/drafting/pause`, {
        method: 'POST',
      });
      const data = await response.json();
      if (!response.ok) {
        setPauseNotice(data.error ?? 'Pause failed — try again');
        return;
      }
      setPauseNotice(data.already_paused ? 'Drafting is already paused' : 'Drafting paused');
      await loadSnapshot();
    } finally {
      setPauseBusy(false);
    }
  }, [campaignId, loadSnapshot]);

  const resumeRun = useCallback(async () => {
    setResumeBusy(true);
    setRescueNotice(null);
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/drafting/resume`, {
        method: 'POST',
      });
      const data = await response.json();
      if (!response.ok) {
        setRescueNotice(data.error ?? 'Resume failed — try again');
        return;
      }
      const queued = Number(data.reconciled_queued ?? 0);
      setRescueNotice(
        data.assessment?.message
        || `Drafting resumed${queued > 0 ? ` — ${queued} job(s) queued` : ''}`,
      );
      await loadSnapshot();
    } finally {
      setResumeBusy(false);
    }
  }, [campaignId, loadSnapshot]);

  const cancelRun = useCallback(async () => {
    const confirmed = window.confirm(
      'Cancel this drafting run? All in-progress drafts will be discarded and you will return to Review (before Go to Drafting).',
    );
    if (!confirmed) return;

    setCancelRunBusy(true);
    setRescueNotice(null);
    setPauseNotice(null);
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/drafting/cancel-run`, {
        method: 'POST',
      });
      const data = await response.json();
      if (!response.ok) {
        setRescueNotice(data.error ?? 'Cancel Run failed — try again');
        return;
      }
      clearDraftingLaunch(campaignId);
      sessionStorage.removeItem(`drafting-idempotency-${campaignId}`);
      setSnapshot(null);
      setLaunching(false);
      setLoading(false);
    } finally {
      setCancelRunBusy(false);
    }
  }, [campaignId]);

  const beginRewriteWatch = useCallback((itemId: string, revision: number) => {
    setRewriteWatches((previous) => {
      const next = { ...previous, [itemId]: revision };
      rewriteWatchesRef.current = next;
      return next;
    });
    void loadSnapshot();
  }, [loadSnapshot]);

  const applyOptimisticRewrite = useCallback((itemId: string) => {
    setSnapshot((previous) => {
      if (!previous) return previous;
      const row = previous.email_rows.find((item) => item.id === itemId);
      if (row) rewriteRollbackRef.current.set(itemId, row);
      const wasRunning = row
        ? ['queued_research', 'waiting_company_research', 'researching', 'queued_write', 'writing', 'repairing', 'queued_rewrite', 'rewriting', 'verifying_mailbox'].includes(row.state)
        : false;
      return {
        ...previous,
        counts: {
          ...previous.counts,
          running: wasRunning ? previous.counts.running : previous.counts.running + 1,
        },
        email_rows: previous.email_rows.map((item) => (
          item.id === itemId
            ? { ...item, state: 'queued_rewrite', review_status: 'unreviewed' }
            : item
        )),
      };
    });
  }, []);

  const leadApproveRollbackRef = useRef<Map<string, DraftingSnapshot['leads_rows'][number]>>(new Map());

  const applyOptimisticLeadApprove = useCallback((row: DraftingSnapshot['leads_rows'][number]) => {
    leadApproveRollbackRef.current.set(row.id, row);
    const verification = row.delivery_snapshot?.emailVerification;
    const draftable = verification === 'valid' || verification === 'rate_limited';
    const nextState = draftable ? 'queued_research' : 'verifying_mailbox';
    const phase = draftable ? 'research' : 'verify';
    setSnapshot((previous) => {
      if (!previous) return previous;
      if (!previous.leads_rows.some((item) => item.id === row.id)) return previous;
      const activityItem = {
        item_id: row.id,
        ordinal: row.ordinal,
        lead_name: row.effective_fields.fullName,
        company: row.effective_fields.company,
        title: row.effective_fields.title,
        phase: phase as DraftingSnapshot['activity']['items'][number]['phase'],
        state: nextState as DraftingSnapshot['leads_rows'][number]['state'],
        snippet: null,
      };
      const alreadyInActivity = previous.activity.items.some((item) => item.item_id === row.id);
      return {
        ...previous,
        counts: {
          ...previous.counts,
          running: previous.counts.running + 1,
          verifying_mailbox: nextState === 'verifying_mailbox'
            ? previous.counts.verifying_mailbox + 1
            : previous.counts.verifying_mailbox,
          leads_attention: Math.max(0, previous.counts.leads_attention - 1),
        },
        leads_rows: previous.leads_rows.filter((item) => item.id !== row.id),
        activity: {
          ...previous.activity,
          active_workers: Math.max(previous.activity.active_workers, 1),
          items: alreadyInActivity
            ? previous.activity.items.map((item) => (
              item.item_id === row.id ? activityItem : item
            ))
            : [activityItem, ...previous.activity.items],
        },
        workspace: {
          ...previous.workspace,
          generation_complete: false,
        },
      };
    });
  }, []);

  const rollbackOptimisticLeadApprove = useCallback((row: DraftingSnapshot['leads_rows'][number]) => {
    const prior = leadApproveRollbackRef.current.get(row.id) ?? row;
    leadApproveRollbackRef.current.delete(row.id);
    setSnapshot((previous) => {
      if (!previous) return previous;
      if (previous.leads_rows.some((item) => item.id === prior.id)) return previous;
      return {
        ...previous,
        counts: {
          ...previous.counts,
          running: Math.max(0, previous.counts.running - 1),
          verifying_mailbox: Math.max(0, previous.counts.verifying_mailbox - (
            prior.delivery_snapshot?.emailVerification === 'valid' ? 0 : 1
          )),
          leads_attention: previous.counts.leads_attention + 1,
        },
        leads_rows: [...previous.leads_rows, prior].sort((a, b) => a.ordinal - b.ordinal),
        activity: {
          ...previous.activity,
          items: previous.activity.items.filter((item) => item.item_id !== prior.id),
        },
      };
    });
  }, []);

  const confirmOptimisticLeadApprove = useCallback((itemId: string) => {
    leadApproveRollbackRef.current.delete(itemId);
  }, []);

  const rollbackOptimisticRewrite = useCallback((itemId: string) => {
    const prior = rewriteRollbackRef.current.get(itemId);
    rewriteRollbackRef.current.delete(itemId);
    if (prior) {
      setSnapshot((previous) => {
        if (!previous) return previous;
        const currentRow = previous.email_rows.find((item) => item.id === itemId);
        const optimisticRunning = currentRow
          && (currentRow.state === 'queued_rewrite' || currentRow.state === 'rewriting');
        const priorRunning = ['queued_research', 'waiting_company_research', 'researching', 'queued_write', 'writing', 'repairing', 'queued_rewrite', 'rewriting', 'verifying_mailbox'].includes(prior.state);
        const runningDelta = optimisticRunning && !priorRunning ? -1 : 0;
        return {
          ...previous,
          counts: {
            ...previous.counts,
            running: Math.max(0, previous.counts.running + runningDelta),
          },
          email_rows: previous.email_rows.map((item) => (
            item.id === itemId ? prior : item
          )),
        };
      });
      return;
    }
    void loadSnapshot();
  }, [loadSnapshot]);

  const confirmOptimisticRewrite = useCallback((itemId: string) => {
    rewriteRollbackRef.current.delete(itemId);
  }, []);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  useEffect(() => {
    if (!snapshot || defaultedMode.current) return;
    defaultedMode.current = true;
    if (snapshot.counts.mailbox_valid_total === 0 && snapshot.leads_rows.length > 0) {
      setMode('leads');
    }
  }, [snapshot]);

  useEffect(() => {
    fetch('/api/sender-profiles')
      .then((response) => response.json())
      .then((data) => {
        const profiles = data.profiles as SenderProfile[] | undefined;
        setSender(profiles?.find((profile) => profile.is_default) ?? profiles?.[0] ?? null);
      })
      .catch(() => undefined);
  }, []);

  const rewriteWatchCount = Object.keys(rewriteWatches).length;
  const hasWorkspace = Boolean(snapshot?.workspace?.id);
  const pipelineActive = Boolean(
    launching
    || (snapshot && !snapshot.workspace.paused && (
      snapshot.counts.running > 0
      || snapshot.activity.items.length > 0
      || rewriteWatchCount > 0
    )),
  );
  const workRemaining = Boolean(
    snapshot && (
      snapshot.workspace.paused
      || !snapshot.workspace.generation_complete
      || !snapshot.workspace.review_complete
      || snapshot.counts.leads_attention > 0
      || snapshot.counts.verifying_mailbox > 0
      || snapshot.counts.waiting_for_enrichment > 0
      || snapshot.counts.budget_paused > 0
      || snapshot.counts.failed > 0
      || snapshot.counts.running > 0
    ),
  );
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  useEffect(() => {
    if (!hasWorkspace && !launching) return;

    const intervalFor = () => {
      const current = snapshotRef.current;
      if (!current) return launching ? 2_000 : 0;
      const rewriteInFlight = rewriteWatchCount > 0
        || current.email_rows.some((row) =>
          row.state === 'queued_rewrite' || row.state === 'rewriting',
        );
      const active = launching
        || current.counts.running > 0
        || current.activity.items.length > 0
        || rewriteInFlight;
      const remaining = !current.workspace.generation_complete
        || !current.workspace.review_complete
        || current.counts.leads_attention > 0
        || current.counts.verifying_mailbox > 0
        || current.counts.waiting_for_enrichment > 0
        || current.counts.budget_paused > 0
        || current.counts.failed > 0;
      return rewriteInFlight ? 1_000 : active ? 2_000 : remaining ? 2_500 : 0;
    };

    let timer: number | undefined;
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      stop();
      if (document.hidden) return;
      const ms = intervalFor();
      if (!ms) return;
      timer = window.setInterval(() => {
        if (!document.hidden) void loadSnapshot();
      }, ms);
    };

    function onVisibilityChange() {
      if (document.hidden) {
        stop();
        return;
      }
      void loadSnapshot();
      start();
    }

    start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [hasWorkspace, launching, loadSnapshot, pipelineActive, rewriteWatchCount, workRemaining]);

  const leadsAttention =
    (snapshot?.counts.leads_attention ?? 0)
    + (snapshot?.counts.verifying_mailbox ?? 0);

  // Only show the launch shell until the workspace exists. Once Go to Drafting
  // returns a real workspace, drop into the live UI even if research is still
  // queueing — otherwise a stuck sessionStorage flag or slow poll freezes forever.
  const showLaunchShell =
    (launching && !snapshot?.workspace?.id)
    || (loading && !snapshot);

  if (showLaunchShell) {
    return (
      <div className="drafting-workspace drafting-workspace--launching">
        <DraftingStatusStrip
          snapshot={snapshot}
          launching
          leadsAttention={leadsAttention}
          pollError={pollError}
          decisionsMade={decisionsMade}
          rescueBusy={rescueBusy}
          rescueNotice={rescueNotice}
          pauseBusy={pauseBusy}
          resumeBusy={resumeBusy}
          cancelRunBusy={cancelRunBusy}
          pauseNotice={pauseNotice}
          onRetryPoll={() => void loadSnapshot()}
          onRescue={() => void rescueRun()}
          onPause={() => void pauseRun()}
          onResume={() => void resumeRun()}
          onCancelRun={() => void cancelRun()}
          onSelectEmail={() => setMode('email')}
          onSelectLeads={() => setMode('leads')}
        />
        {snapshot ? <DraftingActivityPanel snapshot={snapshot} /> : null}
        <div className="drafting-launch-shell" role="status">
          <p>Setting up your drafting workspace — research jobs will appear here as they finish.</p>
        </div>
      </div>
    );
  }

  if (!snapshot?.workspace.id) {
    return (
      <div className="empty-state">
        <strong>Drafting has not started yet</strong>
        <span>
          Enrichment lives on Upload and Review — email drafts only exist after you click{' '}
          <strong>Go to Drafting</strong> on the Review tab (that creates this workspace).
        </span>
        <Link href={`/campaigns/${campaignId}/review`} className="btn btn--primary">
          Go to Review
        </Link>
      </div>
    );
  }

  if (snapshot.counts.total === 0) {
    return (
      <div className="empty-state">
        <strong>There are no reviewed leads to draft yet.</strong>
        <Link href={`/campaigns/${campaignId}/review`} className="btn btn--primary">
          Back to Review
        </Link>
      </div>
    );
  }

  return (
    <div className="drafting-workspace">
      <DraftingStatusStrip
        snapshot={snapshot}
        launching={false}
        leadsAttention={leadsAttention}
        pollError={pollError}
        decisionsMade={decisionsMade}
        rescueBusy={rescueBusy}
        rescueNotice={rescueNotice}
        pauseBusy={pauseBusy}
        resumeBusy={resumeBusy}
        cancelRunBusy={cancelRunBusy}
        pauseNotice={pauseNotice}
        onRetryPoll={() => void loadSnapshot()}
        onRescue={() => void rescueRun()}
        onPause={() => void pauseRun()}
        onResume={() => void resumeRun()}
        onCancelRun={() => void cancelRun()}
        onSelectEmail={() => setMode('email')}
        onSelectLeads={() => setMode('leads')}
      />

      <div className="drafting-mode-bar">
        <div className="segmented drafting-mode-toggle" role="tablist" aria-label="Drafting mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'email'}
            className={`segmented__item${mode === 'email' ? ' segmented__item--active' : ''}`}
            onClick={() => setMode('email')}
          >
            Email
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'leads'}
            className={`segmented__item${mode === 'leads' ? ' segmented__item--active' : ''}`}
            onClick={() => setMode('leads')}
          >
            Leads
            {leadsAttention > 0 ? <span className="drafting-attention-dot" aria-hidden="true" /> : null}
          </button>
        </div>
        {mode === 'email' && leadsAttention > 0 ? (
          <p className="drafting-leads-helper" role="status">
            Leads require mailbox verification before drafting
          </p>
        ) : null}
      </div>

      {mode === 'email' ? (
        <>
          <EmailReview
            rows={snapshot.email_rows}
            currentItemId={currentItemId}
            sender={sender}
            sends={snapshot.sends}
            onSelectItem={setCurrentItemId}
            onRefresh={() => void loadSnapshot()}
            onOptimisticApprove={applyOptimisticApprove}
            onOptimisticRewrite={applyOptimisticRewrite}
            onBeginRewriteWatch={beginRewriteWatch}
            onEndRewriteWatch={endRewriteWatch}
            onRewriteFailed={(itemId) => {
              endRewriteWatch(itemId);
              rollbackOptimisticRewrite(itemId);
              setCurrentItemId(itemId);
            }}
            onRewriteQueued={confirmOptimisticRewrite}
            onDecision={() => setDecisionsMade((count) => count + 1)}
          />
          <ExportPanel
            campaignId={campaignId}
            snapshot={snapshot}
            exportPulse={exportPulse}
            onSwitchToLeads={() => setMode('leads')}
            onRefresh={() => void loadSnapshot()}
          />
        </>
      ) : (
        <LeadsTable
          campaignId={campaignId}
          rows={snapshot.leads_rows}
          onRefresh={() => void loadSnapshot()}
          onOptimisticApprove={applyOptimisticLeadApprove}
          onOptimisticApproveRollback={rollbackOptimisticLeadApprove}
          onOptimisticApproveConfirm={confirmOptimisticLeadApprove}
        />
      )}

      {!snapshot.workspace.generation_complete || snapshot.activity.items.length > 0 || snapshot.counts.running > 0 ? (
        <DraftingActivityPanel snapshot={snapshot} />
      ) : null}
    </div>
  );
}
