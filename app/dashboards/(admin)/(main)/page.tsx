import { format } from 'date-fns';
import Link from 'next/link';

import CopyUrlButton from '@/app/dashboards/(admin)/CopyUrlButton';
import { getAdminProjects } from '@/lib/dashboards/admin-data';

export const dynamic = 'force-dynamic';

const STATUS_BADGE: Record<string, string> = {
  ACTIVE: 'bg-[#E8F5E8] text-[#138510]',
  PAUSED: 'bg-amber-50 text-amber-700',
  COMPLETE: 'bg-blue-50 text-blue-700',
  ARCHIVED: 'bg-neutral-100 text-neutral-500',
};

export default async function AdminProjectsPage() {
  const projects = await getAdminProjects();

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="font-heading text-2xl font-bold tracking-tight text-fg-1">
            Projects
          </h1>
          <p className="mt-1 text-sm font-light text-fg-3">
            {projects.length} project{projects.length !== 1 ? 's' : ''}
          </p>
        </div>
        <Link
          href="/dashboards/projects/new"
          className="rounded-pill bg-[#FF5E1A] px-4 py-2 text-sm font-semibold text-white shadow-cta-glow hover:bg-[#E54E0F] transition-colors"
        >
          + New project
        </Link>
      </div>

      {projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-white py-20 text-center">
          <p className="mb-4 text-lg font-medium text-fg-2">No projects yet</p>
          <Link
            href="/dashboards/projects/new"
            className="rounded-pill bg-[#FF5E1A] px-5 py-2.5 text-sm font-semibold text-white shadow-cta-glow hover:bg-[#E54E0F] transition-colors"
          >
            Create your first project
          </Link>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-white">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-bg-alt">
                <th className="px-4 py-3 font-semibold text-fg-2">Project</th>
                <th className="px-4 py-3 font-semibold text-fg-2">Client</th>
                <th className="px-4 py-3 font-semibold text-fg-2">Status</th>
                <th className="hidden px-4 py-3 font-semibold text-fg-2 md:table-cell">
                  Days left
                </th>
                <th className="hidden px-4 py-3 font-semibold text-fg-2 lg:table-cell">
                  Last update
                </th>
                <th className="px-4 py-3 font-semibold text-fg-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-soft">
              {projects.map((p) => (
                <tr key={p.id} className="hover:bg-bg-alt transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/dashboards/projects/${p.id}`}
                        className="font-medium text-fg-1 hover:text-accent transition-colors"
                      >
                        {p.name}
                      </Link>
                      {!p.deckPdfUrl && !p.deckStoragePath && (
                        <span
                          title="No deck uploaded"
                          className="rounded-pill bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700"
                        >
                          ⚠ No deck
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-fg-muted font-mono">
                      {p.githubRepo}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-fg-2">{p.client.name}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-pill px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${STATUS_BADGE[p.status] ?? ''}`}
                    >
                      {p.status}
                    </span>
                  </td>
                  <td className="hidden px-4 py-3 text-fg-3 md:table-cell">
                    {p.status === 'COMPLETE'
                      ? '—'
                      : p.daysRemaining > 0
                        ? `${p.daysRemaining}d`
                        : `${Math.abs(p.daysRemaining)}d overdue`}
                  </td>
                  <td className="hidden px-4 py-3 text-fg-3 lg:table-cell">
                    {p.lastUpdateAt
                      ? format(p.lastUpdateAt, 'MMM d, yyyy')
                      : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <CopyUrlButton token={p.accessToken} />
                      <Link
                        href={`/dashboards/projects/${p.id}`}
                        className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-fg-2 hover:bg-bg-alt transition-colors"
                      >
                        Edit
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
