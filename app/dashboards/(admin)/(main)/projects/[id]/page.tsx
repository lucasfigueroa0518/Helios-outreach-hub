import { notFound } from 'next/navigation';

import DeleteProjectButton from '@/app/dashboards/(admin)/(main)/projects/[id]/DeleteProjectButton';
import EditProjectForm from '@/app/dashboards/(admin)/(main)/projects/[id]/EditProjectForm';
import GenerateUpdateButton from '@/app/dashboards/(admin)/(main)/projects/[id]/GenerateUpdateButton';
import SyncButton from '@/app/dashboards/(admin)/(main)/projects/[id]/SyncButton';
import { getAdminProject, getAllClients } from '@/lib/dashboards/admin-data';

export const dynamic = 'force-dynamic';

export default async function EditProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [project, clients] = await Promise.all([
    getAdminProject(id),
    getAllClients(),
  ]);

  if (!project) notFound();

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="font-heading text-2xl font-bold tracking-tight text-fg-1">
          {project.name}
        </h1>
        <p className="mt-1 text-sm font-light text-fg-3">{project.client.name}</p>
      </div>
      <div className="space-y-6">
        <GenerateUpdateButton projectId={project.id} />
        {project.lastSyncError && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <span className="font-semibold">⚠ Last sync failed.</span>{' '}
            {project.lastSyncError}
          </div>
        )}
        <SyncButton
          projectId={project.id}
          lastSyncAt={project.githubLastSyncAt}
        />
        <EditProjectForm project={project} clients={clients} />
        <DeleteProjectButton projectId={project.id} projectName={project.name} />
      </div>
    </div>
  );
}
