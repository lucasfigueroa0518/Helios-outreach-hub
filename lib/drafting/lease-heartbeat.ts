export async function runWithLeaseHeartbeat<T>(input: {
  heartbeat: () => Promise<void>;
  operation: () => Promise<T>;
  intervalMs?: number;
  onHeartbeatError?: (error: unknown) => void;
  scheduler?: {
    setInterval: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
    clearInterval: (timer: ReturnType<typeof setInterval>) => void;
  };
}): Promise<T> {
  await input.heartbeat();
  const scheduler = input.scheduler ?? {
    setInterval,
    clearInterval,
  };
  const timer = scheduler.setInterval(() => {
    void input.heartbeat().catch((error: unknown) => {
      input.onHeartbeatError?.(error);
    });
  }, input.intervalMs ?? 60_000);
  try {
    return await input.operation();
  } finally {
    scheduler.clearInterval(timer);
  }
}
