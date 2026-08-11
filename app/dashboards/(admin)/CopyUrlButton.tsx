'use client';

import { useState } from 'react';

export default function CopyUrlButton({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const url = `${window.location.origin}/d/${token}`;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={copy}
      className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-fg-2 hover:bg-bg-alt transition-colors"
    >
      {copied ? 'Copied!' : 'Copy URL'}
    </button>
  );
}
