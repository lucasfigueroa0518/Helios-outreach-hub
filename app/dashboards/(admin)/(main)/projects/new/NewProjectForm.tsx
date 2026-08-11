'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import {
  createProject,
  type ActionState,
} from '@/app/dashboards/(admin)/(main)/projects/actions';
import ClientCombobox from '@/components/dashboards/admin/ClientCombobox';
import { formatDate } from '@/lib/dashboards/utils';

type Client = { id: string; name: string };

const inputCls = (err?: string) =>
  'w-full rounded-lg border px-3 py-2 text-sm text-fg-1 outline-none focus:ring-2 focus:ring-[#FF5E1A]/30 transition ' +
  (err ? 'border-red-400 bg-red-50' : 'border-border bg-white');

export default function NewProjectForm({ clients }: { clients: Client[] }) {
  const [state, action, isPending] = useActionState<ActionState, FormData>(
    createProject,
    {},
  );

  const fe = state?.fieldErrors ?? {};
  const today = formatDate(new Date());

  return (
    <form action={action} className="space-y-5 rounded-xl border border-border bg-white p-6">
      {state?.error && (
        <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {state.error}
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
          placeholder="Q3 Content Engine"
          className={inputCls(fe.name)}
        />
        {fe.name && <p className="mt-1 text-xs text-red-500">{fe.name}</p>}
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-fg-1">
          Client <span className="text-red-400">*</span>
        </label>
        <ClientCombobox clients={clients} error={fe.clientId} />
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-fg-1">
          GitHub repo
        </label>
        <input
          name="githubRepo"
          type="text"
          placeholder="owner/repo or https://github.com/owner/repo"
          className={inputCls(fe.githubRepo)}
        />
        {fe.githubRepo ? (
          <p className="mt-1 text-xs text-red-500">{fe.githubRepo}</p>
        ) : (
          <p className="mt-1 text-xs text-fg-muted">
            Sync uses the encrypted PAT for the repo owner under Tokens.
          </p>
        )}
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-fg-1">
          Default branch
        </label>
        <input
          name="githubBranch"
          type="text"
          defaultValue="main"
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
            defaultValue={today}
            className={inputCls(fe.startDate)}
          />
          {fe.startDate && <p className="mt-1 text-xs text-red-500">{fe.startDate}</p>}
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-fg-1">
            Target end date <span className="text-red-400">*</span>
          </label>
          <input
            name="targetEndDate"
            type="date"
            required
            className={inputCls(fe.targetEndDate)}
          />
          {fe.targetEndDate && (
            <p className="mt-1 text-xs text-red-500">{fe.targetEndDate}</p>
          )}
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-fg-1">Status</label>
        <select name="status" defaultValue="ACTIVE" className={inputCls()}>
          <option value="ACTIVE">Active</option>
          <option value="PAUSED">Paused</option>
          <option value="COMPLETE">Complete</option>
          <option value="ARCHIVED">Archived</option>
        </select>
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
          <input type="checkbox" name="mvpDelivered" className="peer sr-only" />
          <span className="block h-full w-full cursor-pointer rounded-full bg-neutral-200 transition-colors peer-checked:bg-[#FF5E1A]" />
          <span className="pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 peer-checked:translate-x-4" />
        </label>
      </div>

      <div className="flex items-center gap-3 border-t border-border-soft pt-4">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-pill bg-[#FF5E1A] px-5 py-2.5 text-sm font-semibold text-white shadow-cta-glow hover:bg-[#E54E0F] disabled:opacity-60 transition-colors"
        >
          {isPending ? 'Creating…' : 'Create project'}
        </button>
        <Link
          href="/dashboards"
          className="text-sm font-medium text-fg-3 hover:text-fg-1 transition-colors"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
