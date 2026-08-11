'use client';

import { useState } from 'react';

import { deleteProject } from '@/app/dashboards/(admin)/(main)/projects/actions';

export default function DeleteProjectButton({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canDelete = confirmText.trim() === projectName.trim() && !deleting;

  function close() {
    if (deleting) return;
    setOpen(false);
    setConfirmText('');
    setError(null);
  }

  async function handleDelete() {
    if (!canDelete) return;
    setDeleting(true);
    setError(null);
    const result = await deleteProject(projectId);
    if (result?.error) {
      setError(result.error);
      setDeleting(false);
    }
  }

  return (
    <div className="rounded-xl border border-red-200 bg-red-50/50 p-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-red-700">Danger zone</h2>
          <p className="mt-0.5 text-xs text-red-600/80">
            Permanently delete this dashboard, its AI updates, synced GitHub
            activity, access token, and uploaded deck. This cannot be undone.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="shrink-0 rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 transition-colors"
        >
          Delete dashboard
        </button>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          role="dialog"
          aria-modal="true"
          onClick={close}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-heading text-lg font-bold text-fg-1">
              Delete this dashboard?
            </h3>
            <p className="mt-2 text-sm font-light text-fg-2">
              This permanently removes the client dashboard for{' '}
              <span className="font-semibold text-fg-1">{projectName}</span>,
              along with all AI updates, synced GitHub events, its access token,
              and any uploaded deck. The client&apos;s link will stop working
              immediately. This cannot be undone.
            </p>

            <label className="mt-4 block text-xs font-medium text-fg-2">
              Type{' '}
              <span className="font-semibold text-fg-1">{projectName}</span> to
              confirm
            </label>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              disabled={deleting}
              autoFocus
              className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-sm text-fg-1 outline-none focus:border-red-400 disabled:opacity-50"
              placeholder={projectName}
            />

            {error && (
              <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                Error: {error}
              </div>
            )}

            <div className="mt-5 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={close}
                disabled={deleting}
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-fg-2 hover:bg-bg-alt disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={!canDelete}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
              >
                {deleting ? 'Deleting…' : 'Delete dashboard'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
