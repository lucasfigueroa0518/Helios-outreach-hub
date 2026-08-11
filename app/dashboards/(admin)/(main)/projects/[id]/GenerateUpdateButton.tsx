'use client';

import { useState } from 'react';

import { generateUpdateAction } from '@/app/dashboards/(admin)/(main)/projects/actions';

type State = 'idle' | 'loading' | 'success' | 'fallback' | 'empty' | 'error';

export default function GenerateUpdateButton({ projectId }: { projectId: string }) {
  const [state, setState] = useState<State>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [hasPriorUpdate, setHasPriorUpdate] = useState(true);

  async function handleGenerate() {
    setState('loading');
    setErrorMsg(null);
    setAiError(null);
    const result = await generateUpdateAction(projectId);
    if (result.error) {
      setErrorMsg(result.error);
      setState('error');
    } else if (result.generated) {
      if (result.source === 'fallback') {
        setAiError(result.aiError ?? 'AI summary unavailable');
        setState('fallback');
      } else {
        setState('success');
      }
    } else {
      setHasPriorUpdate(result.hasPriorUpdate ?? true);
      setState('empty');
    }
    setTimeout(() => setState('idle'), 10000);
  }

  return (
    <div className="rounded-xl border border-border bg-white p-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-fg-1">AI context update</h2>
          <p className="mt-0.5 text-xs text-fg-3">
            Generate a client-facing summary from recent GitHub activity.
          </p>
        </div>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={state === 'loading'}
          className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg-2 hover:bg-bg-alt disabled:opacity-50 transition-colors"
        >
          {state === 'loading' ? 'Generating…' : 'Generate now'}
        </button>
      </div>
      {state === 'success' && (
        <div className="mt-3 rounded-lg bg-[#E8F5E8] px-3 py-2 text-xs text-[#138510]">
          Update generated. Clients will see it on the next dashboard visit.
        </div>
      )}
      {state === 'fallback' && (
        <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Generated a basic summary from GitHub activity — the AI summary was
          unavailable: {aiError}. Clients will still see the update.
        </div>
      )}
      {state === 'empty' && (
        <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          {hasPriorUpdate
            ? 'No new activity to summarize since the last update.'
            : 'No activity since this project was added. The first update will generate once new commits land.'}
        </div>
      )}
      {state === 'error' && (
        <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          Error: {errorMsg}
        </div>
      )}
    </div>
  );
}
