import NewProjectForm from '@/app/dashboards/(admin)/(main)/projects/new/NewProjectForm';
import { getAllClients } from '@/lib/dashboards/admin-data';

export default async function NewProjectPage() {
  const clients = await getAllClients();
  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="font-heading text-2xl font-bold tracking-tight text-fg-1">
          New project
        </h1>
        <p className="mt-1 text-sm font-light text-fg-3">
          Create a project and share its dashboard URL with the client.
        </p>
      </div>
      <NewProjectForm clients={clients} />
    </div>
  );
}
