'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

type CreatedMeta = {
  id: string;
  githubHandle: string;
  tokenSuffix: string;
};

export default function AddTokenForm({
  prefillHandle = '',
}: {
  prefillHandle?: string;
}) {
  const router = useRouter();
  const [handle, setHandle] = useState(prefillHandle);
  const [token, setToken] = useState('');
  const [neverExpires, setNeverExpires] = useState(true);
  const [expiresAt, setExpiresAt] = useState('');
  const [show, setShow] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedMeta | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setCreated(null);
    try {
      const res = await fetch('/api/dashboards/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          githubHandle: handle.trim(),
          token,
          expiresAt: neverExpires ? null : expiresAt || null,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        id?: string;
        githubHandle?: string;
        tokenSuffix?: string;
      };
      if (!res.ok) {
        setError(data.error ?? 'Failed to save token.');
        return;
      }
      setCreated({
        id: data.id!,
        githubHandle: data.githubHandle!,
        tokenSuffix: data.tokenSuffix!,
      });
      setToken('');
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save token.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-xl border border-border bg-white p-5"
    >
      <h2 className="text-sm font-semibold text-fg-1">Add GitHub PAT</h2>
      <p className="text-xs font-light text-fg-3">
        Classic PAT with <code className="font-mono">repo</code> scope. The full
        token is encrypted at rest and never shown again.
      </p>

      {created && (
        <div className="space-y-2 rounded-lg bg-[#E8F5E8] px-4 py-3 text-sm text-[#138510]">
          <p>
            Added @{created.githubHandle}. Token ends in{' '}
            <span className="font-mono">{created.tokenSuffix}</span>. You won&apos;t
            see the full token again.
          </p>
          <a href="/dashboards" className="font-semibold underline underline-offset-2">
            Continue to projects →
          </a>
        </div>
      )}
      {error && (
        <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div>
        <label className="mb-1.5 block text-sm font-medium text-fg-1">
          GitHub handle
        </label>
        <input
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          required
          autoComplete="off"
          placeholder="your-github-username"
          className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-fg-1 outline-none focus:ring-2 focus:ring-[#FF5E1A]/30"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-fg-1">
          Personal access token
        </label>
        <div className="flex gap-2">
          <input
            type={show ? 'text' : 'password'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            autoComplete="off"
            placeholder="github_pat_… or ghp_…"
            className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-fg-1 outline-none focus:ring-2 focus:ring-[#FF5E1A]/30"
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            className="shrink-0 rounded-lg border border-border px-3 py-2 text-xs font-medium text-fg-2 hover:bg-bg-alt"
          >
            {show ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      <div className="dashboards-expiry">
        <span className="dashboards-expiry__label" id="pat-expiry-label">
          Expires
        </span>
        <div
          className="dashboards-segmented"
          role="radiogroup"
          aria-labelledby="pat-expiry-label"
        >
          <button
            type="button"
            role="radio"
            aria-checked={neverExpires}
            className={`dashboards-segmented__item${neverExpires ? ' is-active' : ''}`}
            onClick={() => {
              setNeverExpires(true);
              setExpiresAt('');
            }}
          >
            Never expires
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={!neverExpires}
            className={`dashboards-segmented__item${!neverExpires ? ' is-active' : ''}`}
            onClick={() => setNeverExpires(false)}
          >
            Set a date
          </button>
        </div>
        {!neverExpires && (
          <input
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            required
            className="dashboards-expiry__date"
          />
        )}
      </div>

      <button
        type="submit"
        disabled={pending}
        className="rounded-pill bg-[#FF5E1A] px-5 py-2.5 text-sm font-semibold text-white shadow-cta-glow hover:bg-[#E54E0F] disabled:opacity-60 transition-colors"
      >
        {pending ? 'Saving…' : 'Save token'}
      </button>
    </form>
  );
}
