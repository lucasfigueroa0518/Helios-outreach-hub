'use client';

import { format } from 'date-fns';
import { useState } from 'react';

import { triggerSync } from '@/app/dashboards/(admin)/(main)/projects/actions';

export default function SyncButton({
  projectId,
  lastSyncAt,
}: {
  projectId: string;
  lastSyncAt: Date | null;
}) {
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<{
    synced: number;
    skipped: number;
    error?: string;
  } | null>(null);
  const [lastSync, setLastSync] = useState(lastSyncAt);

  async function handleSync() {
    setSyncing(true);
    setResult(null);
    const res = await triggerSync(projectId);
    setResult(res);
    if (!res.error) setLastSync(new Date());
    setSyncing(false);
  }

  return (
    <div className="rounded-xl border border-border bg-white p-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-fg-1">GitHub sync</h2>
          <p className="mt-0.5 text-xs text-fg-3">
            {lastSync
              ? `Last synced ${format(new Date(lastSync), "MMM d, yyyy 'at' HH:mm")} UTC`
              : 'Never synced — worker runs daily'}
          </p>
        </div>
        <button
          type="button"
          onClick={handleSync}
          disabled={syncing}
          className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg-2 hover:bg-bg-alt disabled:opacity-50 transition-colors"
        >
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>
      {result && (
        <div
          className={`mt-3 rounded-lg px-3 py-2 text-xs ${
            result.error ? 'bg-red-50 text-red-700' : 'bg-[#E8F5E8] text-[#138510]'
          }`}
        >
          {result.error
            ? `Error: ${result.error}`
            : `Synced ${result.synced} new event${result.synced !== 1 ? 's' : ''}${
                result.skipped > 0
                  ? `, filtered ${result.skipped} junk commit${result.skipped !== 1 ? 's' : ''}`
                  : ''
              }.`}
        </div>
      )}
    </div>
  );
}
