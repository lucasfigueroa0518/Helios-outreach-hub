export function HubLoadingSpinner({ label = 'Loading' }: { label?: string }) {
  return (
    <main className="app-shell hub-loading-shell">
      <div className="hub-loading" role="status" aria-live="polite" aria-busy="true">
        <span className="loading-spinner hub-loading__spinner" aria-hidden="true" />
        <span className="visually-hidden">{label}</span>
      </div>
    </main>
  );
}
