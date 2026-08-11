'use client';

import { useEffect, useRef, useState } from 'react';

type Client = { id: string; name: string };

interface ClientComboboxProps {
  clients: Client[];
  defaultClientId?: string;
  defaultClientName?: string;
  error?: string;
}

export default function ClientCombobox({
  clients,
  defaultClientId = '',
  defaultClientName = '',
  error,
}: ClientComboboxProps) {
  const [query, setQuery] = useState(defaultClientName);
  const [clientId, setClientId] = useState(defaultClientId);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = clients.filter((c) =>
    c.name.toLowerCase().includes(query.toLowerCase()),
  );
  const isExactMatch = clients.some(
    (c) => c.name.toLowerCase() === query.toLowerCase(),
  );
  const showAddNew = query.trim().length > 0 && !isExactMatch;

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  function select(client: Client) {
    setQuery(client.name);
    setClientId(client.id);
    setOpen(false);
  }

  function selectNew() {
    setClientId('');
    setOpen(false);
  }

  const inputCls =
    'w-full rounded-lg border px-3 py-2 text-sm text-fg-1 outline-none focus:ring-2 focus:ring-[#FF5E1A]/30 transition ' +
    (error ? 'border-red-400 bg-red-50' : 'border-border bg-white');

  return (
    <div ref={containerRef} className="relative">
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="clientName" value={query} />

      <input
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setClientId('');
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search or type new client name…"
        className={inputCls}
        autoComplete="off"
      />

      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}

      {open && (filtered.length > 0 || showAddNew) && (
        <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-border bg-white shadow-md">
          {filtered.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => select(c)}
                className="flex w-full items-center px-3 py-2 text-left text-sm text-fg-1 hover:bg-bg-alt transition-colors"
              >
                {c.name}
              </button>
            </li>
          ))}
          {showAddNew && (
            <li className="border-t border-border-soft">
              <button
                type="button"
                onClick={selectNew}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[#FF5E1A] hover:bg-[#FFF8F5] transition-colors"
              >
                <span className="font-medium">+ Add new:</span>
                <span>{query.trim()}</span>
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
