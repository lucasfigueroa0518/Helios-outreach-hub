'use client';

import { useRef, useState } from 'react';

export function ReplaceSheet({ campaignId }: { campaignId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function replace(file: File) {
    if (!window.confirm('Replace this campaign’s lead set? Leads absent from this file will be removed from the campaign. Relationship snapshots refresh only on the next enrichment run.')) return;
    setBusy(true);
    setMessage(null);
    const body = new FormData();
    body.append('file', file);
    const response = await fetch(`/api/campaigns/${campaignId}/sheet/replace`, { method: 'POST', body });
    const data = await response.json();
    setBusy(false);
    setMessage(response.ok ? `Replaced campaign sheet with ${data.rows} lead${data.rows === 1 ? '' : 's'}.` : data.error ?? 'Replace failed');
    if (response.ok) window.location.reload();
  }

  return (
    <div className="replace-sheet">
      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        accept=".csv,.xlsx"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void replace(file);
          event.target.value = '';
        }}
      />
      <button className="btn btn--secondary" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? 'Replacing…' : 'Upload & Replace'}
      </button>
      {message && <p className="text-muted">{message}</p>}
    </div>
  );
}
