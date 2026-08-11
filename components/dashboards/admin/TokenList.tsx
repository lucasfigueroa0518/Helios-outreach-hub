'use client';

import { formatDistanceToNow } from 'date-fns';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export type TokenListItem = {
  id: string;
  githubHandle: string;
  tokenSuffix: string;
  addedByEmail: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
};

export default function TokenList({ tokens }: { tokens: TokenListItem[] }) {
  const router = useRouter();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onDelete(id: string) {
    if (!confirm('Delete this GitHub PAT? Sync for repos owned by that handle will stop until a new token is added.')) {
      return;
    }
    setDeletingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/dashboards/tokens/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? 'Delete failed.');
        return;
      }
      router.refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Delete failed.');
    } finally {
      setDeletingId(null);
    }
  }

  if (tokens.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-white py-12 text-center">
        <p className="text-sm font-medium text-fg-2">No tokens stored yet</p>
        <p className="mt-1 text-xs text-fg-muted">
          Add your GitHub PAT above to enable project sync.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-white">
      {error && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
          {error}
        </div>
      )}
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border bg-bg-alt">
            <th className="px-4 py-3 font-semibold text-fg-2">GitHub</th>
            <th className="px-4 py-3 font-semibold text-fg-2">Token</th>
            <th className="hidden px-4 py-3 font-semibold text-fg-2 md:table-cell">
              Added by
            </th>
            <th className="hidden px-4 py-3 font-semibold text-fg-2 lg:table-cell">
              Last used
            </th>
            <th className="hidden px-4 py-3 font-semibold text-fg-2 md:table-cell">
              Expires
            </th>
            <th className="px-4 py-3 font-semibold text-fg-2">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-soft">
          {tokens.map((t) => (
            <tr key={t.id} className="hover:bg-bg-alt transition-colors">
              <td className="px-4 py-3">
                <a
                  href={`https://github.com/${t.githubHandle}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-fg-1 hover:text-accent"
                >
                  @{t.githubHandle}
                </a>
              </td>
              <td className="px-4 py-3 font-mono text-xs text-fg-3">
                github_pat_••••{t.tokenSuffix}
              </td>
              <td className="hidden px-4 py-3 text-fg-3 md:table-cell">
                {t.addedByEmail}
              </td>
              <td className="hidden px-4 py-3 text-fg-3 lg:table-cell">
                {t.lastUsedAt
                  ? formatDistanceToNow(new Date(t.lastUsedAt), { addSuffix: true })
                  : 'Never'}
              </td>
              <td className="hidden px-4 py-3 text-fg-3 md:table-cell">
                {t.expiresAt
                  ? formatDistanceToNow(new Date(t.expiresAt), { addSuffix: true })
                  : 'Never'}
              </td>
              <td className="px-4 py-3">
                <button
                  type="button"
                  onClick={() => void onDelete(t.id)}
                  disabled={deletingId === t.id}
                  className="rounded-md border border-red-300 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
                >
                  {deletingId === t.id ? 'Deleting…' : 'Delete'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
