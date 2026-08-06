/** Wall-clock helpers for drafting diagnostics. */

export type Stopwatch = {
  startedAtMs: number;
  startedAtIso: string;
  elapsedMs: () => number;
  formatElapsed: () => string;
  lap: (label: string) => { label: string; elapsed_ms: number; elapsed: string };
};

export function createStopwatch(startedAtMs = Date.now()): Stopwatch {
  return {
    startedAtMs,
    startedAtIso: new Date(startedAtMs).toISOString(),
    elapsedMs: () => Date.now() - startedAtMs,
    formatElapsed: () => formatDuration(Date.now() - startedAtMs),
    lap: (label: string) => {
      const elapsed_ms = Date.now() - startedAtMs;
      return { label, elapsed_ms, elapsed: formatDuration(elapsed_ms) };
    },
  };
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00.0';
  const totalTenths = Math.floor(ms / 100);
  const tenths = totalTenths % 10;
  const totalSeconds = Math.floor(totalTenths / 10);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0) {
    return `${hours}:${String(mins).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`;
  }
  return `${mins}:${String(seconds).padStart(2, '0')}.${tenths}`;
}

export function durationBetween(startIso: string | null | undefined, endIso: string | null | undefined): string | null {
  if (!startIso || !endIso) return null;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return formatDuration(end - start);
}
