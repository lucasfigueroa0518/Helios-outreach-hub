/**
 * Run async work over items with a fixed concurrency limit.
 * Results preserve input order. Failures reject the whole pool only if
 * callers don't catch inside `fn` — prefer catching per-item for bulk UX.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onItemDone?: (completed: number, total: number) => void,
): Promise<R[]> {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
      completed += 1;
      onItemDone?.(completed, items.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/** Split an array into chunks of at most `size` (last chunk may be smaller). */
export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunkSize = Math.max(1, size);
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}
