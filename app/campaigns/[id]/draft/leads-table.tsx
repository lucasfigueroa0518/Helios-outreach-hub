'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

import type { DraftingItemRow } from '@/app/campaigns/[id]/draft/types';

type FieldKey = 'fullName' | 'email' | 'company' | 'title' | 'workLocation';

type RowDraft = {
  fields: Record<FieldKey, string>;
  revision: number;
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  approving: boolean;
  removing: boolean;
  actionError: string | null;
};

const FIELD_LABELS: Record<FieldKey, string> = {
  fullName: 'Name',
  email: 'Email',
  company: 'Company',
  title: 'Title',
  workLocation: 'Location (optional)',
};

function verificationLabel(status: string | undefined) {
  if (!status || status === 'missing') return 'Missing email';
  if (status === 'valid') return 'Valid';
  if (status === 'invalid') return 'Invalid';
  if (status === 'pending') return 'Pending verification';
  if (status === 'unknown') return 'Unknown';
  if (status === 'risky') return 'Risky';
  if (status === 'accept_all') return 'Accept-all';
  if (status === 'malformed') return 'Malformed';
  if (status === 'rate_limited') return 'Verification rate limited';
  return status;
}

function rowStatusText(row: DraftingItemRow) {
  if (row.state === 'waiting_for_enrichment') return 'Still enriching';
  if (row.state === 'verifying_mailbox') return 'Verifying mailbox…';
  if (row.state === 'waiting_company_research') return 'Waiting on company research…';
  if (
    row.state === 'failed_research'
    && row.last_error_code === 'empty_research_brief'
    && row.empty_brief_input_fingerprint === row.input_fingerprint
  ) {
    return 'Research found no usable personalization after 2 attempts. Review lead inputs, then retry.';
  }
  if (row.state === 'failed_research') return 'Research failed — approve again to retry';
  if (row.state === 'failed_write' || row.state === 'failed_rewrite') {
    return 'Drafting failed — approve again to retry';
  }
  if (row.state === 'budget_paused') return 'Paused — budget limit hit';
  const verification = row.delivery_snapshot?.emailVerification;
  if (verification === 'rate_limited') {
    const blockingMissing = row.missing_fields.filter((field) => field !== 'workLocation');
    if (blockingMissing.length > 0) {
      return 'Verification rate limited · missing fields';
    }
    return 'Verification rate limited · ready to draft';
  }
  if (verification && verification !== 'valid') {
    return `Mailbox ${verificationLabel(verification).toLowerCase()}`;
  }
  const blockingMissing = row.missing_fields.filter((field) => field !== 'workLocation');
  if (blockingMissing.length > 0) {
    const labels = blockingMissing.map((field) => {
      if (field === 'fullName') return 'name';
      if (field === 'firstName') return 'first name';
      return field;
    });
    const prefix = verification === 'valid' ? 'Mailbox valid · missing ' : 'Missing ';
    return `${prefix}${labels.join(' and ')}`;
  }
  if (verification === 'valid') return 'Ready to approve for drafting';
  return 'Ready to approve';
}

function fieldsFromRow(row: DraftingItemRow): Record<FieldKey, string> {
  return {
    fullName: row.effective_fields.fullName ?? '',
    email: row.effective_fields.email ?? '',
    company: row.effective_fields.company ?? '',
    title: row.effective_fields.title ?? '',
    workLocation: row.effective_fields.workLocation ?? '',
  };
}

function fieldsEqual(a: Record<FieldKey, string>, b: Record<FieldKey, string>) {
  return (Object.keys(a) as FieldKey[]).every((key) => a[key] === b[key]);
}

function rowCanApprove(row: DraftingItemRow, draft: RowDraft) {
  if (row.state === 'verifying_mailbox' || draft.approving || draft.saveState === 'saving') {
    return false;
  }
  const complete = (['fullName', 'email', 'company', 'title'] as const).every(
    (key) => draft.fields[key].trim().length > 0,
  );
  return complete;
}

type LatestRow = {
  fields: Record<FieldKey, string>;
  revision: number;
  savePromise: Promise<number | null> | null;
};

export function LeadsTable({
  campaignId,
  rows,
  onRefresh,
  onOptimisticApprove,
  onOptimisticApproveRollback,
  onOptimisticApproveConfirm,
}: {
  campaignId: string;
  rows: DraftingItemRow[];
  onRefresh: () => void;
  onOptimisticApprove?: (row: DraftingItemRow) => void;
  onOptimisticApproveRollback?: (row: DraftingItemRow) => void;
  onOptimisticApproveConfirm?: (itemId: string) => void;
}) {
  const [rowDrafts, setRowDrafts] = useState<Record<string, RowDraft>>({});
  const [bulkApproving, setBulkApproving] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const latestRef = useRef<Record<string, LatestRow>>({});

  useEffect(() => {
    setRowDrafts((prev) => {
      const next: Record<string, RowDraft> = { ...prev };
      for (const row of rows) {
        const latest = latestRef.current[row.id];
        const serverFields = fieldsFromRow(row);
        // Don't clobber in-progress local edits when a refresh arrives.
        if (latest && !fieldsEqual(latest.fields, serverFields) && latest.savePromise) {
          continue;
        }
        if (!next[row.id] || next[row.id].revision !== row.input_revision) {
          next[row.id] = {
            fields: serverFields,
            revision: row.input_revision,
            saveState: 'idle',
            approving: false,
            removing: false,
            actionError: null,
          };
          latestRef.current[row.id] = {
            fields: serverFields,
            revision: row.input_revision,
            savePromise: latest?.savePromise ?? null,
          };
        }
      }
      return next;
    });
  }, [rows]);

  const persistField = useCallback(
    async (rowId: string, fields: Record<FieldKey, string>, expectedRevision: number) => {
      const latest = latestRef.current[rowId] ?? {
        fields,
        revision: expectedRevision,
        savePromise: null,
      };
      // Serialize saves per row so blur/debounce/approve cannot race revisions.
      if (latest.savePromise) {
        const prior = await latest.savePromise;
        if (prior == null) return null;
        const after = latestRef.current[rowId];
        if (!after) return prior;
        if (fieldsEqual(after.fields, fields) && after.revision !== expectedRevision) {
          return after.revision;
        }
        return persistField(rowId, after.fields, after.revision);
      }

      const run = (async (): Promise<number | null> => {
        setRowDrafts((prev) => ({
          ...prev,
          [rowId]: {
            ...(prev[rowId] ?? {
              fields,
              revision: expectedRevision,
              approving: false,
              removing: false,
              actionError: null,
            }),
            saveState: 'saving',
            actionError: null,
          },
        }));

        let revision = latestRef.current[rowId]?.revision ?? expectedRevision;
        let attemptFields = latestRef.current[rowId]?.fields ?? fields;

        for (let attempt = 0; attempt < 2; attempt += 1) {
          const response = await fetch(`/api/drafting/items/${rowId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expected_revision: revision, fields: attemptFields }),
          });
          const data = await response.json().catch(() => ({}));

          if (response.ok) {
            const nextRevision = Number(data.item.input_revision);
            latestRef.current[rowId] = {
              fields: attemptFields,
              revision: nextRevision,
              savePromise: null,
            };
            setRowDrafts((prev) => ({
              ...prev,
              [rowId]: {
                ...prev[rowId],
                fields: attemptFields,
                revision: nextRevision,
                saveState: 'saved',
                actionError: null,
              },
            }));
            onRefresh();
            return nextRevision;
          }

          if (response.status === 409 && attempt === 0) {
            // Reload server revision and retry once with latest local fields.
            const snap = await fetch(`/api/campaigns/${campaignId}/drafting`);
            const snapData = await snap.json().catch(() => null);
            const serverRow = snapData?.leads_rows?.find((item: DraftingItemRow) => item.id === rowId)
              ?? snapData?.email_rows?.find((item: DraftingItemRow) => item.id === rowId);
            if (!serverRow) break;
            revision = Number(serverRow.input_revision);
            attemptFields = latestRef.current[rowId]?.fields ?? attemptFields;
            latestRef.current[rowId] = {
              fields: attemptFields,
              revision,
              savePromise: latestRef.current[rowId]?.savePromise ?? null,
            };
            continue;
          }

          const message = typeof data.error === 'string' ? data.error : 'Couldn\'t save';
          setRowDrafts((prev) => ({
            ...prev,
            [rowId]: { ...prev[rowId], saveState: 'error', actionError: message },
          }));
          return null;
        }

        setRowDrafts((prev) => ({
          ...prev,
          [rowId]: {
            ...prev[rowId],
            saveState: 'error',
            actionError: 'Couldn\'t save — refresh and try again',
          },
        }));
        return null;
      })();

      latestRef.current[rowId] = {
        fields: latestRef.current[rowId]?.fields ?? fields,
        revision: latestRef.current[rowId]?.revision ?? expectedRevision,
        savePromise: run,
      };

      try {
        return await run;
      } finally {
        const current = latestRef.current[rowId];
        if (current?.savePromise === run) {
          latestRef.current[rowId] = { ...current, savePromise: null };
        }
      }
    },
    [campaignId, onRefresh],
  );

  function scheduleSave(rowId: string, fields: Record<FieldKey, string>, revision: number) {
    clearTimeout(debounceTimers.current[rowId]);
    debounceTimers.current[rowId] = setTimeout(() => {
      void persistField(rowId, fields, revision);
    }, 500);
  }

  function updateField(row: DraftingItemRow, key: FieldKey, value: string) {
    setRowDrafts((prev) => {
      const current = prev[row.id];
      const fields = { ...current.fields, [key]: value };
      latestRef.current[row.id] = {
        fields,
        revision: current.revision,
        savePromise: latestRef.current[row.id]?.savePromise ?? null,
      };
      scheduleSave(row.id, fields, current.revision);
      return {
        ...prev,
        [row.id]: { ...current, fields, saveState: 'idle', actionError: null },
      };
    });
  }

  async function flushAndApprove(row: DraftingItemRow) {
    const draft = rowDrafts[row.id];
    if (!draft) return;
    clearTimeout(debounceTimers.current[row.id]);

    const latest = latestRef.current[row.id] ?? {
      fields: draft.fields,
      revision: draft.revision,
      savePromise: null,
    };

    let revision = latest.revision;
    if (latest.savePromise) {
      const saved = await latest.savePromise;
      if (saved == null) return;
      revision = saved;
    } else {
      const serverFields = fieldsFromRow(row);
      if (!fieldsEqual(latest.fields, serverFields)) {
        const saved = await persistField(row.id, latest.fields, revision);
        if (saved == null) return;
        revision = saved;
      }
    }

    revision = latestRef.current[row.id]?.revision ?? revision;

    // Instant feedback: drop the row into live activity before the network round-trip.
    onOptimisticApprove?.(row);
    setRowDrafts((prev) => ({
      ...prev,
      [row.id]: { ...prev[row.id], approving: true, actionError: null },
    }));

    const response = await fetch(`/api/drafting/items/${row.id}/approve-lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_revision: revision,
        idempotency_key: `approve-lead:${row.id}:${revision}:${Date.now()}`,
      }),
    });
    const data = await response.json().catch(() => ({}));

    setRowDrafts((prev) => ({
      ...prev,
      [row.id]: { ...prev[row.id], approving: false },
    }));

    if (!response.ok) {
      onOptimisticApproveRollback?.(row);
      const message = typeof data.error === 'string'
        ? data.error
        : 'Could not approve for drafting';
      setRowDrafts((prev) => ({
        ...prev,
        [row.id]: { ...prev[row.id], actionError: message, saveState: 'error' },
      }));
      return;
    }

    onOptimisticApproveConfirm?.(row.id);
    onRefresh();
  }

  async function removeRow(row: DraftingItemRow) {
    const draft = rowDrafts[row.id];
    if (!draft) return;
    const name = draft.fields.fullName || draft.fields.email || 'this lead';
    const confirmed = window.confirm(
      `Remove ${name} from the campaign? It will no longer appear in Review, Drafting, or campaign exports. The shared person record is not deleted.`,
    );
    if (!confirmed) return;
    clearTimeout(debounceTimers.current[row.id]);
    setRowDrafts((prev) => ({
      ...prev,
      [row.id]: { ...prev[row.id], removing: true, actionError: null },
    }));
    const revision = latestRef.current[row.id]?.revision ?? draft.revision;
    const response = await fetch(`/api/drafting/items/${row.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_revision: revision, confirm: true }),
    });
    const data = await response.json().catch(() => ({}));
    setRowDrafts((prev) => ({
      ...prev,
      [row.id]: { ...prev[row.id], removing: false },
    }));
    if (!response.ok) {
      setRowDrafts((prev) => ({
        ...prev,
        [row.id]: {
          ...prev[row.id],
          actionError: typeof data.error === 'string' ? data.error : 'Could not remove lead',
          saveState: 'error',
        },
      }));
      return;
    }
    onRefresh();
  }

  async function approveAllEligible() {
    const eligible = rows.filter((row) => {
      const draft = rowDrafts[row.id];
      return draft ? rowCanApprove(row, draft) : false;
    });
    if (eligible.length === 0 || bulkApproving) return;

    setBulkApproving(true);
    setBulkError(null);
    for (const row of eligible) {
      onOptimisticApprove?.(row);
    }

    try {
      const response = await fetch(`/api/campaigns/${campaignId}/drafting/approve-leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          item_ids: eligible.map((row) => row.id),
          idempotency_key: `bulk-approve:${campaignId}:${Date.now()}`,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        for (const row of eligible) {
          onOptimisticApproveRollback?.(row);
        }
        setBulkError(typeof data.error === 'string' ? data.error : 'Bulk approve failed');
        return;
      }
      for (const row of eligible) {
        onOptimisticApproveConfirm?.(row.id);
      }
      onRefresh();
    } catch {
      for (const row of eligible) {
        onOptimisticApproveRollback?.(row);
      }
      setBulkError('Bulk approve failed');
    } finally {
      setBulkApproving(false);
    }
  }

  if (!rows.length) {
    return (
      <div className="empty-state">
        <strong>No leads need correction</strong>
        <span>Every campaign lead is mailbox-verified and profile-complete, or still generating drafts.</span>
      </div>
    );
  }

  return (
    <div className="drafting-leads">
      <div className="drafting-leads__header">
        <div>
          <strong>{rows.length} lead{rows.length === 1 ? '' : 's'} require verification or correction</strong>
          <p className="text-muted">Approve a complete row to verify its mailbox and queue drafting.</p>
          {bulkError ? <p className="drafting-action-error" role="alert">{bulkError}</p> : null}
        </div>
        <div className="drafting-leads__header-actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={bulkApproving || rows.every((row) => {
              const draft = rowDrafts[row.id];
              return !draft || !rowCanApprove(row, draft);
            })}
            onClick={() => void approveAllEligible()}
          >
            {bulkApproving ? 'Queueing…' : 'Approve all eligible'}
          </button>
          <a
            className="btn btn--secondary"
            href={`/api/campaigns/${campaignId}/drafting/export?type=unverified`}
          >
            Download unverified leads CSV
          </a>
        </div>
      </div>
      <div className="drafting-leads__table-wrap">
        <table className="data-table drafting-leads__table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Company</th>
              <th>Title</th>
              <th>LOCATION (OPTIONAL)</th>
              <th>Verification</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const draft = rowDrafts[row.id];
              if (!draft) return null;
              const verification = row.delivery_snapshot?.emailVerification;
              return (
                <tr key={row.id}>
                  {(['fullName', 'email', 'company', 'title', 'workLocation'] as FieldKey[]).map((key) => (
                    <td key={key} data-label={FIELD_LABELS[key]}>
                      <input
                        className={`drafting-leads__input${!draft.fields[key].trim() ? ' drafting-leads__input--missing' : ''}`}
                        value={draft.fields[key]}
                        onChange={(event) => updateField(row, key, event.target.value)}
                        onBlur={() => {
                          clearTimeout(debounceTimers.current[row.id]);
                          const latest = latestRef.current[row.id];
                          if (!latest) return;
                          const serverFields = fieldsFromRow(row);
                          if (fieldsEqual(latest.fields, serverFields) && !latest.savePromise) return;
                          void persistField(row.id, latest.fields, latest.revision);
                        }}
                        aria-label={FIELD_LABELS[key]}
                      />
                    </td>
                  ))}
                  <td data-label="Verification">
                    <span className={`email-verify-chip email-verify-chip--${verification ?? 'unknown'}`}>
                      {verificationLabel(verification)}
                    </span>
                    <div className="drafting-leads__row-status">{rowStatusText(row)}</div>
                  </td>
                  <td data-label="Actions">
                    <div className="drafting-leads__actions">
                      <button
                        type="button"
                        className="btn btn--primary"
                        disabled={!rowCanApprove(row, draft)}
                        onClick={() => void flushAndApprove(row)}
                      >
                        {draft.approving
                          ? (verification === 'valid' || verification === 'rate_limited' ? 'Queueing…' : 'Verifying…')
                          : row.last_error_code === 'empty_research_brief'
                            ? 'Retry'
                            : 'Approve for drafting'}
                      </button>
                      <button
                        type="button"
                        className="drafting-icon-btn"
                        disabled={draft.removing}
                        aria-label={`Remove ${draft.fields.fullName || draft.fields.email} from campaign`}
                        title="Remove from campaign"
                        onClick={() => void removeRow(row)}
                      >
                        <X size={16} />
                      </button>
                    </div>
                    {draft.saveState === 'saving' ? (
                      <span className="drafting-save-state">Saving…</span>
                    ) : null}
                    {draft.saveState === 'saved' && !draft.actionError ? (
                      <span className="drafting-save-state drafting-save-state--saved">Saved</span>
                    ) : null}
                    {draft.actionError ? (
                      <span className="drafting-save-state drafting-save-state--error" role="alert">
                        {draft.actionError}
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
