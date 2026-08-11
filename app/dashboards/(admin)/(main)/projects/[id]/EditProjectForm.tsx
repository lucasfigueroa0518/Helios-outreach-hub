'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';

import {
  regenerateToken,
  updateProject,
  type ActionState,
} from '@/app/dashboards/(admin)/(main)/projects/actions';
import ClientCombobox from '@/components/dashboards/admin/ClientCombobox';
import DeckUploadZone from '@/components/dashboards/admin/DeckUploadZone';
import { formatDate } from '@/lib/dashboards/utils';

type Client = { id: string; name: string };

type Project = {
  id: string;
  name: string;
  status: string;
  startDate: Date;
  targetEndDate: Date;
  completedAt: Date | null;
  accessToken: string;
  githubRepo: string;
  githubBranch: string;
  deckPdfUrl: string | null;
  cronEnabled: boolean;
  mvpDelivered: boolean;
  client: Client;
};

const inputCls = (err?: string) =>
  'w-full rounded-lg border px-3 py-2 text-sm text-fg-1 outline-none focus:ring-2 focus:ring-[#FF5E1A]/30 transition ' +
  (err ? 'border-red-400 bg-red-50' : 'border-border bg-white');

export default function EditProjectForm({
  project,
  clients,
}: {
  project: Project;
  clients: Client[];
}) {
  const updateWithId = updateProject.bind(null, project.id);
  const [state, action, isPending] = useActionState<ActionState, FormData>(
    updateWithId,
    {},
  );
  const [saved, setSaved] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [tokenRegenPending, setTokenRegenPending] = useState(false);
  const [currentToken, setCurrentToken] = useState(project.accessToken);

  const fe = state?.fieldErrors ?? {};

  async function handleFormAction(formData: FormData) {
    setSaved(false);
    await action(formData);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  async function handleRegenerate() {
    setTokenRegenPending(true);
    setShowConfirm(false);
    const result = await regenerateToken(project.id);
    setCurrentToken(result.newToken);
    setTokenRegenPending(false);
  }

  async function copyUrl() {
    await navigator.clipboard.writeText(
      `${window.location.origin}/d/${currentToken}`,
    );
    setUrlCopied(true);
    setTimeout(() => setUrlCopied(false), 2000);
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-white p-5">
        <h2 className="mb-3 text-sm font-semibold text-fg-1">Dashboard URL</h2>
        <div className="flex items-center gap-2">
          <code className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-lg bg-bg-alt px-3 py-2 text-xs text-fg-2">
            {typeof window !== 'undefined'
              ? `${window.location.origin}/d/${currentToken}`
              : `/d/${currentToken}`}
          </code>
          <button
            type="button"
            onClick={copyUrl}
            className="shrink-0 rounded-lg border border-border px-3 py-2 text-xs font-medium text-fg-2 hover:bg-bg-alt transition-colors"
          >
            {urlCopied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <div className="mt-3 flex items-center gap-2">
          {showConfirm ? (
            <>
              <span className="text-xs text-fg-3">
                Rotating the token will invalidate the current URL.
              </span>
              <button
                type="button"
                onClick={handleRegenerate}
                disabled={tokenRegenPending}
                className="text-xs font-medium text-red-600 hover:underline disabled:opacity-50"
              >
                {tokenRegenPending ? 'Rotating…' : 'Yes, rotate'}
              </button>
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                className="text-xs text-fg-muted hover:text-fg-2"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setShowConfirm(true)}
              className="text-xs text-fg-3 hover:text-fg-1 underline-offset-2 hover:underline transition-colors"
            >
              Regenerate token
            </button>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-white p-5">
        <h2 className="mb-3 text-sm font-semibold text-fg-1">Project deck (PDF)</h2>
        <DeckUploadZone projectId={project.id} currentUrl={project.deckPdfUrl} />
      </div>

      <form
        action={handleFormAction}
        className="space-y-5 rounded-xl border border-border bg-white p-6"
      >
        <h2 className="text-sm font-semibold text-fg-1">Project details</h2>

        {state?.error && (
          <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
            {state.error}
          </div>
        )}
        {saved && (
          <div className="rounded-lg bg-[#E8F5E8] px-4 py-3 text-sm text-[#138510]">
            Changes saved.
          </div>
        )}

        <div>
          <label className="mb-1.5 block text-sm font-medium text-fg-1">
            Project name <span className="text-red-400">*</span>
          </label>
          <input
            name="name"
            type="text"
            required
            defaultValue={project.name}
            className={inputCls(fe.name)}
          />
          {fe.name && <p className="mt-1 text-xs text-red-500">{fe.name}</p>}
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-fg-1">
            Client <span className="text-red-400">*</span>
          </label>
          <ClientCombobox
            clients={clients}
            defaultClientId={project.client.id}
            defaultClientName={project.client.name}
            error={fe.clientId}
          />
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-fg-1">
            GitHub repo
          </label>
          <input
            name="githubRepo"
            type="text"
            defaultValue={project.githubRepo}
            placeholder="owner/repo"
            className={inputCls(fe.githubRepo)}
          />
          {fe.githubRepo && (
            <p className="mt-1 text-xs text-red-500">{fe.githubRepo}</p>
          )}
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-fg-1">
            Default branch
          </label>
          <input
            name="githubBranch"
            type="text"
            defaultValue={project.githubBranch}
            placeholder="main"
            className={inputCls(fe.githubBranch)}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-fg-1">
              Start date <span className="text-red-400">*</span>
            </label>
            <input
              name="startDate"
              type="date"
              required
              defaultValue={formatDate(project.startDate)}
              className={inputCls(fe.startDate)}
            />
            {fe.startDate && (
              <p className="mt-1 text-xs text-red-500">{fe.startDate}</p>
            )}
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-fg-1">
              Target end date <span className="text-red-400">*</span>
            </label>
            <input
              name="targetEndDate"
              type="date"
              required
              defaultValue={formatDate(project.targetEndDate)}
              className={inputCls(fe.targetEndDate)}
            />
            {fe.targetEndDate && (
              <p className="mt-1 text-xs text-red-500">{fe.targetEndDate}</p>
            )}
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-fg-1">Status</label>
          <select name="status" defaultValue={project.status} className={inputCls()}>
            <option value="ACTIVE">Active</option>
            <option value="PAUSED">Paused</option>
            <option value="COMPLETE">Complete</option>
            <option value="ARCHIVED">Archived</option>
          </select>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
          <div>
            <p className="text-sm font-medium text-fg-1">AI update cron</p>
            <p className="mt-0.5 text-xs text-fg-3">
              Generate updates automatically on schedule
            </p>
          </div>
          <label className="relative inline-block h-5 w-9 shrink-0 cursor-pointer">
            <input
              type="checkbox"
              name="cronEnabled"
              defaultChecked={project.cronEnabled}
              className="peer sr-only"
            />
            <span className="block h-full w-full cursor-pointer rounded-full bg-neutral-200 transition-colors peer-checked:bg-[#FF5E1A]" />
            <span className="pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 peer-checked:translate-x-4" />
          </label>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
          <div>
            <p className="text-sm font-medium text-fg-1">MVP Delivered</p>
            <p className="mt-0.5 text-xs text-fg-3">
              When on, replaces the countdown with “MVP Delivered” + “Continuous
              improvements ongoing”.
            </p>
          </div>
          <label className="relative inline-block h-5 w-9 shrink-0 cursor-pointer">
            <input
              type="checkbox"
              name="mvpDelivered"
              defaultChecked={project.mvpDelivered}
              className="peer sr-only"
            />
            <span className="block h-full w-full cursor-pointer rounded-full bg-neutral-200 transition-colors peer-checked:bg-[#FF5E1A]" />
            <span className="pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 peer-checked:translate-x-4" />
          </label>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-fg-1">
            Completed on{' '}
            <span className="text-xs font-normal text-fg-muted">
              (when status is Complete)
            </span>
          </label>
          <input
            name="completedAt"
            type="date"
            defaultValue={
              project.completedAt ? formatDate(project.completedAt) : ''
            }
            className={inputCls()}
          />
        </div>

        <div className="flex items-center gap-3 border-t border-border-soft pt-4">
          <button
            type="submit"
            disabled={isPending}
            className="rounded-pill bg-[#FF5E1A] px-5 py-2.5 text-sm font-semibold text-white shadow-cta-glow hover:bg-[#E54E0F] disabled:opacity-60 transition-colors"
          >
            {isPending ? 'Saving…' : 'Save changes'}
          </button>
          <Link
            href="/dashboards"
            className="text-sm font-medium text-fg-3 hover:text-fg-1 transition-colors"
          >
            Back to projects
          </Link>
        </div>
      </form>
    </div>
  );
}
