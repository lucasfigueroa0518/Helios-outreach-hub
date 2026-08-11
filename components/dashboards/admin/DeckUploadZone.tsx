'use client';

import { useCallback, useRef, useState } from 'react';

import {
  removeDeck,
  uploadDeck,
} from '@/app/dashboards/(admin)/(main)/projects/actions';

const MAX_MB = 25;
const MAX_BYTES = MAX_MB * 1024 * 1024;

interface DeckUploadZoneProps {
  projectId: string;
  currentUrl: string | null;
}

export default function DeckUploadZone({ projectId, currentUrl }: DeckUploadZoneProps) {
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveUrl, setLiveUrl] = useState<string | null>(currentUrl);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function validateFile(f: File): string | null {
    if (f.type !== 'application/pdf') return 'File must be a PDF.';
    if (f.size > MAX_BYTES) {
      return `File must be ${MAX_MB} MB or smaller (got ${(f.size / 1024 / 1024).toFixed(1)} MB).`;
    }
    return null;
  }

  function pickFile(f: File) {
    const err = validateFile(f);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setPendingFile(f);
  }

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback(() => setIsDragging(false), []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) pickFile(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleUpload() {
    if (!pendingFile) return;
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('deck', pendingFile);
      const result = await uploadDeck(projectId, fd);
      if ('error' in result) {
        setError(result.error);
      } else {
        setLiveUrl(result.url);
        setPendingFile(null);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    try {
      await removeDeck(projectId, liveUrl);
      setLiveUrl(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Remove failed. Try again.');
    } finally {
      setRemoving(false);
    }
  }

  const dropZoneCls =
    'flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition-colors ' +
    (isDragging
      ? 'border-[#FF5E1A] bg-[#FFF8F5]'
      : 'border-border hover:border-border hover:bg-bg-alt');

  return (
    <div className="space-y-3">
      {liveUrl ? (
        <div className="rounded-xl border border-border bg-white p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-[#138510]">Deck uploaded</p>
              <a
                href={liveUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-0.5 block truncate text-xs text-fg-muted hover:text-accent transition-colors"
              >
                {liveUrl}
              </a>
            </div>
            <button
              type="button"
              onClick={handleRemove}
              disabled={removing}
              className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-fg-3 hover:border-red-300 hover:text-red-600 disabled:opacity-50 transition-colors"
            >
              {removing ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </div>
      ) : (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
          ⚠ No deck uploaded — the dashboard will show a placeholder.
        </p>
      )}

      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={dropZoneCls}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) pickFile(f);
          }}
        />
        <svg
          className="mb-3 h-8 w-8 text-fg-muted"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
          />
        </svg>
        {pendingFile ? (
          <p className="text-sm font-medium text-fg-1">{pendingFile.name}</p>
        ) : (
          <>
            <p className="text-sm font-medium text-fg-2">Drop PDF here or click to browse</p>
            <p className="mt-1 text-xs text-fg-muted">Max {MAX_MB} MB</p>
          </>
        )}
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      {pendingFile && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleUpload}
            disabled={uploading}
            className="rounded-pill bg-[#FF5E1A] px-4 py-2 text-sm font-semibold text-white shadow-cta-glow hover:bg-[#E54E0F] disabled:opacity-60 transition-colors"
          >
            {uploading ? 'Uploading…' : liveUrl ? 'Replace deck' : 'Upload deck'}
          </button>
          <button
            type="button"
            onClick={() => {
              setPendingFile(null);
              setError(null);
            }}
            className="text-sm text-fg-muted hover:text-fg-2 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
