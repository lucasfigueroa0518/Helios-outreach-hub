export function LivePulse({ live, label = 'Live' }: { live: boolean; label?: string }) {
  if (!live) {
    return <span className="live-pulse live-pulse--off" aria-hidden="true" />;
  }
  return (
    <span className="live-pulse" role="status" aria-label={label}>
      <span className="live-pulse__dot" />
      {label}
    </span>
  );
}
