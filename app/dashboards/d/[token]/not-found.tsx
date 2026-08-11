export default function ClientDashboardNotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-page px-6 text-center font-body">
      <div>
        <p className="font-heading text-xl font-bold text-fg-1">Dashboard not found</p>
        <p className="mt-2 text-sm font-light text-fg-3">
          This link may be invalid or the project was removed.
        </p>
      </div>
    </div>
  );
}
